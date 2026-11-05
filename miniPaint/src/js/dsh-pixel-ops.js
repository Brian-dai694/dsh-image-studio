// 纯像素运算：羽化（alpha 高斯/盒式模糊）与 Reinhard 色彩匹配。
//
// 单独成模块的原因：这两步是纯数据变换，不依赖 DOM 与 miniPaint 状态，可以在 Node 里直接
// 用合成 ImageData 做回归；桥接层只负责取图/写回，算法本身可独立验证。
// 约定：输入输出都是 {width, height, data} 的 RGBA Uint8ClampedArray 结构。

/** RGBA 的 Lab 近似转换（sRGB → XYZ → CIELAB，D65）。 */
function rgbToLab(r, g, b) {
  const lin = value => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lr = lin(r), lg = lin(g), lb = lin(b);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = t => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  let lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  let lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  let lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const enc = v => {
    const c = Math.max(0, Math.min(1, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  };
  return [enc(lr), enc(lg), enc(lb)];
}

/** 统计一张图（忽略全透明像素）的 Lab 均值与标准差。 */
export function labStats(image) {
  const { data } = image;
  let n = 0, sL = 0, sa = 0, sb = 0, qL = 0, qa = 0, qb = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [L, a, b] = rgbToLab(data[i], data[i + 1], data[i + 2]);
    n += 1; sL += L; sa += a; sb += b; qL += L * L; qa += a * a; qb += b * b;
  }
  if (!n) return { count: 0, mean: [0, 0, 0], std: [0, 0, 0] };
  const mean = [sL / n, sa / n, sb / n];
  const variance = [qL / n - mean[0] ** 2, qa / n - mean[1] ** 2, qb / n - mean[2] ** 2];
  return { count: n, mean, std: variance.map(v => Math.sqrt(Math.max(0, v))) };
}

/**
 * Reinhard 色彩迁移：把 base 的 Lab 分布对齐到 reference。
 * strength 是线性插值系数（0 = 原图，1 = 完全匹配）；同一 base 上重复调用结果一致（幂等）。
 */
export function reinhardTransfer(base, reference, strength = 1) {
  const k = Math.max(0, Math.min(1, strength));
  const src = labStats(base), dst = labStats(reference);
  const out = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
  if (!src.count || !dst.count) return out;
  const gain = [0, 1, 2].map(i => (src.std[i] === 0 ? 1 : dst.std[i] / src.std[i]));
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue;
    const [L, a, b] = rgbToLab(out.data[i], out.data[i + 1], out.data[i + 2]);
    const shifted = [L, a, b].map((v, idx) => (v - src.mean[idx]) * gain[idx] + dst.mean[idx]);
    const blended = [L, a, b].map((v, idx) => v + (shifted[idx] - v) * k);
    const [r, g, bl] = labToRgb(blended[0], blended[1], blended[2]);
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = bl;
  }
  return out;
}

/**
 * 只对 alpha 通道做盒式模糊（两次一维，等价于一次近似高斯）。
 * RGB 不动，避免边缘颜色渗色；radiusPx 限制在 1..64。
 */
export function blurAlpha(image, radiusPx) {
  const radius = Math.max(1, Math.min(64, Math.round(radiusPx)));
  const { width, height } = image;
  const out = { width, height, data: new Uint8ClampedArray(image.data) };
  const pass = (srcAlpha, dstAlpha, length, stride) => {
    for (let i = 0; i < length; i += 1) {
      let sum = 0, count = 0;
      for (let d = -radius; d <= radius; d += 1) {
        const at = i + d;
        if (at < 0 || at >= length) continue;
        sum += srcAlpha[at * stride]; count += 1;
      }
      dstAlpha[i * stride] = Math.round(sum / count);
    }
  };
  const horizontal = new Uint8ClampedArray(width * height);
  const vertical = new Uint8ClampedArray(width * height);
  const src = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) src[i] = image.data[i * 4 + 3];
  for (let y = 0; y < height; y += 1) {
    const row = src.subarray(y * width, (y + 1) * width);
    const target = horizontal.subarray(y * width, (y + 1) * width);
    const rowCopy = new Uint8ClampedArray(row);
    for (let x = 0; x < width; x += 1) {
      let sum = 0, count = 0;
      for (let d = -radius; d <= radius; d += 1) {
        const at = x + d;
        if (at < 0 || at >= width) continue;
        sum += rowCopy[at]; count += 1;
      }
      target[x] = Math.round(sum / count);
    }
  }
  for (let x = 0; x < width; x += 1) {
    const column = new Uint8ClampedArray(height);
    for (let y = 0; y < height; y += 1) column[y] = horizontal[y * width + x];
    for (let y = 0; y < height; y += 1) {
      let sum = 0, count = 0;
      for (let d = -radius; d <= radius; d += 1) {
        const at = y + d;
        if (at < 0 || at >= height) continue;
        sum += column[at]; count += 1;
      }
      vertical[y * width + x] = Math.round(sum / count);
    }
  }
  for (let i = 0; i < width * height; i += 1) out.data[i * 4 + 3] = vertical[i];
  return out;
}

/** 像素内容的稳定摘要：FNV-1a 64 位，用于「首帧快照」溯源，不暴露像素。 */
export function pixelDigest(image) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < image.data.length; i += 1) {
    hash ^= BigInt(image.data[i]);
    hash = (hash * prime) & mask;
  }
  return 'fnv1a64-' + hash.toString(16).padStart(16, '0');
}
