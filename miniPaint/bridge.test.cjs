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
  await test('canvas crop and resize are native reversible single history entries', async () => {
    const width=config.WIDTH,height=config.HEIGHT,x=config.layers[0].x;
    const crop=await send({type:'canvas.crop',payload:{x:10,y:10,width:200,height:100}});
    assert.equal(crop.ok,true);
    assert.equal(config.WIDTH,200);assert.equal(config.layers[0].x,x-10);
    const undo=await send({type:'history.undo',payload:{}});
    assert.equal(undo.ok,true);assert.equal(config.WIDTH,width);assert.equal(config.HEIGHT,height);assert.equal(config.layers[0].x,x);
    const resize=await send({type:'canvas.resize',payload:{width:400,height:300}});
    assert.equal(resize.ok,true);assert.equal(config.WIDTH,400);assert.equal(config.layers[0].x,x);
  });
  console.log(JSON.stringify({passed:count,scope:'real bridge + real native action/state methods; DOM/rendering stubbed, not browser acceptance'}));
})().catch(error => { console.error(error); process.exitCode=1; });
