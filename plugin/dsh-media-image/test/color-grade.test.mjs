// 色调曲线 + 分区 HSL 的数学验证。这些是纯函数，直接在 Node 里测（不经浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { monotoneInterp, buildMasterLut, buildChannelLuts, applyGrade, bandWeight, HSL_BANDS, BAND_CENTERS } from '../../../miniPaint/src/js/dsh-color-grade.js';

const pixel = (r, g, b, a = 255) => new Uint8ClampedArray([r, g, b, a]);
const read = data => [data[0], data[1], data[2], data[3]];

test('单调插值不过冲：单调输入点得到单调输出', () => {
  const points = [{ x: 0, y: 0 }, { x: 0.25, y: 0.2 }, { x: 0.5, y: 0.6 }, { x: 0.75, y: 0.8 }, { x: 1, y: 1 }];
  let previous = -1;
  for (let index = 0; index <= 100; index += 1) {
    const value = monotoneInterp(points, index / 100);
    assert.ok(value >= previous - 1e-9, `在 x=${index / 100} 处出现回落：${previous} → ${value}`);
    assert.ok(value >= -1e-9 && value <= 1 + 1e-9, '不能超出 [0,1]');
    previous = value;
  }
  // 端点必须精确命中
  assert.equal(monotoneInterp(points, 0), 0);
  assert.equal(monotoneInterp(points, 1), 1);
});

test('空 spec 得到的 LUT 是恒等映射（不改画面）', () => {
  const lut = buildMasterLut({});
  for (let index = 0; index < 256; index += 1) {
    assert.ok(Math.abs(lut[index] - index) <= 1, `第 ${index} 项应接近自身，实际 ${lut[index]}`);
  }
});

test('曝光/对比的作用方向正确', () => {
  const bright = buildMasterLut({ exposure: 1 });
  const dark = buildMasterLut({ exposure: -1 });
  assert.ok(bright[128] > 128, '正曝光要提亮中间调');
  assert.ok(dark[128] < 128, '负曝光要压暗中中间调');
  const punchy = buildMasterLut({ contrast: 50 });
  assert.ok(punchy[64] < 64, '加对比：暗部更暗');
  assert.ok(punchy[192] > 192, '加对比：亮部更亮');
});

test('高光/阴影走曲线控制点：高光恢复主要压亮部，阴影提亮主要提暗部', () => {
  const recover = buildMasterLut({ highlights: -60 });
  assert.ok(recover[230] < 230, '高光应被压下来');
  assert.ok(Math.abs(recover[40] - 40) <= 2, '暗部基本不动');

  const lift = buildMasterLut({ shadows: 60 });
  assert.ok(lift[40] > 40, '阴影应被提亮');
  assert.ok(Math.abs(lift[230] - 230) <= 3, '亮部基本不动');
});

test('显式曲线点优先：给 curve 就按它算，忽略滑杆', () => {
  const withCurve = buildMasterLut({ curve: [{ x: 0, y: 64 }, { x: 1, y: 255 }], highlights: -100 });
  // 0 映射到 64，说明用的是曲线点而不是 highlights 滑杆
  assert.ok(Math.abs(withCurve[0] - 64) <= 2, `实际 ${withCurve[0]}`);
});

test('通道曲线各自独立', () => {
  const luts = buildChannelLuts({ curveRed: [{ x: 0, y: 0 }, { x: 1, y: 128 }], curveGreen: [{ x: 0, y: 0 }, { x: 1, y: 255 }] });
  assert.ok(luts.r[255] < 140, '红通道被压');
  assert.ok(luts.g[255] > 250, '绿通道保持');
  assert.ok(Math.abs(luts.b[128] - 128) <= 1, '没给蓝曲线就是恒等');
});

test('分区 HSL 只影响对应色相：改红色不会动蓝色', () => {
  const red = pixel(220, 30, 30);
  applyGrade(red, { hsl: { red: { sat: 100 } } });
  const [r1, g1, b1] = read(red);
  assert.ok(r1 > 200, '红色像素应保持/更红');
  assert.ok(g1 <= 30, '红像素的绿分量不应上升');

  const blue = pixel(30, 30, 220);
  applyGrade(blue, { hsl: { red: { sat: 100 } } });
  assert.deepEqual(read(blue), [30, 30, 220, 255], '蓝像素不该被红色带的调整影响');
});

test('色相偏移能真的转动色相', () => {
  const orange = pixel(240, 140, 40);
  const before = read(orange);
  applyGrade(orange, { hsl: { orange: { hue: -60 } } });
  const after = read(orange);
  assert.notDeepEqual(after.slice(0, 3), before.slice(0, 3), '色相应变');
  // 往 -60 度转，红色分量应仍高、蓝色分量上升（向红/品红靠）
  assert.ok(after[2] > before[2], `蓝分量应上升，before=${before[2]} after=${after[2]}`);
});

test('带权重在环上连续：相邻带边界处归零，中心为 1', () => {
  for (const band of HSL_BANDS) {
    assert.equal(bandWeight(BAND_CENTERS[band], band), 1, `${band} 中心权重应为 1`);
    assert.equal(bandWeight((BAND_CENTERS[band] + 90) % 360, band), 0, `${band} 偏离 90° 应无权重`);
  }
  // 红色带在 350° 与 10° 都应有权重（跨 0° 的环形距离）
  assert.ok(bandWeight(350, 'red') > 0);
  assert.ok(bandWeight(10, 'red') > 0);
});

test('alpha 不被改动，全透明像素被跳过', () => {
  const half = new Uint8ClampedArray([200, 100, 50, 128, 10, 20, 30, 0]);
  applyGrade(half, { exposure: 1, hsl: { red: { sat: 50 } } });
  assert.equal(half[3], 128, '半透明 alpha 必须原样');
  assert.equal(half[7], 0, '全透明 alpha 仍是 0');
  assert.deepEqual([half[4], half[5], half[6]], [10, 20, 30], '全透明像素的 RGB 不该被改');
});

test('分离色调：高光偏暖、阴影偏冷，方向正确', () => {
  const highlight = pixel(220, 220, 220);
  applyGrade(highlight, { splitTone: { highlightHue: 40, highlightSat: 80 } });
  const [hr, , hb] = read(highlight);
  assert.ok(hr > hb, `高光应偏暖：r=${hr} b=${hb}`);

  const shadow = pixel(40, 40, 40);
  applyGrade(shadow, { splitTone: { shadowHue: 210, shadowSat: 80 } });
  const [sr, , sb] = read(shadow);
  assert.ok(sb > sr, `阴影应偏冷：r=${sr} b=${sb}`);
});
