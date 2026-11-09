// PSD 像素合成（零依赖）：把"非文字、非商品槽"的可见图层合成一张整幅 PNG 当底图。
//
// 为什么需要它：重建式套版会丢掉 PSD 的渐变、描边、投影。把这些图层按位置合成到底图里，
// 装饰就真的回到画布上，而文字层与商品槽层留空（由 layer.add_text / layer.add_image 填）。
//
// 支持范围（超出就明确报错，绝不猜测）：RGB 8bit、raw(0) 与 RLE(1) 压缩。
// ZIP(2/3)、CMYK/灰度/索引色、16/32bit 一律返回带 code 的 PsdError。

import { deflateSync } from 'node:zlib';
import { parsePsdHeader, PsdError } from './psd.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * 混合函数（PSD blend key → 通道混合）。只实现可逐像素核对的那几个；
 * 未实现的模式**不猜**：退回 source-over 并记进 approximated，让调用方如实告知。
 * 公式按 W3C/PDF 的分离通道定义，输入输出都是 0..1。
 */
// W3C soft-light 的 D(b)：小于 0.25 走三次多项式，否则取平方根。
const softLightD = b => (b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b));

const BLEND_FUNCS = {
  norm: (b, s) => s,
  mul: (b, s) => b * s,
  scrn: (b, s) => b + s - b * s,
  over: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  dark: (b, s) => Math.min(b, s),
  lite: (b, s) => Math.max(b, s),
  diff: (b, s) => Math.abs(b - s),
  smud: (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (softLightD(b) - b)),
  hLit: (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
};

export const SUPPORTED_BLEND_KEYS = Object.keys(BLEND_FUNCS);
export function encodePngRgba(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PackBits RLE 解一行/一段：返回写入 dst 的字节数。 */
function unpackBits(src, start, end, dst, dstStart, expected) {
  let p = start, d = dstStart;
  while (p < end && d < dstStart + expected) {
    const n = src.readInt8(p); p += 1;
    if (n >= 0) {
      const count = n + 1;
      if (p + count > end) throw new PsdError('PSD_RLE_TRUNCATED', 'RLE 字面量数据被截断');
      src.copy(dst, d, p, p + count); d += count; p += count;
    } else if (n !== -128) {
      const count = 1 - n;
      if (p >= end) throw new PsdError('PSD_RLE_TRUNCATED', 'RLE 重复段缺少字节');
      const value = src[p]; p += 1;
      dst.fill(value, d, Math.min(d + count, dstStart + expected)); d += count;
    }
  }
  if (d < dstStart + expected) throw new PsdError('PSD_RLE_TRUNCATED', 'RLE 解出的像素不足');
  return d;
}

/** 解一个通道（width×height 单字节）。 */
function decodeChannel(buf, offset, length, width, height) {
  const end = Math.min(offset + length, buf.length);
  if (offset + 2 > end) throw new PsdError('PSD_TRUNCATED', '通道数据被截断');
  const compression = buf.readUInt16BE(offset);
  const out = Buffer.alloc(width * height);
  if (compression === 0) {
    const start = offset + 2;
    if (start + out.length > end) throw new PsdError('PSD_TRUNCATED', 'raw 通道数据不足');
    buf.copy(out, 0, start, start + out.length);
    return out;
  }
  if (compression === 1) {
    let p = offset + 2;
    if (p + height * 2 > end) throw new PsdError('PSD_TRUNCATED', 'RLE 行长度表被截断');
    const rows = [];
    for (let y = 0; y < height; y += 1) { rows.push(buf.readUInt16BE(p)); p += 2; }
    for (let y = 0; y < height; y += 1) {
      const start = p;
      const stop = Math.min(p + rows[y], end);
      unpackBits(buf, start, stop, out, y * width, width);
      p = stop;
    }
    return out;
  }
  throw new PsdError('PSD_COMPRESSION_UNSUPPORTED', `不支持的 PSD 通道压缩：${compression}（仅支持 raw/RLE）`);
}

/**
 * 逐层合成。layerIndices 与 parsePsdLayers 的 index 一致（0 起）。
 * @param excludeLayerIndices 不参与合成的图层（商品槽、文字层），下标同 parsePsdLayers
 */
export function compositePsdLayers(buffer, { excludeLayerIndices = [] } = {}) {
  const header = parsePsdHeader(buffer);
  if (header.colorMode !== 3) throw new PsdError('PSD_COLORMODE_UNSUPPORTED', '只支持 RGB 色彩模式的 PSD 合成');
  if (header.depth !== 8) throw new PsdError('PSD_DEPTH_UNSUPPORTED', '只支持 8bit 深度的 PSD 合成');
  const width = header.width, height = header.height;
  const excluded = new Set(excludeLayerIndices.map(Number));

  let o = 26;
  o += 4 + buffer.readUInt32BE(o);      // color mode data
  o += 4 + buffer.readUInt32BE(o);      // image resources
  const lmLen = buffer.readUInt32BE(o); o += 4;
  if (!lmLen) return { png: encodePngRgba(Buffer.alloc(width * height * 4), width, height), width, height, composited: 0, skipped: [], approximated: [] };
  o += 4;                                // layer info length
  let count = buffer.readInt16BE(o); o += 2;
  count = Math.abs(count);
  if (count > 5000) throw new PsdError('PSD_TOO_MANY_LAYERS', '图层数量异常');

  const records = [];
  for (let index = 0; index < count; index += 1) {
    if (o + 16 > buffer.length) break;
    const top = buffer.readInt32BE(o), left = buffer.readInt32BE(o + 4);
    const bottom = buffer.readInt32BE(o + 8), right = buffer.readInt32BE(o + 12);
    o += 16;
    const channelCount = buffer.readUInt16BE(o); o += 2;
    const channels = [];
    for (let c = 0; c < channelCount; c += 1) {
      const id = buffer.readInt16BE(o);
      const length = buffer.readUInt32BE(o + 2);
      channels.push({ id, length });
      o += 6;
    }
    // signature(4) + blend key(4) + opacity(1) + clipping(1) + flags(1) + filler(1)
    const blendKey = buffer.toString('ascii', o + 4, o + 8).trim();
    const layerOpacity = buffer.readUInt8(o + 8);
    o += 12;
    const extraLen = buffer.readUInt32BE(o); o += 4;
    o += extraLen;
    records.push({ index, left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top), channels, blendKey, layerOpacity });
  }

  // 通道数据紧跟在全部图层记录之后，按图层顺序、每层按通道顺序排列。
  const canvas = Buffer.alloc(width * height * 4);
  const skipped = [];
  const approximated = [];
  let composited = 0;
  for (const record of records) {
    const channelData = [];
    for (const channel of record.channels) {
      channelData.push({ id: channel.id, bytes: channel.length, offset: o });
      o += channel.length;
    }
    if (excluded.has(record.index) || record.width < 1 || record.height < 1) { skipped.push(record.index); continue; }
    const byId = new Map(channelData.map(item => [item.id, item]));
    const need = [0, 1, 2].map(id => byId.get(id));
    if (need.some(item => !item)) { skipped.push(record.index); continue; }  // 非 RGB 通道（如形状矢量层）
    try {
      const planes = need.map(item => decodeChannel(buffer, item.offset, item.bytes, record.width, record.height));
      const alphaInfo = byId.get(-1);
      const alpha = alphaInfo ? decodeChannel(buffer, alphaInfo.offset, alphaInfo.bytes, record.width, record.height) : null;
      // 图层蒙版（通道 -2）：按蒙版灰度乘进 alpha，这是 PSD 的标准语义。
      const maskInfo = byId.get(-2);
      const layerMask = maskInfo ? decodeChannel(buffer, maskInfo.offset, maskInfo.bytes, record.width, record.height) : null;
      const blend = BLEND_FUNCS[record.blendKey] || BLEND_FUNCS.norm;
      if (!BLEND_FUNCS[record.blendKey]) approximated.push({ layerIndex: record.index, reason: `BLEND_MODE_${String(record.blendKey).trim()}_AS_SOURCE_OVER` });
      const opacity = Math.max(0, Math.min(255, record.layerOpacity === undefined ? 255 : record.layerOpacity));
      for (let y = 0; y < record.height; y += 1) {
        const cy = record.top + y;
        if (cy < 0 || cy >= height) continue;
        for (let x = 0; x < record.width; x += 1) {
          const cx = record.left + x;
          if (cx < 0 || cx >= width) continue;
          const src = y * record.width + x;
          let a = alpha ? alpha[src] : 255;
          if (layerMask) a = Math.round(a * (layerMask[src] / 255));
          a = Math.round(a * (opacity / 255));
          if (a === 0) continue;
          const dst = (cy * width + cx) * 4;
          const sa = a / 255, da = canvas[dst + 3] / 255;
          const outA = sa + da * (1 - sa);
          if (outA === 0) continue;
          for (let c = 0; c < 3; c += 1) {
            const back = canvas[dst + c] / 255;
            const srcUnit = planes[c][src] / 255;
            // 分离通道混合公式：结果 = (1-da)·s + da·B(d, s)，再按 alpha 归一化。
            const mixed = (1 - da) * srcUnit + da * blend(back, srcUnit);
            canvas[dst + c] = Math.round(Math.max(0, Math.min(1, (mixed * sa + back * da * (1 - sa)) / outA)) * 255);
          }
          canvas[dst + 3] = Math.round(outA * 255);
        }
      }
      composited += 1;
    } catch (error) {
      // 单层解不出来不该毁掉整张底图：记录并跳过，让调用方如实告知。
      if (error?.code === 'PSD_COMPRESSION_UNSUPPORTED' || error?.code === 'PSD_RLE_TRUNCATED' || error?.code === 'PSD_TRUNCATED') {
        skipped.push(record.index);
        approximated.push({ layerIndex: record.index, reason: error.code });
        continue;
      }
      throw error;
    }
  }
  return { png: encodePngRgba(canvas, width, height), width, height, composited, skipped, approximated };
}
