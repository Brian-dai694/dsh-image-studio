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
  useState(value) {
    // 极简桩：只保证组件顶层调用不炸；不需要重渲染语义（测试直接读返回的元素树）。
    const holder = { value };
    return [value, next => { holder.value = typeof next === 'function' ? next(holder.value) : next; }];
  },
  useEffect() {},
  useLayoutEffect() {},
  createElement(type, props, ...children) { return { type, props: { ...(props || {}), children } }; },
};

/** 从页面元素树里找对话面板（不依赖它在 children 里的下标）。 */
function conversationOf(page) {
  const found = (page.props?.children || []).find(child => typeof child?.type === 'function' && child.type.name === 'Conversation');
  assert.ok(found, '页面里必须有 Conversation 面板');
  return found;
}

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
  assert.equal(conversationOf(client.chat.makePage(client.entries[0], () => ctx.remote)(injected)).props.getRemote().session, session);
  assert.equal(conversationOf(client.chat.makePage(client.entries[0], () => ctx.remote)({})).props.getRemote().session, session);
});

test('dotted service lookup is supported without a root remote object', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  const session = { create() {} };
  ctx.get = key => key === 'remote.session' ? session : undefined;
  client.apply(ctx); flush();
  const main = registered.find(item => item.definition.name === 'main');
  assert.equal(conversationOf(client.chat.makePage(client.entries[0])(main.definition.inject())).props.getRemote().session, session);
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
  for (const page of Object.values(byId)) assert.equal(conversationOf(page).type.name, 'Conversation');
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

test('tool and approval events render as readable cards, never raw JSON', async () => {
  const client = await loadClient(), reduce = client.chat.makeTranscript();
  const rows = reduce({ type: 'event', event: { seq: 1, type: 'tool/result', data: {
    toolName: 'media_image_read_state',
    result: { status: 'applied', revision: 0, documentId: '04ae7a2b-fec2-4a14-a6e3-c26d3ec0fea1', layersCount: 1, stateDigest: 'fnv1a64-2eaa7dad7ad80f0f' },
  } } });
  assert.equal(rows[0].role, 'tool');
  assert.equal(rows[0].text, '', '聊天文本里不能再出现原始 JSON');
  assert.equal(rows[0].card.name, '读取工程');
  assert.equal(rows[0].card.status, 'applied');
  assert.equal(rows[0].card.revision, 0);
  assert.doesNotMatch(JSON.stringify(rows[0].card), /fnv1a64|isError|stateDigest/);

  const failed = reduce({ type: 'event', event: { seq: 2, type: 'tool/result', data: {
    toolName: 'media_image_apply_command', result: { error: { code: 'SESSION_BINDING_REQUIRED' } },
  } } });
  assert.match(failed[1].card.line, /授权/);
  assert.equal(failed[1].card.error, true);
  assert.equal(failed[1].text, '');

  const approval = reduce({ type: 'event', event: { seq: 3, type: 'approval/decided', data: { outcome: 'rejected' } } });
  assert.equal(approval[2].role, 'approval');
  assert.match(approval[2].text, /未获授权/);
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
  const result = {commandId:'image-edit-1',revision:3,afterDigest:'fnv1a64-0000000000000003'};
  const rows = reduce({type:'event',event:{seq:1,type:'tool/result',data:{toolName:'media_image_apply_command',result}}});
  assert.deepEqual(rows[0].undo,{commandId:'image-edit-1',appliedRevision:3,afterDigest:'fnv1a64-0000000000000003'});
  const conflict = reduce({type:'event',event:{seq:2,type:'tool/result',data:{result:{...result,error:{code:'HISTORY_CONFLICT'}}}}});
  assert.match(conflict[1].issue,/已有后续人工或 AI 修改/);
  assert.equal(conflict[1].undo,null);
  const prompt = client.chat.undoPrompt(rows[0].undo);
  assert.match(prompt,/history\.undo/);
  assert.match(prompt,/targetCommandId/);
  assert.match(prompt,/fnv1a64-0000000000000003/);
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

test('the image package registers a native tool card for each of its six tools', async () => {
  const client = await loadClient();
  const { ctx, registered, injected, flush } = makeContext();
  client.apply(ctx);
  flush();
  assert.ok(injected.includes('tool.call.toolview'));
  const views = registered.filter(item => item.definition.name === 'tool.call.toolview');
  const keys = views.map(item => item.definition.key).sort();
  assert.equal(keys.length, 6);
  assert.deepEqual(keys, [...client.toolViewKeys].sort());
  for (const key of keys) assert.match(key, /^media_image_/);
});

test('tool cards show fields instead of the raw JSON body', async () => {
  const client = await loadClient();
  const { ctx, registered, flush } = makeContext();
  client.apply(ctx); flush();
  const view = registered.find(item => item.definition.name === 'tool.call.toolview').component;
  const ok = JSON.stringify(view({ block: { kind: 'result', content: [{ text: JSON.stringify({ status: 'applied', result: { revision: 3, layersCount: 2, stateDigest: 'secret-digest' } }) }] } }));
  assert.match(ok, /applied/);
  assert.match(ok, /R3/);
  assert.match(ok, /2 个图层/);
  assert.doesNotMatch(ok, /secret-digest/);
  const failed = JSON.stringify(view({ block: { kind: 'result', content: [{ text: JSON.stringify({ result: { error: { code: 'REVISION_CONFLICT' }, revision: 4 } }) }] } }));
  assert.match(failed, /版本已变化/);
});

test('an empty status with an error code defaults to rejected, not unknown', async () => {
  const client = await loadClient();
  // 静态夹具暴露过的缺陷：回执只有 error.code、没有 status 时，卡片曾被默认成 unknown，
  // 让"未执行"看起来像"结果未知"，而两者在重放语义上完全不同。
  const card = client.chat.toolCard({ toolName: 'media_image_apply_command', result: { revision: 3, error: { code: 'REVISION_CONFLICT' } } }, false);
  assert.equal(card.status, 'rejected');
  assert.equal(card.error, true);
  const plan = client.chat.buildDialogPlan([{ id: 't1', role: 'tool', card }]);
  assert.equal(plan[0].badge, 'rejected');
  const plain = client.chat.toolCard({ toolName: 'media_image_apply_command', result: { revision: 4 } }, false);
  assert.equal(plain.status, 'applied', '没有错误码、也没有结构化摘要 → applied + 摘要无法解析，不是 unknown');
  assert.match(plain.line, /摘要无法解析/);
});

test('session list follows the strict contract and only our project is shown', async () => {
  const client = await loadClient();
  // 契约：{ items: SessionSummary[] }；标题在 projections.values.title，缺失就是 null
  const items = client.chat.normalizeSessionItems({ value: { items: [
    { sessionId: 's1', updatedAt: 1700000000000, running: true, blank: false, agentAvailable: true, projections: { values: { title: '本工程：改标题' } } },
    { sessionId: 's2', updatedAt: 1699999999000, running: false, blank: true, agentAvailable: true },
    { sessionId: 's3', updatedAt: 1699999998000, running: false, blank: false, agentAvailable: false, projections: { values: { title: '助手不在线' } } },
    { sessionId: '' },
  ] } });
  assert.deepEqual(items.map(item => item.sessionId), ['s1', 's2', 's3']);
  assert.equal(items[0].title, '本工程：改标题');
  assert.equal(items[1].title, null, '没有 projections 时标题必须是 null，不许拿 id 冒充');
  assert.deepEqual(client.chat.sessionAnnotations(items[0]), ['有回合在跑']);
  assert.deepEqual(client.chat.sessionAnnotations(items[1]), ['空会话']);
  assert.deepEqual(client.chat.sessionAnnotations(items[2]), ['助手不在线']);
  // 形状不符合契约 → 明确抛错，不静默退回"只能新建"
  assert.throws(() => client.chat.normalizeSessionItems({ value: { sessions: [] } }), /items/);
  assert.throws(() => client.chat.normalizeSessionItems(undefined), /items/);
  await assert.rejects(() => client.chat.listSessions({ session: {} }), /session\.list/);
  await assert.rejects(() => client.chat.listSessions({ session: { list: async () => ({ ok: true, value: {} }) } }), /items/);
  // 隐私边界：只把本工程标记的会话放进列表，其他一律进 others（默认不展示）
  const grouped = client.chat.filterSessionsForProject(items, 'proj-a', { s1: 'proj-a', s2: 'proj-b', s3: null });
  assert.deepEqual(grouped.matched.map(item => item.sessionId), ['s1']);
  assert.deepEqual(grouped.others.map(item => item.sessionId), ['s2', 's3']);
  const none = client.chat.filterSessionsForProject(items, 'proj-none', { s1: 'proj-a', s2: 'proj-b', s3: null });
  assert.equal(none.matched.length, 0, '没有匹配时不能把无关会话顶上来');
  assert.equal(none.others.length, 3);
});

test('peekProjectId reads the project marker from a session snapshot without keeping it', async () => {
  const client = await loadClient();
  const marked = '当前编辑工程身份：' + JSON.stringify({ editorKind: 'image', projectId: 'proj-a' }) + '\n用户指令：\n改标题';
  const remote = {
    session: {
      follow() {
        let index = 0;
        const frames = [{ type: 'snapshot', header: { id: 's1' }, records: [{ event: { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: marked }] } } } }] }];
        return { [Symbol.asyncIterator]() { return { async next() { return index < frames.length ? { done: false, value: frames[index++] } : new Promise(() => {}) } } } };
      },
    },
  };
  assert.equal(await client.chat.peekProjectId(remote, 's1', 500), 'proj-a');
  const empty = { session: { follow() { return { [Symbol.asyncIterator]() { return { async next() { return { done: false, value: { type: 'snapshot', header: { id: 's2' }, records: [] } } } } } } } } };
  assert.equal(await client.chat.peekProjectId(empty, 's2', 300), null, '没有标记就返回 null，不猜测');
  assert.equal(await client.chat.peekProjectId({ session: {} }, 's3', 300), null);
});

test('real tool/result envelopes map to applied/rejected/undo/export instead of unknown', async () => {
  const client = await loadClient();
  const reduce = client.chat.makeTranscript();
  // 真机回执的外壳：{call:{toolName}} + {result:{ok,value}}，也支持回执正文放在 content 文本 JSON 里
  const envelope = [
    { seq: 1, type: 'tool/call', data: { call: { toolName: 'media_image_apply_command', arguments: { operation: 'layer.add_text' } } } },
    { seq: 2, type: 'tool/result', data: { call: { toolName: 'media_image_apply_command' }, result: { ok: true, value: { status: 'applied', revision: 1, commandId: 'fde-acceptance-addtext-001', afterDigest: 'fnv1a64-0000000000000001', operation: 'layer.add_text' } } } },
    { seq: 3, type: 'tool/result', data: { result: { ok: false, error: { code: 'REVISION_CONFLICT' }, value: { status: 'rejected', revision: 1 } } } },
    { seq: 4, type: 'tool/result', data: { result: { value: { status: 'applied', revision: 2, exportId: 'a0196778-e614-45bf-9e94-88a1f9d6c0a5', artifactRef: 'blob:http://127.0.0.1:59302/621b9acb' } } } },
    { seq: 5, type: 'tool/result', data: { result: { content: [{ type: 'text', text: JSON.stringify({ status: 'applied', revision: 3, commandId: 'cmd-text-shape', afterDigest: 'fnv1a64-0000000000000003' }) }] } } },
    { seq: 6, type: 'tool/result', data: { result: { ok: true, value: { status: 'applied', revision: 4 } } } },
  ];
  const rows = reduce({ type: 'snapshot', header: { id: 's1' }, records: envelope.map(event => ({ event })) });
  const plan = client.chat.buildDialogPlan(rows);
  const toolRows = plan.filter(item => item.kind === 'tool');
  assert.deepEqual(toolRows.map(item => item.badge), ['pending', 'applied', 'rejected', 'applied', 'applied', 'applied']);
  // 名字：结果行沿用上一条 call 的工具名，不再整屏「工具调用」
  assert.deepEqual(toolRows.slice(1).map(item => item.card.name), ['执行编辑', '执行编辑', '执行编辑', '执行编辑', '执行编辑']);
  // REVISION_CONFLICT 必须显示"未执行"，并给出中文原因
  assert.match(toolRows[2].card.line, /版本已变化/);
  // 撤销：真实回执带 commandId/revision/afterDigest → 动作出现，且 prompt 带 targetCommandId
  const undo = toolRows[1].actions.find(action => action.kind === 'fill-undo');
  assert.ok(undo, '带凭据的 applied 回执必须给撤销动作');
  assert.match(undo.prompt, /fde-acceptance-addtext-001/);
  assert.ok(toolRows[4].actions.some(action => action.kind === 'fill-undo'), 'content 文本 JSON 里的凭据同样要认');
  // 导出：真实 artifactRef 必须给下载动作
  const exported = toolRows[3].actions.find(action => action.kind === 'download-export');
  assert.ok(exported, '带 exportId 的回执必须给导出动作');
  assert.equal(exported.export.exportId, 'a0196778-e614-45bf-9e94-88a1f9d6c0a5');
  assert.match(exported.export.artifactRef, /^blob:/);
  // 没有凭据的 applied 不给撤销按钮（宁可不给，也不给假按钮）
  assert.equal(toolRows[5].actions.some(action => action.kind === 'fill-undo'), false);
  assertNoRawJsonInPlan(client, plan);
});

test('status priority: outer layer wins, inner-only status still resolves, conflicts are spoken not silenced', async () => {
  const client = await loadClient();
  // 外层 applied、内层 rejected：按外层取值，且卡片必须写明"不一致"，不许静默挑一个
  const outer = client.chat.toolCard({ status: 'applied', revision: 2, value: { status: 'rejected' } }, false, '执行编辑');
  assert.equal(outer.status, 'applied');
  assert.equal(outer.revision, 2);
  assert.match(outer.line, /不一致/);
  assert.match(outer.line, /applied \/ rejected/);
  // 只有内层有状态：照样取得到
  const inner = client.chat.toolCard({ value: { status: 'rejected', revision: 3 } }, false, '执行编辑');
  assert.equal(inner.status, 'rejected');
  assert.equal(inner.revision, 3);
  assert.doesNotMatch(inner.line, /不一致/);
  // 契约层 {result:{ok,value}} 优先于更深的 content 文本
  const contract = client.chat.toolCard({ result: { ok: true, value: { status: 'applied', revision: 4 } }, content: [{ type: 'text', text: JSON.stringify({ status: 'unknown', revision: 99 }) }] }, false, '执行编辑');
  assert.equal(contract.status, 'applied');
  assert.equal(contract.revision, 4);
  assert.match(contract.line, /不一致/);
  // meta.status 也能认
  const meta = client.chat.toolCard({ meta: { status: 'rejected', revision: 5 } }, false, '执行编辑');
  assert.equal(meta.status, 'rejected');
  // 完全没有状态、也没有错误码：按源码结论，成功即 applied，"解析不到"不许冒充 unknown
  const none = client.chat.toolCard({ result: { ok: true, value: { revision: 6 } } }, false, '执行编辑');
  assert.equal(none.status, 'applied');
  assert.match(none.line, /摘要无法解析/);
});

test('source-documented event shapes: name on call, isError on result, output JSON in message content', async () => {
  const client = await loadClient();
  const reduce = client.chat.makeTranscript();
  const applied = { status: 'applied', revision: 1, commandId: 'fde-addtext-001', afterDigest: 'fnv1a64-0000000000000001', operation: 'layer.add_text' };
  const exported = { status: 'applied', revision: 2, exportId: 'exp-doc-1', artifactRef: 'blob:http://127.0.0.1:59302/abc', format: 'png' };
  const events = [
    // tool/call：名字在 name，参数是 JSON 字符串
    { seq: 1, type: 'tool/call', data: { turn: 1, step: 2, callId: 'call-1', name: 'media_image_apply_command', arguments: JSON.stringify({ operation: 'layer.add_text' }) } },
    // tool/result：状态与凭据都在 message.content 的文本 JSON 里
    { seq: 2, type: 'tool/result', data: { turn: 1, step: 3, message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: JSON.stringify(applied) }] } } },
    // 失败：isError + error.code，事件里没有 status
    { seq: 3, type: 'tool/result', data: { turn: 1, step: 4, message: { toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: '版本冲突' }] }, error: { name: 'MediaBridgeError', code: 'REVISION_CONFLICT' } } },
    // 导出成功：exportId/artifactRef 同样在 content JSON 里
    { seq: 4, type: 'tool/result', data: { turn: 1, step: 5, message: { toolCallId: 'call-3', isError: false, content: [{ type: 'text', text: JSON.stringify(exported) }] } } },
    // 成功但摘要无法解析：不许变成 unknown
    { seq: 5, type: 'tool/result', data: { turn: 1, step: 6, message: { toolCallId: 'call-4', isError: false, content: [{ type: 'text', text: '操作完成，但没有结构化摘要' }] } } },
    // 显式 unknown：工具自己回 status:'unknown' 才算
    { seq: 6, type: 'tool/result', data: { turn: 1, step: 7, message: { toolCallId: 'call-5', isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'unknown', revision: 3 }) }] } } },
  ];
  const rows = reduce({ type: 'snapshot', header: { id: 's1' }, records: events.map(event => ({ event })) });
  const plan = client.chat.buildDialogPlan(rows);
  assert.deepEqual(plan.map(item => item.badge), ['pending', 'applied', 'rejected', 'applied', 'applied', 'unknown']);
  // 名字：result 靠 toolCallId 映射回 call 的名字
  assert.deepEqual(plan.slice(1).map(item => item.card.name), ['执行编辑', '执行编辑', '执行编辑', '执行编辑', '执行编辑']);
  // 失败行的原因是中文，不是错误码原文
  assert.match(plan[2].card.line, /版本已变化/);
  // 撤销与导出都来自 content JSON
  assert.ok(plan[1].actions.some(action => action.kind === 'fill-undo'), '带凭据的回执要给撤销动作');
  assert.equal(plan[3].actions.find(action => action.kind === 'download-export').export.exportId, 'exp-doc-1');
  // 摘要无法解析：applied + 明确提示 + 原文只进 diagnostic
  assert.match(plan[4].card.line, /摘要无法解析/);
  assert.ok(plan[4].diagnostic, '原文应保留给复制诊断');
  assert.equal(plan[4].actions.some(action => action.kind === 'fill-undo'), false, '没有凭据就不给撤销');
  assertNoRawJsonInPlan(client, plan);
});

test('structured credentials in meta drive the undo and export buttons', async () => {
  const client = await loadClient();
  const reduce = client.chat.makeTranscript();
  const events = [
    { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'media_image_apply_command', arguments: '{}' } },
    { seq: 2, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'applied · c-meta · R3' }] },
      meta: { status: 'applied', operation: 'layer.add_text', commandId: 'c-meta', appliedRevision: 3, afterDigest: 'fnv1a64-0000000000000003' } } },
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'media_image_export_start', arguments: '{}' } },
    { seq: 4, type: 'tool/result', data: { turn: 1, step: 2, message: { toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'applied · c-export · R3' }] },
      meta: { status: 'applied', exportId: 'exp-1', artifactRef: 'blob:http://127.0.0.1:59302/abc', format: 'png' } } },
    // 缺 appliedRevision → 不给撤销按钮
    { seq: 5, type: 'tool/call', data: { turn: 1, step: 3, callId: 'c3', name: 'media_image_apply_command', arguments: '{}' } },
    { seq: 6, type: 'tool/result', data: { turn: 1, step: 3, message: { toolCallId: 'c3', isError: false, content: [{ type: 'text', text: 'applied · c-partial · R4' }] },
      meta: { status: 'applied', commandId: 'c-partial', afterDigest: 'fnv1a64-0000000000000004' } } },
  ];
  const plan = client.chat.buildDialogPlan(reduce({ type: 'snapshot', header: { id: 's' }, records: events.map(event => ({ event })) }));
  const tools = plan.filter(item => item.kind === 'tool');
  const undo = tools[1].actions.find(action => action.kind === 'fill-undo');
  assert.ok(undo, 'meta 里三项齐全时必须给撤销动作');
  assert.equal(undo.undo.commandId, 'c-meta');
  assert.equal(undo.undo.appliedRevision, 3);
  assert.match(undo.prompt, /targetCommandId/);
  const exported = tools[3].actions.find(action => action.kind === 'download-export');
  assert.ok(exported, 'meta 里 exportId/artifactRef 齐全时必须给导出动作');
  assert.equal(exported.export.exportId, 'exp-1');
  assert.equal(exported.export.format, 'png');
  assert.equal(tools[5].actions.some(action => action.kind === 'fill-undo'), false, '缺 appliedRevision 就不出按钮');
});

test('highlight request is built only from locate and clamps ttl; suggestions stay inside the whitelist', async () => {
  const client = await loadClient();
  assert.equal(client.chat.highlightRequest(null, 'r1'), null);
  assert.equal(client.chat.highlightRequest({ objectIds: [], kind: 'layer' }, 'r1'), null);
  const message = client.chat.highlightRequest({ objectIds: ['layer-1', 'layer-2'], kind: 'layer' }, 'r1', 99999);
  assert.equal(message.type, 'media.highlight.request');
  assert.deepEqual(message.objectIds, ['layer-1', 'layer-2']);
  assert.equal(message.ttlMs, 5000, 'ttl 上界 5000');
  assert.equal(client.chat.highlightRequest({ objectIds: ['a'], kind: 'clip' }, 'r2', 1).ttlMs, 200, 'ttl 下界 200');
  // 非法 id 会被过滤；全部非法时不给请求
  assert.deepEqual(client.chat.highlightRequest({ objectIds: ['ok', 42, ''], kind: 'layer' }, 'r3').objectIds, ['ok']);
  // 建议只对"恰好一个图层"生成；白名单外的动作不出现
  const suggestions = client.chat.suggestionsFor(['layer-1'], 'layer');
  assert.equal(suggestions.length, 4);
  for (const suggestion of suggestions) assert.match(suggestion.prompt, /layer-1/);
  assert.deepEqual(client.chat.suggestionsFor(['a', 'b'], 'layer'), []);
  assert.deepEqual(client.chat.suggestionsFor(['a'], 'clip'), []);
  assert.deepEqual(client.chat.suggestionsFor([], null), []);
});

test('real captured events render with meta.status and callId-linked names', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve: resolvePath, dirname: dirOf } = await import('node:path');
  const { fileURLToPath: fileOf } = await import('node:url');
  const fixture = JSON.parse(readFileSync(resolvePath(dirOf(fileOf(import.meta.url)), '../../../docs/fixtures/real-events.json'), 'utf8'));
  const client = await loadClient();
  const reduce = client.chat.makeTranscript();
  const rows = reduce({ type: 'snapshot', header: { id: 's1' }, records: fixture.events.map(event => ({ event })) });
  const plan = client.chat.buildDialogPlan(rows);
  const tools = plan.filter(item => item.kind === 'tool');
  // 前 14 条全部是 FDE 在 0.2.1 上抓的原文（meta 已带凭据）；最后 2 条是 synthetic:explicit-unknown。
  assert.deepEqual(tools.map(item => item.badge), ['pending', 'applied', 'pending', 'applied', 'pending', 'rejected', 'pending', 'applied', 'pending', 'applied', 'pending', 'applied', 'pending', 'unknown']);
  assert.deepEqual(tools.map(item => item.card.name), ['读取工程', '读取工程', '执行编辑', '执行编辑', '执行编辑', '执行编辑', '开始导出', '开始导出', '查询导出', '查询导出', '查询导出', '查询导出', '执行编辑', '执行编辑']);
  // stale 写入：meta.status=rejected + meta.errorCode=REVISION_CONFLICT → 未执行 + 具体中文原因
  assert.equal(tools[5].badge, 'rejected');
  assert.match(tools[5].card.line, /版本已变化/);
  assert.doesNotMatch(tools[5].card.line, /没有错误码/);
  // 正常写入那条：meta 带 commandId/appliedRevision/afterDigest → 必须出现「填入撤销指令」
  assert.deepEqual(tools[3].actions.map(action => action.kind), ['fill-undo']);
  assert.equal(tools[3].actions[0].undo.commandId, 'fde-021-step2-addtext-01');
  assert.equal(tools[3].actions[0].undo.appliedRevision, 1);
  assert.match(tools[3].actions[0].prompt, /fde-021-step2-addtext-01/);
  assert.match(tools[3].actions[0].prompt, /HISTORY_CONFLICT/);
  // 导出那三条：meta 带 exportId/artifactRef → 必须出现下载动作
  for (const index of [7, 9, 11]) {
    assert.deepEqual(tools[index].actions.map(action => action.kind), ['download-export'], `第 ${index} 条导出应可下载`);
    assert.equal(tools[index].actions[0].export.exportId, '6fc84fc2-3c0e-4204-b949-f7cd2eaa0287');
    assert.match(tools[index].actions[0].export.artifactRef, /^blob:/);
  }
  // 其余工具行没有凭据 → 不出现按钮
  assert.deepEqual([0, 1, 2, 4, 6, 8, 10, 12, 13].filter(index => tools[index].actions.length > 0), []);
  // 真实 0.2.1 样本（前 12 条工具行）里 unknown 必须是 0：unknown 只能来自显式 meta.status='unknown'，
  // 而那条只有末尾的 synthetic 显式 unknown 样例（第 14 条）。isError 在 rejected 上是 false，
  // 因此判定只看 meta.status / meta.errorCode，不把 isError 当失败判据。
  assert.equal(tools.slice(0, 12).filter(item => item.badge === 'unknown').length, 0);
  assert.equal(tools.filter(item => item.badge === 'unknown').length, 1);
  assert.equal(tools[13].badge, 'unknown');
  assertNoRawJsonInPlan(client, plan);
});

test('fixture samples still match the captured probe file (source guard)', async (t) => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve: resolvePath, dirname: dirOf } = await import('node:path');
  const { fileURLToPath: fileOf } = await import('node:url');
  const probe = 'C:/Users/UEFR/.dsh/bot/workspace/diagram-studio-prototype/.qa/probe/real-events.json';
  if (!existsSync(probe)) { t.skip('抓包原文不在这台机器上（.qa 不入库）'); return }
  const fixture = JSON.parse(readFileSync(resolvePath(dirOf(fileOf(import.meta.url)), '../../../docs/fixtures/real-events.json'), 'utf8'));
  const captured = JSON.parse(readFileSync(probe, 'utf8'));
  const bySeq = new Map();
  for (const key of Object.keys(captured.samples || {})) for (const event of captured.samples[key]) bySeq.set(event.seq, event);
  if (captured.revisionConflictSample) bySeq.set(captured.revisionConflictSample.seq, captured.revisionConflictSample);
  let checked = 0;
  for (const event of fixture.events) {
    if (!String(event.fixtureOrigin || '').startsWith('probe:')) continue;
    const source = bySeq.get(event.seq);
    assert.ok(source, `夹具里的 seq ${event.seq} 在抓包里找不到来源`);
    assert.deepEqual(JSON.parse(JSON.stringify(event.data)), JSON.parse(JSON.stringify(source.data)), `seq ${event.seq} 与抓包原文不一致`);
    checked += 1;
  }
  assert.ok(checked >= 14, '至少要比对到 14 条真实样本');
  // 夹具 16 条 = 14 条 probe 原文 + 2 条 synthetic（显式 unknown 那一对）；这 16 条里只有 2 条不是原文。
  assert.ok(fixture.events.length >= 16, '夹具事件总数应不少于 16');
  assert.equal(fixture.events.filter(event => !String(event.fixtureOrigin || '').startsWith('probe:')).length, 2);
});

test('unknown only from explicit status; pending only from call without result; parse failure falls back', async () => {
  const client = await loadClient();
  const reduce = client.chat.makeTranscript();
  const events = [
    { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'media_image_apply_command', arguments: '{}' } },
    { seq: 2, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'applied · cmd-1 · R1' }] }, meta: { status: 'applied', operation: 'layer.add_text' } } },
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'media_image_apply_command', arguments: '{}' } },
    { seq: 4, type: 'tool/result', data: { turn: 1, step: 2, message: { toolCallId: 'c2', isError: false, content: [{ type: 'text', text: 'unknown' }] }, meta: { status: 'unknown' } } },
  ];
  const plan = client.chat.buildDialogPlan(reduce({ type: 'snapshot', header: { id: 's' }, records: events.map(event => ({ event })) }));
  const tools = plan.filter(item => item.kind === 'tool');
  assert.deepEqual(tools.map(item => item.badge), ['pending', 'applied', 'pending', 'unknown']);
  // 成功但只有人读文本、没有结构化字段：摘要无法解析，但**不是** unknown
  assert.match(tools[1].card.line, /摘要无法解析/);
  assert.equal(tools[1].badge, 'applied');
});

test('locate 只从 meta 的 changedObjectIds + objectKind 来；缺一项就整卡不可点', async () => {
  const client = await loadClient();
  const reduce = client.chat.makeTranscript();
  const result = (seq, callId, meta) => ({
    seq, type: 'tool/result',
    data: { turn: 1, step: seq, message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: 'applied · c · R1' }] }, meta },
  });
  const events = [
    { seq: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'media_image_apply_command', arguments: '{}' } },
    // ① meta 两项齐全（后端 7e55a0f 起的真实形状）→ 出 locate，卡片可点
    result(2, 'c1', { status: 'applied', commandId: 'c-1', appliedRevision: 1, changedObjectIds: ['layer-a', 'layer-b'], objectKind: 'layer' }),
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 3, callId: 'c2', name: 'media_image_read_state', arguments: '{}' } },
    // ② 没有 changedObjectIds（0.2.1 的 read_state 就是这样）→ 不给 locate，属正确降级
    result(4, 'c2', { status: 'applied' }),
    { seq: 5, type: 'tool/call', data: { turn: 1, step: 5, callId: 'c3', name: 'media_image_apply_command', arguments: '{}' } },
    // ③ 有 ids 但没有 objectKind → 整体省略（不按 layer 猜类型）
    result(6, 'c3', { status: 'applied', changedObjectIds: ['layer-c'] }),
    { seq: 7, type: 'tool/call', data: { turn: 1, step: 7, callId: 'c4', name: 'media_image_apply_command', arguments: '{}' } },
    // ④ kind 越界 → 整体省略
    result(8, 'c4', { status: 'applied', changedObjectIds: ['layer-d'], objectKind: 'gizmo' }),
    { seq: 9, type: 'tool/call', data: { turn: 1, step: 9, callId: 'c5', name: 'media_image_apply_command', arguments: '{}' } },
    // ⑤ 空数组等价于"没有对象被改"
    result(10, 'c5', { status: 'applied', changedObjectIds: [], objectKind: 'layer' }),
  ];
  const plan = client.chat.buildDialogPlan(reduce({ type: 'snapshot', header: { id: 's' }, records: events.map(event => ({ event })) }));
  const tools = plan.filter(item => item.kind === 'tool');
  assert.deepEqual(tools[1].locate, { objectIds: ['layer-a', 'layer-b'], kind: 'layer' });
  // 可点：role=button，且 data-object-ids 与 meta.changedObjectIds 逐字相等
  const props = client.chat.locateAttributes(tools[1].locate);
  assert.equal(props.role, 'button');
  assert.equal(props['data-object-kind'], 'layer');
  assert.equal(props['data-object-ids'], 'layer-a,layer-b');
  // 高亮请求只带这些 id，不附带任何写语义
  const request = client.chat.highlightRequest(tools[1].locate, 'r1');
  assert.deepEqual(request.objectIds, ['layer-a', 'layer-b']);
  assert.deepEqual(Object.keys(request).sort(), ['objectIds', 'requestId', 'ttlMs', 'type']);
  // ②③④⑤ 一律不可点：没有 locate，也不挂 role=button
  for (const index of [3, 5, 7, 9]) {
    assert.equal('locate' in tools[index], false, `第 ${index} 条定位信息不完整，不能给 locate`);
    const none = client.chat.locateAttributes(tools[index].locate || null);
    assert.equal('role' in none, false, '不可点的卡片不能挂 role=button');
    assert.equal(none['data-object-ids'], '');
  }
});

test('工程授权四态：未授权 / 待激活（票据）/ 已授权 / 已过期', async () => {
  const client = await loadClient();
  const now = 1_800_000_000_000;
  const binding = { sessionId: 's-1', projectId: 'p-1', editorInstanceId: 'i-1' };
  // 什么都没签
  assert.equal(client.chat.fromBindingStatus({ ok: true, ticket: null, grant: null }, binding, now).authorized, false);
  assert.equal(client.chat.authorizationState(null, now).code, 'unauthorized');
  // 只有票据：还没被会话消费 → 「待激活」，不能显示成已授权（契约 §3：票据 ≠ 授权）
  const pending = client.chat.fromBindingStatus({ ok: true, ticket: { ticketId: 't1', projectId: 'p-1', expiresAt: now + 300_000 }, grant: null }, binding, now);
  assert.equal(pending.pending, true);
  assert.equal(pending.authorized, false);
  assert.equal(client.chat.authorizationState(pending, now).code, 'pending', '票据阶段是第四态「待激活」，不是已授权');
  assert.equal(client.chat.authorizationState(pending, now).label, '待激活');
  // 会话消费后才有 grant
  const granted = client.chat.fromBindingStatus({ ok: true, ticket: null, grant: { source: 'panel', projectId: 'p-1', grantedAt: now - 1_000, expiresAt: now + 3_600_000 } }, binding, now);
  assert.equal(granted.authorized, true);
  assert.equal(granted.source, 'panel');
  assert.equal(granted.editorInstanceId, 'i-1');
  assert.equal(client.chat.authorizationState(granted, now).code, 'authorized');
  // 过期：grant 到期时刻本身即失效；只有过期票据也归过期
  assert.equal(client.chat.authorizationState({ ...granted, expiresAt: now }, now).code, 'expired');
  const staleTicket = client.chat.fromBindingStatus({ ok: true, ticket: { ticketId: 't1', expiresAt: now - 1 }, grant: null }, binding, now);
  assert.equal(client.chat.authorizationState(staleTicket, now).code, 'expired');
});

test('授权摘要写清范围、来源与有效期；票据阶段不说"已授权"', async () => {
  const client = await loadClient();
  const now = 1_800_000_000_000;
  const granted = { authorized: true, source: 'panel', projectId: '6b41471f-3ba2-4958', editorInstanceId: 'c9f97101-db91-4c73', grantedAt: now - 60_000, expiresAt: now + 222_000 };
  const summary = client.chat.authorizationSummary(granted, now);
  assert.match(summary, /范围：本会话 × 工程 6b41471f…/);
  assert.match(summary, /实例 c9f97101…/);
  assert.match(summary, /来源：面板授权/);
  assert.match(summary, /还剩 3:42/);
  const pending = client.chat.authorizationSummary({ authorized: false, pending: true, ticketId: 'tkt-abcdef123456', ticketExpiresAt: now + 90_000 }, now);
  assert.match(pending, /已签发票据 tkt-abcd…/);
  assert.match(pending, /还剩 1:30/);
  assert.doesNotMatch(pending, /已授权/);
  assert.match(client.chat.authorizationSummary({ authorized: true, source: 'native' }, now), /来源：原生审批/);
  assert.match(client.chat.authorizationSummary({ authorized: true }, now), /有效期：未提供/);
  assert.match(client.chat.authorizationSummary({ authorized: true, expiresAt: now - 90_000 }, now), /有效期已于/);
  assert.match(client.chat.authorizationSummary(null, now), /还没有读写这个工程的授权/);
});

test('面板授权按 Host 真实线协议：先取页面令牌，再带 Bearer + 同源头签票据', async () => {
  const client = await loadClient();
  const binding = { sessionId: 's-1', projectId: 'p-1', editorInstanceId: 'i-1' };
  const calls = [];
  const stub = async (url, init) => {
    calls.push({ url, init });
    if (url === client.chat.AUTH.boot) return { ok: true, status: 200, json: async () => ({ accessToken: 'page-token-1' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, ticket: { ticketId: 'tkt-1', sessionId: 's-1', projectId: 'p-1', instanceId: 'i-1', expiresAt: 1_800_000_300_000, ttlMs: 300000 } }) };
  };
  const record = await client.chat.requestAuthorization(binding, stub);
  assert.equal(calls[0].url, '/media-image/boot');
  assert.equal(calls[0].init.headers['x-dsh-media-boot'], '1');
  assert.equal(calls[1].url, '/media-image/grant/ticket');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers.authorization, 'Bearer page-token-1');
  assert.equal(calls[1].init.headers['x-dsh-media-relay'], '1');
  assert.equal(calls[1].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].init.body), { instanceId: 'i-1' }, '面板只发 instanceId：sessionId 由 Host 用真实 exec 补');
  // 签出来的是票据，不是授权
  assert.equal(record.authorized, false);
  assert.equal(record.pending, true);
  assert.equal(record.ticketId, 'tkt-1');
  assert.equal(record.ticketExpiresAt, 1_800_000_300_000);
  // 页面令牌缓存：第二次不会再取 boot
  await client.chat.requestAuthorization(binding, stub);
  assert.equal(calls.filter(call => call.url === '/media-image/boot').length, 1);

  // 身份缺一项：一个字节都不发（连 boot 都不取）
  const fresh = await loadClient();
  const noCall = async () => { throw new Error('不应发起请求'); };
  await assert.rejects(() => fresh.chat.requestAuthorization({ sessionId: 's-1' }, noCall), /编辑器实例缺失/);
  // Host 明确拒绝：稳定错误码 → 中文，不重试
  const denied = async (url) => url.endsWith('/boot')
    ? { ok: true, status: 200, json: async () => ({ accessToken: 't' }) }
    : { ok: false, status: 403, json: async () => ({ code: 'BIND_UNAVAILABLE', message: 'nope' }) };
  await assert.rejects(() => fresh.chat.requestAuthorization(binding, denied), /没有面板授权能力/);
  // 200 但没有票据：不能当成功
  const empty = async (url) => url.endsWith('/boot')
    ? { ok: true, status: 200, json: async () => ({ accessToken: 't' }) }
    : { ok: true, status: 200, json: async () => ({ ok: true }) };
  await assert.rejects(() => fresh.chat.requestAuthorization(binding, empty), /没有返回票据/);
});

test('授权状态读取与解绑走真实路由；解绑失败不谎报已解绑', async () => {
  const client = await loadClient();
  const binding = { sessionId: 's-1', projectId: 'p-1', editorInstanceId: 'i-1' };
  const calls = [];
  const stub = async (url, init) => {
    calls.push({ url, init });
    if (url === client.chat.AUTH.boot) return { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) };
    if (url.startsWith(client.chat.AUTH.status)) return { ok: true, status: 200, json: async () => ({ ok: true, ticket: null, grant: { source: 'panel', projectId: 'p-1', grantedAt: 1_799_999_999_000, expiresAt: 1_800_003_600_000 } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) };
  };
  const status = await client.chat.readAuthorizationStatus(binding, stub);
  assert.equal(status.authorized, true);
  assert.equal(status.source, 'panel');
  // 页面令牌可能已被同进程内的模块缓存复用，所以按 URL 找调用，不假设固定下标。
  const statusCall = calls.find(call => call.url.startsWith(client.chat.AUTH.status));
  assert.ok(statusCall, '必须请求 bind-status');
  assert.equal(statusCall.url, '/media-image/bind-status?instanceId=i-1', '状态按实例维度读：面板不知道真实 sessionId');
  assert.equal(statusCall.init.method, 'GET');
  assert.equal(statusCall.init.body, undefined, 'GET 不带 body');

  const sent = [];
  const revokeStub = async (url, init) => {
    sent.push({ url, init });
    if (url === client.chat.AUTH.boot) return { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) };
  };
  assert.deepEqual(await client.chat.releaseAuthorization(binding, revokeStub), { authorized: false });
  const revokeCall = sent.find(call => call.url === client.chat.AUTH.unbind);
  assert.ok(revokeCall, '解绑必须 POST /grant/unbind');
  assert.deepEqual(JSON.parse(revokeCall.init.body), { instanceId: 'i-1' });
  const broken = async (url) => url.endsWith('/boot')
    ? { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) }
    : { ok: false, status: 500, json: async () => null };
  await assert.rejects(() => client.chat.releaseAuthorization(binding, broken), /解绑失败/);
  // 旧 Host 没有面板授权接口
  const missing = async (url) => url.endsWith('/boot')
    ? { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) }
    : { ok: false, status: 404, json: async () => null };
  assert.equal((await client.chat.readAuthorizationStatus(binding, missing)).unsupported, true);
});

test('授权不会被自动触发：只在用户点击路径里签发', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve: resolvePath, dirname: dirOf } = await import('node:path');
  const { fileURLToPath: fileOf } = await import('node:url');
  const source = readFileSync(resolvePath(dirOf(fileOf(import.meta.url)), '../lib/client.js'), 'utf8');
  // 定义 1 处 + authorize() 里 1 处（canRequestAuthorization 不算请求）
  assert.equal((source.match(/\brequestAuthorization\(/g) || []).length, 2);
  assert.match(source, /onClick: function \(\) \{ void authorize\(\) \}/, '确认授权必须是用户点击');
  assert.match(source, /onClick: function \(\) \{ setAuthConfirm\(true\) \}/, '首次点击只展开确认卡片，不直接签发');
  // 副作用里不得出现签发调用：逐个 useEffect 看开头 600 字符（订阅/清理都在这个窗口里）
  for (const match of source.matchAll(/React\.useEffect\(/g)) {
    const body = source.slice(match.index, match.index + 600);
    assert.equal(/requestAuthorization\(|authorize\(\)/.test(body), false, 'useEffect 里不能触发授权');
  }
});

test('a missing slots service degrades instead of throwing', async () => {
  const client = await loadClient();
  assert.doesNotThrow(() => client.apply({ inject() { throw new Error('no services'); } }));
  assert.doesNotThrow(() => client.apply(undefined));
});

// ---------- 对话框 v1（P0）----------

/** 渲染树断言：计划里任何一段要进 DOM 的文本，都不能是一段裸 JSON。 */
function assertNoRawJsonInPlan(client, plan) {
  const texts = [];
  for (const item of plan) {
    if (item.card?.line) texts.push(item.card.line);
    if (item.issue) texts.push(item.issue);
    if (item.title) texts.push(item.title);
    for (const action of item.actions || []) { if (action.label) texts.push(action.label); if (action.hint) texts.push(action.hint); }
    for (const block of item.blocks || []) {
      // 围栏代码块是"用户/助手主动展示的代码"，不算泄漏；其余块必须过裸 JSON 判定。
      if (block.kind === 'code') continue;
      texts.push(block.text || '');
      for (const value of block.items || []) texts.push(value);
    }
  }
  for (const text of texts) assert.equal(client.chat.isRawPayload(text), false, `裸 JSON 进了渲染计划：${String(text).slice(0, 40)}`);
  // 诊断原文只能留在 diagnostic 里，不得同时出现在任何渲染文本中
  for (const item of plan) {
    if (!item.diagnostic) continue;
    assert.equal(texts.includes(item.diagnostic), false, '诊断原文泄漏进了渲染文本');
  }
}

test('dialog plan maps every message kind and never carries raw JSON into the view', async () => {
  const client = await loadClient();
  const plan = client.chat.buildDialogPlan([
    { id: 'u1', role: 'user', text: '把画布改成 1200×800' },
    { id: 'a1', role: 'assistant', text: '好的\n\n- 已调整\n- 版本 R2\n\n```json\n{"width":1200}\n```' },
    { id: 't1', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 2, line: 'canvas.resize' } },
    { id: 't2', role: 'tool', card: { name: '执行编辑', status: 'unknown', revision: 2, line: '' } },
    { id: 't3', role: 'tool', card: { name: '读取工程', status: 'rejected', revision: null, line: '', error: true } },
    { id: 't4', role: 'tool', card: { name: '执行编辑', status: '', revision: null, line: '' } },
    { id: 'v1', role: 'approval', text: '等待本人在原生会话确认审批：media_image_read_state' },
    { id: 'v2', role: 'approval', decided: true, outcome: 'rejected', text: '审批已拒绝（也可能由 never 策略自动拒绝），本次请求未获授权。' },
    { id: 'v3', role: 'approval', decided: true, outcome: 'unavailable', text: '原生审批不可用或没有可回答的界面，本次请求未获授权。' },
    { id: 'e1', role: 'error', text: '{"error":{"code":"REVISION_CONFLICT"}}' },
    { id: 'raw1', role: 'assistant', text: '{"quite":"a long raw json body that must not reach the dom at all","n":1}' },
  ]);
  assert.deepEqual(plan.map(item => item.kind), ['user', 'assistant', 'tool', 'tool', 'tool', 'tool', 'approval', 'approval', 'approval', 'error', 'assistant']);
  // 四态徽标：unknown 单独一态，不能画成失败
  assert.deepEqual(plan.slice(2, 6).map(item => item.badge), ['applied', 'unknown', 'rejected', 'pending']);
  // 审批也收敛到四态：pending / rejected / unknown（unavailable 不冒充拒绝）
  assert.deepEqual(plan.filter(item => item.kind === 'approval').map(item => item.badge), ['pending', 'rejected', 'unknown']);
  // 审批只读：唯一动作是打开原生会话，没有任何"允许/拒绝"按钮
  for (const item of plan.filter(entry => entry.kind === 'approval')) {
    assert.deepEqual(item.actions.map(action => action.kind), ['open-native']);
  }
  // 裸 JSON 兜底成一句话；原始内容只留在 diagnostic（剪贴板），不进 DOM
  const raw = plan.at(-1);
  assert.equal(raw.blocks[0].text, '这一步已执行（无法解析摘要）');
  assert.match(raw.diagnostic, /^\{/);
  assertNoRawJsonInPlan(client, plan);
});

test('markdown blocks keep code, lists, headings and inline links/images apart', async () => {
  const client = await loadClient();
  const blocks = client.chat.parseMarkdownBlocks('# 标题\n\n段落一\n\n- 一\n- 二\n\n```js\nconst a = 1\n```\n\n> 引用');
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'paragraph', 'list', 'code', 'quote']);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[3].lang, 'js');
  const tokens = client.chat.parseInlineTokens('见 `a.js` 与 [文档](https://example.com) 和 ![图](https://example.com/a.png)');
  assert.deepEqual(tokens.map(token => token.kind), ['text', 'code', 'text', 'link', 'text', 'image']);
  assert.equal(tokens[3].href, 'https://example.com');
  assert.equal(tokens[5].href, 'https://example.com/a.png');
});

test('attachments are validated before they can be attached', async () => {
  const client = await loadClient();
  const png = 'data:image/png;base64,' + Buffer.from('x'.repeat(64)).toString('base64');
  const ok = client.chat.attachmentFromDataUrl('a.png', png);
  assert.equal(ok.ok, true);
  assert.equal(ok.part.type, 'image');
  assert.equal(client.chat.attachmentFromDataUrl('a.gif', 'data:image/gif;base64,AAA').ok, false);
  assert.match(client.chat.attachmentFromDataUrl('a.txt', 'not-a-data-url').message, /PNG/);
  const big = 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024);
  assert.match(client.chat.attachmentFromDataUrl('big.png', big).message, /4 MB/);
  const body = client.chat.promptBody('s', 'hi', [ok.part]);
  assert.deepEqual(body.content.map(part => part.type), ['text', 'image']);
  assert.deepEqual(client.chat.promptBody('s', 'hi').content.map(part => part.type), ['text']);
});

test('retry is allowed exactly once for a known failure and refused when the outcome is unknown', async () => {
  const client = await loadClient();
  assert.equal(client.chat.retryState(null), null);
  assert.equal(client.chat.retryState({ text: 'a', unknown: false }).retryable, true);
  assert.equal(client.chat.retryState({ text: 'a', unknown: true }).retryable, false);
  assert.match(client.chat.retryState({ text: 'a', unknown: true }).reason, /核对会话记录/);
  assert.equal(client.chat.normalizeToolStatus('completed', false), 'applied');
  assert.equal(client.chat.normalizeToolStatus('', true), 'rejected');
  assert.equal(client.chat.normalizeToolStatus('unknown', false), 'unknown');
});

test('undo action carries its own credentials; nothing is looked up from the raw row', async () => {
  const client = await loadClient();
  const plan = client.chat.buildDialogPlan([{ id: 't1', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 3, line: 'layer.set_frame' },
    undo: { commandId: 'cmd-7', appliedRevision: 3, afterDigest: 'fnv1a64-0000000000000001' } }]);
  const action = plan[0].actions.find(item => item.kind === 'fill-undo');
  assert.ok(action, '撤销必须给"填入输入框"动作');
  assert.match(action.hint, /栈顶/);
  assert.match(action.hint, /HISTORY_CONFLICT/);
  // 凭据必须在动作里：渲染层只 setDraft(action.prompt)，不回查原始行
  assert.equal(action.undo.commandId, 'cmd-7');
  assert.equal(action.undo.appliedRevision, 3);
  assert.equal(action.undo.afterDigest, 'fnv1a64-0000000000000001');
  assert.match(action.prompt, /cmd-7/);
  assert.match(action.prompt, /HISTORY_CONFLICT/);
  assert.equal(plan[0].actions.some(item => item.kind === 'undo'), false, '不允许出现直接执行撤销的动作');
  // 非法凭据（缺 digest / 修订号不是整数）→ 整体不给动作，而不是给一个跑不通的按钮
  for (const bad of [{ commandId: 'cmd-7', appliedRevision: 3 }, { commandId: 'cmd-7', appliedRevision: '3', afterDigest: 'fnv1a64-0000000000000001' },
    { commandId: '', appliedRevision: 3, afterDigest: 'fnv1a64-0000000000000001' }, { commandId: 'c', appliedRevision: 3, afterDigest: 'nope' }]) {
    const planned = client.chat.buildDialogPlan([{ id: 't2', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 3, line: 'x' }, undo: bad }]);
    assert.equal(planned[0].actions.some(item => item.kind === 'fill-undo'), false, `非法凭据不该给动作：${JSON.stringify(bad)}`);
  }
  assert.equal(client.chat.undoPrompt({}), '');
});

test('export action carries the export ref it needs', async () => {
  const client = await loadClient();
  const plan = client.chat.buildDialogPlan([{ id: 't1', role: 'tool', card: { name: '开始导出', status: 'completed', revision: 2, line: 'export_start' },
    exportRef: { exportId: 'exp-1', artifactRef: 'artifact:1', format: 'png' } }]);
  const action = plan[0].actions.find(item => item.kind === 'download-export');
  assert.deepEqual(action.export, { exportId: 'exp-1', artifactRef: 'artifact:1', format: 'png' });
  // 没有 exportId 的引用不产生动作
  const none = client.chat.buildDialogPlan([{ id: 't2', role: 'tool', card: { name: '开始导出', status: 'completed', revision: 2, line: 'x' }, exportRef: { artifactRef: 'artifact:2' } }]);
  assert.equal(none[0].actions.some(item => item.kind === 'download-export'), false);
});

test('locate 透传：合法原样保留，非法整体省略', async () => {
  const client = await loadClient();
  const ok = client.chat.buildDialogPlan([{ id: 't1', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 2, line: 'layer.set_frame' },
    locate: { objectIds: ['layer-1', 'layer-2'], kind: 'layer' } }]);
  assert.deepEqual(ok[0].locate, { objectIds: ['layer-1', 'layer-2'], kind: 'layer' });
  for (const locate of [{ objectIds: [], kind: 'layer' }, { objectIds: ['a'], kind: 'gizmo' }, { objectIds: [1], kind: 'clip' }, null, 'nope']) {
    const plan = client.chat.buildDialogPlan([{ id: 't2', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 2, line: 'x' }, locate }]);
    assert.equal('locate' in plan[0], false, `非法 locate 必须整体省略：${JSON.stringify(locate)}`);
  }
  // 视频侧的 clip/track 也在白名单里
  const track = client.chat.buildDialogPlan([{ id: 't3', role: 'tool', card: { name: '改轨道', status: 'applied', revision: 2, line: 'track.update' }, locate: { objectIds: ['video-track-1'], kind: 'track' } }]);
  assert.equal(track[0].locate.kind, 'track');
});

test('错误行与工具回执用严格判定：短 JSON 也不会当正文渲染', async () => {
  const client = await loadClient();
  const shortError = '{"code":"REVISION_CONFLICT"}';
  assert.equal(client.chat.looksLikeRawJson(shortError), false, '散文阈值对短 JSON 是豁免的');
  assert.equal(client.chat.isRawPayload(shortError), true, '严格判定必须认出它');
  const plan = client.chat.buildDialogPlan([
    { id: 'e1', role: 'error', text: shortError },
    { id: 't1', role: 'tool', card: { name: '执行编辑', status: 'rejected', revision: null, line: shortError, error: true } },
  ]);
  assert.equal(plan[0].blocks[0].text, '操作没有完成（无法解析摘要）');
  assert.equal(plan[1].card.line, '');
  assert.equal(plan[1].diagnostic, shortError);
  assertNoRawJsonInPlan(client, plan);
});

