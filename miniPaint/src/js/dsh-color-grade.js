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
 * 可分离盒式模糊（对单通道）。O(n) 与半径无关，适合清晰度/纹理/锐化取低频。
 * @returns {Float32Array} 模糊后的同尺寸数组
 */
export function boxBlurPlane(plane, width, height, radius) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return Float32Array.from(plane);
  const temp = new Float32Array(plane.length);
  const out = new Float32Array(plane.length);
  // 水平
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -r; x <= r; x += 1) sum += plane[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      temp[row + x] = sum / (2 * r + 1);
      const add = Math.min(width - 1, x + r + 1);
      const remove = Math.max(0, x - r);
      sum += plane[row + add] - plane[row + remove];
    }
  }
  // 垂直
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -r; y <= r; y += 1) sum += temp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / (2 * r + 1);
      const add = Math.min(height - 1, y + r + 1);
      const remove = Math.max(0, y - r);
      sum += temp[add * width + x] - temp[remove * width + x];
    }
  }
  return out;
}

const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * 对一段 RGBA 像素**就地**应用色彩分级。
 * @param {Uint8ClampedArray} pixels RGBA
 * @param {object} spec
 *   exposure(EV) / contrast / highlights / shadows / whites / blacks / curve[] /
 *   curveRed|Green|Blue[] / hsl:{red:{hue,sat,lum},...} / splitTone:{...}
 *   / sharpen / clarity / texture / dehaze / grain / vignette（-100..100）
 * @param {object} [options]
 *   width/height：给定时启用 4×4 有序抖动，并且局部算子（清晰度/纹理/锐化/暗角）才能算；
 *   缺省时局部算子被跳过并在返回值里报告（不假装做了）。
 * @returns {{pixels:Uint8ClampedArray, touched:number, skipped:string[]}}
 */
export function applyGrade(pixels, spec = {}, options = {}) {
  const master = buildMasterLut(spec);
  const channels = buildChannelLuts(spec);
  const hsl = spec.hsl && typeof spec.hsl === 'object' ? spec.hsl : null;
  const split = spec.splitTone && typeof spec.splitTone === 'object' ? spec.splitTone : null;
  const width = Number.isSafeInteger(options.width) && options.width > 0 ? options.width : 0;
  const height = Number.isSafeInteger(options.height) && options.height > 0 ? options.height : 0;
  const hasGeometry = width > 0 && height > 0;
  const dither = options.dither !== false && hasGeometry;
  const skipped = [];
  let touched = 0;

  // ── 需要几何的局部算子：先算低频亮度，再逐像素加回高频 ──
  const lumaPlane = hasGeometry ? new Float32Array(width * height) : null;
  if (hasGeometry) {
    for (let index = 0, p = 0; index < pixels.length; index += 4, p += 1) {
      lumaPlane[p] = lumaOf(pixels[index], pixels[index + 1], pixels[index + 2]) / 255;
    }
  }
  const unsharp = (amount, radius, label, strength = 1) => {
    if (!amount) return null;
    if (!hasGeometry) { skipped.push(label); return null; }
    const low = boxBlurPlane(lumaPlane, width, height, Math.max(1, Math.round(radius)));
    const detail = new Float32Array(lumaPlane.length);
    const gain = amount / 100;
    // 钳制每像素增量，阻止 unsharp halo；强度系数分别设定，清晰度半径大、容许增量也较大。
    const limit = 0.05 + strength * Math.abs(gain);
    for (let p = 0; p < lumaPlane.length; p += 1) {
      const delta = (lumaPlane[p] - low[p]) * gain;
      detail[p] = delta > limit ? limit : delta < -limit ? -limit : delta;
    }
    return detail;
  };
  // 清晰度是中频局部对比：半径按短边约 2.5%（(w+h)/80）缩放。
  // /40 在 1198×1198 真照片上约 60px，实测边缘暗晕太宽；减半到约 30px。
  const clarityDetail = unsharp(Number(spec.clarity) || 0, Math.max(4, (width + height) / 80), 'clarity', 0.20);
  const textureDetail = unsharp(Number(spec.texture) || 0, Math.max(2, (width + height) / 300), 'texture', 0.12);
  const sharpenDetail = unsharp(Number(spec.sharpen) || 0, 1.2, 'sharpen', 0.08);
  const dehazeAmount = Number(spec.dehaze) || 0;
  if (dehazeAmount && !hasGeometry) skipped.push('dehaze');
  const grainAmount = Number(spec.grain) || 0;
  const vignetteAmount = Number(spec.vignette) || 0;
  if (vignetteAmount && !hasGeometry) skipped.push('vignette');
  // 去雾需要"大气光"估计：用大半径模糊当作雾幕。真正的去雾要估大气光并解透射率，
  // 这里用同一份低频当作 A，做 J = A + (I - A)/t —— 方向正确：雾幕内部被拉开，不是整体提亮。
  const airlight = dehazeAmount && hasGeometry ? boxBlurPlane(lumaPlane, width, height, Math.max(8, (width + height) / 16)) : null;
  const centerX = (width - 1) / 2, centerY = (height - 1) / 2;
  const maxDistance = Math.hypot(centerX, centerY) || 1;

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

    if (hasGeometry) {
      const p = index / 4;
      // 清晰度/纹理/锐化：都是"原亮度 + 高频增量"，加在三个通道上保持色相。
      let delta = 0;
      if (clarityDetail) delta += clarityDetail[p];
      if (textureDetail) delta += textureDetail[p];
      if (sharpenDetail) delta += sharpenDetail[p];
      if (delta) { r += delta; g += delta; b += delta; }

      // 去雾：J = A + (I - A)/t。A 是低频大气光估计，t<1 拉开雾幕内的层次。
      // 第一版用"整体加对比 + 提饱和"，方向错了：亮雾区被继续提亮并裁切，雾没有减少。
      if (airlight) {
        const requested = dehazeAmount / 100;
        const a = airlight[p];
        // Edge protection: fade dehaze at strong local edges, but don't suppress the whole product.
        // The threshold is intentionally broad: a narrow threshold made dehaze effectively a no-op on real product photos.
        const edge = Math.abs(lumaPlane[p] - a);
        const protection = clamp01(1 - edge / 0.42);
        const strength = requested * protection;
        const t = Math.max(0.68, 1 - strength * 0.32);
        r = a + (r - a) / t;
        g = a + (g - a) / t;
        b = a + (b - a) / t;
        const mean = (r + g + b) / 3;
        const boost = 1 + strength * 0.12;
        r = mean + (r - mean) * boost;
        g = mean + (g - mean) * boost;
        b = mean + (b - mean) * boost;
      }

      // 颗粒：整数哈希（xorshift 风格）。用 Math.sin 会在规律图上出现对角条纹 ——
      // 第一版的 "sin(x*a + y*b)*big" 就是周期函数，肉眼直接看到斜纹，不是噪声。
      if (grainAmount) {
        const x = p % width, y = (p - x) / width;
        let h = (x * 374761393 + y * 668265263) | 0;
        h = (h ^ (h >>> 13)) * 1274126177 | 0;
        h = (h ^ (h >>> 16)) >>> 0;
        const noise = (h / 4294967296 - 0.5) * (grainAmount / 100) * 0.18;
        r += noise; g += noise; b += noise;
      }

      // 暗角：按到中心的归一化距离压暗（负值则提亮四周）。
      if (vignetteAmount) {
        const x = p % width, y = (p - x) / width;
        const distance = Math.hypot(x - centerX, y - centerY) / maxDistance;
        const factor = 1 + (vignetteAmount / 100) * 0.9 * distance * distance;
        r *= factor; g *= factor; b *= factor;
      }
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
  return { pixels, touched, skipped };
}
