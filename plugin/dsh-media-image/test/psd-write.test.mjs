// PSD 写入的往返验证：写出来 → 用自家的 lib/psd.js 读回来 → 比对结构与元数据。
// 这能证明"文件格式自洽"，**不能**证明 Photoshop 一定能打开 —— 后者要人工点一次，测试里不假装。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parsePsdHeader, parsePsdLayers, psdToTemplate } from '../lib/psd.js';
import { buildPsd } from '../../../miniPaint/src/js/dsh-psd-write.js';

/** 造一层像素：纯色填充（可选 alpha），便于验证通道顺序与压缩往返。 */
function solid(width, height, [r, g, b, a = 255]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = r; pixels[index * 4 + 1] = g; pixels[index * 4 + 2] = b; pixels[index * 4 + 3] = a;
  }
  return pixels;
}

function gradient(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      pixels[index] = (x * 7) & 0xff; pixels[index + 1] = (y * 11) & 0xff; pixels[index + 2] = 0x30; pixels[index + 3] = 255;
    }
  }
  return pixels;
}

/** 与 gradient() 同一公式的单通道取值：给"解码后逐像素比对"用，避免复制整幅像素。 */
function gradientAt(width, height, x, y, channel) {
  void height;
  const base = [0, 0, 0x30, 255];
  if (channel === 0) return (x * 7) & 0xff;
  if (channel === 1) return (y * 11) & 0xff;
  return base[channel];
}

test('写出的 PSD 头部与图层结构能被自家解析器读回', () => {
  const layers = [
    { name: '背景', rect: { x: 0, y: 0, width: 64, height: 48 }, opacity: 100, blendMode: 'source-over', visible: true, pixels: solid(64, 48, [255, 255, 255]) },
    { name: '渐变层', rect: { x: 8, y: 6, width: 20, height: 10 }, opacity: 60, blendMode: 'multiply', visible: true, pixels: gradient(20, 10) },
    { name: '隐藏层', rect: { x: 0, y: 0, width: 10, height: 10 }, opacity: 40, blendMode: 'screen', visible: false, pixels: solid(10, 10, [10, 20, 30]) },
  ];
  const bytes = buildPsd({ width: 64, height: 48, layers, composite: solid(64, 48, [200, 200, 200]) });
  const buffer = Buffer.from(bytes);

  const header = parsePsdHeader(buffer);
  assert.equal(header.width, 64);
  assert.equal(header.height, 48);
  assert.equal(header.colorModeName, 'rgb');

  const { layers: parsed } = parsePsdLayers(buffer);
  assert.equal(parsed.length, 3, '图层数必须一一对应');
  // PSD 记录是"从左到右 / 从下到上"，我们写入顺序就是自下而上，读回顺序应保持一致。
  assert.deepEqual(parsed.map(layer => layer.name), ['背景', '渐变层', '隐藏层']);
  assert.deepEqual(parsed[1].rect, { x: 8, y: 6, width: 20, height: 10 });
  assert.equal(parsed[1].opacity, 60);
  assert.equal(parsed[1].blendMode, 'multiply');
  assert.equal(parsed[2].visible, false, '隐藏图层要如实写进 flags');
  assert.equal(parsed[2].opacity, 40);
  assert.equal(parsed[2].blendMode, 'screen');
});

test('非 latin1 图层名通过 luni 块正确往返', () => {
  const bytes = buildPsd({
    width: 8, height: 8,
    layers: [{ name: '主标题·细节图', rect: { x: 0, y: 0, width: 8, height: 8 }, opacity: 100, blendMode: 'source-over', visible: true, pixels: solid(8, 8, [0, 0, 0]) }],
    composite: solid(8, 8, [0, 0, 0]),
  });
  const { layers: parsed } = parsePsdLayers(Buffer.from(bytes));
  assert.equal(parsed[0].name, '主标题·细节图');
});

test('像素通道按 RLE 往返：解码后的 RGB 与写入值一致', () => {
  // 用非纯色、带横向重复的图，确保真的走到 PackBits 的重复串分支。
  const width = 32, height = 16;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const band = x < 16 ? 0x11 : 0x22;
      pixels[index] = band; pixels[index + 1] = band; pixels[index + 2] = (y * 3) & 0xff; pixels[index + 3] = 255;
    }
  }
  const bytes = buildPsd({
    width, height,
    layers: [{ name: 'repeat', rect: { x: 0, y: 0, width, height }, opacity: 100, blendMode: 'source-over', visible: true, pixels }],
    composite: pixels,
  });
  // 结构能读回（这也意味着 RLE 的行长度前缀没写错，否则偏移会全乱）。
  const { layers: parsed } = parsePsdLayers(Buffer.from(bytes));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].rect, { x: 0, y: 0, width, height });

  // 真正解码像素：从通道区把 R 平面解出来比对。
  const decoded = decodeFirstLayerChannel(bytes, { channelId: 0, width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      assert.equal(decoded[y * width + x], pixels[(y * width + x) * 4], `R 通道在 (${x},${y}) 不一致`);
    }
  }
});

test('用真实模板的图层元数据重写一份 PSD，读回后与原始一致', async t => {
  const sample = 'C:/Users/UEFR/.dsh/tools/kwiki-cli/samples/aplus01.psd';
  if (!existsSync(sample)) return t.skip('缺少样例 aplus01.psd');
  const original = readFileSync(sample);
  const parsed = parsePsdLayers(original);

  // 用原文件的元数据（名称/矩形/不透明度/混合/可见性）构图，像素用合成色占位 ——
  // 这一步验证的是"我们写出的结构能被同一个解析器按原样读回来"。
  const layers = parsed.layers
    .filter(layer => layer.kind !== 'group' && layer.rect.width > 0 && layer.rect.height > 0)
    .map(layer => ({
      name: layer.name,
      rect: layer.rect,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      visible: layer.visible,
      pixels: solid(layer.rect.width, layer.rect.height, [40, 80, 120]),
    }));
  const bytes = buildPsd({
    width: parsed.header.width, height: parsed.header.height,
    layers, composite: solid(parsed.header.width, parsed.header.height, [0, 0, 0]),
  });
  const reread = parsePsdLayers(Buffer.from(bytes));

  assert.equal(reread.header.width, parsed.header.width);
  assert.equal(reread.header.height, parsed.header.height);
  assert.equal(reread.layers.length, layers.length, '图层数必须一致');
  for (let index = 0; index < layers.length; index += 1) {
    const expected = layers[index];
    const actual = reread.layers[index];
    assert.equal(actual.name, expected.name, `第 ${index} 层名字`);
    assert.deepEqual(actual.rect, expected.rect, `第 ${index} 层矩形`);
    assert.equal(actual.opacity, expected.opacity, `第 ${index} 层不透明度`);
    assert.equal(actual.blendMode, expected.blendMode, `第 ${index} 层混合模式`);
    assert.equal(actual.visible, expected.visible, `第 ${index} 层可见性`);
  }
});

test('真实尺寸的图层不会因为拼接方式爆栈（回归：push(...bigArray) 曾让导出直接崩）', () => {
  // 800×600 的通道数据压缩后仍有几十万字节；旧实现用 spread 拼接，会抛
  // "RangeError: Maximum call stack size exceeded"，而小图测试永远发现不了。
  const width = 800, height = 600;
  const layers = [
    { name: '大幅面', rect: { x: 0, y: 0, width, height }, opacity: 100, blendMode: 'source-over', visible: true, pixels: gradient(width, height) },
    { name: '二等奖', rect: { x: 40, y: 30, width: 300, height: 200 }, opacity: 70, blendMode: 'overlay', visible: true, pixels: solid(300, 200, [12, 34, 56]) },
  ];
  const bytes = buildPsd({ width, height, layers, composite: gradient(width, height) });
  assert.ok(bytes.length > 100_000, `文件应达到真实量级，实际 ${bytes.length}`);

  const parsed = parsePsdLayers(Buffer.from(bytes));
  assert.equal(parsed.layers.length, 2);
  assert.deepEqual(parsed.layers[0].rect, { x: 0, y: 0, width, height });
  assert.deepEqual(parsed.layers[1].rect, { x: 40, y: 30, width: 300, height: 200 });
  assert.equal(parsed.layers[1].blendMode, 'overlay');
  assert.equal(parsed.layers[1].opacity, 70);

  // 抽一行像素核对通道确实写在了对的位置（不只是"能解析"）。
  const decoded = decodeFirstLayerChannel(bytes, { channelId: 1, width, height });
  const expectedG = (x, y) => gradientAt(width, height, x, y, 1);
  for (const [x, y] of [[0, 0], [123, 45], [width - 1, height - 1]]) {
    assert.equal(decoded[y * width + x], expectedG(x, y), `G 通道在 (${x},${y})`);
  }
});

test('空图层列表也能产出结构合法、可解析的文件', () => {
  const bytes = buildPsd({ width: 4, height: 4, layers: [], composite: solid(4, 4, [0, 0, 0]) });
  const buffer = Buffer.from(bytes);
  assert.equal(parsePsdHeader(buffer).width, 4);
  const result = parsePsdLayers(buffer);
  assert.deepEqual(result.layers, []);
  // 模板转换也要能吃下这种文件，不抛。
  const template = psdToTemplate(buffer);
  assert.equal(template.slotCount, 0);
});

/**
 * 最小 PSD 通道解码器（只给测试用）：定位第一层的某个通道并按 RLE/raw 解出来。
 * 刻意不复用写入器的代码路径，避免"同一个 bug 两头都错"的自证循环。
 */
function decodeFirstLayerChannel(bytes, { channelId, width, height }) {
  const buffer = Buffer.from(bytes);
  let o = 26;
  o += 4 + buffer.readUInt32BE(o);            // color mode data
  o += 4 + buffer.readUInt32BE(o);            // image resources
  const lmLen = buffer.readUInt32BE(o); o += 4;
  const lmEnd = o + lmLen;
  void lmEnd;
  const layerInfoLen = buffer.readUInt32BE(o); o += 4;
  const layerInfoStart = o;
  const count = Math.abs(buffer.readInt16BE(o)); o += 2;

  const channelTables = [];
  for (let index = 0; index < count; index += 1) {
    o += 16;
    const channelCount = buffer.readUInt16BE(o); o += 2;
    const table = [];
    for (let channel = 0; channel < channelCount; channel += 1) {
      const id = buffer.readInt16BE(o); const length = buffer.readUInt32BE(o + 2); o += 6;
      table.push({ id, length });
    }
    channelTables.push(table);
    o += 12; // signature + blend + opacity/clipping/flags/filler
    const extraLen = buffer.readUInt32BE(o); o += 4 + extraLen;
  }
  // 通道数据紧跟在所有图层记录之后，按"图层 → 该层通道表顺序"排列。
  // 要找 id=0 的通道，必须按顺序把前面的通道（alpha）精确跳过，不能直接从这里开始读。
  let cursor = o;
  for (let index = 0; index < count; index += 1) {
    for (const channel of channelTables[index]) {
      const compression = buffer.readUInt16BE(cursor);
      const wanted = index === 0 && channel.id === channelId;
      if (wanted) return decodePlaneAt(buffer, cursor, compression, width, height);
      cursor += channel.length; // 写入器记录的通道数据长度，用它精确跳过
    }
  }
  assert.fail(`图层 0 没有通道 ${channelId}`);
}

/** 从指定偏移解出一个平面（compression 0=raw / 1=RLE）。 */
function decodePlaneAt(buffer, start, compression, width, height) {
  const plane = new Uint8Array(width * height);
  if (compression === 0) {
    for (let index = 0; index < width * height; index += 1) plane[index] = buffer[start + 2 + index];
    return plane;
  }
  let cursor = start + 2 + height * 2; // 跳过 compression 与每行长度表
  for (let y = 0; y < height; y += 1) {
    const rowLength = buffer.readUInt16BE(start + 2 + y * 2);
    let consumed = 0;
    let x = 0;
    while (consumed < rowLength) {
      const header = buffer[cursor]; consumed += 1; cursor += 1;
      if (header < 128) {
        const run = header + 1;
        for (let index = 0; index < run; index += 1) { plane[y * width + x] = buffer[cursor]; consumed += 1; cursor += 1; x += 1; }
      } else if (header > 128) {
        const run = 257 - header;
        const value = buffer[cursor]; consumed += 1; cursor += 1;
        for (let index = 0; index < run; index += 1) { plane[y * width + x] = value; x += 1; }
      }
      // header === 128 是空操作
    }
  }
  return plane;
}
