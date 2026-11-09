// PSD 图层效果（描边 / 投影）的最小实现。
//
// 数据来源：附加图层信息块里的 `lmfx`（新版合并效果）或 `lfx2`（旧版），
// 内容是 Adobe 的 Descriptor 结构。这里只读我们真会画的字段，别的原样跳过——
// 不认识就报告"没还原"，绝不猜。

/** Adobe Unicode 字符串：uint32 字符数（含结尾 NUL）+ UTF-16BE。 */
function readUnicodeString(buffer, offset) {
  if (offset + 4 > buffer.length) throw new Error('PSD_DESCRIPTOR_TRUNCATED');
  const length = buffer.readUInt32BE(offset);
  let o = offset + 4;
  if (length === 0) return { value: '', size: o - offset };
  const chars = Math.max(0, length - 1);
  if (o + chars * 2 > buffer.length) throw new Error('PSD_DESCRIPTOR_TRUNCATED');
  let text = '';
  for (let i = 0; i < chars; i += 1) text += String.fromCharCode(buffer.readUInt16BE(o + i * 2));
  o += length * 2;
  return { value: text, size: o - offset };
}

const READERS = {
  Objc: readDescriptor,
  VlLs: readList,
  UntF: (buffer, o) => ({ value: buffer.readDoubleBE(o + 4), size: 12, unit: buffer.toString('ascii', o, o + 4) }),
  doub: (buffer, o) => ({ value: buffer.readDoubleBE(o), size: 8 }),
  long: (buffer, o) => ({ value: buffer.readInt32BE(o), size: 4 }),
  bool: (buffer, o) => ({ value: buffer.readUInt8(o) !== 0, size: 1 }),
  text: (buffer, o) => readUnicodeString(buffer, o),
  enum: (buffer, o) => {
    const type = readUnicodeString(buffer, o);
    const value = readUnicodeString(buffer, o + type.size);
    return { value: { type: type.value, value: value.value }, size: type.size + value.size };
  },
};

function readList(buffer, offset) {
  const count = buffer.readUInt32BE(offset);
  let o = offset + 4;
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const type = buffer.toString('ascii', o, o + 4);
    o += 4;
    const reader = READERS[type];
    if (!reader) throw new Error(`PSD_DESCRIPTOR_UNSUPPORTED_TYPE_${type.trim()}`);
    const item = reader(buffer, o);
    items.push(item.value);
    o += item.size;
  }
  return { value: items, size: o - offset };
}

/** 读一个 Descriptor：名字 + classID + 键值对。 */
export function readDescriptor(buffer, offset) {
  const name = readUnicodeString(buffer, offset);
  let o = offset + name.size;
  const classID = readUnicodeString(buffer, o);
  o += classID.size;
  if (o + 4 > buffer.length) throw new Error('PSD_DESCRIPTOR_TRUNCATED');
  const count = buffer.readUInt32BE(o);
  o += 4;
  const items = {};
  for (let i = 0; i < count; i += 1) {
    const key = readUnicodeString(buffer, o);
    o += key.size;
    if (o + 4 > buffer.length) throw new Error('PSD_DESCRIPTOR_TRUNCATED');
    const type = buffer.toString('ascii', o, o + 4);
    o += 4;
    const reader = READERS[type];
    if (!reader) throw new Error(`PSD_DESCRIPTOR_UNSUPPORTED_TYPE_${type.trim()}`);
    const item = reader(buffer, o);
    o += item.size;
    items[key.value] = item.value;
  }
  return { value: items, size: o - offset };
}

const colorOf = rgbc => {
  if (!rgbc || typeof rgbc !== 'object') return null;
  const r = Number(rgbc['Rd  ']), g = Number(rgbc['Grn ']), b = Number(rgbc['Bl  ']);
  if (![r, g, b].every(Number.isFinite)) return null;
  const a = Number.isFinite(Number(rgbc['A   '])) ? Number(rgbc['A   ']) : 1;
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a: Math.max(0, Math.min(1, a)) };
};

const sizeOf = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * 从 lmfx / lfx2 描述符里取描边与投影参数。
 * 未识别或未启用返回 null，调用方据此决定"还原/不还原"。
 */
export function readLayerEffects(descriptor) {
  const effects = {};
  if (!descriptor || typeof descriptor !== 'object') return effects;

  const stroke = descriptor.FrFX;
  if (stroke && stroke.enab !== false) {
    const color = colorOf(stroke['Clr ']);
    if (color) {
      const style = String(stroke.Styl?.value || 'OutF');
      effects.stroke = {
        color,
        size: Math.max(1, Math.round(sizeOf(stroke['Sz  '], 3))),
        opacity: Math.max(0, Math.min(1, sizeOf(stroke['Opct'], 100) / 100)),
        style: ['OutF', 'InsF', 'CtrF'].includes(style) ? style : 'OutF',
      };
    }
  }

  const shadow = descriptor.DrSh;
  if (shadow && shadow.enab !== false) {
    const color = colorOf(shadow['Clr ']);
    if (color) {
      effects.shadow = {
        color,
        opacity: Math.max(0, Math.min(1, sizeOf(shadow['Opct'], 75) / 100)),
        angle: sizeOf(shadow['lagl'], 120),
        distance: Math.max(0, sizeOf(shadow['Dstn'], 5)),
        blur: Math.max(0, sizeOf(shadow['Ckmt'], 5)),
      };
    }
  }

  return effects;
}

/** 由 PSD 的角度与距离算屏幕偏移：PS 的角度是光照方向，阴影落在反方向。 */
export function shadowOffset(angleDegrees, distance) {
  const theta = ((angleDegrees + 180) * Math.PI) / 180;
  return { dx: Math.round(Math.cos(theta) * distance), dy: Math.round(-Math.sin(theta) * distance) };
}

/** 4 邻域 max 膨胀：把 alpha 向外扩 radius 像素。 */
export function dilate(alpha, width, height, radius) {
  let current = Float32Array.from(alpha);
  for (let step = 0; step < radius; step += 1) {
    const next = new Float32Array(current);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        let best = current[i];
        if (x > 0) best = Math.max(best, current[i - 1]);
        if (x + 1 < width) best = Math.max(best, current[i + 1]);
        if (y > 0) best = Math.max(best, current[i - width]);
        if (y + 1 < height) best = Math.max(best, current[i + width]);
        next[i] = best;
      }
    }
    current = next;
  }
  return current;
}

/** 可分离 box blur，两趟近似高斯。 */
export function blurAlpha(alpha, width, height, radius) {
  if (radius <= 0) return Float32Array.from(alpha);
  const pass = (src, horizontal) => {
    const out = new Float32Array(src.length);
    const span = radius * 2 + 1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const sx = horizontal ? Math.min(width - 1, Math.max(0, x + k)) : x;
          const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + k));
          sum += src[sy * width + sx];
        }
        out[y * width + x] = sum / span;
      }
    }
    return out;
  };
  return pass(pass(alpha, true), false);
}

/**
 * 把一层效果 alpha 合成到画布上（normal、单色）。
 * alpha 与 layers 同尺寸；rect 是这层的包围盒，用来限制计算范围。
 */
export function compositeTintedAlpha(canvas, alpha, width, color, opacity, rect) {
  const { left, top, right, bottom } = rect;
  for (let y = Math.max(0, top); y < Math.min(canvas.height, bottom); y += 1) {
    for (let x = Math.max(0, left); x < Math.min(canvas.width, right); x += 1) {
      const a = alpha[y * width + x] * opacity * color.a;
      if (a <= 0.002) continue;
      const dst = (y * canvas.width + x) * 4;
      const sa = Math.min(1, a);
      const da = canvas.data[dst + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const src = c === 0 ? color.r : c === 1 ? color.g : color.b;
        canvas.data[dst + c] = Math.round((src * sa + canvas.data[dst + c] * da * (1 - sa)) / outA);
      }
      canvas.data[dst + 3] = Math.round(outA * 255);
    }
  }
}

export { readUnicodeString };
