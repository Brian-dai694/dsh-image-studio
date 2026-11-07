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

/**
 * 蒙版裁剪：把 source 的 alpha 乘上蒙版的覆盖度，用于「生成图按产品轮廓挖洞」。
 *
 * 只改 alpha，不动 RGB —— ImageData 是非预乘的，按覆盖率缩放 RGB 会让半透明边缘发暗，
 * 而挖洞场景要的是「同样的颜色、不同的覆盖面」。
 *
 * mode：
 * - 'luminance' 灰度蒙版（白=保留，黑=挖掉），典型是用户上传的蒙版 PNG；
 * - 'alpha'     用蒙版自身的 alpha 作覆盖度，典型是「取某个图层的轮廓」（产品层）。
 * 两种模式都先乘以蒙版自身的 alpha，因此带透明边的蒙版不会越界。
 *
 * featherPx > 0 时先用 blurAlpha 软化覆盖度，得到自然的边缘过渡。
 */
export function applyMask(source, mask, { mode = 'luminance', invert = false, featherPx = 0 } = {}) {
  if (mask.width !== source.width || mask.height !== source.height) {
    throw new Error('蒙版尺寸必须与源图一致');
  }
  const { width, height } = source;
  const coverage = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < coverage.length; i += 1, p += 4) {
    const alpha = mask.data[p + 3];
    let value;
    if (mode === 'alpha') {
      value = alpha;
    } else {
      const luminance = 0.2126 * mask.data[p] + 0.7152 * mask.data[p + 1] + 0.0722 * mask.data[p + 2];
      value = Math.round(luminance * alpha / 255);
    }
    coverage[i] = value;
  }
  let soft = coverage;
  if (featherPx > 0) {
    const carrier = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let i = 0, p = 0; i < coverage.length; i += 1, p += 4) {
      carrier.data[p] = 255; carrier.data[p + 1] = 255; carrier.data[p + 2] = 255;
      carrier.data[p + 3] = coverage[i];
    }
    const blurred = blurAlpha(carrier, featherPx);
    soft = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < soft.length; i += 1, p += 4) soft[i] = blurred.data[p + 3];
  }
  const out = { width, height, data: new Uint8ClampedArray(source.data) };
  for (let i = 0, p = 0; i < soft.length; i += 1, p += 4) {
    const maskValue = invert ? 255 - soft[i] : soft[i];
    out.data[p + 3] = Math.round(source.data[p + 3] * maskValue / 255);
  }
  return out;
}

/**
 * 把纯数据结果转成真正的 ImageData —— putImageData 只接受 ImageData，传普通对象会抛
 * "parameter 1 is not of type 'ImageData'"。所有像素动作写回画布前都必须经过这里。
 */
export function ensureImageData(image, ImageDataCtor = globalThis.ImageData) {
  const width = image?.width, height = image?.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError('像素尺寸无效');
  }
  if (typeof ImageDataCtor === 'function' && image instanceof ImageDataCtor) return image;
  const source = image?.data;
  const data = source instanceof Uint8ClampedArray ? source : new Uint8ClampedArray(source || []);
  if (data.length !== width * height * 4) throw new RangeError(`像素数据长度 ${data.length} 与尺寸 ${width}×${height} 不匹配`);
  if (typeof ImageDataCtor !== 'function') throw new Error('当前环境不支持 ImageData');
  return new ImageDataCtor(data, width, height);
}

/**
 * 种子擦除（等价于人类用魔棒点一下背景再删）：
 * 只在种子点所在颜色相同的**连通区域**内擦除，不跨过颜色边界，因此不会像全局判定那样
 * 从边缘一路啃进商品内部。tolerance 是 0..100 的相似度，越大吃掉的相近色越多。
 */
export function magicErase(image, { x, y, tolerance = 10, contiguous = true } = {}) {
  const { width, height, data } = image || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new RangeError('Invalid image for magic erase.');
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw new RangeError('Seed point is outside the image.');
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw new RangeError('tolerance must be 0..100.');
  const seed = (y * width + x) * 4;
  if (data[seed + 3] === 0) return { image: { width, height, data: new Uint8ClampedArray(data) }, erased: 0, seedColor: null };
  const target = [data[seed], data[seed + 1], data[seed + 2]];
  const threshold = tolerance * 255 / 100;
  // 单通道比较（比三通道求和更严格），避免把商品里的暗部当成背景
  const matches = pixel => {
    const p = pixel * 4;
    if (data[p + 3] === 0) return true;
    return Math.abs(data[p] - target[0]) <= threshold &&
      Math.abs(data[p + 1] - target[1]) <= threshold &&
      Math.abs(data[p + 2] - target[2]) <= threshold;
  };
  const erasedMask = new Uint8Array(width * height);
  const stack = [y * width + x];
  while (stack.length) {
    const pixel = stack.pop();
    if (pixel < 0 || pixel >= erasedMask.length || erasedMask[pixel] || !matches(pixel)) continue;
    erasedMask[pixel] = 1;
    const px = pixel % width;
    if (px > 0) stack.push(pixel - 1);
    if (px + 1 < width) stack.push(pixel + 1);
    if (pixel >= width) stack.push(pixel - width);
    if (pixel + width < erasedMask.length) stack.push(pixel + width);
  }
  if (!contiguous) {
    // 非连通模式：整张图范围内按颜色擦（等价魔棒的"全局"选项），仍受单通道阈值约束
    for (let pixel = 0; pixel < erasedMask.length; pixel += 1) if (!erasedMask[pixel] && matches(pixel)) erasedMask[pixel] = 1;
  }
  const out = { width, height, data: new Uint8ClampedArray(data) };
  let erased = 0;
  for (let pixel = 0; pixel < erasedMask.length; pixel += 1) {
    if (!erasedMask[pixel]) continue;
    out.data[pixel * 4 + 3] = 0;
    erased += 1;
  }
  return { image: out, erased, coverage: erased / (width * height), seedColor: target };
}

/**
 * 自动去背景（纯本地，不依赖任何模型）：从四条边界采样主背景色，再按连通域擦除。
 * 适用于电商白底/纯色底商品图；背景复杂或有渐变时覆盖率会很低，调用方据此如实回报。
 * 不猜、不补：只擦“与边界背景色接近且与边界连通”的像素，商品内部的同色高光不会被吃掉。
 * @returns {{image: object, coverage: number, background: number[], bbox: object|null}}
 */
export function removeFlatBackground(image, { tolerance = 8, featherPx = 0 } = {}) {
  const { width, height, data } = image || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new RangeError('Invalid image for background removal.');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw new RangeError('tolerance must be 0..100.');
  if (!Number.isFinite(featherPx) || featherPx < 0 || featherPx > 64) throw new RangeError('featherPx must be 0..64.');

  // 1) 边界采样：量化到 5 位/通道后取众数，再用该桶内像素求均值，避免抗锯齿边缘拉偏。
  const border = [];
  for (let x = 0; x < width; x += 1) { border.push(x); border.push((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { border.push(y * width); border.push(y * width + width - 1); }
  const buckets = new Map();
  for (const pixel of border) {
    const p = pixel * 4;
    if (data[p + 3] === 0) continue;
    const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
    const entry = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    entry.count += 1; entry.r += data[p]; entry.g += data[p + 1]; entry.b += data[p + 2];
    buckets.set(key, entry);
  }
  // 背景模型：取边界里最主要的若干个颜色簇（而不是单一主色）。
  // 磨砂面/石材这类纹理背景会同时出现深色底与浅色噪点，只用一个颜色必然擦不干净。
  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count);
  const clusters = [];
  const totalBorder = ranked.reduce((sum, entry) => sum + entry.count, 0) || 1;
  let covered = 0;
  for (const entry of ranked) {
    if (clusters.length >= 6) break;
    if (covered / totalBorder >= 0.85) break;
    const color = [Math.round(entry.r / entry.count), Math.round(entry.g / entry.count), Math.round(entry.b / entry.count)];
    // 与已有簇太近就合并，避免同一颜色被重复计数。
    const duplicate = clusters.find(item => Math.abs(item.color[0] - color[0]) + Math.abs(item.color[1] - color[1]) + Math.abs(item.color[2] - color[2]) < 24);
    if (duplicate) { duplicate.weight += entry.count; continue; }
    clusters.push({ color, weight: entry.count });
    covered += entry.count;
  }
  if (!clusters.length) clusters.push({ color: [0, 0, 0], weight: 1 });
  const background = clusters[0].color.slice();
  const threshold = tolerance * 255 / 100;
  const matches = pixel => {
    const p = pixel * 4;
    if (data[p + 3] === 0) return true;                       // 已透明，视为背景
    let best = Infinity;
    for (const cluster of clusters) {
      const d = Math.abs(data[p] - cluster.color[0]) + Math.abs(data[p + 1] - cluster.color[1]) + Math.abs(data[p + 2] - cluster.color[2]);
      if (d < best) best = d;
    }
    return best <= threshold / 2.2;                           // 三通道和 → 单通道阈值的近似换算
  };

  // 2) 从所有边界像素做 4 连通洪水填充：只擦与边界相连的背景区域。
  const erased = new Uint8Array(width * height);
  const stack = [];
  for (const pixel of border) if (!erased[pixel] && matches(pixel)) { erased[pixel] = 1; stack.push(pixel); }
  while (stack.length) {
    const pixel = stack.pop();
    const px = pixel % width;
    const neighbours = [];
    if (px > 0) neighbours.push(pixel - 1);
    if (px + 1 < width) neighbours.push(pixel + 1);
    if (pixel >= width) neighbours.push(pixel - width);
    if (pixel + width < width * height) neighbours.push(pixel + width);
    for (const next of neighbours) {
      if (erased[next] || !matches(next)) continue;
      erased[next] = 1;
      stack.push(next);
    }
  }

  // 3) 去噪点：贴在背景上、且面积很小的前景孤岛（纹理碎屑）也一并擦掉；
  //    面积大的连通块一定是商品，绝不碰。这一步是"磨砂面擦不干净"的关键补丁。
  const minIsland = Math.max(8, Math.round(width * height * 0.0004));
  const visited = new Uint8Array(width * height);
  let despeckled = 0;
  for (let start = 0; start < erased.length; start += 1) {
    if (visited[start] || erased[start] || data[start * 4 + 3] === 0) continue;
    const component = [];
    let touchesErased = false;
    const queue = [start];
    visited[start] = 1;
    while (queue.length) {
      const pixel = queue.pop();
      component.push(pixel);
      const px = pixel % width;
      const neighbours = [];
      if (px > 0) neighbours.push(pixel - 1);
      if (px + 1 < width) neighbours.push(pixel + 1);
      if (pixel >= width) neighbours.push(pixel - width);
      if (pixel + width < width * height) neighbours.push(pixel + width);
      for (const next of neighbours) {
        if (erased[next]) { touchesErased = true; continue; }
        if (visited[next] || data[next * 4 + 3] === 0) continue;
        visited[next] = 1;
        queue.push(next);
      }
      if (component.length > minIsland * 4) break;             // 大块直接放弃，不做无谓遍历
    }
    if (touchesErased && component.length <= minIsland) {
      for (const pixel of component) { erased[pixel] = 1; despeckled += 1; }
    }
  }

  const out = { width, height, data: new Uint8ClampedArray(data) };
  let erasedCount = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let pixel = 0; pixel < erased.length; pixel += 1) {
    const p = pixel * 4;
    if (erased[pixel]) { out.data[p + 3] = 0; erasedCount += 1; continue; }
    if (data[p + 3] === 0) continue;
    const x = pixel % width, y = (pixel - x) / width;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const soft = featherPx > 0 ? blurAlpha(out, featherPx) : out;
  const bbox = maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  return { image: soft, coverage: erasedCount / (width * height), background, bbox, clusters: clusters.length, despeckled };
}
