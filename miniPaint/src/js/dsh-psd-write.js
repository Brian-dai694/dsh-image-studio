// PSD 写入器：把"已经合成好的图层"写成一份分层的 .psd。
//
// 为什么在编辑器侧而不是宿主侧：宿主的 relay 有 64 KiB 消息 / 256 KiB 响应上限，
// 整层像素根本过不去；而编辑器手里就有全部画布。这个模块刻意**不依赖任何浏览器 API**
// （只吃 RGBA 数组），所以 Node 里能直接 import 它、再用 lib/psd.js 读回来做往返验证。
//
// 明确边界：只写我们自己合成出来的东西。文字层会被栅格化，活蒙版会被烤进像素，
// 不写智能对象 / 图层样式 / 调整层 —— 这些往返到 Photoshop 会变样，不如不做。

const SIGNATURE = [0x38, 0x42, 0x50, 0x53]; // '8BPS'

/** PSD 混合模式键固定 4 字符，不足补空格。 */
const BLEND_KEYS = {
  'source-over': 'norm',
  multiply: 'mul ',
  screen: 'scrn',
  overlay: 'over',
  darken: 'dark',
  lighten: 'lite',
  difference: 'diff',
  'soft-light': 'smud',
  'hard-light': 'hLit',
  'color-dodge': 'div ',
  'color-burn': 'idiv',
  hue: 'hue ',
  saturation: 'sat ',
  color: 'colr',
  luminosity: 'lum ',
};

/** PackBits 编一行，返回 Uint8Array。 */
function packBitsRow(row) {
  const out = [];
  let index = 0;
  while (index < row.length) {
    // 先看有没有 >=3 的重复串
    let repeat = 1;
    while (index + repeat < row.length && row[index + repeat] === row[index] && repeat < 128) repeat += 1;
    if (repeat >= 3) {
      out.push(256 - (repeat - 1), row[index]);
      index += repeat;
      continue;
    }
    // 否则攒一段字面量（直到遇到 >=3 的重复串）
    let literal = 1;
    while (index + literal < row.length && literal < 128) {
      let nextRepeat = 1;
      while (index + literal + nextRepeat < row.length && row[index + literal + nextRepeat] === row[index + literal] && nextRepeat < 128) nextRepeat += 1;
      if (nextRepeat >= 3) break;
      literal += 1;
    }
    out.push(literal - 1);
    for (let offset = 0; offset < literal; offset += 1) out.push(row[index + offset]);
    index += literal;
  }
  return Uint8Array.from(out);
}

/**
 * RLE 编一个平面（channel），结果拼成一个 Uint8Array。
 * PSD 要求每行的字节数用 **uint16** 前缀；某行压完超过 32767 就只能整通道退回不压缩。
 *
 * 注意：这里刻意**不用 spread 拼接**（`push(...bigArray)`）。
 * 真实尺寸下通道数据动辄几十万字节，会把调用栈撑爆——小图测试永远发现不了。
 * @returns {{compressed:boolean, data:Uint8Array, rowLengths:number[]}}
 */
function encodePlane(plane, width, height) {
  const rowBuffers = [];
  const rowLengths = [];
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    const row = plane.subarray(y * width, y * width + width);
    const packed = packBitsRow(row);
    if (!packed || packed.length > 32767) return { compressed: false, data: Uint8Array.from(plane), rowLengths: [] };
    rowBuffers.push(packed);
    rowLengths.push(packed.length);
    total += packed.length;
  }
  const data = new Uint8Array(total);
  let cursor = 0;
  for (const buffer of rowBuffers) { data.set(buffer, cursor); cursor += buffer.length; }
  return { compressed: true, data, rowLengths };
}

const u8 = value => new Uint8Array([value & 0xff]);
const u16 = value => new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
const i16 = value => u16(value < 0 ? value + 0x10000 : value);
const u32 = value => new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const i32 = value => u32(value < 0 ? value + 0x100000000 : value);
const ascii = text => Uint8Array.from([...String(text)].map(char => char.charCodeAt(0) & 0xff));

/** 按顺序把若干块拼成一个 Uint8Array（不用 spread，避免大数据爆栈）。 */
function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.length; }
  return out;
}

/** Pascal 字符串 + 补到 4 字节边界（连同长度字节一起算）。 */
function pascalName(name, maxLength = 255) {
  const bytes = [];
  const text = String(name ?? '').slice(0, maxLength);
  // 名字按 latin1 逐字节写；非 latin1 字符由下面的 luni 块兜底。
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes.push(code <= 0xff ? code : 0x3f);
  }
  const out = [bytes.length, ...bytes];
  while (out.length % 4 !== 0) out.push(0);
  return Uint8Array.from(out);
}

/** luni：UTF-16BE 的图层名，让中文名在 Photoshop 里也正确。 */
function luniBlock(name) {
  const body = [];
  const text = String(name ?? '');
  const lengthBytes = u32(text.length);
  body.push(...lengthBytes);
  for (let index = 0; index < text.length; index += 1) {
    body.push((text.charCodeAt(index) >>> 8) & 0xff, text.charCodeAt(index) & 0xff);
  }
  while (body.length % 4 !== 0) body.push(0);
  return concatBytes([ascii('8BIM'), ascii('luni'), u32(body.length), Uint8Array.from(body)]);
}

/**
 * @param {object} document
 * @param {number} document.width
 * @param {number} document.height
 * @param {Array<{name:string, rect:{x:number,y:number,width:number,height:number}, opacity:number, blendMode:string, visible:boolean, pixels:Uint8ClampedArray}>} document.layers
 *   顺序必须**从下到上**（PSD 的图层记录就是这个顺序）。pixels 是该 rect 内的 RGBA。
 * @param {Uint8ClampedArray} document.composite 整幅合成图的 RGBA
 * @returns {Uint8Array}
 */
export function buildPsd({ width, height, layers = [], composite = null }) {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const usable = layers.filter(layer => layer && layer.rect && layer.rect.width > 0 && layer.rect.height > 0 && layer.pixels);

  // ── 逐层：通道记录 + 通道数据 ───────────────────────────────────
  const channelDataChunks = [];
  const records = [];
  for (const layer of usable) {
    const { x, y, width: lw, height: lh } = layer.rect;
    const planeSize = lw * lh;
    const pixels = layer.pixels;
    // 通道顺序：alpha(-1) 先，然后 R/G/B —— 与常见的 Photoshop 导出一致。
    const planeOf = offset => {
      const plane = new Uint8Array(planeSize);
      for (let index = 0; index < planeSize; index += 1) plane[index] = pixels[index * 4 + offset];
      return plane;
    };
    const channels = [
      { id: -1, plane: planeOf(3) },
      { id: 0, plane: planeOf(0) },
      { id: 1, plane: planeOf(1) },
      { id: 2, plane: planeOf(2) },
    ];
    const encoded = channels.map(channel => ({ id: channel.id, ...encodePlane(channel.plane, lw, lh) }));
    // 通道数据长度 = 2(compression) + (RLE: 每行 2 字节长度前缀 + 数据) 或 原始长度
    const lengths = encoded.map(item => 2 + (item.compressed ? item.rowLengths.length * 2 + item.data.length : item.data.length));
    const channelInfo = [];
    encoded.forEach((item, index) => { channelInfo.push(...i16(item.id), ...u32(lengths[index])); });

    const extra = [];
    extra.push(...u32(0)); // layer mask data 长度 0
    extra.push(...u32(0)); // blending ranges 长度 0
    extra.push(...pascalName(layer.name));
    extra.push(...luniBlock(layer.name));

    const record = [];
    record.push(...i32(y), ...i32(x), ...i32(y + lh), ...i32(x + lw));
    record.push(...u16(encoded.length));
    record.push(...channelInfo);
    record.push(...ascii('8BIM'));
    const key = BLEND_KEYS[layer.blendMode] || 'norm';
    record.push(...ascii(key.padEnd(4, ' ')));
    record.push(Math.max(0, Math.min(255, Math.round(((layer.opacity ?? 100) / 100) * 255))));
    record.push(0); // clipping
    record.push(layer.visible === false ? 2 : 0); // flags：bit1 = 隐藏
    record.push(0); // filler
    record.push(...u32(extra.length));
    record.push(...extra);
    records.push(record);

    encoded.forEach(item => {
      const chunk = [...u16(item.compressed ? 1 : 0)];
      if (item.compressed) {
        for (const rowLength of item.rowLengths) chunk.push(...u16(rowLength));
      }
      channelDataChunks.push(concatBytes([Uint8Array.from(chunk), item.data]));
    });
  }

  const layerInfo = [];
  layerInfo.push(...i16(usable.length));
  for (const record of records) layerInfo.push(...record);
  const layerInfoBytes = concatBytes([Uint8Array.from(layerInfo), ...channelDataChunks, u32(0)]);
  const layerAndMask = concatBytes([u32(layerInfoBytes.length), layerInfoBytes]);

  // ── 合成图（整幅，RLE）─────────────────────────────────────────
  const source = composite || new Uint8ClampedArray(W * H * 4);
  const compositePlanes = [];
  for (const offset of [0, 1, 2, 3]) {
    const plane = new Uint8Array(W * H);
    for (let index = 0; index < W * H; index += 1) plane[index] = source[index * 4 + offset];
    compositePlanes.push(encodePlane(plane, W, H));
  }
  const imageChunks = [];
  if (compositePlanes.every(item => item.compressed)) {
    imageChunks.push(u16(1));
    const lengths = [];
    for (const plane of compositePlanes) for (const rowLength of plane.rowLengths) lengths.push(...u16(rowLength));
    imageChunks.push(Uint8Array.from(lengths));
    for (const plane of compositePlanes) imageChunks.push(plane.data);
  } else {
    // 有任何一条通道压不动就整体不压缩，保持格式合法（不混用）。
    imageChunks.push(u16(0));
    for (const plane of compositePlanes) imageChunks.push(plane.data);
  }
  const imageData = concatBytes(imageChunks);

  const header = concatBytes([
    Uint8Array.from(SIGNATURE),
    u16(1), // version
    new Uint8Array(6), // reserved
    u16(4), // channels (RGBA)
    u32(H), u32(W),
    u16(8), // depth
    u16(3), // color mode: RGB
  ]);

  return concatBytes([header, u32(0), u32(0), u32(layerAndMask.length), layerAndMask, imageData]);
}

export default buildPsd;
