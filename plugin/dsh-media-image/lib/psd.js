// PSD 解析（零依赖）：只读不写，只抽取"套版需要的结构"，不碰像素。
//
// 为什么自己做：miniPaint 打不开 PSD，而用户的模板库（WPS 知识库「图片模版」）大多是 PSD。
// 套版只需要画布尺寸 + 每个图层的位置/尺寸/可见性/不透明/文本，不需要图像数据，
// 所以这里跳过所有像素通道，只走 header → 图层记录 → 附加块（luni/TySh/lsct）。
//
// 边界：任何结构异常都抛 PsdError（带稳定 code），绝不返回半懂的数据去误导上层。

export class PsdError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PsdError';
    this.code = code;
  }
}

const SIGNATURE = '8BPS';

/** 读 PSD 头：宽高、通道、位深、色彩模式。 */
export function parsePsdHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 26) throw new PsdError('PSD_TOO_SMALL', '文件太小，不是有效的 PSD');
  if (buffer.toString('ascii', 0, 4) !== SIGNATURE) throw new PsdError('PSD_BAD_SIGNATURE', '不是 PSD 文件（缺少 8BPS 标识）');
  const version = buffer.readUInt16BE(4);
  if (version !== 1 && version !== 2) throw new PsdError('PSD_BAD_VERSION', `不支持的 PSD 版本：${version}`);
  const height = buffer.readUInt32BE(14);
  const width = buffer.readUInt32BE(18);
  if (!width || !height) throw new PsdError('PSD_BAD_DIMENSIONS', 'PSD 画布尺寸为 0');
  return {
    version,
    channels: buffer.readUInt16BE(12),
    width,
    height,
    depth: buffer.readUInt16BE(22),
    colorMode: buffer.readUInt16BE(24),
    colorModeName: ({ 0: 'bitmap', 1: 'grayscale', 2: 'indexed', 3: 'rgb', 4: 'cmyk', 7: 'multichannel', 8: 'duotone', 9: 'lab' })[buffer.readUInt16BE(24)] || 'unknown',
  };
}

/** 描述符（Descriptor）解析：PSD 用它装 TySh 文本、SoCo 纯色等结构化数据。 */
function parseDescriptor(buf, offset, depth = 0) {
  if (depth > 8) throw new PsdError('PSD_DESCRIPTOR_DEPTH', '描述符嵌套过深');
  let o = offset;
  const need = count => { if (o + count > buf.length) throw new PsdError('PSD_TRUNCATED', '描述符数据被截断'); };
  need(4);
  const nameLen = buf.readUInt32BE(o); o += 4;
  if (nameLen) { need(nameLen * 2); o += nameLen * 2; }
  need(4);
  const classLen = buf.readUInt32BE(o); o += 4;
  // 与字段名同一条规则：长度为 0 时，类名就是紧随其后的 4 个字符。
  if (classLen === 0) { need(4); o += 4; } else { need(classLen); o += classLen; }
  need(4);
  const itemCount = buf.readUInt32BE(o); o += 4;
  if (itemCount > 512) throw new PsdError('PSD_DESCRIPTOR_TOO_LARGE', '描述符字段过多');
  const out = {};
  for (let index = 0; index < itemCount; index += 1) {
    need(4);
    let keyLen = buf.readUInt32BE(o); o += 4;
    let key;
    if (keyLen === 0) { need(4); key = buf.toString('ascii', o, o + 4); o += 4; }
    else { if (keyLen > 255) throw new PsdError('PSD_BAD_KEY', '描述符字段名过长'); need(keyLen); key = buf.toString('ascii', o, o + keyLen); o += keyLen; }
    need(4);
    const type = buf.toString('ascii', o, o + 4); o += 4;
    switch (type) {
      case 'TEXT': {
        need(4); const len = buf.readUInt32BE(o); o += 4;
        if (len > 100_000) throw new PsdError('PSD_TEXT_TOO_LONG', '文本字段异常过大');
        need(len * 2); out[key] = { type: 'text', value: readUtf16BE(buf, o, len) }; o += len * 2; break;
      }
      case 'enum': {
        need(4); const tLen = buf.readUInt32BE(o); o += 4; const typeId = buf.toString('ascii', o, o + tLen); o += tLen;
        need(4); const eLen = buf.readUInt32BE(o); o += 4; const value = buf.toString('ascii', o, o + eLen); o += eLen;
        out[key] = { type: 'enum', typeId, value }; break;
      }
      case 'long': need(4); out[key] = { type: 'long', value: buf.readInt32BE(o) }; o += 4; break;
      case 'comp': need(8); out[key] = { type: 'comp', value: Number(buf.readBigInt64BE(o)) }; o += 8; break;
      case 'bool': need(1); out[key] = { type: 'bool', value: buf[o] !== 0 }; o += 1; break;
      case 'doub': need(8); out[key] = { type: 'double', value: buf.readDoubleBE(o) }; o += 8; break;
      case 'UntF': need(12); out[key] = { type: 'unit', unit: buf.toString('ascii', o, o + 4), value: buf.readDoubleBE(o + 4) }; o += 12; break;
      case 'Pnt ': need(16); out[key] = { type: 'point', x: buf.readDoubleBE(o), y: buf.readDoubleBE(o + 8) }; o += 16; break;
      case 'UnFl': {
        need(32); const values = []; for (let i = 0; i < 4; i += 1) values.push(buf.readDoubleBE(o + i * 8)); o += 32;
        out[key] = { type: 'unitFloats', values }; break;
      }
      case 'Objc':
      case 'GlbO': { const nested = parseDescriptor(buf, o, depth + 1); out[key] = { type: 'descriptor', value: nested.value }; o = nested.offset; break; }
      case 'VlLs': {
        need(4); const len = buf.readUInt32BE(o); o += 4;
        if (len > 512) throw new PsdError('PSD_LIST_TOO_LARGE', '描述符列表过大');
        const items = [];
        for (let i = 0; i < len; i += 1) {
          need(4); const itemType = buf.toString('ascii', o, o + 4); o += 4;
          if (itemType === 'TEXT') {
            need(4); const n = buf.readUInt32BE(o); o += 4; need(n * 2); items.push(readUtf16BE(buf, o, n)); o += n * 2;
          } else if (itemType === 'Objc' || itemType === 'GlbO') {
            const nested = parseDescriptor(buf, o, depth + 1); items.push(nested.value); o = nested.offset;
          } else {
            // 其它列表项类型本模块用不到：跳过其长度前缀的数据，保持偏移正确。
            need(4); const n = buf.readUInt32BE(o); o += 4; need(n); o += n;
          }
        }
        out[key] = { type: 'list', items }; break;
      }
      default: {
        // 未使用类型：按"u32 长度 + 数据"跳过；无法确定长度就报错，不猜。
        if (['ObAr', 'UnFl', 'tdta', 'alis', 'path', 'GlbC'].includes(type)) {
          need(4); const n = buf.readUInt32BE(o); o += 4; need(n); o += n;
        } else {
          throw new PsdError('PSD_UNKNOWN_DESCRIPTOR_TYPE', `未知描述符类型：${type}`);
        }
        break;
      }
    }
  }
  return { value: out, offset: o };
}

function readUtf16BE(buf, offset, units) {
  const bytes = Buffer.from(buf.subarray(offset, offset + units * 2));
  return bytes.swap16().toString('utf16le');
}

/**
 * 在 TySh 数据里按标记定位字段，作为严格解析失败时的兜底。
 * 只认 "Txt "+"TEXT"（文字）与 "Sz  "+"UntF"（字号）两处，超出范围就放弃，不瞎猜。
 */
function scanTyShFields(data) {
  let text = null;
  let fontSize = null;
  const findMarker = (key, type) => {
    const needle = Buffer.from(`${key}${type}`, 'ascii');
    for (let at = data.indexOf(needle); at !== -1; at = data.indexOf(needle, at + 1)) {
      if (at + needle.length + 4 <= data.length) return at + needle.length;
    }
    return -1;
  };
  const textAt = findMarker('Txt ', 'TEXT');
  if (textAt !== -1) {
    const units = data.readUInt32BE(textAt);
    if (units > 0 && units <= 2000 && textAt + 4 + units * 2 <= data.length) text = readUtf16BE(data, textAt + 4, units);
  }
  const sizeAt = findMarker('Sz  ', 'UntF');
  if (sizeAt !== -1 && sizeAt + 12 <= data.length) {
    const unit = data.toString('ascii', sizeAt, sizeAt + 4);
    const value = data.readDoubleBE(sizeAt + 4);
    if (unit === '#Pnt' || unit === '#Pxl' || unit === '#Mpt') fontSize = Math.round(value * 100) / 100;
  }
  return { text, fontSize };
}

/** PSD 文本用 \r 作换行，尾部可能补 NUL；统一成 \n 便于上层直接用。 */
function normalizePsdText(value) {
  return String(value).replace(/\u0000+$/g, '').replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}

/** 解析 TySh（文字图层）：严格解析优先，失败按标记兜底；两者都拿不到就如实标记未解析。 */
function parseTySh(data) {
  try {
    let o = 0;
    const version = data.readUInt16BE(o); o += 2;
    if (version !== 1) return null;
    o += 48; // transform 6 doubles
    const textVersion = data.readUInt16BE(o); o += 2;
    if (textVersion !== 50) return null;
    o += 4; // descriptor version
    const descriptor = parseDescriptor(data, o);
    const fields = descriptor.value;
    const text = fields['Txt ']?.value;
    if (typeof text === 'string' && text.length) {
      const size = fields['Sz  '];
      const font = fields['Font']?.value;
      return {
        text: normalizePsdText(text),
        fontSize: size && size.type === 'unit' ? Math.round(size.value * 100) / 100 : null,
        fontName: typeof font === 'string' ? font : null,
        orientation: fields['Ornt']?.value || null,
        antiAlias: fields['AntA']?.value || null,
        source: 'descriptor',
      };
    }
  } catch {
    // 落到标记兜底
  }
  const scanned = scanTyShFields(data);
  if (typeof scanned.text === 'string') return { text: normalizePsdText(scanned.text), fontSize: scanned.fontSize, source: 'scan' };
  // 有文字块但内容为空：这是编辑器导出/文字被栅格化的常见情况，如实标记。
  return { text: null, unparsed: true };
}

/** 读 luni（图层 Unicode 名）；读不到就用记录里的 Pascal 名。 */
function parseLuni(data) {
  try {
    const units = data.readUInt32BE(0);
    if (units > 255) return null;
    return readUtf16BE(data, 4, units);
  } catch { return null; }
}

const BLEND = { norm: 'source-over', mul: 'multiply', scrn: 'screen', over: 'overlay', dark: 'darken', lite: 'lighten', diff: 'difference', smud: 'soft-light', hLit: 'hard-light', 'div ': 'color-dodge', idiv: 'color-burn', hue: 'hue', sat: 'saturation', colr: 'color', lum: 'luminosity' };

/**
 * 解析图层列表（扁平，带 groupPath）—— 套版只关心"可见的、有矩形"的图层。
 * 跳过所有像素通道数据，因此大 PSD 也很快。
 */
export function parsePsdLayers(buffer) {
  const header = parsePsdHeader(buffer);
  let o = 26;
  const need = count => { if (o + count > buffer.length) throw new PsdError('PSD_TRUNCATED', 'PSD 结构被截断'); };
  need(4); o += 4 + buffer.readUInt32BE(o);            // Color mode data
  need(4); o += 4 + buffer.readUInt32BE(o);            // Image resources
  need(4); const lmLen = buffer.readUInt32BE(o); o += 4;
  const lmEnd = o + lmLen;
  if (lmLen === 0) return { header, layers: [] };
  need(4); const layerInfoLen = buffer.readUInt32BE(o); o += 4;
  const layerInfoEnd = Math.min(o + layerInfoLen, lmEnd);
  need(2); let count = buffer.readInt16BE(o); o += 2;
  const hasAlphaChannel = count < 0;
  count = Math.abs(count);
  if (count > 5000) throw new PsdError('PSD_TOO_MANY_LAYERS', '图层数量异常');

  const layers = [];
  for (let index = 0; index < count; index += 1) {
    if (o + 16 > layerInfoEnd) break;
    const top = buffer.readInt32BE(o), left = buffer.readInt32BE(o + 4), bottom = buffer.readInt32BE(o + 8), right = buffer.readInt32BE(o + 12);
    o += 16;
    need(2); const channelCount = buffer.readUInt16BE(o); o += 2;
    o += channelCount * 6; // channel id + length，像素数据在后面的通道区，这里不需要
    need(12); const sig = buffer.toString('ascii', o, o + 4); o += 4;
    // PSD 的混合模式键固定 4 字符、不足补空格（如 "mul "），必须 trim 才匹配得上映射表。
    const blendKey = buffer.toString('ascii', o, o + 4).trim(); o += 4;
    const opacity = buffer[o]; const clipping = buffer[o + 1]; const flags = buffer[o + 2]; o += 4;
    need(4); const extraLen = buffer.readUInt32BE(o); o += 4;
    const extraStart = o;
    if (extraStart + extraLen > buffer.length) throw new PsdError('PSD_TRUNCATED', '图层附加数据被截断');
    need(4); o += 4 + buffer.readUInt32BE(o);                       // layer mask
    need(4); o += 4 + buffer.readUInt32BE(o);                       // blending ranges
    need(1); const pascalLen = buffer[o]; o += 1;
    let name = buffer.toString('latin1', o, o + pascalLen); o += pascalLen;
    o += (4 - ((1 + pascalLen) % 4)) % 4;                           // Pascal 名补齐到 4

    let unicodeName = null, textBlock = null, sectionType = null, isSolidColor = false, isPlaced = false;
    const extraEnd = extraStart + extraLen;
    while (o + 12 <= extraEnd) {
      const blockSig = buffer.toString('ascii', o, o + 4);
      if (blockSig !== '8BIM' && blockSig !== '8B64') break;
      const key = buffer.toString('ascii', o + 4, o + 8);
      const len = buffer.readUInt32BE(o + 8);
      const dataStart = o + 12;
      const dataEnd = dataStart + len;
      if (dataEnd > buffer.length) throw new PsdError('PSD_TRUNCATED', `附加块 ${key} 被截断`);
      const data = buffer.subarray(dataStart, dataEnd);
      if (key === 'luni') unicodeName = parseLuni(data) || unicodeName;
      else if (key === 'TySh') textBlock = parseTySh(data);
      else if (key === 'lsct') sectionType = data.length >= 4 ? data.readUInt32BE(0) : null;
      else if (key === 'SoCo') isSolidColor = true;
      else if (key === 'PlLd' || key === 'plLd') isPlaced = true;
      o = dataEnd + (len % 2);                                      // 附加块按偶数对齐
    }
    o = extraEnd;

    const visible = (flags & 0x02) === 0;
    void sig; void clipping; void hasAlphaChannel;
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const kind = sectionType === 1 || sectionType === 2 ? 'group'
      : textBlock ? 'text'
        : isPlaced ? 'image'
          : isSolidColor ? 'shape'
            : 'raster';
    layers.push({
      index,
      name: (unicodeName || name || '').trim() || `图层${index + 1}`,
      rect: { x: left, y: top, width, height },
      opacity: Math.round((opacity / 255) * 100),
      visible,
      blendMode: BLEND[blendKey] || 'source-over',
      kind,
      ...(textBlock ? { text: textBlock.text, fontSize: textBlock.fontSize, fontName: textBlock.fontName, textUnparsed: !!textBlock.unparsed } : {}),
    });
  }
  return { header, layers };
}

/** 诊断用：列出每个文字图层 TySh 描述符里实际存在的字段（排查"文字为空"用）。 */
export function debugTextLayers(buffer) {
  const found = [];
  const header = parsePsdHeader(buffer);
  let o = 26;
  o += 4 + buffer.readUInt32BE(o);
  o += 4 + buffer.readUInt32BE(o);
  const lmLen = buffer.readUInt32BE(o); o += 4;
  if (!lmLen) return { header, found };
  o += 4; // layer info length
  let count = Math.abs(buffer.readInt16BE(o)); o += 2;
  for (let index = 0; index < count; index += 1) {
    if (o + 16 > buffer.length) break;
    o += 16;
    const channels = buffer.readUInt16BE(o); o += 2 + channels * 6;
    o += 12; // signature + blend key + opacity/clipping/flags/filler
    const extraLen = buffer.readUInt32BE(o); o += 4;
    const extraStart = o;
    o += 4 + buffer.readUInt32BE(o);
    o += 4 + buffer.readUInt32BE(o);
    const pascalLen = buffer[o]; o += 1 + pascalLen;
    o += (4 - ((1 + pascalLen) % 4)) % 4;
    const extraEnd = extraStart + extraLen;
    while (o + 12 <= extraEnd) {
      const sig = buffer.toString('ascii', o, o + 4);
      if (sig !== '8BIM' && sig !== '8B64') break;
      const key = buffer.toString('ascii', o + 4, o + 8);
      const len = buffer.readUInt32BE(o + 8);
      const data = buffer.subarray(o + 12, o + 12 + len);
      if (key === 'TySh') {
        let p = 0;
        try {
          const version = data.readUInt16BE(p); p += 2;
          p += 48;
          const textVersion = data.readUInt16BE(p); p += 2;
          p += 4;
          const descriptor = parseDescriptor(data, p);
          found.push({
            layerIndex: index,
            version,
            textVersion,
            keys: Object.entries(descriptor.value).map(([name, field]) => `${name}:${field?.type}${typeof field?.value === 'string' ? `="${field.value.slice(0, 40)}"` : ''}`),
          });
        } catch (error) {
          found.push({
            layerIndex: index,
            version: data.readUInt16BE(0),
            declaredLength: data.length,
            descriptorAt: p,
            head: data.subarray(p, Math.min(p + 96, data.length)).toString('hex'),
            error: error.code || error.message,
          });
        }
      }
      o += 12 + len + (len % 2);
    }
    o = extraEnd;
  }
  return { header, found };
}

/**
 * 把 PSD 转成"套版模板"：画布 + 槽位。
 * 槽位只保留可见、有面积的图层；文字图层带原文与字号，图片图层就是待换图的槽。
 */
export function psdToTemplate(buffer, { name = 'psd-template' } = {}) {
  const { header, layers } = parsePsdLayers(buffer);
  const slots = layers
    .filter(layer => layer.kind !== 'group' && layer.rect.width > 0 && layer.rect.height > 0)
    .map(layer => ({
      id: `slot-${layer.index + 1}`,
      name: layer.name,
      type: layer.kind === 'text' ? 'text' : 'image',
      rect: layer.rect,
      visible: layer.visible,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      ...(layer.kind === 'text' ? { text: layer.text ?? '', fontSize: layer.fontSize ?? null, fontName: layer.fontName ?? null } : {}),
    }));
  return {
    name,
    canvas: { width: header.width, height: header.height },
    colorMode: header.colorModeName,
    slotCount: slots.length,
    slots,
    // 分层统计，便于上层判断模板质量（例如"这个模板没有文字槽"）。
    summary: {
      text: slots.filter(slot => slot.type === 'text').length,
      image: slots.filter(slot => slot.type === 'image').length,
      hidden: slots.filter(slot => !slot.visible).length,
    },
  };
}
