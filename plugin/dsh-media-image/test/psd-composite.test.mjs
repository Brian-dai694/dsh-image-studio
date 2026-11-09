// PSD 逐层合成：自造最小 PSD 验证像素与排除逻辑，真实样例验证集成。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { compositePsdLayers, encodePngRgba } from '../lib/psd-composite.js';
import { psdToTemplate } from '../lib/psd.js';

const APLUS = 'C:/Users/UEFR/.dsh/tools/kwiki-cli/samples/aplus01.psd';

/** 构造最小 PSD：2 层，各 4×4 纯色，raw 通道。 */
function buildPsd({ width = 8, height = 8, layers }) {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'ascii');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12);   // channels
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22);   // depth
  header.writeUInt16BE(3, 24);   // RGB

  const records = [];
  const channelData = [];
  layers.forEach((layer, index) => {
    const { x, y, w, h, rgb, alpha = 255, name } = layer;
    const head = Buffer.alloc(16);
    head.writeInt32BE(y, 0); head.writeInt32BE(x, 4); head.writeInt32BE(y + h, 8); head.writeInt32BE(x + w, 12);
    const ids = [0, 1, 2, -1];
    const chanHead = Buffer.alloc(2 + ids.length * 6);
    chanHead.writeUInt16BE(ids.length, 0);
    ids.forEach((chanId, i) => {
      chanHead.writeInt16BE(chanId, 2 + i * 6);
      chanHead.writeUInt32BE(2 + w * h, 2 + i * 6 + 2);
    });
    const pascal = Buffer.from([(name || `layer${index}`).length, ...Buffer.from(name || `layer${index}`, 'latin1')]);
    const pascalPadded = Buffer.concat([pascal, Buffer.alloc((4 - (pascal.length % 4)) % 4)]);
    const extraBody = Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), pascalPadded]);
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
    ...records,
    ...channelData,
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
  // 只解我们自己的输出：filter=0、RGBA、单 IDAT。
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const idatStart = png.indexOf(Buffer.from('IDAT', 'ascii'));
  const length = png.readUInt32BE(idatStart - 4);
  const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + length));
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  return { width, height, rgba };
}

const px = (image, x, y) => image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4);

test('encodePngRgba 产出可解回的 RGBA（尺寸与像素一致）', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128]);
  const png = encodePngRgba(rgba, 2, 1);
  const back = decodePng(png);
  assert.equal(back.width, 2);
  assert.deepEqual([...px(back, 0, 0)], [255, 0, 0, 255]);
  assert.deepEqual([...px(back, 1, 0)], [0, 255, 0, 128]);
});

test('逐层合成：上层覆盖下层，排除的图层不出现', () => {
  const psd = buildPsd({
    width: 8, height: 8,
    layers: [
      { x: 0, y: 0, w: 8, h: 8, rgb: [0, 0, 255], name: 'bottom-blue' },
      { x: 2, y: 2, w: 4, h: 4, rgb: [255, 0, 0], name: 'top-red' },
    ],
  });
  const all = decodePng(compositePsdLayers(psd).png);
  assert.deepEqual([...px(all, 1, 1)], [0, 0, 255, 255], '未被覆盖处保留底层蓝色');
  assert.deepEqual([...px(all, 3, 3)], [255, 0, 0, 255], '上层红色覆盖中间');

  const excluded = decodePng(compositePsdLayers(psd, { excludeLayerIndices: [1] }).png);
  assert.deepEqual([...px(excluded, 3, 3)], [0, 0, 255, 255], '排除上层后应露出底层');
});

test('半透明图层按 alpha 合理混合，不会直接覆盖', () => {
  const psd = buildPsd({
    width: 4, height: 4,
    layers: [
      { x: 0, y: 0, w: 4, h: 4, rgb: [0, 0, 0], name: 'black' },
      { x: 0, y: 0, w: 4, h: 4, rgb: [255, 255, 255], alpha: 128, name: 'half-white' },
    ],
  });
  const image = decodePng(compositePsdLayers(psd).png);
  const [r, g, b] = px(image, 1, 1);
  assert.ok(r > 100 && r < 160, `半透明白叠黑应得到中灰，实际 ${r}`);
  assert.equal(r, g);
  assert.equal(g, b);
});

test('真实 A+ 模板：合成出整幅 PNG，排除文字层后仍保留装饰像素', t => {
  if (!existsSync(APLUS)) return t.skip('缺少样例 aplus01.psd');
  const buffer = readFileSync(APLUS);
  const template = psdToTemplate(buffer, { name: 'aplus01.psd' });
  const textIndices = template.slots.filter(slot => slot.type === 'text').map(slot => Number(String(slot.id).replace('slot-', '')) - 1);
  const out = compositePsdLayers(buffer, { excludeLayerIndices: textIndices });
  assert.equal(out.width, 970);
  assert.equal(out.height, 600);
  assert.ok(out.composited >= 5, `应合成出多个图层，实际 ${out.composited}`);
  const image = decodePng(out.png);
  let ink = 0;
  for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] > 8) ink += 1;
  assert.ok(ink > 970 * 600 * 0.2, `装饰像素应占相当面积，实际 ${ink}`);
});

test('/template/apply：一次上传即合成底图并规划，底图占满画布且装饰不再计入丢失', async t => {
  if (!existsSync(APLUS)) return t.skip('缺少样例 aplus01.psd');
  const { createAssetStore } = await import('../lib/assets.js');
  const { createMediaRouter } = await import('../lib/http.js');
  const assets = createAssetStore();
  const token = 'apply-token';
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets });
  const bytes = readFileSync(APLUS);
  const out = { status: 0, body: '' };
  const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
  const req = {
    method: 'POST', url: '/media-image/template/apply',
    headers: {
      host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}`,
      'x-dsh-media-relay': '1', 'x-dsh-media-asset': '1', 'content-type': 'application/octet-stream',
      'x-psd-name': encodeURIComponent('aplus01.psd'),
      'x-psd-product-asset': `asset:${'a'.repeat(48)}`,
      'x-psd-background': '%23f4f5f7',
    },
    async *[Symbol.asyncIterator]() { yield bytes; },
  };
  await router(req, res);
  assert.equal(out.status, 200, out.body.slice(0, 300));
  const value = JSON.parse(out.body);
  assert.ok(value.base?.assetRef, '应返回底图素材引用');
  assert.match(value.base.assetRef, /^asset:[a-f0-9]{48}$/);
  assert.equal(value.base.width, 970);
  assert.ok(value.base.composited >= 5, `底图应合成多层，实际 ${value.base.composited}`);
  assert.equal(assets.get(value.base.assetRef.slice(6)).mime, 'image/png');

  const first = value.plan.commands.find(command => command.type === 'layer.add_image');
  assert.equal(first.payload.sourceRef, value.base.assetRef, '第一张图必须是底图');
  assert.equal(first.payload.width, 970);
  assert.equal(first.payload.height, 600);
  assert.equal(value.plan.commands[2].payload.sourceRef, `asset:${'a'.repeat(48)}`, '第二张是商品图');
  assert.ok(value.plan.mapping.some(item => item.action === 'preserved-in-base'), '装饰应标为已进底图');
  assert.equal(value.plan.skipped.filter(item => item.kind === 'image').length, 0, '装饰不再计入丢失');
});

test('/template/batch：一次上传合成一次底图，为多个商品各出一份规划', async t => {
  if (!existsSync(APLUS)) return t.skip('缺少样例 aplus01.psd');
  const { createAssetStore } = await import('../lib/assets.js');
  const { createMediaRouter } = await import('../lib/http.js');
  const assets = createAssetStore();
  const token = 'batch-token';
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets });
  const products = [{ assetRef: `asset:${'a'.repeat(48)}`, name: 'A' }, { assetRef: `asset:${'b'.repeat(48)}`, name: 'B' }];
  const out = { status: 0, body: '' };
  const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
  const req = {
    method: 'POST', url: '/media-image/template/batch',
    headers: {
      host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}`,
      'x-dsh-media-relay': '1', 'x-dsh-media-asset': '1', 'content-type': 'application/octet-stream',
      'x-psd-name': encodeURIComponent('aplus01.psd'),
      'x-psd-background': '%23f4f5f7',
      'x-psd-products': encodeURIComponent(JSON.stringify(products)),
    },
    async *[Symbol.asyncIterator]() { yield readFileSync(APLUS); },
  };
  await router(req, res);
  assert.equal(out.status, 200, out.body.slice(0, 300));
  const value = JSON.parse(out.body);
  assert.ok(value.base?.assetRef, '必须返回底图');
  assert.equal(value.variants.length, 2);
  assert.equal(value.summary.variants, 2);
  assert.equal(assets.list().length, 1, '底图只存一份，不按变体重复');
  for (const variant of value.variants) {
    const images = variant.plan.commands.filter(command => command.type === 'layer.add_image');
    assert.equal(images[0].payload.sourceRef, value.base.assetRef, '每份都从同一底图开始');
  }
  assert.equal(value.variants[0].plan.commands.filter(c => c.type === 'layer.add_image')[1].payload.sourceRef, products[0].assetRef);
  assert.equal(value.variants[1].plan.commands.filter(c => c.type === 'layer.add_image')[1].payload.sourceRef, products[1].assetRef);
});

test('非 RGB 或非 8bit 明确拒绝，不返回半成品', () => {
  const psd = buildPsd({ width: 4, height: 4, layers: [{ x: 0, y: 0, w: 4, h: 4, rgb: [1, 2, 3] }] });
  const cmyk = Buffer.from(psd);
  cmyk.writeUInt16BE(4, 24);
  assert.throws(() => compositePsdLayers(cmyk), error => error.code === 'PSD_COLORMODE_UNSUPPORTED');
  const deep = Buffer.from(psd);
  deep.writeUInt16BE(16, 22);
  assert.throws(() => compositePsdLayers(deep), error => error.code === 'PSD_DEPTH_UNSUPPORTED');
});
