// Single-process tests against the real bridge class and real native miniPaint actions.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = __dirname;
const config = { WIDTH: 800, HEIGHT: 600, COLOR: '#000000', TOOL: {name: 'select'}, layers: [], layer: null };
const app = {Actions: {}, GUI: { GUI_layers: { render_layers() {} } }};
const zoomView = {getPosition() {return {x: 12, y: 18};}, getScale() {return 1.5;}};
const listeners = {};
const context = vm.createContext({ console, config, app, zoomView, globalThis: { crypto: { randomUUID: require('node:crypto').randomUUID } },
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
// test-only 画布桩：只让羽化/色匹的结构可测（路由、校验、快照、撤销回退、read_state 字段），
// 不断言像素颜色；像素摘要用「确定性填充值」模拟内容变化，真实像素效果由浏览器验收。
function makeCanvas(w = 8, h = 8, content = 1) {
  const canvas = {
    width: w, height: h, _content: content, _drawn: null,
    getContext() {
      return {
        globalAlpha: 1,
        clearRect() {},
        drawImage(source) { if (source && (source._drawn !== undefined || source._content !== undefined)) canvas._drawn = source._drawn ?? source._content; },
        putImageData(image) {
          // 用抽样和代表「内容」：只要像素内容变了，这个值就会变，用来观察摘要是否跟随。
          const data = image && image.data;
          let sum = 0;
          if (data) for (let index = 0; index < data.length; index += 97) sum += data[index];
          canvas._drawn = sum & 0xff;
        },
        getImageData: (x, y, cw, ch) => {
          const value = Number(canvas._drawn ?? canvas._content) & 0xff;
          return { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4).fill(value) };
        },
      };
    },
  };
  return canvas;
}
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
  console.log(JSON.stringify({passed:count,scope:'real bridge + real native action/state methods; DOM/rendering stubbed, not browser acceptance'}));
})().catch(error => { console.error(error); process.exitCode=1; });
