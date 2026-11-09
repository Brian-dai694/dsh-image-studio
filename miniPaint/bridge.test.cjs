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
for (const [file, symbol] of [['insert-layer','Insert_layer_action'], ['update-layer','Update_layer_action'], ['reorder-layer','Reorder_layer_action'], ['toggle-layer-visibility','Toggle_layer_visibility_action'], ['bundle','Bundle_action']]) app.Actions[symbol] = load(`actions/${file}.js`, symbol);
app.Layers = {auto_increment: 1, render() {}, get_layer(id) { return config.layers.find(layer => layer.id == id); },
  get_sorted_layers() {return config.layers.slice().sort((a,b) => b.order-a.order);},
  find_previous(id) {const layers = this.get_sorted_layers(); return layers[layers.findIndex(l => l.id == id)+1];},
  find_next(id) {const layers = this.get_sorted_layers(); return layers[layers.findIndex(l => l.id == id)-1];}};
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
  console.log(JSON.stringify({passed:count,scope:'real bridge + real native action/state methods; DOM/rendering stubbed, not browser acceptance'}));
})().catch(error => { console.error(error); process.exitCode=1; });
