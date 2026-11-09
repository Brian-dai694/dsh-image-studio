// PSD 图层效果：描述符解析 + 描边/投影真的画出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readDescriptor, readLayerEffects, shadowOffset } from '../lib/psd-effects.js';
import { compositePsdLayers } from '../lib/psd-composite.js';

// ---- 迷你描述符写入器（只覆盖测试需要的类型） ----
const ustr = text => {
  const chars = text.length + 1;
  const buffer = Buffer.alloc(4 + chars * 2);
  buffer.writeUInt32BE(chars, 0);
  for (let i = 0; i < text.length; i += 1) buffer.writeUInt16BE(text.charCodeAt(i), 4 + i * 2);
  buffer.writeUInt16BE(0, 4 + text.length * 2);
  return buffer;
};
const bool = value => Buffer.from([value ? 1 : 0]);
const doub = value => { const b = Buffer.alloc(8); b.writeDoubleBE(value, 0); return b; };
const untf = (unit, value) => Buffer.concat([Buffer.from(unit, 'ascii'), doub(value)]);
const objc = items => Buffer.concat([
  ustr(''), ustr('null'),
  (() => { const b = Buffer.alloc(4); b.writeUInt32BE(items.length, 0); return b; })(),
  ...items.flatMap(([key, type, value]) => [ustr(key), Buffer.from(type, 'ascii'), value]),
]);
const rgbc = (r, g, b) => objc([['Rd  ', 'doub', doub(r)], ['Grn ', 'doub', doub(g)], ['Bl  ', 'doub', doub(b)]]);

function effectsDescriptor({ stroke = null, shadow = null }) {
  const items = [];
  if (stroke) {
    items.push(['FrFX', 'Objc', objc([
      ['enab', 'bool', bool(stroke.enabled !== false)],
      ['Styl', 'enum', Buffer.concat([ustr('BESl'), ustr(stroke.style || 'OutF')])],
      ['Clr ', 'Objc', rgbc(stroke.r, stroke.g, stroke.b)],
      ['Sz  ', 'UntF', untf('#Pxl', stroke.size)],
      ['Opct', 'UntF', untf('#Prc', stroke.opacity)],
    ])]);
  }
  if (shadow) {
    items.push(['DrSh', 'Objc', objc([
      ['enab', 'bool', bool(shadow.enabled !== false)],
      ['Clr ', 'Objc', rgbc(shadow.r, shadow.g, shadow.b)],
      ['Opct', 'UntF', untf('#Prc', shadow.opacity)],
      ['lagl', 'UntF', untf('#Ang', shadow.angle)],
      ['Dstn', 'UntF', untf('#Pxl', shadow.distance)],
      ['Ckmt', 'UntF', untf('#Pxl', shadow.blur)],
    ])]);
  }
  return objc(items);
}

// ---- PSD 写入器（带 lmfx 块） ----
function buildPsd({ width = 8, height = 8, layers }) {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'ascii');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12);
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24);

  const records = [];
  const channelData = [];
  layers.forEach((layer, index) => {
    const { x, y, w, h, rgb, alpha = 255, name, effects = null } = layer;
    const head = Buffer.alloc(16);
    head.writeInt32BE(y, 0); head.writeInt32BE(x, 4); head.writeInt32BE(y + h, 8); head.writeInt32BE(x + w, 12);
    const ids = [0, 1, 2, -1];
    const chanHead = Buffer.alloc(2 + ids.length * 6);
    chanHead.writeUInt16BE(ids.length, 0);
    ids.forEach((chanId, i) => {
      chanHead.writeInt16BE(chanId, 2 + i * 6);
      chanHead.writeUInt32BE(2 + w * h, 2 + i * 6 + 2);
    });
    const label = name || `layer${index}`;
    const pascal = Buffer.from([label.length, ...Buffer.from(label, 'latin1')]);
    const pascalPadded = Buffer.concat([pascal, Buffer.alloc((4 - (pascal.length % 4)) % 4)]);
    const blocks = [];
    if (effects) {
      const body = effectsDescriptor(effects);
      const blockHead = Buffer.alloc(12);
      blockHead.write('8BIM', 0, 'ascii');
      blockHead.write('lmfx', 4, 'ascii');
      blockHead.writeUInt32BE(body.length, 8);
      const pad = Buffer.alloc((4 - (body.length % 4)) % 4);
      blocks.push(blockHead, body, pad);
    }
    const extraBody = Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), pascalPadded, ...blocks]);
    const extraHead = Buffer.alloc(4);
    extraHead.writeUInt32BE(extraBody.length, 0);
    records.push(Buffer.concat([head, chanHead, Buffer.from('8BIMnorm', 'ascii'), Buffer.from([255, 0, 0, 0]), extraHead, extraBody]));
    for (const chanId of ids) {
      const value = chanId === -1 ? alpha : rgb[chanId];
      const pixels = Buffer.alloc(w * h, value);
      const compression = Buffer.alloc(2);
      compression.writeUInt16BE(0, 0);
      channelData.push(Buffer.concat([compression, pixels]));
    }
  });

  const layerInfoBody = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeInt16BE(layers.length, 0); return b; })(),
    ...records, ...channelData,
  ]);
  const layerInfoHead = Buffer.alloc(4);
  layerInfoHead.writeUInt32BE(layerInfoBody.length, 0);
  const globalMask = Buffer.alloc(4);
  const lmBody = Buffer.concat([layerInfoHead, layerInfoBody, globalMask]);
  const lmHead = Buffer.alloc(4);
  lmHead.writeUInt32BE(lmBody.length, 0);
  return Buffer.concat([header, Buffer.alloc(4), Buffer.alloc(4), lmHead, lmBody]);
}

function decodePng(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const idatStart = png.indexOf(Buffer.from('IDAT', 'ascii'));
  const idatLength = png.readUInt32BE(idatStart - 4);
  const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLength));
  const stride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  return { width, height, rgba };
}
const px = (image, x, y) => image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4);

const LM = { stroke: null, shadow: null };

test('描述符解析：描边与投影的关键字段都读得出来', () => {
  const descriptor = effectsDescriptor({
    stroke: { r: 1, g: 0, b: 0, size: 3, opacity: 100, style: 'OutF' },
    shadow: { r: 0, g: 0, b: 0, opacity: 75, angle: 120, distance: 5, blur: 4 },
  });
  const effects = readLayerEffects(readDescriptor(descriptor, 0).value);
  assert.equal(effects.stroke.color.r, 255);
  assert.equal(effects.stroke.color.g, 0);
  assert.equal(effects.stroke.size, 3);
  assert.equal(effects.stroke.opacity, 1);
  assert.equal(effects.stroke.style, 'OutF');
  assert.equal(effects.shadow.opacity, 0.75);
  assert.equal(effects.shadow.angle, 120);
  assert.equal(effects.shadow.distance, 5);
  assert.equal(effects.shadow.blur, 4);
});

test('关闭的效果不返回（enab=false）', () => {
  const effects = readLayerEffects(readDescriptor(effectsDescriptor({
    stroke: { r: 0, g: 0, b: 1, size: 2, opacity: 100, enabled: false },
  }), 0).value);
  assert.equal(effects.stroke, undefined);
});

test('阴影偏移按 PS 的"光照角度"折算，落在反方向', () => {
  assert.deepEqual(shadowOffset(120, 0), { dx: 0, dy: 0 });
  const { dx, dy } = shadowOffset(120, 5);
  assert.ok(dx >= 0 && dy >= 0, `120° 的阴影应落在右下方，实际 ${dx},${dy}`);
  assert.equal(shadowOffset(0, 5).dx, -5, '0° 光照 → 阴影朝左');
});

test('描边：图层外缘真的被画出来', () => {
  const result = compositePsdLayers(buildPsd({
    width: 8, height: 8,
    layers: [{ x: 3, y: 3, w: 2, h: 2, rgb: [255, 255, 255],
      effects: { stroke: { r: 1, g: 0, b: 0, size: 1, opacity: 100, style: 'OutF' } } }],
  }));
  const image = decodePng(result.png);
  const ring = px(image, 2, 3);
  assert.ok(ring[3] > 0, '外描边应让相邻像素出现不透明内容');
  assert.ok(ring[0] > 200 && ring[1] < 60, `描边应为红色，实际 rgb(${ring[0]},${ring[1]},${ring[2]})`);
  const inside = px(image, 3, 3);
  assert.equal(inside[0], 255, '图层本体保持白色');
  assert.ok(result.approximated.some(item => /STROKE/.test(item.reason)), JSON.stringify(result.approximated));
});

test('投影：落在层下方，且不影响层本体', () => {
  const result = compositePsdLayers(buildPsd({
    width: 12, height: 12,
    layers: [{ x: 3, y: 3, w: 3, h: 3, rgb: [255, 255, 255],
      effects: { shadow: { r: 0, g: 0, b: 0, opacity: 100, angle: 120, distance: 2, blur: 0 } } }],
  }));
  const image = decodePng(result.png);
  const { dx, dy } = shadowOffset(120, 2);
  // 层本体占 (3..5)，阴影整体偏移后只在不与本体重叠处可见。
  const shadow = px(image, 3 + dx + 2, 3 + dy + 2);
  assert.ok(shadow[3] > 0, '偏移方向应出现阴影像素');
  assert.ok(shadow[0] < 80, `阴影应为黑色，实际 rgb(${shadow[0]},${shadow[1]},${shadow[2]})`);
  const body = px(image, 3, 3);
  assert.equal(body[0], 255, '层本体不受阴影影响');
  assert.ok(result.approximated.some(item => /SHADOW/.test(item.reason)), JSON.stringify(result.approximated));
});

test('坏描述符不会毁掉整张底图：登记为未解析，图层照常合成', () => {
  const psd = buildPsd({
    width: 6, height: 6,
    layers: [{ x: 1, y: 1, w: 2, h: 2, rgb: [10, 20, 30], effects: { stroke: { r: 0, g: 0, b: 0, size: 1, opacity: 100 } } }],
  });
  // 把描述符里第一个条目的类型字段改成不认识的类型：位置 = lmfx 块头(12) + 名字(6) + class(14) + count(4) + key(14)
  const index = psd.indexOf(Buffer.from('lmfx', 'ascii')) + 12 + 6 + 14 + 4 + 14;
  psd.write('zzzz', index, 'ascii');
  const result = compositePsdLayers(psd);
  const image = decodePng(result.png);
  assert.ok(px(image, 1, 1)[3] > 0, '图层本体仍应合成出来');
  assert.ok(result.approximated.some(item => /UNPARSED/.test(item.reason)), JSON.stringify(result.approximated));
  assert.equal(LM.stroke, null);
});
