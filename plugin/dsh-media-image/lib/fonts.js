// 字体库：登记的字体文件按 id 从同源路由提供给编辑器 FontFace 加载。
//
// 只做"文件签名验明正身 + 限量暂存"，不替用户判断授权。字体是受版权与许可约束的资产，
// 插件不内置任何字体、也不抓字体站；用哪个字体文件由使用者自己提供并自负授权。
// 与其他素材一样存在进程内存里：重启即失效，不做持久化。

import { randomBytes } from 'node:crypto';

export const MAX_FONT_BYTES = 8 * 1024 * 1024;
export const MAX_FONT_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_FONTS = 32;

const SIGNATURES = [
  { mime: 'font/woff2', ext: 'woff2', test: bytes => bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'wOF2' },
  { mime: 'font/woff', ext: 'woff', test: bytes => bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'wOFF' },
  { mime: 'font/otf', ext: 'otf', test: bytes => bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OTTO' },
  { mime: 'font/ttf', ext: 'ttf', test: bytes => bytes.length >= 4 && [0x00010000, 0x74727565].includes(bytes.readUInt32BE(0)) },
];

export function sniffFont(bytes) {
  return SIGNATURES.find(item => item.test(bytes)) ?? null;
}

// 家族名会进 CSS font-family 与 FontFace：只留字母数字空格下划线连字符，长度上限 64。
export function normalizeFamily(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('family 必须是字符串'), { code: 'INVALID_REQUEST' });
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) throw Object.assign(new Error('family 必须是 1..64 字符'), { code: 'INVALID_REQUEST' });
  if (!/^[\p{L}\p{N} _-]+$/u.test(trimmed)) throw Object.assign(new Error('family 只能包含字母、数字、空格、下划线与连字符'), { code: 'INVALID_REQUEST' });
  return trimmed;
}

// PSD 里的字体名常是 "Family-Style"（如 Poppins-Medium、Roboto-Bold）。
// 拆成家族与样式，便于和登记过的字体族比对；拆不出来就整串当家族。
export function splitFontName(name) {
  const text = String(name ?? '').trim();
  if (!text) return { family: null, style: null };
  // 只在"最后一段看起来像样式词"时才拆，避免把 "Helvetica Neue" 拆坏。
  const STYLES = ['thin', 'extralight', 'ultralight', 'light', 'regular', 'normal', 'book', 'medium', 'semibold', 'demibold', 'bold', 'extrabold', 'ultrabold', 'black', 'heavy', 'italic', 'oblique'];
  const parts = text.split(/[-_ ]/);
  if (parts.length >= 2 && STYLES.includes(parts[parts.length - 1].toLowerCase())) {
    return { family: parts.slice(0, -1).join(' '), style: parts[parts.length - 1] };
  }
  return { family: text, style: null };
}

/** 比较用的归一化：去掉空格/连字符/下划线，转小写。 */
const foldName = value => String(value ?? '').toLowerCase().replace(/[\s_-]+/g, '');

export function createFontStore({ maxFontBytes = MAX_FONT_BYTES, maxTotalBytes = MAX_FONT_STORE_BYTES, maxFonts = MAX_FONTS } = {}) {
  const fonts = new Map();
  let totalBytes = 0;

  const metadata = font => ({ id: font.id, family: font.family, mime: font.mime, bytes: font.bytes.length, createdAt: font.createdAt });

  return {
    add({ bytes, family }) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1) throw Object.assign(new Error('字体文件为空'), { code: 'INVALID_FONT' });
      if (bytes.length > maxFontBytes) throw Object.assign(new Error(`字体超过 ${maxFontBytes} 字节上限`), { code: 'PAYLOAD_TOO_LARGE' });
      const type = sniffFont(bytes);
      if (!type) throw Object.assign(new Error('只支持 woff2/woff/otf/ttf 字体'), { code: 'UNSUPPORTED_FONT_TYPE' });
      if (fonts.size >= maxFonts || totalBytes + bytes.length > maxTotalBytes) throw Object.assign(new Error('字体暂存已满'), { code: 'FONT_STORE_FULL' });
      const font = { id: randomBytes(24).toString('hex'), family: normalizeFamily(family), mime: type.mime, ext: type.ext, bytes: Buffer.from(bytes), createdAt: Date.now() };
      fonts.set(font.id, font);
      totalBytes += font.bytes.length;
      return { ...metadata(font), url: `/media-image/fonts/${font.id}` };
    },
    get(id) { return fonts.get(id) ?? null; },
    /**
     * 按"PSD 风格的字体名"找已登记的字体。
     * 顺序：整串精确（忽略大小写/空格/连字符）→ 拆出的家族精确 → 登记家族是该名字的前缀。
     * 找不到就返回 null —— **绝不**编一个字体名让编辑器去悄悄回退。
     * @returns {{id:string, family:string, url:string, match:'exact'|'family'|'prefix'}|null}
     */
    matchFontName(name) {
      const wanted = foldName(name);
      if (!wanted) return null;
      const all = [...fonts.values()];
      const describe = (font, match) => ({ id: font.id, family: font.family, url: `/media-image/fonts/${font.id}`, match });
      const exact = all.find(font => foldName(font.family) === wanted);
      if (exact) return describe(exact, 'exact');
      const { family } = splitFontName(name);
      const foldedFamily = foldName(family);
      if (foldedFamily) {
        const byFamily = all.find(font => foldName(font.family) === foldedFamily);
        if (byFamily) return describe(byFamily, 'family');
        // 登记名可能带额外后缀（如 "Poppins Local"）：允许登记家族以请求家族开头。
        const byPrefix = all.find(font => foldName(font.family).startsWith(foldedFamily));
        if (byPrefix) return describe(byPrefix, 'prefix');
      }
      return null;
    },
    list() { return [...fonts.values()].map(font => ({ ...metadata(font), url: `/media-image/fonts/${font.id}` })); },
    get totalBytes() { return totalBytes; },
    clear() { fonts.clear(); totalBytes = 0; },
  };
}
