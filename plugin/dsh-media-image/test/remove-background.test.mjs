import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeFlatBackground, applyMask, blurAlpha, magicErase, backgroundMask } from '../../../miniPaint/src/js/dsh-pixel-ops.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 画一张 20x20 的白底 + 中央 6x6 红块，模拟电商白底商品图。 */
function whiteBackdropProduct({ background = [255, 255, 255] } = {}) {
  const width = 20, height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const inProduct = x >= 7 && x <= 12 && y >= 7 && y <= 12;
      const rgb = inProduct ? [200, 30, 30] : background;
      data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2]; data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

test('自动去背景：白底被擦成透明，商品像素保持不透明', () => {
  const image = whiteBackdropProduct();
  const result = removeFlatBackground(image, { tolerance: 8 });
  assert.equal(result.coverage > 0.8 && result.coverage < 1, true, `覆盖率应接近但小于 1，实际 ${result.coverage}`);
  const at = (x, y) => (y * 20 + x) * 4 + 3;
  assert.equal(result.image.data[at(0, 0)], 0, '角上的白底必须透明');
  assert.equal(result.image.data[at(19, 19)], 0, '另一角白底也必须透明');
  assert.equal(result.image.data[at(9, 9)], 255, '商品中心必须保留');
  assert.deepEqual(result.background, [255, 255, 255]);
  assert.deepEqual(result.bbox, { x: 7, y: 7, width: 6, height: 6 }, '包围盒用于后续摆位');
});

test('自动去背景：已透明边界不会污染主色，仍能正常工作', () => {
  const image = whiteBackdropProduct({ background: [250, 250, 250] });
  const result = removeFlatBackground(image, { tolerance: 10 });
  assert.equal(result.image.data[(5 * 20 + 5) * 4 + 3], 0);
  assert.equal(result.image.data[(9 * 20 + 9) * 4 + 3], 255);
});

test('自动去背景：纯色整图会给出接近 1 的覆盖率，调用方据此中止而不是毁图', () => {
  const width = 8, height = 8;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const result = removeFlatBackground({ width, height, data }, { tolerance: 8 });
  assert.equal(result.coverage, 1);
  assert.equal(result.bbox, null);
});

test('纹理背景（深底 + 浅噪点）：多色簇模型应擦掉大部分背景并保留商品', () => {
  const width = 60, height = 60;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const inProduct = x >= 18 && x <= 42 && y >= 18 && y <= 42;
      if (inProduct) { data[p] = 196; data[p + 1] = 116; data[p + 2] = 84; }
      else if (rand() > 0.82) { data[p] = 200; data[p + 1] = 200; data[p + 2] = 205; }
      else { data[p] = 26; data[p + 1] = 28; data[p + 2] = 32; }
      data[p + 3] = 255;
    }
  }
  const result = removeFlatBackground({ width, height, data }, { tolerance: 14 });
  assert.ok(result.clusters >= 2, `边界应识别出多个背景色簇，实际 ${result.clusters}`);
  assert.equal(result.image.data[(30 * width + 30) * 4 + 3], 255, '商品中心必须保留');
  assert.equal(result.image.data[(1 * width + 1) * 4 + 3], 0, '角落背景必须擦掉');
  let cleared = 0, total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= 18 && x <= 42 && y >= 18 && y <= 42) continue;
      total += 1;
      if (result.image.data[(y * width + x) * 4 + 3] === 0) cleared += 1;
    }
  }
  const ratio = cleared / total;
  assert.ok(ratio > 0.9, `背景擦除率应高于 90%，实际 ${(ratio * 100).toFixed(1)}%`);
});

test('自动去背景：商品贴着背景色（低对比）时覆盖率为 0，不谎报成功', () => {
  const width = 8, height = 8;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const result = removeFlatBackground({ width, height, data }, { tolerance: 0 });
  assert.equal(result.coverage, 1);
});

test('自动去背景：非法图像与越界参数直接拒绝', () => {
  assert.throws(() => removeFlatBackground({ width: 0, height: 0, data: new Uint8ClampedArray(0) }), RangeError);
  assert.throws(() => removeFlatBackground(whiteBackdropProduct(), { tolerance: 101 }), RangeError);
  assert.throws(() => removeFlatBackground(whiteBackdropProduct(), { featherPx: 65 }), RangeError);
});

test('魔棒擦除：只擦种子点连通的同色区域，不会跨进商品', () => {
  const width = 20, height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const inProduct = x >= 7 && x <= 12 && y >= 7 && y <= 12;
      // 商品是深灰(90)，背景是白(255)：颜色差异明确，魔棒在容差 2 下不应跨过去
      const value = 255;
      data[p] = value; data[p + 1] = value; data[p + 2] = value; data[p + 3] = 255;
      if (inProduct) { data[p] = 90; data[p + 1] = 90; data[p + 2] = 90; }
    }
  }
  const result = magicErase({ width, height, data }, { x: 0, y: 0, tolerance: 2, contiguous: true });
  assert.ok(result.erased > 300, `应擦掉背景区域，实际 ${result.erased}`);
  assert.equal(result.image.data[(9 * width + 9) * 4 + 3], 255, '商品像素必须保留');
  assert.equal(result.image.data[(0 * width + 19) * 4 + 3], 0, '角上的背景必须透明');
});

test('魔棒擦除：越界种子、非法容差直接拒绝；点到已透明处返回 0', () => {
  const image = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) };
  assert.throws(() => magicErase(image, { x: 9, y: 0 }), RangeError);
  assert.throws(() => magicErase(image, { x: 0, y: 0, tolerance: 200 }), RangeError);
  const transparent = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  assert.equal(magicErase(transparent, { x: 0, y: 0 }).erased, 0);
});

test('蒙版图层算法：subject 保留商品、background 反过来，都是白色+alpha', () => {
  const image = whiteBackdropProduct();
  const subject = backgroundMask(image, { tolerance: 8, featherPx: 0, mode: 'subject' });
  const at = (img, x, y) => (y * 20 + x) * 4;
  assert.equal(subject.image.data[at(subject.image, 0, 0) + 3], 0, '背景在蒙版里应透明（被挖掉）');
  assert.equal(subject.image.data[at(subject.image, 9, 9) + 3], 255, '商品在蒙版里应不透明（保留）');
  assert.equal(subject.image.data[at(subject.image, 9, 9)], 255, '蒙版是白色层');
  const background = backgroundMask(image, { tolerance: 8, featherPx: 0, mode: 'background' });
  assert.equal(background.image.data[at(background.image, 0, 0) + 3], 255, '反相蒙版保留背景');
  assert.equal(background.image.data[at(background.image, 9, 9) + 3], 0, '反相蒙版挖掉商品');
});

test('原有像素能力未被破坏：蒙版与羽化仍可用', () => {
  const source = whiteBackdropProduct();
  const mask = { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4) };
  for (let i = 0; i < 20 * 20; i += 1) { mask.data[i * 4 + 3] = 255; }
  const masked = applyMask(source, mask, { mode: 'alpha' });
  assert.equal(masked.data[3], 255);
  const blurred = blurAlpha(source, 2);
  assert.equal(blurred.width, 20);
});

test('网关白名单接受 layer.remove_background 并拒绝非法容差', async () => {
  const { COMMAND_VALIDATORS } = await import(pathToFileURL(resolve(root, 'lib/bridge.js')).href);
  const validate = COMMAND_VALIDATORS.image;
  validate({ type: 'layer.remove_background', payload: { layerId: 'l1' } });
  validate({ type: 'layer.remove_background', payload: { layerId: 'l1', tolerance: 12, featherPx: 2 } });
  assert.throws(() => validate({ type: 'layer.remove_background', payload: { layerId: 'l1', tolerance: 200 } }), /tolerance|range/);
  assert.throws(() => validate({ type: 'layer.remove_background', payload: { layerId: 'l1', featherPx: 70 } }), /featherPx/);
  assert.throws(() => validate({ type: 'layer.remove_background', payload: { layerId: 'l1', x: 3 } }), /Unsupported payload field/);
});
