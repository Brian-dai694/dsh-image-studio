// 回归：putImageData 只认 ImageData。像素算法返回普通 {width,height,data}，
// 直接写回会抛 "parameter 1 is not of type 'ImageData'"（用户截图里的 EDITOR_ERROR）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureImageData, blurAlpha, removeFlatBackground } from '../../../miniPaint/src/js/dsh-pixel-ops.js';

class FakeImageData {
  constructor(data, width, height) {
    this.data = data; this.width = width; this.height = height;
  }
}

test('纯数据结果被转换成真正的 ImageData，尺寸与长度不一致则拒绝', () => {
  const plain = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(7) };
  const converted = ensureImageData(plain, FakeImageData);
  assert.ok(converted instanceof FakeImageData, '必须是 ImageData 实例，否则 putImageData 会抛错');
  assert.equal(converted.width, 2);
  assert.equal(converted.height, 2);
  assert.equal(converted.data[3], 7);

  // 已经是 ImageData 时原样返回（不复制，避免大图额外内存）
  assert.equal(ensureImageData(converted, FakeImageData), converted);

  // 环境缺少 ImageData 时必须明确报错，而不是把普通对象交给 putImageData
  assert.throws(() => ensureImageData(plain, undefined), /ImageData/);
  // 尺寸与数据长度不匹配要拒绝
  assert.throws(() => ensureImageData({ width: 3, height: 3, data: new Uint8ClampedArray(16) }, FakeImageData), /不匹配/);
  assert.throws(() => ensureImageData({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, FakeImageData), /尺寸无效/);
});

test('羽化与去背景的输出都能被安全转换（真实算法链路）', () => {
  const width = 4, height = 4;
  const source = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
  for (const output of [blurAlpha(source, 1), removeFlatBackground(source, { tolerance: 8 }).image]) {
    const converted = ensureImageData(output, FakeImageData);
    assert.ok(converted instanceof FakeImageData);
    assert.equal(converted.data.length, width * height * 4);
  }
});
