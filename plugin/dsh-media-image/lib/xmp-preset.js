// XMP / Camera Raw 预设解析与映射。
//
// 目标不是"完整还原 Lightroom"，而是把预设里**真正能落到 miniPaint 上的部分**转成可执行参数，
// 并把还原不了的部分如实列出来。miniPaint 的非破坏调整只有 CSS filter 那九项
// （blur/brightness/contrast/saturate/grayscale/sepia/invert/hueRotate/opacity），
// 没有色调曲线、没有分区 HSL —— 这些字段一律进 unmapped，绝不假装能还原。
//
// 零依赖：XMP 是文本 XML，用正则抓 crs:* 的两种写法（元素文本 / 属性）就够，
// 不引入 XML 解析器（Preset 文件常有未声明的命名空间前缀，通用解析器反而更容易炸）。

/** Camera Raw 里对本项目有意义的字段（其余字段只保留原值，不参与映射）。 */
export const KNOWN_KEYS = [
  'Exposure2012', 'Contrast2012', 'Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012',
  'Temperature', 'Tint', 'Vibrance', 'Saturation',
  'Clarity2012', 'Dehaze', 'Texture', 'SharpenAmount',
  'SplitToningHighlightHue', 'SplitToningHighlightSaturation', 'SplitToningShadowHue', 'SplitToningShadowSaturation',
  'GrainAmount', 'VignetteAmount',
];

/** 明确"miniPaint 做不到"的字段：列出来是为了让人知道差异在哪，不是为了省事。 */
export const UNMAPPED_KEYS = {
  Highlights2012: '高光恢复需要色调曲线，miniPaint 的 CSS filter 没有',
  Shadows2012: '阴影提亮需要色调曲线',
  Whites2012: '白场需要色阶/曲线',
  Blacks2012: '黑场需要色阶/曲线',
  Clarity2012: '局部对比（中频）无等价实现',
  Dehaze: '去雾是专用算法，不是亮度/对比能替代的',
  Texture: '纹理是局部中频细节，无等价实现',
  SharpenAmount: '锐化需要卷积，CSS filter 里没有（blur 只做模糊）',
  SplitToningHighlightHue: '分离色调需要双色映射，只能近似成纯色叠加层（见 overlays）',
  GrainAmount: '颗粒是噪声纹理，当前没有该效果',
  VignetteAmount: '暗角需要径向遮罩 + 亮度调整，当前没有',
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = value => {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * 解析 XMP 文本，取出 crs:* 参数。
 * 同时支持两种写法：
 *   <crs:Exposure2012>0.30</crs:Exposure2012>
 *   crs:Exposure2012="0.30"     （rdf:Description 的属性写法，Lightroom 导出常见）
 * @returns {{name:string|null, params:Record<string,string>, raw:Record<string,string>}}
 */
export function parseXmp(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw Object.assign(new Error('XMP 内容为空'), { code: 'XMP_EMPTY' });
  }
  // 只认 Camera Raw 命名空间下的 crs: 前缀；别的命名空间同名键不算。
  const params = {};
  for (const match of text.matchAll(/<crs:([A-Za-z0-9_]+)>([^<]*)<\/crs:\1>/g)) {
    params[match[1]] = match[2].trim();
  }
  for (const match of text.matchAll(/\bcrs:([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g)) {
    if (!(match[1] in params)) params[match[1]] = match[2].trim();
  }
  if (!Object.keys(params).length) {
    throw Object.assign(new Error('这个文件里没有 crs: 参数，可能不是 Camera Raw 预设'), { code: 'XMP_NO_CRS' });
  }
  // 预设名：dc:title 或 xmp:Label 或 rdf:Description 的 name 属性
  const nameMatch = /<rdf:li[^>]*>([^<]{1,80})<\/rdf:li>/.exec(text)
    ?? /xmp:Label\s*=\s*"([^"]{1,80})"/.exec(text)
    ?? /dc:title[\s\S]{0,200}?<rdf:li[^>]*>([^<]{1,80})<\/rdf:li>/.exec(text);
  const name = nameMatch ? nameMatch[1].trim() : null;
  const raw = {};
  for (const [key, value] of Object.entries(params)) if (KNOWN_KEYS.includes(key)) raw[key] = value;
  return { name, params, raw };
}

/** 色温/色调 → 一层纯色叠加（近似）。Camera Raw 的色温是线性白平衡，这里只能用色偏近似。 */
function toneOverlay(raw) {
  const overlays = [];
  const temperature = num(raw.Temperature);
  const tint = num(raw.Tint);
  // Lightroom 预设里温度常写绝对值（如 6500）或偏移（±100）；这里按"偏移"解释并说明。
  const pushOverlay = (value, warmHex, coolHex, maxOpacity, label) => {
    if (value === null || value === 0) return;
    const strength = clamp(Math.abs(value) / 100, 0, 1);
    if (strength < 0.02) return;
    overlays.push({ color: value > 0 ? warmHex : coolHex, opacity: Number((strength * maxOpacity).toFixed(3)), blendMode: 'overlay', reason: label });
  };
  pushOverlay(temperature, '#ffb46b', '#6bb4ff', 0.35, '色温偏暖/偏冷（近似为纯色叠加）');
  pushOverlay(tint, '#ff6bb4', '#6bffb4', 0.25, '色调偏洋红/偏绿（近似为纯色叠加）');
  return overlays;
}

/**
 * 把 Camera Raw 参数映射成 miniPaint 能执行的调整。
 *
 * 三个产出：
 *  - effects：直接可用的 dshEffects（非破坏 CSS filter）
 *  - overlays：色温/色调的近似纯色叠加层
 *  - unmapped：还原不了的字段 + 原因（**必须**给调用方看）
 *
 * @returns {{effects:object, overlays:Array, unmapped:Array<{key:string,value:string,reason:string}>, assumptions:string[]}}
 */
export function mapToMiniPaint(raw) {
  const effects = {};
  const assumptions = [];

  const exposure = num(raw.Exposure2012);
  if (exposure !== null && exposure !== 0) {
    // 0.18/EV 是经验系数：CSS brightness 是乘性缩放，与 Lightroom 的线性曝光只是近似。
    effects.brightness = Number(clamp(1 + exposure * 0.18, 0.2, 3).toFixed(3));
    assumptions.push(`曝光 ${exposure} EV → brightness ${effects.brightness}（乘性近似，非线性等值）`);
  }
  const contrast = num(raw.Contrast2012);
  if (contrast !== null && contrast !== 0) {
    effects.contrast = Number(clamp(1 + (contrast / 100) * 0.5, 0.5, 3).toFixed(3));
    assumptions.push(`对比 ${contrast} → contrast ${effects.contrast}`);
  }
  const saturation = num(raw.Saturation);
  const vibrance = num(raw.Vibrance);
  if ((saturation !== null && saturation !== 0) || (vibrance !== null && vibrance !== 0)) {
    // vibrance 只提低饱和像素，CSS saturate 是均匀提升；按半权叠加并标注。
    const combined = (saturation ?? 0) + (vibrance ?? 0) * 0.5;
    effects.saturate = Number(clamp(1 + combined / 100, 0.2, 3).toFixed(3));
    assumptions.push(`饱和 ${saturation ?? 0} + 自然饱和 ${vibrance ?? 0} → saturate ${effects.saturate}（自然饱和按半权近似）`);
  }

  const unmapped = [];
  for (const [key, reason] of Object.entries(UNMAPPED_KEYS)) {
    const value = raw[key];
    if (value !== undefined && value !== '' && num(value) !== 0) unmapped.push({ key, value, reason });
  }
  // 未知但存在的字段也要报：不能悄悄丢掉。
  for (const key of Object.keys(raw)) {
    if (KNOWN_KEYS.includes(key)) continue;
    unmapped.push({ key, value: raw[key], reason: '未识别的 Camera Raw 字段' });
  }
  return { effects, overlays: toneOverlay(raw), unmapped, assumptions };
}

/** 一步到位的入口：XMP 文本 → 可直接展示/执行的方案。 */
export function planPresetFromXmp(text) {
  const parsed = parseXmp(text);
  const mapped = mapToMiniPaint(parsed.raw);
  const executable = Object.keys(mapped.effects).length > 0 || mapped.overlays.length > 0;
  return {
    name: parsed.name,
    params: parsed.raw,
    effects: mapped.effects,
    overlays: mapped.overlays,
    unmapped: mapped.unmapped,
    assumptions: mapped.assumptions,
    executable,
    note: executable
      ? `可用 ${Object.keys(mapped.effects).join('/') || '纯色叠加'}${Object.keys(mapped.effects).length ? ' 近似' : ''}还原${mapped.unmapped.length ? `；另有 ${mapped.unmapped.length} 项还原不了（见 unmapped）` : ''}。`
      : `这个预设的调整项 miniPaint 都还原不了（见 unmapped），不要假装套用。`,
  };
}
