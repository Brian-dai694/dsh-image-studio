// Client-bundle contract test: no DSH runtime, no browser. It stubs the module loader and
// the `slots`/`layout` services so a broken sidebar registration fails here, not in the GUI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fakeReact = {
  useRef(value) { return { current: value }; },
  createElement(type, props, ...children) { return { type, props: { ...(props || {}), children } }; },
};

async function loadClient() {
  let exported = null;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) { exported = factory(name => (name === 'react' ? fakeReact : {})); },
    },
  };
  await import(`${pathToFileURL(resolve(root, 'lib/client.js')).href}?t=${Date.now()}`);
  assert.ok(exported, 'factory 没有被 ModuleLoader 调用');
  return exported;
}

function makeContext() {
  const registered = [];
  const injected = [];
  // The real `slots.inject` runs its factory after apply() returns, which is exactly what
  // turned a `for (var i ...)` closure into "both registrations use the last entry".
  // Defer every callback here so that class of bug fails in this test too.
  const deferred = [];
  const slots = {
    inject(name, factory) { injected.push(name); deferred.push(factory); return () => {}; },
    register(definition, component) { registered.push({ definition, component }); return () => {}; },
  };
  const layout = {
    selectPanel: id => { layout.selected = id; },
    toggleSidebar: () => { layout.sidebarToggles = (layout.sidebarToggles || 0) + 1; },
  };
  const ctx = {
    slots,
    layout,
    inject(services, callback) { deferred.push(() => callback(ctx)); },
  };
  const flush = () => {
    while (deferred.length) {
      const factory = deferred.shift();
      factory();
    }
  };
  return { ctx, registered, injected, layout, flush };
}

test('client bundle exports the Cordis contract', async () => {
  const client = await loadClient();
  assert.equal(client.name, 'dsh-media-image');
  assert.deepEqual(client.inject, ['slots', 'layout', 'remote', 'remote.session', 'uiWorkspace']);
  assert.equal(typeof client.apply, 'function');
});

test('main component receives real remote via injected props and closure without ctx prop', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  const session = { create() {}, follow() {}, prompt() {} };
  ctx.remote = { session };
  client.apply(ctx); flush();
  const main = registered.find(item => item.definition.name === 'main');
  const injected = main.definition.inject();
  assert.equal(injected.remote.session, session);
  assert.equal(client.chat.makePage(client.entries[0], () => ctx.remote)(injected).props.children[1].props.getRemote().session, session);
  assert.equal(client.chat.makePage(client.entries[0], () => ctx.remote)({}).props.children[1].props.getRemote().session, session);
});

test('dotted service lookup is supported without a root remote object', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  const session = { create() {} };
  ctx.get = key => key === 'remote.session' ? session : undefined;
  client.apply(ctx); flush();
  const main = registered.find(item => item.definition.name === 'main');
  assert.equal(client.chat.makePage(client.entries[0])(main.definition.inject()).props.children[1].props.getRemote().session, session);
});

test('it registers exactly one sidebar entry and one main pane', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  client.apply(ctx);
  flush();

  const lists = registered.filter(item => item.definition.name === 'sidebar.panellist');
  const mains = registered.filter(item => item.definition.name === 'main');
  assert.equal(lists.length, 1, '侧栏只应有本编辑器一个入口');
  assert.equal(mains.length, 1, '本入口需要一个 main 内容面板');
  assert.deepEqual(lists.map(item => item.definition.id).sort(), ['media-image-editor']);
  assert.deepEqual(lists.map(item => item.definition.label).sort(), ['图片编辑器'].sort());
  assert.deepEqual(mains.map(item => item.definition.key).sort(), ['media-image-editor']);
  assert.equal(new Set(lists.map(item => item.definition.id)).size, 1, '只有一个入口');
});

test('deferred slot callbacks keep their own entry (no var-closure capture)', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  client.apply(ctx);
  flush();
  // Flushing again must not re-register with a different id, and orders must stay stable.
  const before = registered.map(item => [item.definition.id, item.definition.order]);
  flush();
  assert.deepEqual(registered.map(item => [item.definition.id, item.definition.order]), before);
  const orders = registered.filter(item => item.definition.name === 'sidebar.panellist').map(item => item.definition.order);
  assert.equal(new Set(orders).size, 1, '只有一个入口 order');
});

test('the host pages are framed by the panels, never exposed as their own entries', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  client.apply(ctx);
  flush();
  const panel = registered.filter(item => item.definition.name === 'main');
  const byId = Object.fromEntries(panel.map(item => [item.definition.id, client.chat.makePage(client.entries.find(entry => entry.id === item.definition.id))()]));
  assert.equal(byId['media-image-editor'].props.children[0].props.src, '/media-image/image/host.html');
  for (const page of Object.values(byId)) assert.equal(page.props.children[1].type.name, 'Conversation');
});

test('main keyed panels only own anchors and one root overlay owns retained editor trees', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  client.apply(ctx); flush();
  const retained = registered.filter(item => item.definition.name === 'shell.overlay');
  assert.equal(retained.length, 1);
  assert.equal(retained[0].definition.id, 'media-image-retained-editors');
  for (const main of registered.filter(item => item.definition.name === 'main')) assert.equal(main.component.name, 'EditorAnchor');
});

test('clicking an entry selects its panel through layout.selectPanel', async () => {
  const client = await loadClient();
  const { ctx, registered, layout, flush } = makeContext();
  client.apply(ctx);
  flush();
  const entries = registered.filter(item => item.definition.name === 'sidebar.panellist');
  for (const entry of entries) {
    const element = entry.component({ active: false });
    assert.equal(element.type, 'button');
    assert.equal(element.props['aria-label'], entry.definition.label);
    element.props.onClick();
    assert.equal(layout.selected, entry.definition.id);
  }
});

test('selecting an editor never blindly toggles the native sidebar', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  client.apply(ctx);
  flush();
  const entries = registered.filter(item => item.definition.name === 'sidebar.panellist');
  const toggle = ctx.layout.toggleSidebar;
  let calls = 0;
  ctx.layout.toggleSidebar = () => { calls += 1; toggle(); };
  entries[0].component({ active: false }).props.onClick();
  entries[0].component({ active: false }).props.onClick();
  assert.equal(calls, 0, '面板已有内嵌对话，不应切换原生侧栏');
  assert.equal(ctx.layout.selected, entries[0].definition.id);
});

test('a host without toggleSidebar still selects the panel', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  delete ctx.layout.toggleSidebar;
  client.apply(ctx);
  flush();
  const entry = registered.find(item => item.definition.name === 'sidebar.panellist');
  assert.doesNotThrow(() => entry.component({ active: false }).props.onClick());
  assert.equal(ctx.layout.selected, entry.definition.id);
});

test('prompt failure never retries a potentially accepted request', async () => {
  const client = await loadClient();
  let calls = 0;
  const result = await client.chat.sendPrompt({ session: { prompt() { calls++; throw new Error('requestId required'); } } }, 's1', 'hello');
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
});

test('follow disposal aborts pending next and suppresses late events', async () => {
  const client = await loadClient();
  let resolveNext, signal, returned = 0;
  const events = [];
  const iterator = { next: () => new Promise(resolve => { resolveNext = resolve; }), return: async () => { returned++; return { done: true }; } };
  const remote = { session: { follow(body, options) {
    assert.equal(body.address.sessionId, 's1'); signal = options;
    return { [Symbol.asyncIterator]: () => iterator };
  } } };
  const stop = client.chat.followSession(remote, 's1', event => events.push(event));
  await new Promise(resolve => setImmediate(resolve));
  stop(); resolveNext({ value: { text: 'late' }, done: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(returned, 1);
  assert.deepEqual(events, []);
});

test('stream chunks dedupe and are replaced by committed events in either order', async () => {
  const client = await loadClient();
  for (const eventFirst of [true, false]) {
    const reduce = client.chat.makeTranscript();
    const wrap = frame => ({ type: 'assistant-stream', frame });
    reduce(wrap({ type: 'start', attemptId: 'a', revision: 1 }));
    const chunk = wrap({ type: 'chunk', attemptId: 'a', revision: 1, index: 0, chunk: { type: 'text-delta', text: 'hello' } });
    reduce(chunk);
    assert.equal(reduce(chunk)[0].text, 'hello');
    const event = { type: 'event', event: { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'hello' }] } } } };
    const end = wrap({ type: 'end', attemptId: 'a', revision: 1, index: 1, outcome: { kind: 'committed', seq: 4 } });
    reduce(eventFirst ? event : end);
    assert.equal(reduce(eventFirst ? end : event).length, 1);
    assert.equal(reduce(event)[0].id, 'event-4');
  }
});

test('snapshot records dedupe with live events and abandoned attempts disappear', async () => {
  const client = await loadClient(), reduce = client.chat.makeTranscript();
  const event = { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'edit' }] } };
  reduce({ type: 'snapshot', records: [{ type: 'event', event }] });
  assert.equal(reduce({ type: 'event', event }).length, 1);
  reduce({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'b', revision: 1 } });
  reduce({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'b', revision: 1, index: 0, chunk: { type: 'text-delta', text: 'discard' } } });
  assert.equal(reduce({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'b', revision: 1, outcome: { kind: 'abandoned' } } }).length, 1);
});

test('chat only renders human input and hides runtime context and internal binding prefix', async () => {
  const client = await loadClient(), reduce = client.chat.makeTranscript();
  const make = (seq, source, text) => ({ type: 'event', event: { type: 'user/message', seq, data: { source: { kind: source }, content: [{ type: 'text', text }] } } });
  assert.equal(reduce(make(1, 'runtime', 'skills catalog')).length, 0);
  assert.equal(reduce(make(2, 'system', 'runtime context')).length, 0);
  const rows = reduce(make(3, 'user', '当前编辑工程身份：{}\n内部参数\n用户指令：\n添加文字'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '添加文字');
});

test('prompt accepted is distinct from reply and malformed acceptance stays unknown', async () => {
  const client = await loadClient();
  assert.equal((await client.chat.sendPrompt({ session: { prompt: async () => ({ ok: true, value: { accepted: true } }) } }, 's', 'hi')).ok, true);
  assert.equal((await client.chat.sendPrompt({ session: { prompt: async () => ({}) } }, 's', 'hi')).unknown, true);
  assert.notEqual(client.chat.bindingKey({ editorKind: 'image', projectId: 'p', pageId: '1' }), client.chat.bindingKey({ editorKind: 'video', projectId: 'p', pageId: '1' }));
});

test('native approval navigation opens the exact dedicated session and fails closed without host service', async () => {
  const client = await loadClient();
  let opened;
  client.chat.openNativeSession({ openSession(id) { opened = id; } }, 'dedicated-image');
  assert.equal(opened, 'dedicated-image');
  assert.throws(() => client.chat.openNativeSession(undefined, 's'), /未提供原生会话导航/);
  assert.throws(() => client.chat.openNativeSession({ openSession() {} }, undefined), /未提供原生会话导航/);
});

test('approval audit events show pending and closed outcomes without claiming binding success', async () => {
  const client = await loadClient(), reduce = client.chat.makeTranscript();
  const rows = reduce({ type: 'snapshot', records: [
    { event: { seq: 1, type: 'approval/asked', data: { id: 'a', toolName: 'media_image_read_state', reason: 'document=p page=1' } } },
    { event: { seq: 2, type: 'approval/decided', data: { id: 'a', outcome: 'allowed-once' } } }
  ] });
  assert.match(rows[0].text, /等待本人.*原生会话/);
  assert.match(rows[0].text, /document=p page=1/);
  assert.match(rows[1].text, /尚不能确认绑定成功/);
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) assert.match(client.chat.approvalText(outcome), /未获授权/);
  assert.match(client.chat.approvalText('rejected'), /never/);
  assert.match(client.chat.approvalText('other'), /未知/);
});

test('retained editors follow host panel navigation, hide native conversation and restore on return', async () => {
  const client = await loadClient();
  let activePanelId = 'media-image-editor', listener, disposed = false;
  const observed = [];
  const stop = client.chat.watchPanel({ panelInfo: {
    getSnapshot: () => ({activePanelId}),
    subscribe(fn) { listener = fn; return () => {disposed = true;}; }
  } }, id => observed.push(id));
  const node = {isConnected:true};
  const rect = {width:100,height:100};
  const visible = entry => client.chat.retainedVisible(observed.at(-1), entry, node, rect);
  assert.equal(visible('media-image-editor'), true);
  for (const panel of [null, 'plugins', 'media-video-editor']) {
    activePanelId = panel; listener();
    assert.equal(visible('media-image-editor'), false, 'stale anchor must never cover another panel');
  }
  activePanelId = 'media-image-editor'; listener();
  assert.equal(visible('media-image-editor'), true, 'returning to the editor must restore the pane');
  assert.equal(client.chat.retainedVisible(activePanelId, 'media-other-panel', node, rect), false);
  assert.equal(client.chat.retainedVisible(activePanelId, activePanelId, {...node,isConnected:false}, rect), false);
  assert.equal(client.chat.retainedVisible(activePanelId, activePanelId, node, {width:0,height:0}), false);
  assert.equal(client.chat.retainedVisible(activePanelId, activePanelId, null, rect), false);
  assert.equal(client.chat.isEditorPanel('media-image-editor'), true);
  assert.equal(client.chat.isEditorPanel('media-video-editor'), false);
  stop(); assert.equal(disposed, true);
  client.chat.watchPanel({}, id => assert.equal(id, null));
});

test('a detached cached anchor is replaced by the live panel anchor instead of blanking the pane', async () => {
  const client = await loadClient();
  const detached = {isConnected:false};
  const live = {isConnected:true, dataset:{mediaAnchor:'media-image-editor'}};
  globalThis.document = {querySelector: sel => sel === '[data-media-anchor="media-image-editor"]' ? live : null};
  assert.equal(client.chat.resolveAnchor(detached, 'media-image-editor', 'media-image-editor'), live);
  assert.equal(client.chat.resolveAnchor(live, 'media-image-editor', 'media-image-editor'), live);
  assert.equal(client.chat.resolveAnchor(detached, 'media-image-editor', 'media-video-editor'), null, 'no anchor for a non-editor panel');
  globalThis.document = {querySelector: () => null};
  assert.equal(client.chat.resolveAnchor(detached, 'media-image-editor', 'media-image-editor'), null);
  delete globalThis.document;
  assert.equal(client.chat.resolveAnchor(detached, 'media-image-editor', 'media-image-editor'), null, 'no DOM means no claim');
  assert.equal(client.chat.measureRect(null), null);
  assert.deepEqual(client.chat.measureRect({isConnected:true, getBoundingClientRect:()=>({left:1,top:2,width:640,height:480})}), {left:1,top:2,width:640,height:480});
  assert.equal(client.chat.measureRect({isConnected:true, getBoundingClientRect:()=>({width:0,height:0})}), null);
  assert.equal(client.chat.measureRect({isConnected:false, getBoundingClientRect:()=>({width:9,height:9})}), null);
});

test('hidden retained layer releases owned focus without blurring other panels', async () => {
  const client = await loadClient();
  let blurred = 0;
  globalThis.document = {activeElement:{blur(){blurred++;}}};
  client.chat.releaseHiddenFocus({contains:()=>true}, true);
  client.chat.releaseHiddenFocus({contains:()=>false}, false);
  assert.equal(blurred, 0);
  client.chat.releaseHiddenFocus({contains:()=>true}, false);
  assert.equal(blurred, 1);
  delete globalThis.document;
});

test('image results retain command evidence and expose history conflicts without offering stale undo', async () => {
  const client = await loadClient(), reduce = client.chat.makeTranscript();
  const result = {commandId:'image-edit-1',revision:3,afterDigest:'digest-3'};
  const rows = reduce({type:'event',event:{seq:1,type:'tool/result',data:{toolName:'media_image_apply_command',result}}});
  assert.deepEqual(rows[0].undo,{commandId:'image-edit-1',appliedRevision:3,afterDigest:'digest-3'});
  const conflict = reduce({type:'event',event:{seq:2,type:'tool/result',data:{result:{...result,error:{code:'HISTORY_CONFLICT'}}}}});
  assert.match(conflict[1].issue,/已有后续人工或 AI 修改/);
  assert.equal(conflict[1].undo,null);
  const prompt = client.chat.undoPrompt(rows[0].undo);
  assert.match(prompt,/operation="history\.undo"/);
  assert.match(prompt,/targetCommandId/);
  assert.match(prompt,/HISTORY_CONFLICT.*停止/);
});

test('image panel visibility uses the host navigation contract', async () => {
  const client = await loadClient(), node = {isConnected:true}, rect = {width:640,height:480};
  assert.equal(client.chat.retainedVisible('media-image-editor','media-image-editor',node,rect),true);
  for (const id of [null,'plugins','media-video-editor']) assert.equal(client.chat.retainedVisible(id,'media-image-editor',node,rect),false);
});

test('the image package registers under its own plugin name and overlay id', async () => {
  const client = await loadClient();
  assert.equal(client.name, 'dsh-media-image');
  assert.equal(client.chat.retainedOverlayId, 'media-image-retained-editors');
  assert.notEqual(client.chat.retainedOverlayId, 'media-video-retained-editors');
  assert.notEqual(client.chat.retainedOverlayId, 'media-retained-editors', '共用 overlay id 会被 root list 槽位拒绝并吞掉侧栏入口');
});

test('a missing slots service degrades instead of throwing', async () => {
  const client = await loadClient();
  assert.doesNotThrow(() => client.apply({ inject() { throw new Error('no services'); } }));
  assert.doesNotThrow(() => client.apply(undefined));
});
