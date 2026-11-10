// 色调曲线 + 分区 HSL 的真实实现（纯函数，不碰 DOM，Node 里可直接测）。
//
// 为什么要有这个模块：XMP / Camera Raw 预设里最有表现力的部分就是曲线和分区 HSL，
// 而 miniPaint 的 CSS filter 只有 blur/brightness/contrast/saturate/... 九项，
// 完全表达不了"高光压 -40、橙色明亮度 +15"这类调整。之前只能把它们列进
// unmapped 说"做不到" —— 这个模块把它们**真的**算出来。
//
// 设计取舍：
//  - 一条 master 曲线 + 三条通道曲线，都是 256 项查表（LUT），逐像素查表比每像素算函数快得多；
//  - 曲线用单调三次插值（PCHIP）：线性插值会有明显断层，普通三次会过冲出非单调（暗部被提亮后反而更暗）；
//  - 分区 HSL 按 8 个色相带（Lightroom 的口径），每个像素按色相落在哪一带给**平滑权重**，
//    直接用阈值切分会在带边界出现硬边。

/** Lightroom / Camera Raw 的 8 个 HSL 色相带，中心色相（度）。 */
export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
export const BAND_CENTERS = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 280, magenta: 320 };
/** 每个带的半宽（度）：带之间有重叠，权重因此平滑过渡。 */
const BAND_HALF_WIDTH = 45;

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);
const clamp255 = value => (value < 0 ? 0 : value > 255 ? 255 : value);

/**
 * 单调三次插值（Fritsch–Carlson）。输入点不必等距，但必须按 x 升序。
 * 保证输出单调：曲线因此不会出现"越提越暗"的过冲。
 */
export function monotoneInterp(points, x) {
  const pts = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)).sort((a, b) => a.x - b.x);
  if (!pts.length) return x;
  if (pts.length === 1) return pts[0].y;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  let index = 0;
  while (index < pts.length - 2 && x > pts[index + 1].x) index += 1;
  const h = pts[index + 1].x - pts[index].x;
  if (h <= 0) return pts[index].y;
  const t = (x - pts[index].x) / h;
  // 端点斜率：PCHIP 的做法，按相邻割线加权，保证不过冲。
  const slope = i => {
    if (i === 0) return (pts[1].y - pts[0].y) / (pts[1].x - pts[0].x || 1);
    if (i === pts.length - 1) return (pts[i].y - pts[i - 1].y) / (pts[i].x - pts[i - 1].x || 1);
    const left = (pts[i].y - pts[i - 1].y) / (pts[i].x - pts[i - 1].x || 1);
    const right = (pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x || 1);
    if (left * right <= 0) return 0;
    return (2 * left * right) / (left + right);
  };
  const m0 = slope(index) * h;
  const m1 = slope(index + 1) * h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * pts[index].y
    + (t3 - 2 * t2 + t) * m0
    + (-2 * t3 + 3 * t2) * pts[index + 1].y
    + (t3 - t2) * m1;
}

/**
 * 把"曝光/对比/高光/阴影/白场/黑场 + 显式曲线点"折成一条 256 项 master LUT。
 *
 * 高光/阴影/白场/黑场没有独立实现：它们本来就是曲线上的控制点，
 * 所以按各自区段挪动控制点，再用单调插值取整条曲线——比"分区间线性拉伸"稳。
 */
export function buildMasterLut(spec = {}, size = 256) {
  const exposure = Number(spec.exposure) || 0;      // EV
  const contrast = Number(spec.contrast) || 0;      // -100..100
  const highlights = Number(spec.highlights) || 0;
  const shadows = Number(spec.shadows) || 0;
  const whites = Number(spec.whites) || 0;
  const blacks = Number(spec.blacks) || 0;
  const explicit = Array.isArray(spec.curve) ? spec.curve : null;

  let points;
  if (explicit && explicit.length >= 2) {
    // 预设自带曲线点：直接用（Lightroom 写的是 0..255 的 x,y）。
    points = explicit.map(point => ({ x: clamp01(point.x > 1 ? point.x / 255 : point.x), y: clamp01(point.y > 1 ? point.y / 255 : point.y) }));
  } else {
    // 默认四控制点 + 两个端点，按滑杆挪动。
    points = [
      { x: 0, y: clamp01(blacks / 100 * 0.12) },
      { x: 0.25, y: clamp01(0.25 + shadows / 100 * 0.16) },
      { x: 0.75, y: clamp01(0.75 + highlights / 100 * 0.16) },
      { x: 1, y: clamp01(1 + whites / 100 * 0.10) },
    ];
  }

  const lut = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    let value = index / (size - 1);
    value = monotoneInterp(points, value);
    if (exposure) value *= 2 ** exposure;
    if (contrast) value = (value - 0.5) * (1 + contrast / 100 * 0.6) + 0.5;
    lut[index] = Math.round(clamp255(clamp01(value) * 255));
  }
  return lut;
}

/** 三条通道曲线（预设里的 ToneCurvePV2012Red/Green/Blue）。缺省就是恒等。 */
export function buildChannelLuts(spec = {}, size = 256) {
  const build = curve => {
    const lut = new Uint8Array(size);
    if (!Array.isArray(curve) || curve.length < 2) {
      for (let index = 0; index < size; index += 1) lut[index] = Math.round(index / (size - 1) * 255);
      return lut;
    }
    const points = curve.map(point => ({ x: clamp01(point.x > 1 ? point.x / 255 : point.x), y: clamp01(point.y > 1 ? point.y / 255 : point.y) }));
    for (let index = 0; index < size; index += 1) lut[index] = Math.round(clamp255(clamp01(monotoneInterp(points, index / (size - 1))) * 255));
    return lut;
  };
  return { r: build(spec.curveRed), g: build(spec.curveGreen), b: build(spec.curveBlue) };
}

const rgbToHsl = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
};

const hslToRgb = (h, s, l) => {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p, q, t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = ((h % 360) + 360) % 360 / 360;
  return [hue2rgb(p, q, hk + 1 / 3), hue2rgb(p, q, hk), hue2rgb(p, q, hk - 1 / 3)];
};

/** 某色相落在某个带上的权重：带中心为 1，偏离超过半宽为 0，中间线性过渡。 */
export function bandWeight(hue, band) {
  const center = BAND_CENTERS[band];
  if (center === undefined) return 0;
  // 环形距离：先平移到 [0,360) 再折回 ±180，最后取绝对值。
  const distance = Math.abs((((hue - center) % 360) + 540) % 360 - 180);
  if (distance >= BAND_HALF_WIDTH) return 0;
  return 1 - distance / BAND_HALF_WIDTH;
}

/** 4×4 有序抖动矩阵（Bayer）。8-bit 输出上的平滑渐变会出 banding，靠它打散。 */
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map(row => row.map(value => value / 16 - 0.5));

/**
 * 对一段 RGBA 像素**就地**应用色彩分级。
 * @param {Uint8ClampedArray} pixels RGBA
 * @param {object} spec
 *   exposure(EV) / contrast / highlights / shadows / whites / blacks / curve[] /
 *   curveRed|Green|Blue[] / hsl:{red:{hue,sat,lum},...} / splitTone:{highlightHue,highlightSat,shadowHue,shadowSat}
 * @param {object} [options]
 *   width 给定时启用 4×4 有序抖动（平滑渐变不再出条带）；dither=false 可关掉。
 * @returns {{pixels:Uint8ClampedArray, touched:number}}
 */
export function applyGrade(pixels, spec = {}, options = {}) {
  const master = buildMasterLut(spec);
  const channels = buildChannelLuts(spec);
  const hsl = spec.hsl && typeof spec.hsl === 'object' ? spec.hsl : null;
  const split = spec.splitTone && typeof spec.splitTone === 'object' ? spec.splitTone : null;
  const width = Number.isSafeInteger(options.width) && options.width > 0 ? options.width : 0;
  const dither = options.dither !== false && width > 0;
  let touched = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha === 0) continue; // 全透明像素不参与，避免把透明区染出色
    let r = channels.r[master[pixels[index]]] / 255;
    let g = channels.g[master[pixels[index + 1]]] / 255;
    let b = channels.b[master[pixels[index + 2]]] / 255;

    if (hsl) {
      const [hue, sat, lum] = rgbToHsl(r, g, b);
      // 加权**平均**而不是逐带相乘：重叠区的多个带如果把系数乘起来，
      // 强度会随带边界起伏，平滑渐变上就会看到一段段竖条。
      let hueShift = 0, satSum = 0, lumSum = 0, weightSum = 0;
      for (const band of HSL_BANDS) {
        const entry = hsl[band];
        if (!entry) continue;
        const weight = bandWeight(hue, band);
        if (weight <= 0) continue;
        weightSum += weight;
        hueShift += (Number(entry.hue) || 0) * weight;
        satSum += (Number(entry.sat) || 0) / 100 * weight;
        lumSum += (Number(entry.lum) || 0) / 100 * weight;
      }
      if (weightSum > 0) {
        const satScale = 1 + satSum / weightSum;
        const lumScale = 1 + (lumSum / weightSum) * 0.5;
        const [rr, gg, bb] = hslToRgb(hue + hueShift / weightSum, clamp01(sat * satScale), clamp01(lum * lumScale));
        r = rr; g = gg; b = bb;
      }
    }

    if (split) {
      // 分离色调：高光偏一个色相、阴影偏另一个，按亮度平滑加权。
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const apply = (hue, satPercent, weight) => {
        if (!Number.isFinite(hue) || !weight) return;
        const strength = (Number(satPercent) || 0) / 100 * weight * 0.35;
        if (strength <= 0) return;
        const [tr, tg, tb] = hslToRgb(hue, 1, 0.5);
        r += (tr - 0.5) * strength;
        g += (tg - 0.5) * strength;
        b += (tb - 0.5) * strength;
      };
      apply(Number(split.shadowHue), Number(split.shadowSat), 1 - lum);
      apply(Number(split.highlightHue), Number(split.highlightSat), lum);
    }

    // 抖动：按像素位置取矩阵值，±0.5 LSB 的量级足够打散条带，又不会引入可见噪点。
    let noise = 0;
    if (dither) {
      const index2 = index / 4;
      noise = BAYER_4X4[Math.floor(index2 / width) % 4][index2 % 4] / 255;
    }
    pixels[index] = Math.round(clamp255(clamp01(r + noise) * 255));
    pixels[index + 1] = Math.round(clamp255(clamp01(g + noise) * 255));
    pixels[index + 2] = Math.round(clamp255(clamp01(b + noise) * 255));
    // alpha 原样保留：分级不该改透明度
    touched += 1;
  }
  return { pixels, touched };
}
