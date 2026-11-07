import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeFlatBackground, applyMask, blurAlpha } from '../../../miniPaint/src/js/dsh-pixel-ops.js';

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
