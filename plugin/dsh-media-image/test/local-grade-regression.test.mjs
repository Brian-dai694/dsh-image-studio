import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGrade } from '../../../miniPaint/src/js/dsh-color-grade.js';

function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    const v = fn(x, y);
    data.set([v, v, v, 255], p);
  }
  return data;
}
function distance(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 4) total += Math.abs(a[i] - b[i]);
  return total / (a.length / 4);
}

test('局部细节滑杆强度连续增强，零值保持原图', () => {
  const width = 192, height = 64;
  const base = image(width, height, x => 128 + Math.round(32 * Math.sin(x / 9) + 12 * Math.sin(x / 2)));
  for (const key of ['clarity', 'texture', 'sharpen']) {
    let previous = 0;
    for (const amount of [0, 20, 40, 80, 100]) {
      const output = base.slice();
      applyGrade(output, { [key]: amount }, { width, height, dither: false });
      const change = distance(base, output);
      if (!amount) assert.equal(change, 0, key);
      else assert.ok(change > previous, `${key} ${amount}: ${change} <= ${previous}`);
      previous = change;
    }
  }
});

test('去雾强边缘保护：黑白阶跃不产生新灰边或光晕', () => {
  const width = 192, height = 32;
  const base = image(width, height, x => x < width / 2 ? 24 : 236);
  const output = base.slice();
  applyGrade(output, { dehaze: 100 }, { width, height, dither: false });
  let maxChange = 0;
  for (let i = 0; i < base.length; i += 4) maxChange = Math.max(maxChange, Math.abs(base[i] - output[i]));
  assert.ok(maxChange <= 12, `强边缘最大偏移 ${maxChange} > 12`);
});

test('去雾低对比渐变具有可测且随强度增加的变化', () => {
  const width = 192, height = 32;
  // 低对比纹理尺度必须落在当前局部估计半径内；慢于估计窗口的渐变并非雾景真值。
  const base = image(width, height, x => 160 + Math.round(18 * Math.sin(x / 6)));
  let previous = 0;
  for (const amount of [35, 70, 100]) {
    const output = base.slice();
    applyGrade(output, { dehaze: amount }, { width, height, dither: false });
    const change = distance(base, output);
    assert.ok(change > previous, `${amount}: ${change} <= ${previous}`);
    previous = change;
  }
});
