// Single-process tests against the real bridge class and real native miniPaint actions.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = __dirname;
const config = { WIDTH: 800, HEIGHT: 600, COLOR: '#000000', TOOL: {name: 'select'}, layers: [], layer: null };
const app = {Actions: {}, GUI: { GUI_layers: { render_layers() {} } }};
const zoomView = {getPosition() {return {x: 12, y: 18};}, getScale() {return 1.5;}};
class TestImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
}
globalThis.ImageData = TestImageData;
const listeners = {};
const context = vm.createContext({ console, config, app, zoomView, ImageData: TestImageData, globalThis: { crypto: { randomUUID: require('node:crypto').randomUUID } },
  window: {addEventListener() {}}, document: {activeElement: null, addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }},
  alertify: {error() {}, success() {}}, performance: {} });
function load(file, symbol, injected = {}) {
  let code = fs.readFileSync(path.join(root, 'src/js', file), 'utf8');
  code = code.replace(/^import .*;\r?\n/gm, '').replace(/export default .*;\s*$/m, '').replace(/export class /g, 'class ');
  for (const [name, value] of Object.entries(injected)) context[name] = value;
  return vm.runInContext(`${code}\n;${symbol}`, context);
}
context.Base_action = load('actions/base.js', 'Base_action');
for (const [file, symbol] of [['insert-layer','Insert_layer_action'], ['update-layer','Update_layer_action'], ['reorder-layer','Reorder_layer_action'], ['toggle-layer-visibility','Toggle_layer_visibility_action'], ['delete-layer','Delete_layer_action'], ['bundle','Bundle_action']]) app.Actions[symbol] = load(`actions/${file}.js`, symbol);
app.Layers = {auto_increment: 1, render() {}, get_layer(id) { return config.layers.find(layer => layer.id == id); },
  // 合成桩：画一块灰，够 analyze/preview 走通即可（像素精度由浏览器验收）。
  convert_layers_to_canvas(ctx) { ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 8, 8); },
  get_sorted_layers() {return config.layers.slice().sort((a,b) => b.order-a.order);},
  find_previous(id) {const layers = this.get_sorted_layers(); return layers[layers.findIndex(l => l.id == id)+1];},
  find_next(id) {const layers = this.get_sorted_layers(); return layers[layers.findIndex(l => l.id == id)-1];},
  // 单层渲染桩：栅格化/向下合并走编辑器自己的 render_object，这里只按 alpha 画一块，
  // 够验证"新层产生了、层数变化、撤销复原"这些结构事实（真实像素由浏览器验收）。
  render_object(ctx, layer) {
    if (!layer || layer.visible === false) return;
    const alpha = (layer.opacity ?? 100) / 100;
    ctx.globalAlpha = alpha;
    ctx.fillRect(0, 0, 8, 8);
  },
  // 镜像 core/base-layers.js 的 dsh_effect_filter：桥会根据它生成回执里的 filter 字符串。
  // 顺序必须与那边一致（CSS filter 的先后会改变结果）。
  dsh_effect_filter(object) {
    const stack = object && object.params && object.params.dshEffects;
    if (!stack || typeof stack !== 'object') return '';
    const parts = [];
    for (const key of ['blur', 'brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'invert', 'hueRotate', 'opacity']) {
      const value = stack[key];
      if (value === undefined || value === null || Number.isNaN(Number(value))) continue;
      if (key === 'blur') parts.push(`blur(${Number(value)}px)`);
      else if (key === 'hueRotate') parts.push(`hue-rotate(${Number(value)}deg)`);
      else parts.push(`${key}(${Number(value)})`);
    }
    return parts.join(' ');
  }};
// Native state uses DOM constructors; use its exact history methods with narrow constructor stubs.
context.Base_layers_class = function () {return app.Layers;};
context.Base_gui_class = function () {return app.GUI;};
context.Helper_class = function () {this.is_input = () => false;};
app.State = new (load('core/base-state.js', 'Base_state_class'))();
app.Actions.Update_config_action = load('actions/update-config.js', 'Update_config_action');
app.Actions.Autoresize_canvas_action = class { constructor() {} async do() {} async undo() {} free() {} };
// test-only 画布桩：只让羽化/色匹的结构可测（路由、校验、快照、撤销回退、read_state 字段），
// 不断言像素颜色；像素摘要用「确定性填充值」模拟内容变化，真实像素效果由浏览器验收。
function makeCanvas(w = 8, h = 8, content = 1) {
  const canvas = {
    width: w, height: h, _content: content, _drawn: null,
    getContext() {
      const ctx = {
        globalAlpha: 1,
        fillStyle: '#000',
        font: '400 12px sans-serif',
        clearRect() {},
        fillRect(x, y, w, h) { canvas._drawn = (Number(canvas._drawn ?? 0) + Math.max(1, Math.round(w * h))) & 0xff; },
        drawImage(source) { if (source && (source._drawn !== undefined || source._content !== undefined)) canvas._drawn = source._drawn ?? source._content; },
        putImageData(image) {
          assert.ok(image instanceof TestImageData, 'Canvas only accepts native ImageData');
          // 用抽样和代表「内容」：只要像素内容变了，这个值就会变，用来观察摘要是否跟随。
          const data = image && image.data;
          let sum = 0;
          if (data) for (let index = 0; index < data.length; index += 97) sum += data[index];
          canvas._drawn = sum & 0xff;
        },
        getImageData: (x, y, cw, ch) => {
          const value = Number(canvas._drawn ?? canvas._content) & 0xff;
          return new TestImageData(new Uint8ClampedArray(cw * ch * 4).fill(value), cw, ch);
        },
        // 只测「按字号线性变宽」：半角字宽 = 0.5×字号，足够验证二分收缩。
        measureText(text) {
          const size = Number((/(\d+(?:\.\d+)?)px/.exec(ctx.font) || [0, 12])[1]) || 12;
          return { width: String(text).length * size * 0.5 };
        },
        // 网格绘制用的路径 API：桩里不真的画线，只要调用不炸。
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {},
        // 图层帧渲染（栅格化/合并）与画笔会用到这些变换与描边属性：桩里不产生像素效果。
        translate() {}, rotate() {}, scale() {},
        lineWidth: 1, strokeStyle: '#000', lineCap: 'butt', lineJoin: 'miter', globalCompositeOperation: 'source-over',
      };
      return ctx;
    },
    // 只有真的改了像素（蒙版合成）才需要重编码；返回带尺寸标记的稳定假 dataURL。
    toDataURL() { toDataUrlCalls += 1; return `data:image/png;base64,stub-${canvas.width}x${canvas.height}-${Number(canvas._drawn ?? canvas._content) & 0xff}`; },
  };
  return canvas;
}
// 蒙版路径必须重编码、透传路径不该重编码：用调用次数作为可核对的证据。
let toDataUrlCalls = 0;
context.document = Object.assign(context.document || {}, { createElement: () => makeCanvas() });
// 原生 Insert_layer_action 对 type:'image' + data 字符串会 `new Image()` 解码。
// 复制/栅格化/合并都会走到 insert，所以这里给一个全局桩（个别用例还会临时覆盖再还原）。
if (typeof context.Image !== 'function') {
  context.Image = class {
    constructor() { this.width = 1; this.height = 1; this.naturalWidth = 1; this.naturalHeight = 1; }
    set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
  };
}
// 与原生 Update_layer_image_action 同形的桩：只做 link/尺寸写回，验证历史与状态同步。
app.Actions.Update_layer_image_action = class {
  constructor(canvas, layer_id) { this.canvas = canvas; this.layer_id = layer_id; this.action_id = 'update_layer_image'; this.action_description = 'Update Layer Image'; }
  async do() {
    this.layer = config.layers.find(item => String(item.id) === String(this.layer_id));
    if (!this.layer) return;
    this.previous = { link: this.layer.link, width: this.layer.width, height: this.layer.height };
    this.layer.link = this.canvas; this.layer.width = this.canvas.width; this.layer.height = this.canvas.height;
  }
  async undo() { if (this.layer && this.previous) Object.assign(this.layer, this.previous); }
  free() {}
};
// PSD 写入器：桥里是 `import { buildPsd }`（打包时正常解析），但本 harness 会把 import 行剥掉，
// 所以这里把模块本身载进 vm 上下文、暴露成全局 buildPsd。
{
  let writerCode = fs.readFileSync(path.join(root, 'src/js/dsh-psd-write.js'), 'utf8');
  writerCode = writerCode.replace(/^export default .*;\s*$/m, '').replace(/^export /gm, '');
  context.buildPsd = vm.runInContext(`${writerCode}\n;buildPsd`, context);
}
const Bridge = load('dsh-editor-bridge.js', 'DshEditorBridge', { zoomView });
const bridge = new Bridge();
let count = 0;
async function test(label, fn) {await fn(); console.log(`PASS ${++count}: ${label}`);}
let id = 0;
let initialStateDigest;
async function send(command, revision = bridge.revision, commandId = `cmd-${++id}`) {
  const request = {type: 'editor.apply_command', requestId: `request-${id}`, editorInstanceId: bridge.editorInstanceId, documentId: bridge.documentId, expectedRevision: revision, commandId, command};
  let response;
  await bridge.handleRequest(request, {postMessage(value) { response = value; }});
  return response;
}
(async () => {
  await test('read_state exposes stable digest, selected summary, history and view fields', async () => {
    // Simulate the real renderer materializing dynamic text bounds after insertion.
    app.Layers.render = force => { if (force && config.layer?.type === 'text' && config.layer.width == null) { config.layer.width = 220; config.layer.height = 64; } };

    const result = await send({type:'layer.add_text', payload:{text:'中文第一行\n第二行',x:20,y:30,style:{size:32}}});
    assert.equal(result.ok,true); assert.equal(bridge.revision,1); assert.equal(app.State.action_history.length,1);
    app.Layers.render(true);
    const state = bridge.readState();
    assert.equal(state.revision, result.result.revision, 'rendered text bounds must be part of the command commit');
    assert.equal(state.layers[0].text,'中文第一行\n第二行');
    assert.equal(state.selectedObjects[0].id,String(config.layer.id));
    assert.equal(state.selectedObjects[0].textSummary,'中文第一行\n第二行');
    assert.equal(state.history.canUndo,true); assert.equal(state.history.canRedo,false);
    assert.equal(state.history.undoDepth,1); assert.equal(state.history.redoDepth,0);
    assert.match(state.stateDigest,/^fnv1a64-[0-9a-f]{16}$/); initialStateDigest = state.stateDigest;
    assert.equal(state.view.scale,1.5); assert.equal(state.view.position.x,12); assert.equal(state.view.position.y,18);
  });
  const layerId = String(config.layer.id);
  await test('undo and redo expose auditable state and restore matching digest', async () => {
    await send({type:'layer.update_text',payload:{layerId,text:'更新后的中文'}});
    const afterEdit = bridge.readState();
    assert.equal(afterEdit.selectedObjects[0].textSummary,'更新后的中文');
    await app.State.undo();
    const afterUndo = bridge.readState();
    assert.equal(afterUndo.selectedObjects[0].textSummary,'中文第一行\n第二行');
    assert.equal(afterUndo.stateDigest,initialStateDigest);
    assert.equal(afterUndo.history.canRedo,true); assert.equal(afterUndo.history.canUndo,true);
    assert.equal(afterUndo.history.undoDepth,1); assert.equal(afterUndo.history.redoDepth,1);
    assert.equal(afterUndo.revision,3);
    await app.State.redo();
    const afterRedo = bridge.readState();
    assert.equal(afterRedo.selectedObjects[0].textSummary,'更新后的中文');
    assert.equal(afterRedo.stateDigest,afterEdit.stateDigest);
    assert.notEqual(afterRedo.stateDigest,initialStateDigest);
    assert.equal(afterRedo.history.redoDepth,0); assert.equal(afterRedo.history.undoDepth,2);
    assert.equal(afterRedo.revision,4);
  });
  await test('layer.add_image inserts a decoded image as one undoable layer and rejects unresolved assets', async () => {
    const previousImage = context.Image;
    context.Image = class {
      constructor() { this.naturalWidth = 2; this.naturalHeight = 1; }
      set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
    };
    try {
      const before = bridge.readState();
      const added = await send({ type: 'layer.add_image', payload: {
        sourceRef: 'data:image/png;base64,iVBORw0KGgo=', x: 7, y: 9, name: 'AI background'
      } });
      assert.equal(added.ok, true, JSON.stringify(added));
      assert.equal(bridge.revision, before.revision + 1);
      assert.equal(config.layer.name, 'AI background');
      assert.equal(config.layer.x, 7); assert.equal(config.layer.y, 9);
      assert.equal(config.layer.width, 2); assert.equal(config.layer.height, 1);
      assert.equal(bridge.readState().history.undoDepth, before.history.undoDepth + 1);
      await app.State.undo();
      assert.equal(config.layers.some(layer => layer.name === 'AI background'), false);
      assert.equal(bridge.revision, before.revision + 2);
      const missing = await send({ type: 'layer.add_image', payload: { sourceRef: 'asset:missing' } });
      assert.equal(missing.ok, false);
      assert.equal(missing.error.code, 'INVALID_REQUEST');
    } finally {
      if (previousImage === undefined) delete context.Image; else context.Image = previousImage;
    }
  });
  await test('editor.measure_text reports size without drawing and shrinks to fit a width', async () => {
    const before = bridge.readState();
    const plain = await bridge.handleRequest({ type: 'editor.measure_text', requestId: 'm1', editorInstanceId: bridge.editorInstanceId,
      text: 'HELLO', style: { size: 40 } }, { postMessage(value) { this.value = value; } });
    assert.equal(plain, undefined, 'handleRequest 只回 postMessage');
    const send = async request => {
      const box = {};
      await bridge.handleRequest({ requestId: 'r', editorInstanceId: bridge.editorInstanceId, ...request }, { postMessage(value) { box.value = value; } });
      return box.value;
    };
    const wide = await send({ type: 'editor.measure_text', text: 'HELLO', style: { size: 40 } });
    assert.equal(wide.ok, true, JSON.stringify(wide));
    assert.equal(wide.result.lineCount, 1);
    assert.equal(wide.result.fittedSize, 40, '没给 maxWidth 时不应擅自改字号');
    assert.equal(wide.result.fits, null);
    // 5 字 × 0.5 × 字号 = 宽度；限 50px 时最大可用字号 = 20
    const fitted = await send({ type: 'editor.measure_text', text: 'HELLO', style: { size: 40 }, maxWidth: 50 });
    assert.equal(fitted.ok, true);
    assert.ok(fitted.result.fittedSize <= 20, `应收缩到 ≤20，实际 ${fitted.result.fittedSize}`);
    assert.ok(fitted.result.fittedSize >= 19, `应收得尽量满，实际 ${fitted.result.fittedSize}`);
    assert.equal(fitted.result.fits, true);
    const multiline = await send({ type: 'editor.measure_text', text: 'AB\nCD', style: { size: 20 } });
    assert.equal(multiline.result.lineCount, 2);
    assert.equal(multiline.result.height, 48, '行高 = 字号 × 1.2');
    const after = bridge.readState();
    assert.equal(after.revision, before.revision, '测量不能推进 revision');
    assert.equal(after.contentDigest, before.contentDigest, '测量不能改内容');
    const bad = await send({ type: 'editor.measure_text', text: '' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'INVALID_REQUEST');
  });

  await test('editor.analyze measures a downsampled composite and reports clipping without touching revision', async () => {
    const before = bridge.readState();
    // 合成结果固定为白色：期望平均亮度接近 1、高光裁切接近 100%。
    const originalComposite = bridge.compositeCanvas.bind(bridge);
    bridge.compositeCanvas = () => makeCanvas(64, 64, 255);
    try {
      const box = {};
      await bridge.handleRequest({ type: 'editor.analyze', requestId: 'a1', editorInstanceId: bridge.editorInstanceId }, { postMessage(value) { box.value = value; } });
      assert.equal(box.value.ok, true, JSON.stringify(box.value));
      const analysis = box.value.result;
      assert.ok(analysis.sampledWidth <= 320 && analysis.sampledWidth >= 1);
      assert.ok(analysis.luminance.mean > 0.95, `平均亮度应接近 1，实际 ${analysis.luminance.mean}`);
      assert.ok(analysis.clipping.highlights > 0.9, `高光裁切应接近 100%，实际 ${analysis.clipping.highlights}`);
      assert.equal(analysis.clipping.shadows, 0);
      assert.equal(analysis.layers.total, config.layers.length);
      assert.ok(Array.isArray(analysis.layers.offCanvas));
      assert.equal(typeof analysis.sharpness.laplacianVariance, 'number');
    } finally {
      bridge.compositeCanvas = originalComposite;
    }
    const after = bridge.readState();
    assert.equal(after.revision, before.revision, '测量不能推进 revision');
    assert.equal(after.contentDigest, before.contentDigest, '测量不能改内容');
  });

  await test('editor.preview_png returns a downsampled data URL and refuses oversized output', async () => {
    const originalComposite = bridge.compositeCanvas.bind(bridge);
    bridge.compositeCanvas = () => makeCanvas(1200, 600, 200);
    try {
      const box = {};
      await bridge.handleRequest({ type: 'editor.preview_png', requestId: 'p1', editorInstanceId: bridge.editorInstanceId, maxWidth: 300 }, { postMessage(value) { box.value = value; } });
      assert.equal(box.value.ok, true, JSON.stringify(box.value));
      const preview = box.value.result;
      assert.ok(preview.dataUrl.startsWith('data:image/png;base64,'), '必须是 PNG data URL');
      assert.equal(preview.width, 300, '长边被压到 maxWidth');
      assert.equal(preview.height, 150, '按比例缩放');
      assert.ok(preview.bytes > 0);
    } finally {
      bridge.compositeCanvas = originalComposite;
    }
    const before = bridge.readState();
    const box2 = {};
    await bridge.handleRequest({ type: 'editor.preview_png', requestId: 'p2', editorInstanceId: bridge.editorInstanceId }, { postMessage(value) { box2.value = value; } });
    const after = bridge.readState();
    assert.equal(box2.value.ok, true);
    assert.equal(after.revision, before.revision, '预览不能推进 revision');
    assert.equal(after.contentDigest, before.contentDigest, '预览不能改内容');
  });

  await test('layer.update_text can change fill colour (style.fill_color) as one undoable step', async () => {
    const idsBefore = new Set(config.layers.map(item => String(item.id)));
    const created = await send({ type: 'layer.add_text', payload: { text: 'colour test', x: 5, y: 5, style: { size: 20, fill_color: '#ffffff' } } });
    assert.equal(created.ok, true, JSON.stringify(created));
    const added = config.layers.find(item => !idsBefore.has(String(item.id)));
    assert.ok(added, '新图层应出现在 config 里');
    const id = String(added.id);
    assert.equal(added.data[0][0].meta.fill_color, '#ffffff');
    const before = bridge.readState();
    const updated = await send({ type: 'layer.update_text', payload: { layerId: String(id), text: 'colour test', style: { fill_color: '#101010' } } });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(added.data[0][0].meta.fill_color, '#101010', '颜色应被改掉');
    assert.equal(bridge.readState().history.undoDepth, before.history.undoDepth + 1, '只增加一条历史');
    const rejected = await send({ type: 'layer.update_text', payload: { layerId: String(id), text: 'x', style: { fill_color: 'red' } } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'INVALID_REQUEST');
    const extraKey = await send({ type: 'layer.update_text', payload: { layerId: String(id), text: 'x', style: { size: 10 } } });
    assert.equal(extraKey.ok, false, 'style 只允许 fill_color');
    await app.State.undo();
    assert.equal(added.data[0][0].meta.fill_color, '#ffffff', '撤销后回到原色');
  });

  await test('editor.preview_png accepts a coordinate grid option without changing the document', async () => {
    const originalComposite = bridge.compositeCanvas.bind(bridge);
    bridge.compositeCanvas = () => makeCanvas(300, 300, 180);
    try {
      const box = {};
      await bridge.handleRequest({ type: 'editor.preview_png', requestId: 'g1', editorInstanceId: bridge.editorInstanceId, maxWidth: 200, grid: true }, { postMessage(value) { box.value = value; } });
      assert.equal(box.value.ok, true, JSON.stringify(box.value));
      assert.ok(box.value.result.dataUrl.startsWith('data:image/png;base64,'));
    } finally {
      bridge.compositeCanvas = originalComposite;
    }
  });

  await test('editor.preview_png can tint a mask overlay so the affected region is visible', async () => {
    const originalComposite = bridge.compositeCanvas.bind(bridge);
    bridge.compositeCanvas = () => makeCanvas(120, 120, 200);
    // 自造蒙版层：全幅不透明，用来验证叠加确实被画上去
    const maskSource = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) };
    config.layers.push({ id: 'overlay-mask', name: 'overlay-mask', type: 'image', x: 0, y: 0, width: 120, height: 120, visible: true, link: maskSource, params: {}, data: null, order: config.layers.length });
    try {
      const plain = {};
      await bridge.handleRequest({ type: 'editor.preview_png', requestId: 'o1', editorInstanceId: bridge.editorInstanceId, maxWidth: 120 }, { postMessage(value) { plain.value = value; } });
      const tinted = {};
      await bridge.handleRequest({ type: 'editor.preview_png', requestId: 'o2', editorInstanceId: bridge.editorInstanceId, maxWidth: 120, overlay: { layerId: 'overlay-mask', color: '#ff00ff', opacity: 0.5 } }, { postMessage(value) { tinted.value = value; } });
      assert.equal(plain.value.ok, true, JSON.stringify(plain.value));
      assert.equal(tinted.value.ok, true, JSON.stringify(tinted.value));
      assert.ok(tinted.value.result.overlay, '要回报叠加的矩形与颜色');
      assert.equal(tinted.value.result.overlay.layerId, 'overlay-mask');
      assert.equal(tinted.value.result.overlay.color, '#ff00ff');
      assert.equal(tinted.value.result.overlay.opacity, 0.5);
      assert.notEqual(tinted.value.result.dataUrl, plain.value.result.dataUrl, '带叠加的预览应与不带不同');
      assert.equal(plain.value.result.overlay, undefined, '没要求叠加时不要附带 overlay');
      const before = bridge.readState();
      assert.equal(before.revision, bridge.revision, '预览与叠加都不改文档');
    } finally {
      bridge.compositeCanvas = originalComposite;
      const index = config.layers.findIndex(item => item.id === 'overlay-mask');
      if (index >= 0) config.layers.splice(index, 1);
      if (typeof bridge.refreshRevision === 'function') bridge.refreshRevision();
    }
  });

  await test('layer.add_image with maskRef layer:<id> binds a LIVE mask, not baked pixels', async () => {
    // 自造一张带 alpha 的蒙版层：alpha 通道白/黑各半
    const maskSource = { width: 2, height: 2, data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255]) };
    const maskLayer = { id: 'live-mask', name: 'live-mask', type: 'image', x: 0, y: 0, width: 2, height: 2, visible: true,
      link: maskSource, params: {}, data: null, order: config.layers.length };
    config.layers.push(maskLayer);
    // 前面的用例直接动过 app.State，先读一次让桥接的 revision 与实际状态对齐。
    await bridge.handleRequest({ type: 'editor.read_state', requestId: `request-${++id}`, editorInstanceId: bridge.editorInstanceId }, { postMessage() {} });
    const previousImage = context.Image;
    context.Image = class {
      constructor() { this.naturalWidth = 2; this.naturalHeight = 2; }
      set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
    };
    let maskBakes = 0;
    const originalApply = bridge.applyMaskToCanvas.bind(bridge);
    bridge.applyMaskToCanvas = async (...args) => { maskBakes += 1; return originalApply(...args); };
    try {
      const result = await send({ type: 'layer.add_image', payload: { sourceRef: 'data:image/png;base64,iVBORw0KGgo=', x: 0, y: 0, width: 2, height: 2, fit: 'stretch', name: 'live-masked', maskRef: 'layer:live-mask' } });
      assert.equal(result.ok, true, JSON.stringify(result));
      const created = config.layers.find(l => l.name === 'live-masked');
      assert.ok(created, '图层应被插入');
      assert.equal(created.params?.dshMask?.sourceLayerId, 'live-mask', '必须绑定活蒙版');
      assert.equal(maskBakes, 0, '活蒙版不该烤进像素');
      const state = bridge.readState();
      const view = state.layers.find(l => l.name === 'live-masked');
      assert.equal(view.mask?.sourceLayerId, 'live-mask', 'read_state 要报出绑定的蒙版');
      assert.equal(view.mask?.editable, true);
    } finally {
      bridge.applyMaskToCanvas = originalApply;
      context.Image = previousImage;
      // 用完移除临时图层，免得影响后面依赖图层顺序的用例。
      for (const name of ['live-masked', 'live-mask']) {
        const index = config.layers.findIndex(item => item.name === name);
        if (index >= 0) config.layers.splice(index, 1);
      }
      if (typeof bridge.refreshRevision === 'function') bridge.refreshRevision();
    }
  });

  await test('mask binding survives native undo/redo and composition reads the edited mask', async () => {
    const previousImage = context.Image;
    const previousOps = context.globalThis.__dshPixelOps;
    const previousRaster = bridge.rasterizeLayer;
    const source = { id: 'source-mask-test', name: 'original', type: 'image', x: 7, y: 9, width: 4, height: 4, order: 0, params: {}, link: makeCanvas(4, 4, 77) };
    config.layers.push(source); config.layer = source;
    bridge.refreshRevision();
    const originalLink = source.link;
    const pixels = new TestImageData(new Uint8ClampedArray(64).fill(255), 4, 4);
    let maskVersion = 1, observedMaskVersion = null;
    context.Image = class { set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); } };
    context.globalThis.__dshPixelOps = {
      ensureImageData: img => new TestImageData(img.data, img.width, img.height),
      backgroundMask: () => ({ image: pixels }),
      applyMask: (src, mask) => { observedMaskVersion = mask.data[0]; return src; },
    };
    bridge.rasterizeLayer = layer => new TestImageData(new Uint8ClampedArray(64).fill(layer === source ? 77 : maskVersion), 4, 4);
    try {
      const created = await send({ type: 'layer.add_mask_layer', payload: { sourceLayerId: source.id } });
      assert.equal(created.ok, true, JSON.stringify(created));
      const maskId = created.result.changedObjectIds[0];
      assert.notEqual(maskId, 'null');
      const mask = config.layer;
      assert.equal(mask.params.dshMask.sourceLayerId, source.id);
      assert.equal(bridge.readState().layers.find(l => l.id === maskId).mask.sourceLayerId, source.id);
      await app.State.undo();
      assert.equal(bridge.readState().layers.some(l => l.id === maskId), false);
      await app.State.redo();
      assert.equal(bridge.readState().layers.find(l => l.id === maskId).mask.sourceLayerId, source.id);
      maskVersion = 93; // simulate a person's committed mask edit
      const composed = await send({ type: 'layer.add_image', payload: { sourceRef: 'layer:' + source.id, maskRef: 'layer:' + maskId, maskMode: 'alpha', width: 4, height: 4, name: 'result' } });
      assert.equal(composed.ok, true, JSON.stringify(composed));
      assert.equal(source.link, originalLink, 'original pixels must not be replaced');
      assert.notEqual(composed.result.changedObjectIds[0], maskId);
      await app.State.undo(); // removes only composed copy
      assert.ok(config.layers.includes(source));
      assert.ok(bridge.readState().layers.find(l => l.id === maskId).mask);
    } finally {
      bridge.rasterizeLayer = previousRaster;
      context.globalThis.__dshPixelOps = previousOps;
      if (previousImage === undefined) delete context.Image; else context.Image = previousImage;
    }
  });
  await test('history.batch applies all steps as ONE undo entry, and rejects nested history', async () => {
    const before = bridge.readState();
    const batched = await send({ type: 'history.batch', payload: { steps: [
      { type: 'layer.add_text', payload: { text: '批量A', x: 10, y: 10 } },
      { type: 'layer.add_text', payload: { text: '批量B', x: 10, y: 60 } },
    ] } });
    assert.equal(batched.ok, true, JSON.stringify(batched));
    const after = bridge.readState();
    assert.equal(after.revision, before.revision + 1, '一次批量只前进一个 revision');
    assert.equal(after.layers.length, before.layers.length + 2);
    assert.equal(after.history.undoDepth, before.history.undoDepth + 1, '只增加一条历史');
    await app.State.undo();
    const undone = bridge.readState();
    assert.equal(undone.layers.length, before.layers.length, '一步撤销应同时移除两步');
    assert.equal(undone.contentDigest, before.contentDigest, '内容必须完全回到批量前');

    const nested = await send({ type: 'history.batch', payload: { steps: [{ type: 'history.undo', payload: {} }] } });
    assert.equal(nested.ok, false);
    assert.equal(nested.error.code, 'INVALID_REQUEST');
    const tooMany = await send({ type: 'history.batch', payload: { steps: Array.from({ length: 13 }, () => ({ type: 'layer.add_text', payload: { text: 'x' } })) } });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error.code, 'INVALID_REQUEST');
  });

  await test('asset:<id> fetches bytes after the parent token handshake and inserts one undoable layer', async () => {
    const previous = {
      parent: context.window.parent, location: context.window.location, fetch: context.fetch,
      FileReader: context.FileReader, Image: context.Image,
      addEventListener: context.window.addEventListener, removeEventListener: context.window.removeEventListener,
    };
    const messageListeners = new Set();
    const token = 'a'.repeat(64);
    context.window.addEventListener = (type, fn) => { if (type === 'message') messageListeners.add(fn); };
    context.window.removeEventListener = (type, fn) => { if (type === 'message') messageListeners.delete(fn); };
    context.window.location = { origin: 'http://localhost' };
    context.window.parent = {
      postMessage(message) {
        if (message.type !== 'dsh.asset.token.request') return;
        queueMicrotask(() => {
          for (const fn of [...messageListeners]) fn({ source: context.window.parent, origin: 'http://localhost',
            data: { type: 'dsh.asset.token', requestId: message.requestId, token } });
        });
      },
    };
    let requested = null;
    context.fetch = async (url, options) => {
      requested = { url, options };
      return { ok: true, status: 200, blob: async () => ({ size: 12 }) };
    };
    context.FileReader = class {
      readAsDataURL() { this.result = 'data:image/png;base64,iVBORw0KGgo='; queueMicrotask(() => this.onload?.()); }
    };
    context.Image = class {
      constructor() { this.naturalWidth = 4; this.naturalHeight = 3; }
      set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
    };
    try {
      const before = bridge.readState();
      const assetId = 'c'.repeat(48);
      const added = await send({ type: 'layer.add_image', payload: { sourceRef: `asset:${assetId}`, name: '生成背景' } });
      assert.equal(added.ok, true, JSON.stringify(added));
      assert.equal(requested.url, `/media-image/assets/${assetId}`);
      assert.equal(requested.options.headers.Authorization, `Bearer ${token}`);
      assert.equal(requested.options.headers['x-dsh-media-asset'], '1');
      assert.equal(config.layer.name, '生成背景');
      assert.equal(config.layer.width, 4);
      assert.equal(config.layer.height, 3);
      assert.equal(bridge.revision, before.revision + 1);
      await app.State.undo();
      assert.equal(config.layers.some(layer => layer.name === '生成背景'), false);
    } finally {
      context.window.parent = previous.parent;
      context.window.location = previous.location;
      context.window.addEventListener = previous.addEventListener;
      context.window.removeEventListener = previous.removeEventListener;
      context.fetch = previous.fetch;
      context.FileReader = previous.FileReader;
      context.Image = previous.Image;
    }
  });
  await test('applyMask cuts alpha by luminance or alpha coverage, inverts, and feathers', async () => {
    const ops = await import('./src/js/dsh-pixel-ops.js');
    // 2x1：source 两个不透明像素（红、绿）。
    const source = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]) };
    // 灰度蒙版：左白（保留）、右黑（挖掉）。
    const luminanceMask = { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]) };
    const clipped = ops.applyMask(source, luminanceMask, { mode: 'luminance' });
    assert.equal(clipped.data[3], 255, '白色区域保留不透明');
    assert.equal(clipped.data[7], 0, '黑色区域被挖空');
    assert.deepEqual([clipped.data[0], clipped.data[1], clipped.data[2]], [255, 0, 0], 'RGB 不变，只改 alpha');

    const inverted = ops.applyMask(source, luminanceMask, { mode: 'luminance', invert: true });
    assert.equal(inverted.data[3], 0);
    assert.equal(inverted.data[7], 255);

    // alpha 模式：用蒙版自身 alpha 作覆盖度（取图层轮廓时用）。
    const alphaMask = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0, 123, 45, 67, 255]) };
    const byAlpha = ops.applyMask(source, alphaMask, { mode: 'alpha' });
    assert.equal(byAlpha.data[3], 0, '蒙版 alpha=0 处挖空');
    assert.equal(byAlpha.data[7], 255, '蒙版 alpha=255 处保留');

    // 半透明蒙版与亮度相乘，不会越界。
    const halfGray = { width: 2, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255, 255, 255, 255, 128]) };
    const half = ops.applyMask(source, halfGray, { mode: 'luminance' });
    assert.ok(half.data[3] > 0 && half.data[3] < 255, '半透明蒙版得到中间 alpha');
    assert.ok(half.data[7] > 0 && half.data[7] < 255, '带 alpha 的蒙版同样按比例衰减');

    // 羽化把硬边界摊开：右侧原本 0，羽化后仍应 <= 原值的邻域内取值（只验单调性）。
    const feathered = ops.applyMask(source, luminanceMask, { mode: 'luminance', featherPx: 1 });
    assert.ok(feathered.data[3] >= 0 && feathered.data[3] < 255, '羽化后边缘不再是不透明的硬边');
    assert.ok(feathered.data[7] > 0, '羽化后挖空处出现过渡');

    // 尺寸不一致必须显式失败，不能悄悄拉伸。
    assert.throws(() => ops.applyMask(source, { width: 3, height: 1, data: new Uint8ClampedArray(12) }), /蒙版尺寸/);
  });
  await test('layer.add_image with maskRef recomposes pixels and rejects mask params without maskRef', async () => {
    const previousImage = context.Image;
    context.Image = class {
      constructor() { this.naturalWidth = 2; this.naturalHeight = 1; }
      set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
    };
    try {
    const before = bridge.readState();
    // 蒙版合成走 pixelOps()：vm 里没有动态 import，按桥约定注入纯像素模块。
    context.globalThis.__dshPixelOps = await import('./src/js/dsh-pixel-ops.js');
    const inline = 'data:image/png;base64,iVBORw0KGgo=';
    const masked = await send({ type: 'layer.add_image', payload: {
      sourceRef: inline, maskRef: inline, maskMode: 'luminance', featherPx: 0, name: '生成背景（挖洞）'
    } });
    assert.equal(masked.ok, true, JSON.stringify(masked));
    assert.equal(config.layer.name, '生成背景（挖洞）');
    // 蒙版路径必须重编码（像素真的变了），不能把原 dataUrl 透传。
    assert.ok(toDataUrlCalls > 0, '蒙版合成后应重新编码');
    assert.equal(config.layer.width, 2);
    assert.equal(config.layer.height, 1);
    assert.equal(bridge.revision, before.revision + 1);
    await app.State.undo();
    assert.equal(config.layers.some(layer => layer.name === '生成背景（挖洞）'), false);

    const orphan = await send({ type: 'layer.add_image', payload: { sourceRef: inline, featherPx: 4 } });
    assert.equal(orphan.ok, false);
    assert.equal(orphan.error.code, 'INVALID_REQUEST');
    const badMode = await send({ type: 'layer.add_image', payload: { sourceRef: inline, maskRef: inline, maskMode: 'chroma' } });
    assert.equal(badMode.ok, false);
    assert.equal(badMode.error.code, 'INVALID_REQUEST');
    } finally {
      if (previousImage === undefined) delete context.Image; else context.Image = previousImage;
    }
  });
  await test('layer.set_appearance changes opacity/blend/name, shows in read_state, and undoes as one step', async () => {
    const target = { id: 'appearance-1', name: '原名称', type: 'image', link: makeCanvas(4, 4), opacity: 100,
      composition: 'source-over', x: 0, y: 0, width: 4, height: 4, width_original: 4, height_original: 4, order: 99, visible: true };
    config.layers.push(target);
    bridge.refreshRevision();
    const before = bridge.readState();
    const applied = await send({ type: 'layer.set_appearance', payload: { layerId: 'appearance-1', opacity: 40, blendMode: 'multiply', name: '背景·正片叠底' } });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const shown = bridge.readState().layers.find(item => item.id === 'appearance-1');
    assert.equal(shown.opacity, 40);
    assert.equal(shown.blendMode, 'multiply');
    assert.equal(shown.name, '背景·正片叠底');
    // 合成模式必须进内容摘要，否则「写后回读校验」对 blendMode 等于没校验。
    assert.notEqual(bridge.readState().stateDigest, before.stateDigest);
    await app.State.undo();
    const undone = bridge.readState().layers.find(item => item.id === 'appearance-1');
    assert.equal(undone.opacity, 100);
    assert.equal(undone.blendMode, 'source-over');
    assert.equal(undone.name, '原名称');
    for (const payload of [{ layerId: 'appearance-1' }, { layerId: 'appearance-1', opacity: 120 },
      { layerId: 'appearance-1', blendMode: 'carve' }, { layerId: 'appearance-1', name: '  ' }]) {
      const bad = await send({ type: 'layer.set_appearance', payload });
      assert.equal(bad.ok, false, JSON.stringify(payload));
    }
    config.layers = config.layers.filter(item => item.id !== 'appearance-1');
    bridge.refreshRevision();
  });
  await test('maskRect clips by an explicit canvas rect, and selection: refuses without a marquee', async () => {
    const previousImage = context.Image;
    context.Image = class {
      constructor() { this.naturalWidth = 2; this.naturalHeight = 1; }
      set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
    };
    try {
      context.globalThis.__dshPixelOps = await import('./src/js/dsh-pixel-ops.js');
      const inline = 'data:image/png;base64,iVBORw0KGgo=';
      const before = bridge.readState();
      const rectMasked = await send({ type: 'layer.add_image', payload: {
        sourceRef: inline, maskRect: { x: 0, y: 0, width: 120, height: 80 }, featherPx: 0, name: '矩形蒙版层'
      } });
      assert.equal(rectMasked.ok, true, JSON.stringify(rectMasked));
      assert.equal(config.layer.name, '矩形蒙版层');
      assert.equal(bridge.revision, before.revision + 1);
      await app.State.undo();

      // 不是选择工具时没有选区：必须明确报 NO_SELECTION，不能悄悄画成全图。
      const noSelection = await send({ type: 'layer.add_image', payload: { sourceRef: inline, maskRef: 'selection:' } });
      assert.equal(noSelection.ok, false);
      assert.equal(noSelection.error.code, 'NO_SELECTION');
      assert.equal(config.layers.some(layer => layer.name === 'AI 生成图层'), false, '失败不得留下半成品图层');

      // 互斥：同时给 maskRef 与 maskRect 应被拒绝。
      const both = await send({ type: 'layer.add_image', payload: { sourceRef: inline, maskRef: 'selection:', maskRect: { x: 0, y: 0, width: 10, height: 10 } } });
      assert.equal(both.ok, false);
      assert.equal(both.error.code, 'INVALID_REQUEST');
    } finally {
      if (previousImage === undefined) delete context.Image; else context.Image = previousImage;
    }
  });
  await test('read_state reports the live marquee only while the selection tool is active', async () => {
    const previousTool = config.TOOL.name;
    const previousSelection = app.Layers.Base_selection;
    try {
      app.Layers.Base_selection = { get_selection: () => ({ x: 12, y: 34, width: 200, height: 150 }) };
      config.TOOL.name = 'selection';
      // vm 里造出来的对象原型不同，deepEqual 会因原型不等失败，逐字段比。
      const live = bridge.readState().selection;
      assert.equal(live?.x, 12); assert.equal(live?.y, 34);
      assert.equal(live?.width, 200); assert.equal(live?.height, 150);
      // 切到别的工具后选区不可信（编辑器会清空），必须报 null 而不是给旧矩形。
      config.TOOL.name = 'brush';
      assert.equal(bridge.readState().selection, null);
      // 选择工具下但选区为空（x/y/width/height 全 null）也算没有选区。
      config.TOOL.name = 'selection';
      app.Layers.Base_selection = { get_selection: () => ({ x: null, y: null, width: null, height: null }) };
      assert.equal(bridge.readState().selection, null);
      // 读状态不得因为 Base_selection 缺失而抛错。
      app.Layers.Base_selection = undefined;
      assert.equal(bridge.readState().selection, null);
    } finally {
      config.TOOL.name = previousTool;
      app.Layers.Base_selection = previousSelection;
    }
  });
  await test('layer.add_text loads a registered font via token fetch before inserting', async () => {
    const previous = { fetch: context.fetch, FontFace: context.FontFace, fonts: context.document.fonts, createObjectURL: context.URL };
    const requested = [];
    context.fetch = async (url, init) => {
      requested.push({ url, headers: init?.headers || {} });
      return { ok: true, status: 200, blob: async () => ({ size: 32 }) };
    };
    const registered = [];
    context.FontFace = class {
      constructor(family, source) { this.family = family; this.source = source; this.status = 'loaded'; }
      async load() { this.loaded = true; return this; }
    };
    context.URL = { createObjectURL: () => 'blob:font-1' };
    context.document.fonts = { add: face => registered.push(face) };
    try {
      const before = bridge.readState();
      const fontUrl = `/media-image/fonts/${'d'.repeat(48)}`;
      const added = await send({ type: 'layer.add_text', payload: {
        text: '思源黑体标题', x: 10, y: 20, style: { size: 40, family: 'Source Han Sans' }, fontUrl,
      } });
      assert.equal(added.ok, true, JSON.stringify(added));
      assert.equal(requested.length, 1);
      assert.equal(requested[0].url, fontUrl);
      assert.match(requested[0].headers.Authorization, /^Bearer .+/);
      assert.equal(registered.length, 1);
      assert.equal(registered[0].family, 'Source Han Sans');
      assert.match(registered[0].source, /^url\(blob:/);
      assert.equal(bridge.revision, before.revision + 1);
      // 同一字体再次使用不应重复下载。
      await send({ type: 'layer.add_text', payload: { text: '副标题', style: { size: 20, family: 'Source Han Sans' }, fontUrl } });
      assert.equal(requested.length, 1, '同一 family+url 只加载一次');
      // 只给 fontUrl 不给 family：必须拒绝，不能静默忽略。
      const noFamily = await send({ type: 'layer.add_text', payload: { text: 'x', fontUrl } });
      assert.equal(noFamily.ok, false);
      assert.equal(noFamily.error.code, 'INVALID_REQUEST');
      // 跨站 URL 直接挡掉。
      const foreign = await send({ type: 'layer.add_text', payload: { text: 'x', style: { family: 'A' }, fontUrl: 'https://evil.example/f.woff2' } });
      assert.equal(foreign.ok, false);
    } finally {
      context.fetch = previous.fetch;
      if (previous.FontFace === undefined) delete context.FontFace; else context.FontFace = previous.FontFace;
      context.URL = previous.createObjectURL;
      context.document.fonts = previous.fonts;
    }
  });
  await test('cached applied and rejected outcomes contain contract fields', async () => {
    const commandId = 'idempotent'; const cmd = {type:'layer.set_visibility', payload:{layerId,visible:false}};
    const first = await send(cmd,bridge.revision,commandId); const revision = bridge.revision;
    const replay = await send(cmd,0,commandId); assert.equal(replay.result.revision,first.result.revision); assert.equal(bridge.revision,revision);
    const rejected = await send(cmd,0,'stale'); assert.equal(rejected.error.code,'REVISION_CONFLICT');
    assert.equal(bridge.getCommandResult({commandId:'stale'}).originalResult,null);
    assert.equal(bridge.getCommandResult({commandId:'stale'}).status,'rejected');
  });
  await test('native human commit queued before agent makes old revision conflict', async () => {
    const revision = bridge.revision;
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    const human = app.State.do_action({action_id:'human_async',async do() {await gate; config.layer.x=77;}, async undo() {}, free() {}});
    const agent = send({type:'layer.set_transform',payload:{layerId,x:90}},revision,'race');
    release(); await human; const result = await agent;
    assert.equal(result.error.code,'REVISION_CONFLICT'); assert.equal(config.layer.x,77);
  });
  await test('active gesture or text focus rejects agent without side effects', async () => {
    bridge.pointerDown=true;
    const before=bridge.revision;
    const result=await send({type:'layer.update_text',payload:{layerId,text:'不应写入'}});
    assert.equal(result.error.code,'EDITOR_NOT_READY'); assert.equal(bridge.revision,before); bridge.pointerDown=false;
  });
  await test('direct human preview changed before apply invalidates old revision', async () => {
    const revision=bridge.revision; config.layer.y=201;
    const result=await send({type:'layer.set_transform',payload:{layerId,x:100}},revision);
    assert.equal(result.error.code,'REVISION_CONFLICT'); assert.equal(config.layer.x,77);
  });
  await test('reorder maps index zero to the top, grouped into one undo entry', async () => {
    await send({type:'layer.add_text',payload:{text:'上层',x:0,y:0}});
    const before=app.State.action_history.length;
    const result=await send({type:'layer.reorder',payload:{layerId,toIndex:0}});
    assert.equal(result.ok,true); assert.equal(String(app.Layers.get_sorted_layers()[0].id),layerId);
    assert.equal(app.State.action_history.length,before+1);
    await app.State.undo_action(); assert.notEqual(String(app.Layers.get_sorted_layers()[0].id),layerId);
  });
  await test('reject invalid style and properties before mutation', async () => {
    const before=bridge.revision;
    const result=await send({type:'layer.add_text',payload:{text:'invalid',x:0,y:0,style:{text:'override'}}});
    assert.equal(result.error.code,'INVALID_REQUEST'); assert.equal(bridge.revision,before);
  });
  await test('failed native commit remains unknown and cannot be replayed', async () => {
    const original=bridge.nativeDo; let calls=0;
    bridge.nativeDo=async () => {calls++; return {status:'aborted'};};
    const command={type:'layer.update_text',payload:{layerId,text:'不能重复'}};
    const first=await send(command,bridge.revision,'unknown'); assert.equal(first.error.code,'EDITOR_TIMEOUT_OUTCOME_UNKNOWN');
    assert.equal(bridge.getCommandResult({commandId:'unknown'}).status,'unknown');
    await send(command,bridge.revision,'unknown'); assert.equal(calls,1); bridge.nativeDo=original;
  });
  await test('new/open native commit changes document identity', async () => {
    const before=bridge.documentId;
    await app.State.do_action({action_id:'open_json_file',async do() {},async undo() {},free() {}});
    assert.notEqual(bridge.documentId,before);
  });
  // Regression: the Host validates `editorKind` + `changedObjectIds`; a mismatch used to
  // report "rejected" for a write that had already landed.
  await test('apply_command result carries editorKind and changedObjectIds', async () => {
    const result = await send({type:'layer.add_text', payload:{text:'契约字段'}});
    assert.equal(result.ok, true);
    assert.equal(result.result.editorKind, 'image');
    assert.equal(result.result.documentId, bridge.documentId);
    assert.ok(Array.isArray(result.result.changedObjectIds));
    assert.equal(result.result.changedObjectIds.length, 1);
    assert.equal('changedLayerIds' in result.result, false);
    assert.equal(bridge.getCommandResult({commandId: `cmd-${id}`}).originalResult.editorKind, 'image');
  });
  await test('layer.add_text without x/y lands on the canvas centre', async () => {
    const before = app.State.action_history.length;
    const result = await send({type:'layer.add_text', payload:{text:'无坐标'}});
    assert.equal(result.ok, true);
    assert.equal(app.State.action_history.length, before + 1);
    const created = config.layers[config.layers.length - 1];
    assert.equal(created.x, Math.round(config.WIDTH / 2));
    assert.equal(created.y, Math.round(config.HEIGHT / 2));
  });
  await test('revision advances by exactly one per apply, undo and redo', async () => {
    const r0 = bridge.revision;
    await send({type:'layer.add_text', payload:{text:'步进'}});
    assert.equal(bridge.revision, r0 + 1);
    await app.State.undo();
    assert.equal(bridge.revision, r0 + 2);
    await app.State.redo();
    assert.equal(bridge.revision, r0 + 3);
    // A read-only request must never bump the revision.
    bridge.readState();
    assert.equal(bridge.revision, r0 + 3);
  });
  await test('targeted undo checks exact command, digest and top history; duplicate does not undo twice', async () => {
    const result = await send({type:'layer.add_text',payload:{text:'定向撤销'}});
    const before = bridge.readState();
    assert.equal(before.history.lastCommandId,result.result.commandId);
    assert.equal(before.history.afterDigest,result.result.afterDigest);
    const command={type:'history.undo',payload:{targetCommandId:result.result.commandId,afterDigest:result.result.afterDigest}};
    const undone=await send(command,bridge.revision,'target-undo');
    assert.equal(undone.ok,true);
    const revision=bridge.revision;
    await send(command,bridge.revision,'target-undo');
    assert.equal(bridge.revision,revision);
    const next=await send({type:'layer.add_text',payload:{text:'后续修改'}});
    const rejected=await send(command);
    assert.equal(rejected.ok,false);
    assert.equal(rejected.error.code,'HISTORY_CONFLICT');
    assert.equal(bridge.revision,next.result.revision);
  });
  await test('layer.set_frame positions by pixel box and derives the missing side', async () => {
    const created = await send({type:'layer.add_text',payload:{text:'像素框'}});
    const layerId = created.result.changedObjectIds[0];
    const layer = config.layers.find(item => String(item.id) === layerId);
    const ratio = (layer.width || layer.width_original) / (layer.height || layer.height_original);
    const oneSided = await send({type:'layer.set_frame',payload:{layerId, x: 30, y: 40, width: 200}});
    assert.equal(oneSided.ok, true);
    assert.equal(layer.x, 30); assert.equal(layer.y, 40);
    assert.equal(layer.width, 200);
    assert.equal(layer.height, Math.max(1, Math.round(200 / ratio)));
    const centered = await send({type:'layer.set_frame',payload:{layerId, x: 100, y: 100, width: 40, height: 20, anchor: 'center'}});
    assert.equal(centered.ok, true);
    assert.equal(layer.x, 80); assert.equal(layer.y, 90);
    const before = { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
    for (const payload of [{layerId, width: 0}, {layerId, width: 10, height: 10, fit: 'fill'}, {layerId, width: 10, extra: 1}, {layerId: 'missing', width: 10}]) {
      const rejected = await send({type:'layer.set_frame',payload});
      assert.equal(rejected.ok, false);
    }
    assert.deepEqual({ x: layer.x, y: layer.y, width: layer.width, height: layer.height }, before);
  });
  await test('layer.feather keeps one base snapshot, reports it and follows undo/redo', async () => {
    context.__dshPixelOps = await import('./src/js/dsh-pixel-ops.js');
    // 桥里读的是 vm 里的 `globalThis`（harness 显式提供了一个对象），两边都挂上更稳。
    context.globalThis.__dshPixelOps = context.__dshPixelOps;
    const layer = { id: 'img-1', name: '图', type: 'image', link: makeCanvas(8, 8), x: 0, y: 0, width: 8, height: 8, width_original: 8, height_original: 8, order: 0, visible: true };
    config.layers.push(layer);
    // 直接改 config 相当于一次人工编辑：先让桥重算 revision，再发命令，否则会拿到 REVISION_CONFLICT。
    bridge.refreshRevision();
    let state = bridge.readState().layers.find(item => item.id === 'img-1');
    assert.equal(state.feather, undefined, '未应用前不应出现 feather');

    const first = await send({type:'layer.feather', payload:{layerId:'img-1', radiusPx:4}});
    assert.equal(first.ok, true, JSON.stringify(first));
    const baseDigest = bridge.pixelBases.get('img-1').digest;
    assert.match(baseDigest, /^fnv1a64-[0-9a-f]{16}$/);
    state = bridge.readState().layers.find(item => item.id === 'img-1');
    // vm 里的对象与宿主的原型不同，deepStrictEqual 会因为跨 realm 失败，用 JSON 归一化后比较。
    assert.deepEqual(JSON.parse(JSON.stringify(state.feather)), { radiusPx: 4, fromDigest: baseDigest });

    // 撤销：字段必须消失，不能继续声称生效。
    const undone = await send({type:'history.undo', payload:{}});
    assert.equal(undone.ok, true);
    assert.equal(bridge.readState().layers.find(item => item.id === 'img-1').feather, undefined, '撤销后不能还显示 feather');
    // 重做：字段恢复成刚才那次的参数。
    const redone = await send({type:'history.redo', payload:{}});
    assert.equal(redone.ok, true);
    assert.equal(bridge.readState().layers.find(item => item.id === 'img-1').feather.radiusPx, 4);

    // 换半径必须允许，但仍从同一份 base 重算。
    const second = await send({type:'layer.feather', payload:{layerId:'img-1', radiusPx:9}});
    assert.equal(second.ok, true);
    assert.equal(bridge.pixelBases.get('img-1').digest, baseDigest, '调半径不能换 base');
    assert.equal(bridge.readState().layers.find(item => item.id === 'img-1').feather.radiusPx, 9);
  });
  await test('layer.feather rejects bad radius, unknown keys and missing layers', async () => {
    for (const payload of [{layerId:'img-1', radiusPx:0}, {layerId:'img-1', radiusPx:65}, {layerId:'img-1', radiusPx:1.5},
      {layerId:'img-1', radiusPx:3, extra:1}, {layerId:'missing', radiusPx:3}]) {
      const rejected = await send({type:'layer.feather', payload});
      assert.equal(rejected.ok, false, JSON.stringify(payload));
    }
  });
  await test('layer.color_match is idempotent per base and follows undo', async () => {
    const first = await send({type:'layer.color_match', payload:{layerId:'img-1', method:'reinhard', strength:0.8}});
    assert.equal(first.ok, true);
    const baseDigest = bridge.pixelBases.get('img-1').digest;
    let state = bridge.readState().layers.find(item => item.id === 'img-1');
    assert.deepEqual(JSON.parse(JSON.stringify(state.colorMatch)), { method: 'reinhard', strength: 0.8, fromDigest: baseDigest });
    const second = await send({type:'layer.color_match', payload:{layerId:'img-1', method:'reinhard', strength:0.25, reference:'canvas'}});
    assert.equal(second.ok, true);
    assert.equal(bridge.pixelBases.get('img-1').digest, baseDigest);
    assert.equal(bridge.readState().layers.find(item => item.id === 'img-1').colorMatch.strength, 0.25);
    const undone = await send({type:'history.undo', payload:{}});
    assert.equal(undone.ok, true);
    // 撤销的是第二次匹配，状态回到第一次的 0.8，而不是整段消失。
    assert.equal(bridge.readState().layers.find(item => item.id === 'img-1').colorMatch.strength, 0.8);
    for (const payload of [{layerId:'img-1', method:'lab'}, {layerId:'img-1', method:'reinhard', strength:2},
      {layerId:'img-1', method:'reinhard', reference:{rect:[1,2,3]}}, {layerId:'img-1', method:'reinhard', extra:1}]) {
      const rejected = await send({type:'layer.color_match', payload});
      assert.equal(rejected.ok, false, JSON.stringify(payload));
    }
  });
  await test('contentDigest covers pixels, ignores selection and survives a cold cache', async () => {
    // 专用图层：让「处理前后像素不同」在桩里也成立（内容值 77，处理后抽样和不同）。
    const target = { id: 'img-3', name: '像素层', type: 'image', link: makeCanvas(8, 8, 77), x: 0, y: 0, width: 8, height: 8, width_original: 8, height_original: 8, order: 2, visible: true };
    config.layers.push(target);
    bridge.refreshRevision();
    const before = bridge.readState();
    assert.match(before.contentDigest, /^fnv1a64-[0-9a-f]{16}$/);
    assert.equal(before.stateDigest, before.contentDigest, 'stateDigest 保留一版且与 contentDigest 同值');
    assert.ok(before.viewState && 'selectedLayerId' in before.viewState);

    // ① 羽化改像素后内容摘要必须变化（这是此前真正的漏洞：只比元数据，像素改了摘要不变）。
    const feather = await send({type:'layer.feather', payload:{layerId:'img-3', radiusPx:5}});
    assert.equal(feather.ok, true, JSON.stringify(feather));
    const afterPixels = bridge.readState();
    assert.notEqual(afterPixels.contentDigest, before.contentDigest, '像素变化必须反映到 contentDigest');

    // ② 仅切换选中层：内容摘要与 revision 都不该变。
    const other = { id: 'img-2', name: '另一层', type: 'image', link: makeCanvas(4, 4, 2), x: 1, y: 1, width: 4, height: 4, order: 1, visible: true };
    config.layers.push(other);
    bridge.refreshRevision();
    const stable = bridge.readState();
    const revisionBeforeSelect = bridge.revision;
    config.layer = other;
    bridge.refreshRevision();
    const afterSelect = bridge.readState();
    assert.equal(afterSelect.contentDigest, stable.contentDigest, '切换选中层不能算内容变化');
    assert.equal(bridge.revision, revisionBeforeSelect, '切换选中层不能让 revision 增长');
    assert.equal(afterSelect.viewState.selectedLayerId, 'img-2', '选中层应体现在 viewState');

    // ③ 清掉像素缓存后重算，摘要必须稳定（同一内容不能因重算而变化）。
    bridge.pixelDigestCache.clear();
    assert.equal(bridge.readState().contentDigest, afterSelect.contentDigest, '同一内容重算两次必须一致');

    // ④ 只改极少像素（模拟一行小字的改动）也必须反映到摘要：这是全分辨率摘要的意义。
    const tiny = { id: 'img-4', name: '细节层', type: 'image', link: makeCanvas(16, 16, 100), x: 0, y: 0, width: 16, height: 16, order: 3, visible: true };
    config.layers.push(tiny);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const beforeTiny = bridge.readState().contentDigest;
    // 同一个 link 对象，只改一个像素并让变更计数自增（等价于一次原生像素动作）。
    tiny.link._content = 101;
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    assert.notEqual(bridge.readState().contentDigest, beforeTiny, '一个像素的改动也不能被摘要漏掉');
  });
  await test('large layers digest in chunks, equal to one-shot, and never leak a Promise', async () => {
    const big = { id: 'img-big', name: '大图', type: 'image', link: makeCanvas(1001, 1000, 7), x: 0, y: 0, width: 1001, height: 1000, order: 4, visible: true };
    config.layers.push(big);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const bytes = 1001 * 1000 * 4;
    const expected = 'pixels:' + bridge.hashPixels(new Uint8ClampedArray(bytes).fill(7)).toString(16).padStart(16, '0');
    await bridge.prepareDigest();
    assert.equal(bridge.pixelDigestCache.get('img-big').digest, expected, `分块计算结果必须与一次性计算完全一致（actual=${bridge.pixelDigestCache.get('img-big').digest} expected=${expected}）`);
    const state = bridge.readState();
    assert.equal(typeof state.contentDigest, 'string', 'contentDigest 必须是字符串，不能是 Promise');
    assert.match(state.contentDigest, /^fnv1a64-/);
    assert.equal(typeof state.digestTimeMs, 'number');
    // 大图未算完就同步读取：必须明确失败，绝不返回占位摘要。
    bridge.pixelDigestCache.delete('img-big');
    assert.throws(() => bridge.readState(), /摘要|DIGEST/);
    // 写后审计：afterDigest 必须已经算完，且像素动作后发生变化。
    await bridge.prepareDigest();
    bridge.refreshRevision();
    const before = bridge.readState().contentDigest;
    const feather = await send({type:'layer.feather', payload:{layerId:'img-big', radiusPx:3}});
    assert.equal(feather.ok, true, JSON.stringify(feather));
    assert.equal(typeof feather.result.afterDigest, 'string');
    assert.match(feather.result.afterDigest, /^fnv1a64-/);
    assert.notEqual(feather.result.afterDigest, before, '像素写入后 afterDigest 必须变');
  });
  await test('canvas crop and resize are native reversible single history entries', async () => {
    const width=config.WIDTH,height=config.HEIGHT,x=config.layers[0].x;
    const crop=await send({type:'canvas.crop',payload:{x:10,y:10,width:200,height:100}});
    assert.equal(crop.ok,true,JSON.stringify(crop));
    assert.equal(config.WIDTH,200);assert.equal(config.layers[0].x,x-10);
    const undo=await send({type:'history.undo',payload:{}});
    assert.equal(undo.ok,true);assert.equal(config.WIDTH,width);assert.equal(config.HEIGHT,height);assert.equal(config.layers[0].x,x);
    const resize=await send({type:'canvas.resize',payload:{width:400,height:300}});
    assert.equal(resize.ok,true);assert.equal(config.WIDTH,400);assert.equal(config.layers[0].x,x);
  });
  async function callEditor(request) {
    let response;
    await bridge.handleRequest(request, { postMessage(value) { response = value } });
    return response;
  }
  await test('editor.highlight only paints an outline: revision, digest, history and selection unchanged', async () => {
    const layerId = String(config.layers[0].id);
    const before = bridge.readState();
    const historyBefore = app.State.action_history.length;
    const selectedBefore = config.layer ? String(config.layer.id) : null;
    const result = await callEditor({ type: 'editor.highlight', requestId: 'hl-1', editorInstanceId: bridge.editorInstanceId, objectIds: [layerId, 'nope'] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result.matched, [layerId]);
    assert.deepEqual(result.result.missing, ['nope']);
    const after = bridge.readState();
    assert.equal(after.revision, before.revision, '高亮不许 bump revision');
    assert.equal(after.contentDigest, before.contentDigest, '高亮不许改内容摘要');
    assert.equal(app.State.action_history.length, historyBefore, '高亮不许进历史');
    assert.equal(config.layer ? String(config.layer.id) : null, selectedBefore, '高亮不许改选中');
  });
  await test('editor.highlight rejects malformed objectIds and clamps ttl', async () => {
    for (const objectIds of [undefined, [], [1], ['', 'x'], new Array(201).fill('a')]) {
      const bad = await callEditor({ type: 'editor.highlight', requestId: 'hl-bad', editorInstanceId: bridge.editorInstanceId, objectIds });
      assert.equal(bad.ok, false, JSON.stringify(bad));
      assert.equal(bad.error.code, 'INVALID_REQUEST');
    }
    const layerId = String(config.layers[0].id);
    const clamped = await callEditor({ type: 'editor.highlight', requestId: 'hl-ttl', editorInstanceId: bridge.editorInstanceId, objectIds: [layerId], ttlMs: 999999 });
    assert.equal(clamped.ok, true);
    assert.equal(bridge.highlightState.ttlMs, 5000);
    const small = await callEditor({ type: 'editor.highlight', requestId: 'hl-ttl2', editorInstanceId: bridge.editorInstanceId, objectIds: [layerId], ttlMs: 1 });
    assert.equal(small.ok, true);
    assert.equal(bridge.highlightState.ttlMs, 200);
    bridge.clearHighlight();
  });
  await test('selection_changed is a throttled read-only push', async () => {
    const sent = [];
    bridge.port = { postMessage: message => sent.push(message) };
    bridge.selectionEmitAt = 0;
    bridge.emitSelectionChanged();
    bridge.emitSelectionChanged();
    bridge.emitSelectionChanged();
    assert.equal(sent.length, 1, '100ms 内只发一条');
    assert.equal(sent[0].type, 'editor.selection_changed');
    assert.equal(typeof sent[0].revision, 'number');
    assert.ok(Array.isArray(sent[0].selectedObjectIds));
    assert.ok(['layer', null].includes(sent[0].objectKind));
    bridge.selectionEmitAt = 0;
    bridge.emitSelectionChanged();
    assert.equal(sent.length, 2, '超过节流窗口后可以再发');
    const historyBefore = app.State.action_history.length;
    const revisionBefore = bridge.revision;
    assert.equal(app.State.action_history.length, historyBefore, '推送不产生历史');
    assert.equal(bridge.revision, revisionBefore, '推送不 bump revision');
    bridge.port = null;
  });
  await test('layer.align computes x/y inside the editor and returns the landing box as detail', async () => {
    // 造一个已知尺寸的图片层，画布与尺寸都由本用例控制，避免依赖前面的用例留下的状态。
    config.WIDTH = 1000; config.HEIGHT = 800;
    const aligned = { id: 'align-1', name: '对齐测试', type: 'image', link: makeCanvas(100, 50, 9), x: 111, y: 222, width: 300, height: 150, order: 90, visible: true };
    config.layers.push(aligned);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();

    // 右下角 + 24px 内缩：x = 1000-24-300 = 676，y = 800-24-150 = 626
    const rightBottom = await send({ type: 'layer.align', payload: { layerId: 'align-1', h: 'right', v: 'bottom', margin: 24 } });
    assert.equal(rightBottom.ok, true, JSON.stringify(rightBottom));
    assert.equal(aligned.x, 676);
    assert.equal(aligned.y, 626);
    // 编辑器在 vm 里跑，返回对象来自另一个 realm：用 JSON 归一后再比较，避免原型不同导致的假失败。
    assert.deepEqual(JSON.parse(JSON.stringify(rightBottom.result.commandDetail.aligned)),
      { layerId: 'align-1', x: 676, y: 626, width: 300, height: 150, h: 'right', v: 'bottom', margin: 24, canvas: { width: 1000, height: 800 } });

    // 居中：x = round((1000-300)/2) = 350，y = round((800-150)/2) = 325 —— v 不动时保留原 y
    const centred = await send({ type: 'layer.align', payload: { layerId: 'align-1', h: 'center' } });
    assert.equal(centred.ok, true, JSON.stringify(centred));
    assert.equal(aligned.x, 350);
    assert.equal(aligned.y, 626, '没给 v 时不能顺手改 y');
    assert.equal(centred.result.commandDetail.aligned.v, null);

    // 左上角：margin 缺省为 0
    const topLeft = await send({ type: 'layer.align', payload: { layerId: 'align-1', h: 'left', v: 'top' } });
    assert.equal(topLeft.ok, true, JSON.stringify(topLeft));
    assert.equal(aligned.x, 0);
    assert.equal(aligned.y, 0);
    assert.equal(topLeft.result.commandDetail.aligned.margin, 0);

    // 整条命令只占一步历史：撤销一次就回到对齐之前的位置。
    const undo = await send({ type: 'history.undo', payload: {} });
    assert.equal(undo.ok, true);
    assert.equal(aligned.x, 350, '撤销一次应回到上一次对齐的落点');
    assert.equal(aligned.y, 626);
    config.layers = config.layers.filter(layer => layer.id !== 'align-1');
  });
  await test('layer.align rejects missing intent, out-of-range margin and unknown targets', async () => {
    const target = { id: 'align-2', name: '边界', type: 'image', link: makeCanvas(10, 10, 3), x: 0, y: 0, width: 100, height: 100, order: 91, visible: true };
    config.layers.push(target);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const bad = [
      { layerId: 'align-2' },                                        // h/v 都没给
      { layerId: 'align-2', h: 'middle' },                           // h 用了 v 的取值
      { layerId: 'align-2', v: 'center' },                           // v 用了 h 的取值
      { layerId: 'align-2', h: 'left', margin: -1 },
      { layerId: 'align-2', h: 'left', margin: 1.5 },
      { layerId: 'align-2', h: 'left', margin: 99999 },
      { layerId: 'align-2', h: 'left', to: 'selection' },
      { layerId: 'missing', h: 'left' },
    ];
    for (const payload of bad) {
      const response = await send({ type: 'layer.align', payload });
      assert.equal(response.ok, false, JSON.stringify(payload));
      assert.ok(['INVALID_REQUEST', 'LAYER_NOT_FOUND'].includes(response.error.code), `${JSON.stringify(payload)} -> ${response.error.code}`);
    }
    // margin 大到可用区域变负：明确拒绝，而不是算出一个负数坐标。
    const tooMuch = await send({ type: 'layer.align', payload: { layerId: 'align-2', h: 'left', margin: Math.floor(config.WIDTH / 2) } });
    assert.equal(tooMuch.ok, false, JSON.stringify(tooMuch));
    assert.equal(tooMuch.error.code, 'INVALID_REQUEST');
    assert.equal(target.x, 0, '被拒绝的命令不能改动图层');
    config.layers = config.layers.filter(layer => layer.id !== 'align-2');
  });
  await test('layer.duplicate copies the layer one step up, offsets it, and is a single undo', async () => {
    const source = { id: 'dup-src', name: '商品', type: 'image', data: 'data:image/png;base64,dup', link: makeCanvas(40, 20, 5), x: 100, y: 60, width: 40, height: 20, width_original: 40, height_original: 20, opacity: 80, rotate: 0, order: 70, visible: true, params: { dshMask: { sourceLayerId: 'mask-1', mode: 'alpha' } } };
    config.layers.push(source);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const before = config.layers.length;

    const duplicated = await send({ type: 'layer.duplicate', payload: { layerId: 'dup-src', offsetX: 12, offsetY: -8 } });
    assert.equal(duplicated.ok, true, JSON.stringify(duplicated));
    assert.equal(config.layers.length, before + 1, '复制必须新增一层');
    const copy = config.layers.find(layer => String(layer.id) === String(duplicated.result.changedObjectIds[0]));
    assert.ok(copy, '回执里的 changedObjectIds 必须是新层 id');
    assert.equal(copy.x, 112); assert.equal(copy.y, 52);
    assert.equal(copy.width, 40); assert.equal(copy.height, 20);
    assert.equal(copy.opacity, 80);
    assert.notEqual(copy.id, source.id);
    assert.deepEqual(JSON.parse(JSON.stringify(copy.params)), { dshMask: { sourceLayerId: 'mask-1', mode: 'alpha' } }, '活蒙版配置必须跟着复制');
    assert.match(copy.name, /副本$/);

    const undo = await send({ type: 'history.undo', payload: {} });
    assert.equal(undo.ok, true);
    assert.equal(config.layers.length, before, '撤销一次必须把副本拿掉');
  });
  await test('layer.duplicate rejects unknown keys, bad offsets and missing layers', async () => {
    for (const payload of [
      { layerId: 'dup-src', offsetX: 1.5 },
      { layerId: 'dup-src', offsetX: 99999 },
      { layerId: 'dup-src', scaleX: 2 },
      { layerId: 'dup-src', name: '' },
      { layerId: 'nope' },
    ]) {
      const response = await send({ type: 'layer.duplicate', payload });
      assert.equal(response.ok, false, JSON.stringify(payload));
      assert.ok(['INVALID_REQUEST', 'LAYER_NOT_FOUND'].includes(response.error.code), `${JSON.stringify(payload)} -> ${response.error.code}`);
    }
    config.layers = config.layers.filter(layer => layer.id !== 'dup-src');
  });

  await test('layer.rasterize replaces a layer with a pixel copy in one history entry', async () => {
    // 真实图层 id 是整数（Delete_layer_action 会 parseInt），所以用例也用数字 id。
    const textLayer = { id: 9001, name: '标题', type: 'text', data: [[{ text: 'HAND WEAVING' }]], x: 30, y: 40, width: 200, height: 60, opacity: 70, rotate: 15, order: 71, visible: true, is_vector: false };
    config.layers.push(textLayer);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const before = config.layers.length;

    const result = await send({ type: 'layer.rasterize', payload: { layerId: '9001' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(config.layers.length, before, '栅格化是替换，不是新增');
    assert.equal(config.layers.some(layer => String(layer.id) === '9001'), false, '原文字层必须被移除');
    const produced = config.layers.find(layer => String(layer.id) === String(result.result.changedObjectIds[0]));
    assert.ok(produced, '回执里的 changedObjectIds 必须是新层 id');
    assert.equal(produced.type, 'image', '结果必须是图片层');
    assert.equal(produced.x, 30); assert.equal(produced.y, 40);
    assert.equal(produced.width, 200); assert.equal(produced.height, 60);
    assert.equal(produced.opacity, 70);
    assert.equal(produced.rotate, 0, '旋转已烤进像素，新层不能带 rotate');
    assert.deepEqual(JSON.parse(JSON.stringify(produced.params)), {}, '活蒙版也已烤进像素，新层不能带 params');

    const undo = await send({ type: 'history.undo', payload: {} });
    assert.equal(undo.ok, true);
    assert.equal(config.layers.some(layer => String(layer.id) === '9001'), true, '撤销必须把原文字层还回来');
    config.layers = config.layers.filter(layer => String(layer.id) !== '9001' && String(layer.id) !== String(produced.id));
  });
  await test('layer.rasterize refuses empty layers and unknown layer ids', async () => {
    const empty = { id: 9002, name: '空', type: null, x: 0, y: 0, width: 10, height: 10, order: 72, visible: true };
    config.layers.push(empty);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const refused = await send({ type: 'layer.rasterize', payload: { layerId: '9002' } });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'EMPTY_LAYER');
    const missing = await send({ type: 'layer.rasterize', payload: { layerId: 'no-such-layer' } });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'LAYER_NOT_FOUND');
    config.layers = config.layers.filter(layer => layer.id !== 9002);
  });

  await test('layer.merge_down folds two layers into one and a single undo brings both back', async () => {
    config.WIDTH = 120; config.HEIGHT = 90;
    const lower = { id: 9003, name: '底', type: 'image', link: makeCanvas(20, 20, 3), x: 0, y: 0, width: 20, height: 20, order: 80, visible: true, opacity: 100, composition: 'source-over' };
    const upper = { id: 9004, name: '上', type: 'image', link: makeCanvas(20, 20, 4), x: 10, y: 10, width: 20, height: 20, order: 81, visible: true, opacity: 60, composition: 'multiply' };
    config.layers.push(lower, upper);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const before = config.layers.length;

    const merged = await send({ type: 'layer.merge_down', payload: { layerId: '9004' } });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.equal(config.layers.length, before - 1, '合并后层数必须减一');
    assert.equal(config.layers.some(layer => [9003, 9004].includes(layer.id)), false, '两层都必须被移除');
    const result = config.layers.find(layer => String(layer.id) === String(merged.result.changedObjectIds[0]));
    assert.ok(result);
    assert.equal(result.type, 'image');
    assert.equal(result.width, 120); assert.equal(result.height, 90, '合并结果覆盖整块画布');
    assert.equal(result.opacity, 100, '外观已烤进像素，新层不能重复叠加');
    assert.equal(result.composition, 'source-over');

    const undo = await send({ type: 'history.undo', payload: {} });
    assert.equal(undo.ok, true);
    assert.equal(config.layers.length, before, '撤销必须把两层都还回来');
    assert.ok(config.layers.some(layer => layer.id === 9004));
    assert.ok(config.layers.some(layer => layer.id === 9003));
    config.layers = config.layers.filter(layer => ![9003, 9004].includes(layer.id) && String(layer.id) !== String(result.id));
  });
  await test('layer.merge_down reports NO_LAYER_BELOW instead of silently doing nothing', async () => {
    const only = { id: 9005, name: '唯一', type: 'image', link: makeCanvas(10, 10, 1), x: 0, y: 0, width: 10, height: 10, order: 82, visible: true };
    // 只留这一层，确保它下面没有任何层。
    const saved = config.layers.slice();
    config.layers = [only];
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const response = await send({ type: 'layer.merge_down', payload: { layerId: '9005' } });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'NO_LAYER_BELOW');
    config.layers = saved;
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
  });

  await test('layer.paint_stroke draws onto the layer pixels as one undoable step', async () => {
    const target = { id: 9006, name: '画布层', type: 'image', link: makeCanvas(40, 40, 9), x: 0, y: 0, width: 40, height: 40, width_original: 40, height_original: 40, order: 83, visible: true };
    config.layers.push(target);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const revisionBefore = bridge.revision;
    const layersBefore = config.layers.length;

    const drawn = await send({ type: 'layer.paint_stroke', payload: { layerId: '9006', points: [{ x: 2, y: 2 }, { x: 20, y: 20 }, { x: 38, y: 5 }], color: '#ff0000', size: 6, opacity: 0.8 } });
    assert.equal(drawn.ok, true, JSON.stringify(drawn));
    // vm 里返回的数组来自另一个 realm：JSON 归一后再比，避免原型不同导致的假失败。
    assert.deepEqual(JSON.parse(JSON.stringify(drawn.result.changedObjectIds)), ['9006'], '画笔只改目标层，不新增层');
    assert.equal(bridge.revision, revisionBefore + 1, '一笔就是一步 revision');
    assert.equal(config.layers.length, layersBefore, '画笔不改变层数');

    const undo = await send({ type: 'history.undo', payload: {} });
    assert.equal(undo.ok, true);
    // 这里不断言"撤销把 revision +1"：桩版 Update_layer_image_action 的 undo 不触碰 pixelMutation，
    // revision 是否前进取决于真实原生动作。可断言的是撤销成功且 revision 不倒退。
    assert.ok(bridge.revision >= revisionBefore + 1, '撤销不能把 revision 倒退');
    config.layers = config.layers.filter(layer => layer.id !== 9006);
  });
  await test('layer.paint_stroke validates points, colour, size and opacity before touching pixels', async () => {
    const target = { id: 9007, name: '目标', type: 'image', link: makeCanvas(10, 10, 2), x: 0, y: 0, width: 10, height: 10, order: 84, visible: true };
    config.layers.push(target);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const bad = [
      { layerId: '9007', points: [{ x: 1, y: 1 }] },                                  // 少于 2 点
      { layerId: '9007', points: Array.from({ length: 201 }, () => ({ x: 1, y: 1 })) }, // 超过 200 点
      { layerId: '9007', points: [{ x: 'a', y: 1 }, { x: 2, y: 2 }] },                 // 非数字
      { layerId: '9007', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], color: 'red' },
      { layerId: '9007', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], size: 0 },
      { layerId: '9007', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], size: 201 },
      { layerId: '9007', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], opacity: 1.5 },
      { layerId: '9007', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], hardness: 0.5 },     // 未知键
      { layerId: 'missing', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
    ];
    for (const payload of bad) {
      const response = await send({ type: 'layer.paint_stroke', payload });
      assert.equal(response.ok, false, JSON.stringify(payload).slice(0, 160));
      assert.ok(['INVALID_REQUEST', 'LAYER_NOT_FOUND'].includes(response.error.code), `${JSON.stringify(payload).slice(0, 80)} -> ${response.error.code}`);
    }
    config.layers = config.layers.filter(layer => layer.id !== 9007);
  });
  await test('layer.set_effect builds a non-destructive stack that read_state reports and undo reverts', async () => {
    const layer = { id: 9101, name: '效果层', type: 'image', link: makeCanvas(20, 20, 6), x: 0, y: 0, width: 20, height: 20, order: 90, visible: true, opacity: 100 };
    config.layers.push(layer);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    config.layer = layer;

    const first = await send({ type: 'layer.set_effect', payload: { layerId: '9101', effect: 'brightness', value: 1.4 } });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.commandDetail.effects.filter, 'brightness(1.4)', '回执里的 filter 必须是渲染时真正用的那条');
    const second = await send({ type: 'layer.set_effect', payload: { layerId: '9101', effect: 'blur', value: 3 } });
    assert.equal(second.ok, true, JSON.stringify(second));
    // 顺序固定：blur 在 brightness 之前，和 dsh_effect_filter 的遍历顺序一致。
    assert.equal(second.result.commandDetail.effects.filter, 'blur(3px) brightness(1.4)');
    assert.equal(bridge.readState().layers.find(item => String(item.id) === '9101').effects.blur, 3, 'read_state 必须能看到效果栈');

    const undone = await send({ type: 'history.undo', payload: {} });
    assert.equal(undone.ok, true);
    const afterUndo = bridge.readState().layers.find(item => String(item.id) === '9101').effects;
    assert.equal(afterUndo.blur, undefined, '撤销一次应退回只加 brightness 的状态');
    assert.equal(afterUndo.brightness, 1.4);

    // value:null 等价于删掉这一项。
    const cleared = await send({ type: 'layer.set_effect', payload: { layerId: '9101', effect: 'brightness', value: null } });
    assert.equal(cleared.ok, true, JSON.stringify(cleared));
    assert.equal(cleared.result.commandDetail.effects.filter, '');
    assert.equal(bridge.readState().layers.find(item => String(item.id) === '9101').effects, undefined, '栈空了就不该留空对象');
    config.layers = config.layers.filter(item => item.id !== 9101);
  });
  await test('layer.remove_effect drops one entry, or clears the whole stack when effect is omitted', async () => {
    const layer = { id: 9102, name: '效果层2', type: 'image', link: makeCanvas(20, 20, 7), x: 0, y: 0, width: 20, height: 20, order: 91, visible: true, opacity: 100 };
    config.layers.push(layer);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    for (const [effect, value] of [['brightness', 1.2], ['saturate', 0.5], ['grayscale', 1]]) {
      const response = await send({ type: 'layer.set_effect', payload: { layerId: '9102', effect, value } });
      assert.equal(response.ok, true, JSON.stringify(response));
    }
    const one = await send({ type: 'layer.remove_effect', payload: { layerId: '9102', effect: 'saturate' } });
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.equal(one.result.commandDetail.effects.filter, 'brightness(1.2) grayscale(1)');
    const all = await send({ type: 'layer.remove_effect', payload: { layerId: '9102' } });
    assert.equal(all.ok, true, JSON.stringify(all));
    assert.equal(all.result.commandDetail.effects.filter, '');
    config.layers = config.layers.filter(item => item.id !== 9102);
  });
  await test('effect commands reject unknown vocabulary, out-of-range values and extra keys', async () => {
    const layer = { id: 9103, name: '效果层3', type: 'image', link: makeCanvas(10, 10, 1), x: 0, y: 0, width: 10, height: 10, order: 92, visible: true };
    config.layers.push(layer);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    const bad = [
      { layerId: '9103', effect: 'sharpen', value: 1 },       // 词表之外
      { layerId: '9103', effect: 'brightness', value: 5 },    // 超出 0..3
      { layerId: '9103', effect: 'brightness', value: -1 },
      { layerId: '9103', effect: 'blur', value: 51 },
      { layerId: '9103', effect: 'hueRotate', value: 400 },
      { layerId: '9103', effect: 'grayscale', value: '1' },   // 字符串
      { layerId: '9103', value: 1 },                          // 缺 effect
      { layerId: '9103', effect: 'brightness', value: 1, extra: true },
      { layerId: 'missing', effect: 'brightness', value: 1 },
    ];
    for (const payload of bad) {
      const response = await send({ type: 'layer.set_effect', payload });
      assert.equal(response.ok, false, JSON.stringify(payload));
      assert.ok(['INVALID_REQUEST', 'LAYER_NOT_FOUND'].includes(response.error.code), `${JSON.stringify(payload)} -> ${response.error.code}`);
    }
    const clearBad = await send({ type: 'layer.remove_effect', payload: { layerId: '9103' } });
    assert.equal(clearBad.ok, true, '空栈上清空是幂等的，不该报错');
    config.layers = config.layers.filter(item => item.id !== 9103);
  });
  await test('layer.update_mask flips invert, rebinds the mask source, and undo restores the previous mask', async () => {
    const maskA = { id: 9201, name: '蒙版A', type: 'image', link: makeCanvas(20, 20, 3), x: 0, y: 0, width: 20, height: 20, order: 93, visible: true };
    const maskB = { id: 9202, name: '蒙版B', type: 'image', link: makeCanvas(20, 20, 4), x: 0, y: 0, width: 20, height: 20, order: 94, visible: true };
    const target = { id: 9203, name: '被遮罩层', type: 'image', link: makeCanvas(20, 20, 5), x: 0, y: 0, width: 20, height: 20, order: 95, visible: true,
      params: { dshMask: { sourceLayerId: '9201', mode: 'alpha', invert: false } } };
    config.layers.push(maskA, maskB, target);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    // 手工加图层后要先算完摘要，否则 readState 会（正确地）抛 DIGEST_TIMEOUT。
    await bridge.prepareDigest();

    // read_state 必须能看到 invert，否则改完无法自证。
    const before = bridge.readState().layers.find(item => String(item.id) === '9203');
    assert.equal(before.mask.sourceLayerId, '9201');
    assert.equal(before.mask.invert, false);

    const flipped = await send({ type: 'layer.update_mask', payload: { layerId: '9203', invert: true } });
    assert.equal(flipped.ok, true, JSON.stringify(flipped));
    assert.deepEqual(JSON.parse(JSON.stringify(flipped.result.commandDetail.mask)), { layerId: '9203', sourceLayerId: '9201', invert: true });
    assert.equal(bridge.readState().layers.find(item => String(item.id) === '9203').mask.invert, true);

    const rebound = await send({ type: 'layer.update_mask', payload: { layerId: '9203', sourceLayerId: '9202' } });
    assert.equal(rebound.ok, true, JSON.stringify(rebound));
    assert.equal(rebound.result.commandDetail.mask.sourceLayerId, '9202');
    assert.equal(rebound.result.commandDetail.mask.invert, true, '换蒙版源不该顺手把 invert 重置');

    const undone = await send({ type: 'history.undo', payload: {} });
    assert.equal(undone.ok, true);
    assert.equal(bridge.readState().layers.find(item => String(item.id) === '9203').mask.sourceLayerId, '9201', '撤销一次退回上一个蒙版源');

    // remove 整块摘掉活蒙版。
    const removed = await send({ type: 'layer.update_mask', payload: { layerId: '9203', remove: true } });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.result.commandDetail.mask.removed, true);
    assert.equal(bridge.readState().layers.find(item => String(item.id) === '9203').mask, undefined, '摘掉后 read_state 不该再有 mask');
    config.layers = config.layers.filter(item => ![9201, 9202, 9203].includes(item.id));
  });
  await test('layer.update_mask refuses cycles, unknown sources, and params the live renderer ignores', async () => {
    const a = { id: 9211, name: 'A', type: 'image', link: makeCanvas(10, 10, 1), x: 0, y: 0, width: 10, height: 10, order: 96, visible: true };
    const b = { id: 9212, name: 'B', type: 'image', link: makeCanvas(10, 10, 2), x: 0, y: 0, width: 10, height: 10, order: 97, visible: true,
      params: { dshMask: { sourceLayerId: '9211', mode: 'alpha', invert: false } } };
    const plain = { id: 9213, name: '无蒙版', type: 'image', link: makeCanvas(10, 10, 3), x: 0, y: 0, width: 10, height: 10, order: 98, visible: true };
    config.layers.push(a, b, plain);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();

    // A 以 B 为蒙版会让 A→B→A 成环。
    const cycle = await send({ type: 'layer.update_mask', payload: { layerId: '9211', sourceLayerId: '9212' } });
    assert.equal(cycle.ok, false);
    assert.equal(cycle.error.code, 'MASK_CYCLE');

    const self = await send({ type: 'layer.update_mask', payload: { layerId: '9211', sourceLayerId: '9211' } });
    assert.equal(self.ok, false);
    assert.equal(self.error.code, 'MASK_CYCLE');

    const missingSource = await send({ type: 'layer.update_mask', payload: { layerId: '9211', sourceLayerId: 'nope' } });
    assert.equal(missingSource.ok, false);
    assert.equal(missingSource.error.code, 'LAYER_NOT_FOUND');

    // 这一层本来没有活蒙版、又想只改 invert：如实说没有蒙版，而不是造一个空的。
    const noMask = await send({ type: 'layer.update_mask', payload: { layerId: '9213', invert: true } });
    assert.equal(noMask.ok, false);
    assert.equal(noMask.error.code, 'MASK_NOT_FOUND');

    // mode/featherPx 活蒙版渲染不读，收下就是骗人 —— 必须拒绝。
    for (const payload of [
      { layerId: '9212', featherPx: 4 },
      { layerId: '9212', mode: 'luminance' },
      { layerId: '9212' },                                   // 什么都没给
      { layerId: '9212', invert: 'yes' },                    // 类型错
      { layerId: '9212', remove: true, invert: true },       // 互斥
    ]) {
      const response = await send({ type: 'layer.update_mask', payload });
      assert.equal(response.ok, false, JSON.stringify(payload));
      assert.equal(response.error.code, 'INVALID_REQUEST', JSON.stringify(payload));
    }
    config.layers = config.layers.filter(item => ![9211, 9212, 9213].includes(item.id));
  });
  await test('read_state reports bounds and canvas-clipped coverage so callers stop guessing coordinates', async () => {
    config.WIDTH = 400; config.HEIGHT = 200;
    const inside = { id: 9301, name: '内部', type: 'image', link: makeCanvas(100, 50, 5), x: 100, y: 50, width: 200, height: 100, order: 99, visible: true };
    const straddling = { id: 9302, name: '出血', type: 'image', link: makeCanvas(100, 50, 6), x: 300, y: 150, width: 200, height: 100, order: 100, visible: true };
    config.layers.push(inside, straddling);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    await bridge.prepareDigest();
    const state = bridge.readState();
    const read = id => state.layers.find(item => String(item.id) === id);

    const a = read('9301');
    assert.deepEqual(JSON.parse(JSON.stringify(a.bounds)), { x: 100, y: 50, width: 200, height: 100, right: 300, bottom: 150 });
    // 200×100 / (400×200) = 0.25
    assert.equal(a.coverage, 0.25);
    assert.equal(a.offCanvas, undefined, '完全在画布内不该标 offCanvas');

    // 右侧/下侧各溢出 100：可见部分只有 100×50，占画布 100*50/80000 = 0.0625。
    const b = read('9302');
    assert.deepEqual(JSON.parse(JSON.stringify(b.bounds)), { x: 300, y: 150, width: 200, height: 100, right: 500, bottom: 250 });
    assert.equal(b.coverage, 0.0625, 'coverage 按帧∩画布算，溢出部分不计');
    assert.equal(b.offCanvas, true);

    // 完全落在画布外的图层：coverage 必须是 0，不能出现负数或 >1。
    const outside = { id: 9303, name: '外面', type: 'image', link: makeCanvas(10, 10, 1), x: -500, y: -500, width: 10, height: 10, order: 101, visible: true };
    config.layers.push(outside);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    await bridge.prepareDigest();
    const c = bridge.readState().layers.find(item => String(item.id) === '9303');
    assert.equal(c.coverage, 0);
    assert.equal(c.offCanvas, true);
    config.layers = config.layers.filter(item => ![9301, 9302, 9303].includes(item.id));
  });
  await test('analyze reports per-region measurements and flags layers that fall outside the canvas', async () => {
    config.WIDTH = 400; config.HEIGHT = 200;
    const inside = { id: 9311, name: '主体', type: 'image', link: makeCanvas(100, 50, 5), x: 0, y: 0, width: 400, height: 200, order: 102, visible: true };
    const outside = { id: 9312, name: '画布外', type: 'image', link: makeCanvas(10, 10, 1), x: 900, y: 900, width: 10, height: 10, order: 103, visible: true };
    config.layers.push(inside, outside);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();
    await bridge.prepareDigest();

    const analysis = bridge.analyzeDocument({ maxSide: 200 });
    assert.ok(Array.isArray(analysis.regions), 'analyze 必须给出 regions');
    const full = analysis.regions.find(item => item.layerId === '9311');
    assert.equal(full.inCanvas, true);
    assert.ok(full.canvasShare > 0.9, `整幅图层应占满采样画布，实际 ${full.canvasShare}`);
    assert.ok(full.opaqueRatio > 0.9, '合成桩铺满不透明像素，占比应接近 1');
    assert.equal(typeof full.meanLuma, 'number');
    assert.equal(typeof full.lumaStdDev, 'number');

    const gone = analysis.regions.find(item => item.layerId === '9312');
    assert.equal(gone.inCanvas, false, '画布外的图层要如实标 inCanvas:false');
    assert.equal(gone.sampledArea, 0);
    assert.equal(analysis.regionsTruncated, 0);
    config.layers = config.layers.filter(item => ![9311, 9312].includes(item.id));
  });
  await test('preview crop renders only the requested region, clamps it, and reports what it actually used', async () => {
    config.WIDTH = 400; config.HEIGHT = 200;
    const full = bridge.previewPng({ maxWidth: 640 });
    assert.deepEqual(JSON.parse(JSON.stringify(full.crop)), { x: 0, y: 0, width: 400, height: 200 }, '不裁切时 crop 就是整幅');
    assert.equal(full.width, 400);

    // 只截 200×100：maxWidth 640 大于区域宽，所以不缩放。
    const cropped = bridge.previewPng({ maxWidth: 640, crop: { x: 100, y: 50, width: 200, height: 100 } });
    assert.deepEqual(JSON.parse(JSON.stringify(cropped.crop)), { x: 100, y: 50, width: 200, height: 100 });
    assert.equal(cropped.width, 200);
    assert.equal(cropped.height, 100);
    assert.equal(cropped.scale, 1);

    // 越界部分被夹到画布内，并且如实回报夹过的矩形（不假装截了我们写的那个框）。
    const clamped = bridge.previewPng({ maxWidth: 640, crop: { x: 350, y: 150, width: 200, height: 200 } });
    assert.deepEqual(JSON.parse(JSON.stringify(clamped.crop)), { x: 350, y: 150, width: 50, height: 50 });
    assert.equal(clamped.width, 50);

    // 区域放大到 maxWidth：宽 200 的区域被压到 100，scale 0.5。
    const scaled = bridge.previewPng({ maxWidth: 100, crop: { x: 0, y: 0, width: 200, height: 100 } });
    assert.equal(scaled.width, 100);
    assert.equal(scaled.scale, 0.5);
  });
  await test('preview validates crop shape and rejects an empty intersection', async () => {
    for (const crop of [
      { x: 0, y: 0, width: 10 },                                  // 缺字段
      { x: 0, y: 0, width: 0, height: 10 },                        // 宽为 0
      { x: 1.5, y: 0, width: 10, height: 10 },                     // 非整数
      { x: 0, y: 0, width: 10, height: 10, extra: 1 },             // 多余字段
      { x: 900, y: 900, width: 10, height: 10 },                   // 与画布无交集
    ]) {
      assert.throws(() => bridge.previewPng({ crop }), error => error.code === 'INVALID_REQUEST', JSON.stringify(crop));
    }
  });
  await test('preview layerId renders one layer only, and gridStep is validated and echoed', async () => {
    config.WIDTH = 400; config.HEIGHT = 200;
    const layer = { id: 9401, name: '单层', type: 'image', link: makeCanvas(50, 40, 3), x: 10, y: 10, width: 50, height: 40, order: 104, visible: true };
    config.layers.push(layer);
    bridge.pixelMutation += 1;
    bridge.refreshRevision();

    const single = bridge.previewPng({ layerId: '9401', maxWidth: 200 });
    assert.equal(single.layerId, '9401');
    assert.equal(single.crop.width, 400, '单层预览仍按整幅画布坐标系返回');

    assert.throws(() => bridge.previewPng({ layerId: 'nope' }), error => error.code === 'LAYER_NOT_FOUND');

    // 网格步长：布尔 true = 默认 100；数字 = 源图像素步长；越界/非整数拒绝。
    assert.equal(bridge.previewPng({ grid: true }).gridStep, 100);
    assert.equal(bridge.previewPng({ gridStep: 50 }).gridStep, 50);
    assert.equal(bridge.previewPng({ grid: 200 }).gridStep, 200);
    for (const step of [7, 2001, 1.5]) {
      assert.throws(() => bridge.previewPng({ gridStep: step }), error => error.code === 'INVALID_REQUEST', `step ${step}`);
    }
    config.layers = config.layers.filter(item => item.id !== 9401);
  });
  await test('export_start format psd 产出可解析的分层文件，并如实登记降级项', async () => {
    const previousBlob = context.Blob;
    const previousURL = context.URL;
    const savedLayers = config.layers.slice();
    const savedWidth = config.WIDTH, savedHeight = config.HEIGHT;
    context.Blob = class { constructor(parts) { this.size = parts.reduce((sum, part) => sum + (part.length ?? 0), 0); this.parts = parts; } };
    context.URL = { createObjectURL: () => 'blob:psd-1' };
    try {
      config.WIDTH = 40; config.HEIGHT = 30;
      const base = { id: 9501, name: '底', type: 'image', link: makeCanvas(40, 30, 4), x: 0, y: 0, width: 40, height: 30, order: 10, visible: true, opacity: 100, composition: 'source-over' };
      const top = { id: 9502, name: '上层', type: 'image', link: makeCanvas(20, 10, 7), x: 5, y: 5, width: 20, height: 10, order: 20, visible: true, opacity: 50, composition: 'multiply', params: { dshMask: { sourceLayerId: '9501', mode: 'alpha', invert: false } } };
      const offCanvas = { id: 9503, name: '画布外', type: 'image', link: makeCanvas(5, 5, 1), x: 900, y: 900, width: 5, height: 5, order: 30, visible: true };
      // 只留这三层，避免受前面用例残留图层的影响。
      config.layers = [base, top, offCanvas];
      bridge.pixelMutation += 1;
      bridge.refreshRevision();
      await bridge.prepareDigest();

      const result = await callEditor({ type: 'editor.export_start', requestId: 'psd-exp-1', editorInstanceId: bridge.editorInstanceId, documentId: bridge.documentId, expectedRevision: bridge.revision, commandId: 'psd-1', format: 'psd' });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.result.status, 'completed');
      assert.equal(result.result.mimeType, 'image/vnd.adobe.photoshop');
      assert.equal(result.result.layerCount, 2, '画布外的层不该写进 PSD');
      assert.match(result.result.artifactRef, /^blob:/);

      // 降级项必须如实登记：活蒙版烤进像素 + 画布外跳过。
      const kinds = result.result.approximations.map(item => item.kind);
      assert.ok(kinds.includes('mask-baked'), JSON.stringify(result.result.approximations));
      assert.ok(kinds.includes('off-canvas'), JSON.stringify(result.result.approximations));

      // 同一个 commandId 重复调用返回同一份结果，不重写。
      const again = await callEditor({ type: 'editor.export_start', requestId: 'psd-exp-2', editorInstanceId: bridge.editorInstanceId, documentId: bridge.documentId, expectedRevision: bridge.revision, commandId: 'psd-1', format: 'psd' });
      assert.equal(again.result.exportId, result.result.exportId);
    } finally {
      context.Blob = previousBlob;
      context.URL = previousURL;
      config.layers = savedLayers;
      config.WIDTH = savedWidth; config.HEIGHT = savedHeight;
      bridge.pixelMutation += 1;
      bridge.refreshRevision();
    }
  });
  await test('export_start 拒绝未知格式', async () => {
    const bad = await callEditor({ type: 'editor.export_start', requestId: 'bad-exp', editorInstanceId: bridge.editorInstanceId, documentId: bridge.documentId, expectedRevision: bridge.revision, commandId: 'bad-1', format: 'tiff' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'INVALID_REQUEST');
  });
  console.log(JSON.stringify({passed:count,scope:'real bridge + real native action/state methods; DOM/rendering stubbed, not browser acceptance'}));
})().catch(error => { console.error(error); process.exitCode=1; });
