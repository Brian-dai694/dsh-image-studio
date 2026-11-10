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
  // 8 个色相带的 HSL（Lightroom 口径）
  ...['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'].flatMap(name => [
    `HueAdjustment${name}`, `SaturationAdjustment${name}`, `LuminanceAdjustment${name}`,
  ]),
];

/** 现在这些字段**能**还原了（走像素分级），所以从"做不到"名单里移除。 */
export const UNMAPPED_KEYS = {
  Clarity2012: '局部对比（中频）无等价实现',
  Dehaze: '去雾是专用算法，不是亮度/对比能替代的',
  Texture: '纹理是局部中频细节，无等价实现',
  SharpenAmount: '锐化需要卷积，当前没有该效果',
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

const BAND_NAMES = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
const BAND_SUFFIX = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', aqua: 'Aqua', blue: 'Blue', purple: 'Purple', magenta: 'Magenta' };

/** ToneCurvePV2012 之类的曲线：rdf:Seq 里是 "x, y" 形式的字符串。 */
function parseCurve(text, key) {
  // 兼容两种写法：整段 <crs:Key>...</crs:Key>，或属性 crs:Key="0, 0 255, 255"。
  const element = new RegExp(`<crs:${key}>([\\s\\S]*?)</crs:${key}>`).exec(text);
  const attribute = new RegExp(`crs:${key}\\s*=\\s*"([^"]*)"`).exec(text);
  const body = element?.[1] ?? attribute?.[1];
  if (!body) return null;
  const points = [];
  for (const match of body.matchAll(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g)) {
    points.push({ x: Number.parseFloat(match[1]), y: Number.parseFloat(match[2]) });
  }
  if (points.length < 2) return null;
  return points.sort((a, b) => a.x - b.x);
}

/**
 * 把 Camera Raw 参数整理成编辑器的 `layer.apply_grade` 参数。
 * 这是"真的算像素"的路径：曲线 / 高光阴影 / 分区 HSL / 分离色调都在这里，
 * 只有 local（清晰度/去雾/颗粒/暗角）留给 unmapped。
 */
export function buildGrade(raw, text = '') {
  const grade = {};
  const assign = (key, target, scale = 1) => {
    const value = num(raw[key]);
    if (value === null || value === 0) return false;
    target[scale === 1 ? key : 'x'] = value;
    return true;
  };
  const exposure = num(raw.Exposure2012);
  if (exposure !== null && exposure !== 0) grade.exposure = clamp(exposure, -5, 5);
  const contrast = num(raw.Contrast2012);
  if (contrast !== null && contrast !== 0) grade.contrast = clamp(contrast, -100, 100);
  for (const [key, field] of [['Highlights2012', 'highlights'], ['Shadows2012', 'shadows'], ['Whites2012', 'whites'], ['Blacks2012', 'blacks']]) {
    const value = num(raw[key]);
    if (value !== null && value !== 0) grade[field] = clamp(value, -100, 100);
  }
  // 显式曲线（含 RGB 分量）
  const master = parseCurve(text, 'ToneCurvePV2012');
  if (master) grade.curve = master;
  for (const [suffix, field] of [['Red', 'curveRed'], ['Green', 'curveGreen'], ['Blue', 'curveBlue']]) {
    const curve = parseCurve(text, `ToneCurvePV2012${suffix}`);
    if (curve) grade[field] = curve;
  }
  // 分区 HSL
  const hsl = {};
  for (const band of BAND_NAMES) {
    const suffix = BAND_SUFFIX[band];
    const entry = {};
    for (const [key, channel] of [[`HueAdjustment${suffix}`, 'hue'], [`SaturationAdjustment${suffix}`, 'sat'], [`LuminanceAdjustment${suffix}`, 'lum']]) {
      const value = num(raw[key]);
      if (value !== null && value !== 0) entry[channel] = clamp(value, -100, 100);
    }
    if (Object.keys(entry).length) hsl[band] = entry;
  }
  if (Object.keys(hsl).length) grade.hsl = hsl;
  // 分离色调
  const split = {};
  const highlightHue = num(raw.SplitToningHighlightHue), highlightSat = num(raw.SplitToningHighlightSaturation);
  const shadowHue = num(raw.SplitToningShadowHue), shadowSat = num(raw.SplitToningShadowSaturation);
  if (highlightHue !== null) split.highlightHue = ((highlightHue % 360) + 360) % 360;
  if (highlightSat !== null) split.highlightSat = clamp(highlightSat, 0, 100);
  if (shadowHue !== null) split.shadowHue = ((shadowHue % 360) + 360) % 360;
  if (shadowSat !== null) split.shadowSat = clamp(shadowSat, 0, 100);
  if (Object.keys(split).length) grade.splitTone = split;
  void assign;
  return Object.keys(grade).length ? grade : null;
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
  // 真像素这条路优先：曲线/HSL/分离色调都在 grade 里，能字节级还原（除了局部调整）。
  const grade = buildGrade(parsed.raw, text);
  const executable = Boolean(grade) || Object.keys(mapped.effects).length > 0 || mapped.overlays.length > 0;
  const parts = [];
  if (grade) {
    const items = [];
    if (grade.curve) items.push('master 曲线');
    if (grade.curveRed || grade.curveGreen || grade.curveBlue) items.push('通道曲线');
    if (grade.hsl) items.push(`${Object.keys(grade.hsl).length} 个色相带 HSL`);
    if (grade.splitTone) items.push('分离色调');
    for (const key of ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks']) if (grade[key] !== undefined) items.push(`${key}=${grade[key]}`);
    parts.push(`像素分级：${items.join('、')}`);
  }
  if (Object.keys(mapped.effects).length) parts.push(`滤镜近似：${Object.keys(mapped.effects).join('/')}`);
  if (mapped.overlays.length) parts.push(`色温近似：${mapped.overlays.map(item => item.color).join('/')}`);
  return {
    name: parsed.name,
    params: parsed.raw,
    grade,
    effects: mapped.effects,
    overlays: mapped.overlays,
    unmapped: mapped.unmapped,
    assumptions: mapped.assumptions,
    executable,
    note: executable
      ? `${parts.join('；')}${mapped.unmapped.length ? `。另有 ${mapped.unmapped.length} 项（${mapped.unmapped.map(item => item.key).join('、')}）miniPaint 做不到` : ''}。`
      : `这个预设的调整项 miniPaint 都还原不了（见 unmapped），不要假装套用。`,
  };
}
