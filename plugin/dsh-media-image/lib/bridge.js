// Editor adapter for the image editor.
// Owns validation, idempotency, expectedRevision and unknown-outcome semantics.
// It never stores document state: the editor page is the only state owner.

const DEFAULT_TIMEOUT_MS = 10_000;

export class MediaBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MediaBridgeError';
    this.code = code;
    Object.assign(this, details);
  }
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const opaqueId = (value, name) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new MediaBridgeError('INVALID_REQUEST', `${name} must be a non-empty string up to 256 characters.`);
  }
};
const finite = (value, name, { min = -Infinity, max = Infinity } = {}) => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new MediaBridgeError('INVALID_REQUEST', `${name} is outside the supported range.`);
  }
};

const IMAGE_COMMANDS = new Set(['layer.add_text', 'layer.update_text', 'layer.add_image', 'layer.set_frame', 'layer.align', 'layer.duplicate', 'layer.rasterize', 'layer.merge_down', 'layer.paint_stroke', 'layer.set_effect', 'layer.remove_effect', 'layer.update_mask', 'layer.set_appearance', 'layer.feather', 'layer.color_match', 'layer.apply_grade', 'layer.remove_background', 'layer.magic_erase', 'layer.add_mask_layer', 'layer.set_transform', 'layer.set_visibility', 'layer.reorder', 'layer.remove', 'canvas.resize', 'canvas.crop', 'history.undo', 'history.redo', 'history.batch']);

// dshEffects 的非破坏效果词表与取值域。**必须与编辑器 dsh-editor-bridge.js 的
// DSH_EFFECT_RANGES 完全一致**（顺序也一致，因为 CSS filter 的先后会改变结果）——
// 有测试逐项比对两边，任何一边改了另一边没跟上会当场失败。
export const DSH_EFFECT_RANGES = {
  blur: [0, 50],
  brightness: [0, 3],
  contrast: [0, 3],
  saturate: [0, 3],
  grayscale: [0, 1],
  sepia: [0, 1],
  invert: [0, 1],
  hueRotate: [-180, 180],
  opacity: [0, 1],
};

// 与编辑器 modules/layer/composition.js 同源：Canvas globalCompositeOperation 全集。
export const BLEND_MODES = new Set(['color', 'color-burn', 'color-dodge', 'copy', 'darken', 'darker', 'destination-atop', 'destination-in', 'destination-out', 'destination-over', 'difference', 'exclusion', 'hard-light', 'hue', 'lighten', 'lighter', 'luminosity', 'multiply', 'overlay', 'saturation', 'screen', 'soft-light', 'source-atop', 'source-in', 'source-out', 'source-over', 'xor']);
const fieldsOnly = (payload, fields) => {
  const unknown = Object.keys(payload).find(key => !fields.includes(key));
  if (unknown) throw new MediaBridgeError('INVALID_REQUEST', `Unsupported payload field: ${unknown}. Read the operation parameter contract.`);
};

export const ALLOWED_COMMANDS = { image: IMAGE_COMMANDS };

// 需要人工审批的命令：既不能藏在批量里，也不能在计划里。
export const HIGH_RISK_COMMANDS = new Set(['layer.remove', 'canvas.crop', 'layer.add_image']);

// 图片命令校验：白名单 + 逐字段类型/范围检查，必须在发给编辑器之前拒绝。
// 重点边界：canvas 尺寸 1..16384 像素、crop 的 x/y 非负、transform 必须平铺字段、
// 带守卫的撤销必须同时给 targetCommandId 与 afterDigest、像素框/羽化/调色的取值域。
function validateImageCommand(command) {
  const p = command.payload;
  if (!IMAGE_COMMANDS.has(command.type)) throw new MediaBridgeError('UNSUPPORTED_COMMAND', 'Command is not in the image allowlist.');
  if (!isObject(p)) throw new MediaBridgeError('INVALID_REQUEST', 'Command payload must be an object.');
  const fields = {
    'history.undo': ['targetCommandId', 'afterDigest'], 'history.redo': [], 'canvas.resize': ['width', 'height'],
    'canvas.crop': ['x', 'y', 'width', 'height'], 'layer.remove': ['layerId'],
    'layer.add_text': ['text', 'x', 'y', 'style', 'fontUrl'], 'layer.update_text': ['layerId', 'text', 'fontUrl', 'style'],
    'layer.set_transform': ['layerId', 'x', 'y', 'scaleX', 'scaleY', 'rotationDeg'],
    'layer.set_visibility': ['layerId', 'visible'], 'layer.reorder': ['layerId', 'toIndex'],
    'layer.set_appearance': ['layerId', 'opacity', 'blendMode', 'name'],
    'layer.add_image': ['sourceRef', 'x', 'y', 'width', 'height', 'fit', 'name', 'maskRef', 'maskRect', 'maskMode', 'maskInvert', 'featherPx'],
    'layer.set_frame': ['layerId', 'x', 'y', 'width', 'height', 'fit', 'anchor'],
    'layer.align': ['layerId', 'h', 'v', 'margin', 'to'],
    'layer.duplicate': ['layerId', 'offsetX', 'offsetY', 'name'],
    'layer.rasterize': ['layerId', 'name'],
    'layer.merge_down': ['layerId', 'name'],
    'layer.paint_stroke': ['layerId', 'points', 'color', 'size', 'opacity'],
    'layer.set_effect': ['layerId', 'effect', 'value'],
    'layer.remove_effect': ['layerId', 'effect'],
    'layer.update_mask': ['layerId', 'invert', 'sourceLayerId', 'remove'],
    'layer.feather': ['layerId', 'radiusPx'],
    'layer.color_match': ['layerId', 'method', 'strength', 'reference'],
  // 色调曲线 + 分区 HSL：真像素分级（CSS filter 表达不了这些）
  'layer.apply_grade': ['layerId', 'grade'],
    'layer.remove_background': ['layerId', 'tolerance', 'featherPx'],
    'layer.magic_erase': ['layerId', 'x', 'y', 'tolerance', 'contiguous'],
    'layer.add_mask_layer': ['sourceLayerId', 'mode', 'tolerance', 'featherPx', 'name'],
    'history.batch': ['steps', 'name'],
  };
  fieldsOnly(p, fields[command.type]);
  if (command.type === 'layer.update_text' && p.style !== undefined) {
    // 只允许改颜色：这是"文字与背景对比不足"唯一能落地的自动修复动作。
    if (!isObject(p.style)) throw new MediaBridgeError('INVALID_REQUEST', 'style must be an object.');
    const extra = Object.keys(p.style).find(key => key !== 'fill_color');
    if (extra) throw new MediaBridgeError('INVALID_REQUEST', `style only supports fill_color, got ${extra}.`);
    if (p.style.fill_color !== undefined && !/^#[0-9a-f]{6}$/i.test(p.style.fill_color)) {
      throw new MediaBridgeError('INVALID_REQUEST', 'fill_color must be #rrggbb.');
    }
  }
  if (command.type === 'history.batch') {
    // 批量 = 编辑器里一条历史记录（Bundle_action）。这里只做形状与策略校验，
    // 每条步骤的字段细节由编辑器按同一套白名单再验一次。
    if (!Array.isArray(p.steps) || p.steps.length < 1 || p.steps.length > 12) {
      throw new MediaBridgeError('INVALID_REQUEST', 'steps must contain 1..12 commands.');
    }
    if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 80)) {
      throw new MediaBridgeError('INVALID_REQUEST', 'name must be a string up to 80 characters.');
    }
    for (const [index, step] of p.steps.entries()) {
      if (!isObject(step)) throw new MediaBridgeError('INVALID_REQUEST', `step ${index + 1} must be an object.`);
      const extra = Object.keys(step).find(key => key !== 'type' && key !== 'payload');
      if (extra) throw new MediaBridgeError('INVALID_REQUEST', `step ${index + 1} has an unsupported field: ${extra}.`);
      if (typeof step.type !== 'string' || !IMAGE_COMMANDS.has(step.type)) {
        throw new MediaBridgeError('UNSUPPORTED_COMMAND', `step ${index + 1} is not in the image allowlist.`);
      }
      if (step.type.startsWith('history.')) throw new MediaBridgeError('INVALID_REQUEST', `step ${index + 1}: batch cannot contain history commands.`);
      // 与 run_plan 同一条策略：高危动作必须单独走审批，不能藏在批量里。
      if (HIGH_RISK_COMMANDS.has(step.type)) {
        throw new MediaBridgeError('HIGH_RISK_IN_PLAN', `step ${index + 1}: ${step.type} needs its own approval and cannot be batched.`);
      }
      if (step.payload !== undefined && !isObject(step.payload)) throw new MediaBridgeError('INVALID_REQUEST', `step ${index + 1} payload must be an object.`);
    }
  }
  if (command.type === 'history.undo' && (p.targetCommandId !== undefined || p.afterDigest !== undefined)) {
    opaqueId(p.targetCommandId, 'targetCommandId'); opaqueId(p.afterDigest, 'afterDigest');
  }
  if (command.type.startsWith('canvas.')) {
    for (const key of ['width', 'height']) {
      if (!Number.isSafeInteger(p[key]) || p[key] < 1 || p[key] > 16384) throw new MediaBridgeError('INVALID_REQUEST', `${key} must be an integer between 1 and 16384 pixels.`);
    }
    if (command.type === 'canvas.crop') for (const key of ['x', 'y']) {
      if (!Number.isSafeInteger(p[key]) || p[key] < 0) throw new MediaBridgeError('INVALID_REQUEST', `${key} must be a non-negative pixel integer.`);
    }
  }
  if (command.type === 'layer.remove') opaqueId(p.layerId, 'layerId');
  if (command.type === 'layer.add_text' || command.type === 'layer.update_text') {
    if (typeof p.text !== 'string' || p.text.length > 4000) throw new MediaBridgeError('INVALID_REQUEST', 'text must be a string up to 4000 characters.');
    if (command.type === 'layer.update_text') opaqueId(p.layerId, 'layerId');
    // The image editor requires an explicit insertion point; reject it here so the model
    // gets a field-level error instead of a late editor failure.
    // x/y are optional: the editor centers the text when omitted. If one is supplied it
    // must be a number, so a typo still fails at the plugin instead of inside the editor.
    if (command.type === 'layer.add_text') {
      if ((p.x === undefined) !== (p.y === undefined)) {
        throw new MediaBridgeError('INVALID_REQUEST', 'layer.add_text needs both x and y, or neither (the editor centers the text).');
      }
      if (p.x !== undefined) { finite(p.x, 'x'); finite(p.y, 'y'); }
    }
    // 字体只认已登记字体的同源地址；跨站 URL 一律拒绝，避免 fontUrl 变成任意下载口。
    if (p.fontUrl !== undefined && (typeof p.fontUrl !== 'string' || !/^\/media-image\/fonts\/[a-f0-9]{48}$/.test(p.fontUrl))) {
      throw new MediaBridgeError('INVALID_REQUEST', 'fontUrl must be /media-image/fonts/<48-char id> from POST /media-image/fonts.');
    }
  }
  if (command.type === 'layer.set_transform') {
    opaqueId(p.layerId, 'layerId');
    const keys = ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg'].filter(key => p[key] !== undefined);
    if (!keys.length) throw new MediaBridgeError('INVALID_REQUEST', 'Provide x/y/scaleX/scaleY/rotationDeg as flat params, not transform.');
    for (const key of keys) finite(p[key], key, key.startsWith('scale') ? { min: Number.MIN_VALUE } : {});
  }
  if (command.type === 'layer.set_visibility') {
    opaqueId(p.layerId, 'layerId');
    if (typeof p.visible !== 'boolean') throw new MediaBridgeError('INVALID_REQUEST', 'visible must be boolean.');
  }
  if (command.type === 'layer.set_appearance') {
    opaqueId(p.layerId, 'layerId');
    if (['opacity', 'blendMode', 'name'].every(key => p[key] === undefined)) throw new MediaBridgeError('INVALID_REQUEST', 'Provide at least one of opacity, blendMode or name.');
    if (p.opacity !== undefined) finite(p.opacity, 'opacity', { min: 0, max: 100 });
    if (p.blendMode !== undefined && !BLEND_MODES.has(p.blendMode)) throw new MediaBridgeError('INVALID_REQUEST', 'blendMode is not a supported compositing mode.');
    if (p.name !== undefined && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120)) throw new MediaBridgeError('INVALID_REQUEST', 'name must be a non-empty string up to 120 characters.');
  }
  if (command.type === 'layer.reorder') {
    opaqueId(p.layerId, 'layerId');
    if (!Number.isSafeInteger(p.toIndex) || p.toIndex < 0) throw new MediaBridgeError('INVALID_REQUEST', 'toIndex must be a non-negative integer.');
  }
  // 像素框统一规则：宽高成对出现且在 1..16384；坐标是可正可负的整数（允许出血放置）。
  const pixelSize = (key) => {
    if (!Number.isSafeInteger(p[key]) || p[key] < 1 || p[key] > 16384) throw new MediaBridgeError('INVALID_REQUEST', `${key} must be an integer between 1 and 16384 pixels.`);
  };
  const pixelPos = (key) => {
    if (!Number.isSafeInteger(p[key]) || p[key] < -16384 || p[key] > 16384) throw new MediaBridgeError('INVALID_REQUEST', `${key} must be an integer between -16384 and 16384 pixels.`);
  };
  const FRAME_FITS = ['stretch', 'contain', 'cover'];
  // 新层名：可省略；给了就必须是非空、≤120 字符的字符串。
  const assertOptionalName = (name) => {
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 120)) {
      throw new MediaBridgeError('INVALID_REQUEST', 'name must be a non-empty string up to 120 characters.');
    }
  };
  if (command.type === 'layer.add_image') {
    // 仅支持复制已有图层或受限内联图 data:image/(png|jpeg|webp);base64,...（解码后 ≤256 KB）。
    // asset:<id> 暂保留为格式兼容，但当前编辑器没有 asset 注册表，运行时会明确返回 ASSET_NOT_FOUND。
    validateImageSourceRef(p.sourceRef);
    if ((p.width === undefined) !== (p.height === undefined)) throw new MediaBridgeError('INVALID_REQUEST', 'layer.add_image needs both width and height, or neither (the source size is kept).');
    for (const key of ['width', 'height']) if (p[key] !== undefined) pixelSize(key);
    for (const key of ['x', 'y']) if (p[key] !== undefined) pixelPos(key);
    if (p.fit !== undefined && !FRAME_FITS.includes(p.fit)) throw new MediaBridgeError('INVALID_REQUEST', `fit must be one of ${FRAME_FITS.join(', ')}.`);
    if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 120)) throw new MediaBridgeError('INVALID_REQUEST', 'name must be a string up to 120 characters.');
    // 蒙版：maskRef 与 maskRect 互斥且至少给一个；附属参数不能脱离蒙版单独出现。
    const maskExtras = ['maskMode', 'maskInvert', 'featherPx'].filter(key => p[key] !== undefined);
    const hasRef = p.maskRef !== undefined;
    const hasRect = p.maskRect !== undefined;
    if (!hasRef && !hasRect) {
      if (maskExtras.length) throw new MediaBridgeError('INVALID_REQUEST', 'maskMode/maskInvert/featherPx require maskRef or maskRect.');
    } else if (hasRef && hasRect) {
      throw new MediaBridgeError('INVALID_REQUEST', 'Provide either maskRef or maskRect, not both.');
    } else if (hasRect) {
      // 矩形在画布坐标系里，Host 没有画布尺寸，只校验整数与取值范围。
      const rect = p.maskRect;
      if (!isObject(rect) || Object.keys(rect).some(key => !['x', 'y', 'width', 'height'].includes(key)) || ['x', 'y', 'width', 'height'].some(key => rect[key] === undefined)) {
        throw new MediaBridgeError('INVALID_REQUEST', 'maskRect needs x, y, width and height only.');
      }
      for (const key of ['x', 'y']) if (!Number.isSafeInteger(rect[key]) || rect[key] < -16384 || rect[key] > 16384) throw new MediaBridgeError('INVALID_REQUEST', `maskRect.${key} must be an integer within ±16384 pixels.`);
      for (const key of ['width', 'height']) if (!Number.isSafeInteger(rect[key]) || rect[key] < 1 || rect[key] > 16384) throw new MediaBridgeError('INVALID_REQUEST', `maskRect.${key} must be an integer between 1 and 16384 pixels.`);
    } else {
      validateImageSourceRef(p.maskRef, 'maskRef', { allowSelection: true });
      if (p.maskMode !== undefined && !['luminance', 'alpha'].includes(p.maskMode)) throw new MediaBridgeError('INVALID_REQUEST', 'maskMode must be luminance or alpha.');
    }
    if (p.maskInvert !== undefined && typeof p.maskInvert !== 'boolean') throw new MediaBridgeError('INVALID_REQUEST', 'maskInvert must be boolean.');
    if (p.featherPx !== undefined && (!Number.isSafeInteger(p.featherPx) || p.featherPx < 0 || p.featherPx > 64)) throw new MediaBridgeError('INVALID_REQUEST', 'featherPx must be an integer between 0 and 64.');
  }
  if (command.type === 'layer.set_frame') {
    // 模型给的是像素框，不是缩放比；至少改一项，不然是无意义写入。
    opaqueId(p.layerId, 'layerId');
    if (['x', 'y', 'width', 'height', 'fit'].every(key => p[key] === undefined)) throw new MediaBridgeError('INVALID_REQUEST', 'Provide at least one of x, y, width, height or fit.');
    if ((p.width === undefined) !== (p.height === undefined)) throw new MediaBridgeError('INVALID_REQUEST', 'Provide both width and height, or neither.');
    for (const key of ['width', 'height']) if (p[key] !== undefined) pixelSize(key);
    for (const key of ['x', 'y']) if (p[key] !== undefined) pixelPos(key);
    if (p.fit !== undefined && !FRAME_FITS.includes(p.fit)) throw new MediaBridgeError('INVALID_REQUEST', `fit must be one of ${FRAME_FITS.join(', ')}.`);
    if (p.anchor !== undefined && !['top-left', 'center'].includes(p.anchor)) throw new MediaBridgeError('INVALID_REQUEST', 'anchor must be top-left or center.');
  }
  if (command.type === 'layer.align') {
    // 对齐到画布：调用方表达意图（边/中线 + 边距），坐标由编辑器算。
    // 至少给 h 或 v 之一；margin 是可用区域的内缩，必须小于画布一半才有意义（由编辑器按真实尺寸判）。
    opaqueId(p.layerId, 'layerId');
    if (p.h === undefined && p.v === undefined) throw new MediaBridgeError('INVALID_REQUEST', 'Provide h, v, or both.');
    if (p.h !== undefined && !['left', 'center', 'right'].includes(p.h)) throw new MediaBridgeError('INVALID_REQUEST', 'h must be left, center or right.');
    if (p.v !== undefined && !['top', 'middle', 'bottom'].includes(p.v)) throw new MediaBridgeError('INVALID_REQUEST', 'v must be top, middle or bottom.');
    if (p.margin !== undefined && (!Number.isSafeInteger(p.margin) || p.margin < 0 || p.margin > 4096)) throw new MediaBridgeError('INVALID_REQUEST', 'margin must be an integer between 0 and 4096 pixels.');
    if (p.to !== undefined && p.to !== 'canvas') throw new MediaBridgeError('INVALID_REQUEST', 'to currently supports only "canvas".');
  }
  if (command.type === 'layer.duplicate') {
    // 复制图层：偏移量是"相对原层的位置"，不是绝对坐标，避免调用方读一次状态只为算新坐标。
    opaqueId(p.layerId, 'layerId');
    for (const key of ['offsetX', 'offsetY']) {
      if (p[key] !== undefined && (!Number.isSafeInteger(p[key]) || Math.abs(p[key]) > 16384)) {
        throw new MediaBridgeError('INVALID_REQUEST', `${key} must be an integer between -16384 and 16384.`);
      }
    }
    assertOptionalName(p.name);
  }
  if (command.type === 'layer.rasterize' || command.type === 'layer.merge_down') {
    // 两条都是"替换/合并"型：只接受目标层与可选的新层名，避免夹带不知名参数。
    opaqueId(p.layerId, 'layerId');
    assertOptionalName(p.name);
  }
  if (command.type === 'layer.paint_stroke') {
    // 画笔：坐标是图层本地像素；点数、颜色、粗细、不透明度都有确定取值域。
    opaqueId(p.layerId, 'layerId');
    if (!Array.isArray(p.points) || p.points.length < 2 || p.points.length > 200) {
      throw new MediaBridgeError('INVALID_REQUEST', 'points must contain 2..200 stroke points.');
    }
    for (const [index, point] of p.points.entries()) {
      const x = Array.isArray(point) ? point[0] : point?.x;
      const y = Array.isArray(point) ? point[1] : point?.y;
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 16384 || Math.abs(y) > 16384) {
        throw new MediaBridgeError('INVALID_REQUEST', `points[${index}] must be {x,y} or [x,y] with coordinates within ±16384.`);
      }
      if (Array.isArray(point) ? point.length !== 2 : Object.keys(point).some(key => !['x', 'y'].includes(key))) {
        throw new MediaBridgeError('INVALID_REQUEST', `points[${index}] must only carry x and y.`);
      }
    }
    if (p.color !== undefined && (typeof p.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.color))) {
      throw new MediaBridgeError('INVALID_REQUEST', 'color must be #rrggbb.');
    }
    if (p.size !== undefined) finite(p.size, 'size', { min: 1, max: 200 });
    if (p.opacity !== undefined) finite(p.opacity, 'opacity', { min: 0, max: 1 });
  }
  if (command.type === 'layer.set_effect' || command.type === 'layer.remove_effect') {
    // 非破坏效果栈：只改 layer.params.dshEffects，不动像素。词表与取值域在这里就挡住，
    // 不把注定失败的效果发给编辑器。
    opaqueId(p.layerId, 'layerId');
    const assertEffect = () => {
      if (typeof p.effect !== 'string' || !Object.prototype.hasOwnProperty.call(DSH_EFFECT_RANGES, p.effect)) {
        throw new MediaBridgeError('INVALID_REQUEST', `effect must be one of ${Object.keys(DSH_EFFECT_RANGES).join(', ')}.`);
      }
    };
    if (command.type === 'layer.set_effect') {
      assertEffect();
      if (p.value !== null) {
        const [min, max] = DSH_EFFECT_RANGES[p.effect];
        if (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < min || p.value > max) {
          throw new MediaBridgeError('INVALID_REQUEST', `${p.effect} must be a number between ${min} and ${max}, or null to remove it.`);
        }
      }
    } else if (p.effect !== undefined) {
      // 省略 effect = 清空整叠；给了就必须是词表里的一个。
      assertEffect();
    }
  }
  if (command.type === 'layer.update_mask') {
    // 活蒙版的可编辑面：谁当蒙版、是否反相、是否整块摘掉。
    // mode/featherPx 不在契约里，因为活蒙版渲染不读它们 —— 由 fieldsOnly 直接拒绝多余字段。
    opaqueId(p.layerId, 'layerId');
    if (p.invert !== undefined && typeof p.invert !== 'boolean') throw new MediaBridgeError('INVALID_REQUEST', 'invert must be boolean.');
    if (p.remove !== undefined && typeof p.remove !== 'boolean') throw new MediaBridgeError('INVALID_REQUEST', 'remove must be boolean.');
    if (p.sourceLayerId !== undefined) opaqueId(p.sourceLayerId, 'sourceLayerId');
    if (p.remove === true && (p.invert !== undefined || p.sourceLayerId !== undefined)) {
      throw new MediaBridgeError('INVALID_REQUEST', 'remove cannot be combined with invert or sourceLayerId.');
    }
    if (p.invert === undefined && p.sourceLayerId === undefined && p.remove !== true) {
      throw new MediaBridgeError('INVALID_REQUEST', 'Provide invert, sourceLayerId, or remove:true.');
    }
  }
  if (command.type === 'layer.feather') {
    // 只改该图层的 alpha 边缘，不新建图层，也不改像素颜色；同样按首次快照幂等重算。
    opaqueId(p.layerId, 'layerId');
    if (!Number.isSafeInteger(p.radiusPx) || p.radiusPx < 1 || p.radiusPx > 64) throw new MediaBridgeError('INVALID_REQUEST', 'radiusPx must be an integer between 1 and 64 pixels.');
  }
  if (command.type === 'layer.remove_background') {
    // 本地自动去背景：无坐标、无外部服务；容差与羽化都有确定取值域，超界在网关就拒绝。
    opaqueId(p.layerId, 'layerId');
    if (p.tolerance !== undefined) finite(p.tolerance, 'tolerance', { min: 0, max: 100 });
    if (p.featherPx !== undefined) {
      if (!Number.isSafeInteger(p.featherPx) || p.featherPx < 0 || p.featherPx > 64) {
        throw new MediaBridgeError('INVALID_REQUEST', 'featherPx must be an integer between 0 and 64 pixels.');
      }
    }
  }
  if (command.type === 'layer.magic_erase') {
    // 魔棒式擦除：种子点必须是非负整数，容差 0..100；坐标由调用方按图层本地像素给出。
    opaqueId(p.layerId, 'layerId');
    if (!Number.isSafeInteger(p.x) || p.x < 0 || !Number.isSafeInteger(p.y) || p.y < 0) {
      throw new MediaBridgeError('INVALID_REQUEST', 'x and y must be non-negative integers in layer pixels.');
    }
    if (p.tolerance !== undefined) finite(p.tolerance, 'tolerance', { min: 0, max: 100 });
    if (p.contiguous !== undefined && typeof p.contiguous !== 'boolean') {
      throw new MediaBridgeError('INVALID_REQUEST', 'contiguous must be a boolean.');
    }
  }
  if (command.type === 'layer.add_mask_layer') {
    // 生成蒙版图层：只新建一张普通图层，不改原图；后续用 layer.add_image + maskRef 组合。
    opaqueId(p.sourceLayerId, 'sourceLayerId');
    if (p.mode !== undefined && !['subject', 'background'].includes(p.mode)) {
      throw new MediaBridgeError('INVALID_REQUEST', 'mode must be "subject" or "background".');
    }
    if (p.tolerance !== undefined) finite(p.tolerance, 'tolerance', { min: 0, max: 100 });
    if (p.featherPx !== undefined && (!Number.isSafeInteger(p.featherPx) || p.featherPx < 0 || p.featherPx > 64)) {
      throw new MediaBridgeError('INVALID_REQUEST', 'featherPx must be an integer between 0 and 64.');
    }
    if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 120)) {
      throw new MediaBridgeError('INVALID_REQUEST', 'name must be a string up to 120 characters.');
    }
  }
  if (command.type === 'layer.color_match') {
    // 幂等要求：编辑器内部保存首次应用前的像素快照（不暴露给模型），每次从快照重算再按
    // strength 插值；Host 只校验参数形状，read_state 只回 derived 的 colorMatch 字段。
    opaqueId(p.layerId, 'layerId');
    if (p.method !== 'reinhard') throw new MediaBridgeError('INVALID_REQUEST', 'color_match currently supports method "reinhard" only.');
    if (p.strength !== undefined) finite(p.strength, 'strength', { min: 0, max: 1 });
    if (p.reference !== undefined) {
      if (typeof p.reference === 'string') {
        if (!['canvas', 'below'].includes(p.reference)) throw new MediaBridgeError('INVALID_REQUEST', 'reference must be canvas, below or a {x,y,width,height} rect.');
      } else if (isObject(p.reference)) {
        const rect = p.reference;
        if (Object.keys(rect).some(key => !['x', 'y', 'width', 'height'].includes(key)) || ['x', 'y', 'width', 'height'].some(key => rect[key] === undefined)) {
          throw new MediaBridgeError('INVALID_REQUEST', 'reference rect needs x, y, width and height only.');
        }
        for (const key of ['x', 'y']) if (!Number.isSafeInteger(rect[key]) || rect[key] < 0) throw new MediaBridgeError('INVALID_REQUEST', `reference.${key} must be a non-negative integer.`);
        for (const key of ['width', 'height']) if (!Number.isSafeInteger(rect[key]) || rect[key] < 1 || rect[key] > 16384) throw new MediaBridgeError('INVALID_REQUEST', `reference.${key} must be an integer between 1 and 16384 pixels.`);
      } else {
        throw new MediaBridgeError('INVALID_REQUEST', 'reference must be canvas, below or a {x,y,width,height} rect.');
      }
    }
  }
  // layer.drop_shadow 本轮不做：它需要改渲染管线，等单独立项后再进白名单。
}

// layer:<id> copies an existing layer; data:image/... is limited to PNG/JPEG/WebP at 256 KB decoded.
// asset:<id> resolves through the bounded upload route (see lib/assets.js). Mask refs use the same three forms.
const INLINE_IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const INLINE_IMAGE_MAX_BYTES = 256 * 1024;
function validateImageSourceRef(sourceRef, name = 'sourceRef', { allowSelection = false } = {}) {
  if (typeof sourceRef !== 'string' || !sourceRef) throw new MediaBridgeError('INVALID_REQUEST', `${name} is required.`);
  if (allowSelection && sourceRef === 'selection:') return;
  if (sourceRef.startsWith('layer:')) {
    if (sourceRef.length < 7 || sourceRef.length > 256) throw new MediaBridgeError('INVALID_REQUEST', `${name} must be layer:<layerId>.`);
    return;
  }
  if (sourceRef.startsWith('asset:')) {
    if (!/^asset:[a-f0-9]{48}$/.test(sourceRef)) throw new MediaBridgeError('INVALID_REQUEST', `${name} must be asset:<48-char id> from an upload.`);
    return;
  }
  const inline = INLINE_IMAGE.exec(sourceRef);
  if (!inline) throw new MediaBridgeError('INVALID_REQUEST', `${name} must be layer:<layerId>, asset:<id> or data:image/(png|jpeg|webp);base64,...`);
  // base64 每 4 字符解出 3 字节；用上界判断，避免在 Host 里真正解码大图。
  if (Math.ceil(inline[2].length * 3 / 4) > INLINE_IMAGE_MAX_BYTES) throw new MediaBridgeError('INVALID_REQUEST', 'Inline image data must be at most 256 KB; import larger images through the editor.');
}

// 视频命令校验：时间一律整数微秒（1 秒 = 1000000），拒绝 startTime/duration 这类秒字段。
// 重点边界：track 音量 0..2、track.update 至少改一项、clip 的 inUs/outUs 必须成对、
// clip.move 至少要给起点或目标轨道；跨轨同类型判断需要轨道状态，留给编辑器。

export const COMMAND_VALIDATORS = { image: validateImageCommand };

// 编辑器状态校验：只要求必需字段存在且类型正确，不禁止额外字段（如 trackClips、
// capabilities.multitrack），这样编辑器扩展状态时 Host 不用跟着改。
function validateImageState(state, instanceId) {
  if (!isObject(state) || state.editorKind !== 'image' || state.editorInstanceId !== instanceId ||
      typeof state.documentId !== 'string' || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !isObject(state.canvas) || !Number.isFinite(state.canvas.width) || !Number.isFinite(state.canvas.height) ||
      !Array.isArray(state.layers)) {
    throw new MediaBridgeError('EDITOR_ERROR', 'Image editor returned an invalid state.');
  }
  return state;
}

// 视频状态额外要求 timeline/tracks/clips 三个数组都在，避免只给 trackClips 时
// Host 误当成有效状态；其余扩展字段照旧放行。

export const STATE_VALIDATORS = { image: validateImageState };

// 编辑器适配器：文档状态只由页面持有，这里只做校验、幂等、版本与"结果未知"语义。
// completed 命中直接回放首份回执；inFlight 合并同 commandId 并发；uncertain 里挂的
// 命令一律拒绝重放，必须先按 commandId 查询原结果。
export function createMediaBridge({ relay, editorKind = 'image', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!relay || typeof relay.request !== 'function') throw new TypeError('relay.request is required');
  if (editorKind !== 'image') throw new TypeError('editorKind must be "image"');
  const completed = new Map();
  const inFlight = new Map();
  const uncertain = new Map();
  const validateState = STATE_VALIDATORS[editorKind];
  const validateCommand = COMMAND_VALIDATORS[editorKind];
  const keyOf = (instanceId, commandId) => `${instanceId}\0${commandId}`;

  // 单次编辑器请求：超时对只读是 EDITOR_TIMEOUT，对写是 OUTCOME_UNKNOWN，
  // 后者表示"可能已落盘"，调用方只能查、不能重试。
  async function request(type, payload, mutation = false) {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    let timer;
    const send = Promise.resolve().then(() => relay.request({ type, requestId, editorKind, ...payload }, { timeoutMs }));
    try {
      return await Promise.race([
        send,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new MediaBridgeError(
            mutation ? 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' : 'EDITOR_TIMEOUT',
            mutation ? 'Command outcome is unknown; query the original commandId.' : `${editorKind} editor did not respond in time.`,
            { commandId: payload.commandId, outcomeUnknown: mutation },
          )), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof MediaBridgeError) throw error;
      if (error?.code) throw new MediaBridgeError(error.code, error.message || 'Editor request failed.', { revision: error.revision, outcomeUnknown: error.outcomeUnknown, commandId: error.commandId });
      throw new MediaBridgeError('EDITOR_ERROR', error?.message || 'Editor request failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    editorKind,
    getPage(instanceId) { return relay.getPage?.(instanceId) ?? null; },
    async readState(input) {
      opaqueId(input?.instanceId, 'instanceId');
      const state = validateState(await request('editor.read_state', { editorInstanceId: input.instanceId }), input.instanceId);
      if (input.projectId && state.documentId !== input.projectId) throw new MediaBridgeError('DOCUMENT_MISMATCH', 'The active project changed.');
      return state;
    },
    // 只读测量：曝光/裁切/偏色/清晰度 + 图层体检。不改画布、不推进 revision。
    async analyze(input) {
      opaqueId(input?.instanceId, 'instanceId');
      const result = await request('editor.analyze', { editorInstanceId: input.instanceId, ...(input.maxSide === undefined ? {} : { maxSide: input.maxSide }) });
      if (!isObject(result) || !isObject(result.luminance) || !isObject(result.clipping)) {
        throw new MediaBridgeError('EDITOR_ERROR', 'Editor returned an invalid analysis.');
      }
      return result;
    },
    // 缩略预览：只读，返回 data URL；超 256 KB 明确报错而不是截断。
    async preview(input) {
      opaqueId(input?.instanceId, 'instanceId');
      // 只透传调用方真的给了的键：全传 undefined 会被编辑器当成"给了个空值"。
      const payload = { editorInstanceId: input.instanceId };
      for (const key of ['maxWidth', 'grid', 'gridStep', 'layerId', 'crop', 'overlay']) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      const result = await request('editor.preview_png', payload);
      if (!isObject(result) || typeof result.dataUrl !== 'string' || !result.dataUrl.startsWith('data:image/png;base64,')) {
        throw new MediaBridgeError('EDITOR_ERROR', 'Editor returned an invalid preview.');
      }
      return result;
    },
    async getCommandResult(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.commandId, 'commandId');
      const result = await request('editor.get_command_result', { editorInstanceId: input.instanceId, commandId: input.commandId });
      if (!isObject(result) || !['applied', 'rejected', 'unknown'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', 'Editor returned an invalid command result.');
      }
      const key = keyOf(input.instanceId, input.commandId);
      if (result.status === 'applied' && result.originalResult) { completed.set(key, result.originalResult); uncertain.delete(key); }
      return result;
    },
    async startExport(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.projectId, 'projectId');
      opaqueId(input.commandId, 'commandId');
      const formats = ['png', 'jpeg', 'psd'];
      if (!formats.includes(input.format)) throw new MediaBridgeError('INVALID_REQUEST', `Export format for ${editorKind} must be one of ${formats.join(', ')}.`);
      const key = keyOf(input.instanceId, input.commandId);
      if (completed.has(key)) return completed.get(key);
      if (uncertain.has(key)) throw uncertain.get(key);
      const result = await request('editor.export_start', {
        editorInstanceId: input.instanceId,
        documentId: input.projectId,
        expectedRevision: input.expectedRevision,
        commandId: input.commandId,
        format: input.format,
      }, true).catch(error => {
        if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN') uncertain.set(key, error);
        throw error;
      });
      if (!isObject(result) || result.editorKind !== editorKind || result.commandId !== input.commandId ||
          typeof result.exportId !== 'string' || !result.exportId ||
          !['queued', 'running', 'ready', 'completed', 'failed'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', `${editorKind} editor returned an invalid export job.`);
      }
      completed.set(key, result);
      return result;
    },
    async getExportStatus(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.exportId, 'exportId');
      const result = await request('editor.export_status', { editorInstanceId: input.instanceId, exportId: input.exportId });
      if (!isObject(result) || result.editorKind !== editorKind || result.exportId !== input.exportId ||
          !['queued', 'running', 'ready', 'completed', 'failed', 'unknown'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', `${editorKind} editor returned an invalid export status.`);
      }
      if (['ready', 'completed'].includes(result.status) && typeof result.artifactRef !== 'string') {
        throw new MediaBridgeError('EDITOR_ERROR', 'Finished export is missing artifactRef.');
      }
      return result;
    },
    // 写入：先查 completed/inFlight/uncertain，再按 expectedRevision 提交；写后立刻回读，
    // revision 必须等于回执里的值，否则降级为 AUDIT_OUTCOME_UNKNOWN 并禁止重放。
    async applyCommand(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.projectId, 'projectId');
      opaqueId(input.commandId, 'commandId');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new MediaBridgeError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer.');
      }
      validateCommand(input.command);
      const key = keyOf(input.instanceId, input.commandId);
      if (completed.has(key)) return completed.get(key);
      if (inFlight.has(key)) return inFlight.get(key);
      if (uncertain.has(key)) throw uncertain.get(key);
      const operation = (async () => {
        const result = await request('editor.apply_command', {
          editorInstanceId: input.instanceId,
          documentId: input.projectId,
          expectedRevision: input.expectedRevision,
          commandId: input.commandId,
          command: structuredClone(input.command),
        }, true);
        // Contract: {editorKind, documentId, commandId, revision, changedObjectIds}.
        // `changedLayerIds` is accepted as a legacy alias so an editor that renamed the
        // field does not look like a failure after it already wrote.
        const changed = Array.isArray(result?.changedObjectIds)
          ? result.changedObjectIds
          : Array.isArray(result?.changedLayerIds) ? result.changedLayerIds : null;
        const revisionAdvanced = Number.isSafeInteger(result?.revision) && result.revision > input.expectedRevision;
        const shapeValid = isObject(result) &&
          (result.editorKind === undefined || result.editorKind === editorKind) &&
          result.documentId === input.projectId && result.commandId === input.commandId &&
          revisionAdvanced && changed !== null;
        if (!shapeValid) {
          // The revision advanced, so the write may have landed. Never report that as a
          // clean rejection: the caller must query by commandId instead of retrying.
          if (revisionAdvanced) {
            throw new MediaBridgeError(
              'EDITOR_RESULT_INVALID_OUTCOME_UNKNOWN',
              'The editor reported a new revision but the mutation result shape was invalid; the write may have landed. Query this commandId instead of retrying.',
              { outcomeUnknown: true, commandId: input.commandId, revision: result?.revision },
            );
          }
          throw new MediaBridgeError('EDITOR_ERROR', 'Editor returned an invalid mutation result.');
        }
        return { ...result, editorKind, changedObjectIds: changed };
      })();
      inFlight.set(key, operation);
      try {
        const result = await operation;
        let state;
        try {
          const audit = await request('editor.read_state', { editorInstanceId: input.instanceId });
          state = validateState(audit, input.instanceId);
          if (state.documentId !== input.projectId || state.revision !== result.revision) throw new Error('Audit project/revision changed after mutation.');
        } catch (error) {
          throw new MediaBridgeError('EDITOR_AUDIT_OUTCOME_UNKNOWN', `Mutation returned but audit could not verify it: ${error.message}. Query the original commandId.`, { outcomeUnknown: true, commandId: input.commandId });
        }
        const withAudit = {
          ...result,
          stateDigest: state.stateDigest,
          history: isObject(state.history) ? { canUndo: !!state.history.canUndo, canRedo: !!state.history.canRedo } : undefined,
        };
        completed.set(key, withAudit);
        return withAudit;
      } catch (error) {
        // Both a timeout and an unverifiable-but-possibly-applied result block replay.
        if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' || error.outcomeUnknown === true) uncertain.set(key, error);
        throw error;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
