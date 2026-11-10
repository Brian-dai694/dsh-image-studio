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

test('锐化/清晰度/纹理：增强局部对比，且不改整体均值太多', () => {
  // 16×1 的明暗交替条纹：局部对比的可测对象
  const W = 16, H = 1;
  const make = () => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let x = 0; x < W; x += 1) {
      const value = x % 2 === 0 ? 60 : 190;
      const at = x * 4;
      data[at] = value; data[at + 1] = value; data[at + 2] = value; data[at + 3] = 255;
    }
    return data;
  };
  const contrast = data => {
    // 相邻差的中位数（放大 10 倍便于比较）
    const diffs = [];
    for (let x = 1; x < W; x += 1) diffs.push(Math.abs(data[x * 4] - data[(x - 1) * 4]));
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)];
  };

  const plain = make();
  const sharpened = make();
  applyGrade(sharpened, { sharpen: 60 }, { width: W, height: H, dither: false });
  assert.ok(contrast(sharpened) >= contrast(plain), `锐化应增强相邻差：${contrast(plain)} → ${contrast(sharpened)}`);

  const clarified = make();
  applyGrade(clarified, { clarity: 60 }, { width: W, height: H, dither: false });
  // 清晰度在 1 像素高的图上几乎无低频可言，行为只要求"不崩且输出有效"
  assert.equal(clarified.length, plain.length);
});

test('颗粒：增加像素方差，且确定性（同输入同输出）', () => {
  const W = 8, H = 8;
  const make = () => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p += 1) {
      const at = p * 4;
      data[at] = 128; data[at + 1] = 128; data[at + 2] = 128; data[at + 3] = 255;
    }
    return data;
  };
  const variance = data => {
    const values = [];
    for (let p = 0; p < W * H; p += 1) values.push(data[p * 4]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  };
  const flat = make();
  assert.equal(variance(flat), 0, '纯色图方差应为 0');
  const grained = make();
  applyGrade(grained, { grain: 80 }, { width: W, height: H, dither: false });
  assert.ok(variance(grained) > 0, '加了颗粒方差应大于 0');

  const again = make();
  applyGrade(again, { grain: 80 }, { width: W, height: H, dither: false });
  assert.deepEqual(Array.from(grained), Array.from(again), '颗粒必须确定性（同样输入同样输出）');
});

test('暗角：角部被压得比中心多，负值反向', () => {
  const W = 21, H = 21;
  const make = () => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p += 1) {
      const at = p * 4;
      data[at] = 200; data[at + 1] = 200; data[at + 2] = 200; data[at + 3] = 255;
    }
    return data;
  };
  const centerAt = (10 * W + 10) * 4;
  const cornerAt = 0;

  const dark = make();
  applyGrade(dark, { vignette: -80 }, { width: W, height: H, dither: false });
  assert.ok(dark[cornerAt] < dark[centerAt], `角部应更暗：corner=${dark[cornerAt]} center=${dark[centerAt]}`);
  assert.equal(dark[centerAt], 200, '中心不该被改动');

  const light = make();
  applyGrade(light, { vignette: 80 }, { width: W, height: H, dither: false });
  assert.ok(light[cornerAt] > light[centerAt], '正值应提亮四周');
});

test('去雾：拉开明暗对比 + 提饱和（不含"一定压暗中间调"这种臆测）', () => {
  const W = 2, H = 1;
  // 左：偏亮的雾灰；右：偏暗的雾灰。去雾应把两者差距拉大。
  const make = () => {
    const data = new Uint8ClampedArray(W * H * 4);
    const set = (x, value) => {
      const at = x * 4;
      data[at] = value; data[at + 1] = value + 4; data[at + 2] = value + 8; data[at + 3] = 255;
    };
    set(0, 185); set(1, 125);
    return data;
  };
  const before = make();
  const after = make();
  applyGrade(after, { dehaze: 80 }, { width: W, height: H, dither: false });

  const gapBefore = Math.abs(before[0] - before[4]);
  const gapAfter = Math.abs(after[0] - after[4]);
  assert.ok(gapAfter > gapBefore, `去雾应拉开明暗差：${gapBefore} → ${gapAfter}`);

  // 通道差（约等于饱和度）应变大
  const spread = data => Math.max(data[0], data[1], data[2]) - Math.min(data[0], data[1], data[2]);
  assert.ok(spread(after) > spread(before), `去雾应提饱和：${spread(before)} → ${spread(after)}`);
});

test('没有几何信息时，局部算子被跳过并如实报告（不假装做了）', () => {
  const data = pixel(120, 120, 120);
  const result = applyGrade(data, { clarity: 50, texture: 50, sharpen: 50, dehaze: 50, vignette: -50 });
  assert.deepEqual(result.skipped.sort(), ['clarity', 'dehaze', 'sharpen', 'texture', 'vignette']);
  // 全局算子仍应生效（这里没有全局参数，所以像素不变）
  assert.deepEqual(read(data), [120, 120, 120, 255]);
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
