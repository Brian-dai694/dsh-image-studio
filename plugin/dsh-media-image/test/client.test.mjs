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

test('the image package registers a native tool card for each of its five tools', async () => {
  const client = await loadClient();
  const { ctx, registered, injected, flush } = makeContext();
  client.apply(ctx);
  flush();
  assert.ok(injected.includes('tool.call.toolview'));
  const views = registered.filter(item => item.definition.name === 'tool.call.toolview');
  const keys = views.map(item => item.definition.key).sort();
  assert.equal(keys.length, 5);
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
  assert.equal(plain.status, 'unknown', '没有明确结果、也没有错误码时仍然是 unknown');
});

test('binding can attach an existing session, and refuses one that belongs to another project', async () => {
  const client = await loadClient();
  // 列表归一化：字段形状在不同宿主版本里不一致，统一成 {sessionId,title}
  const items = client.chat.sessionListItems({ value: { sessions: [{ sessionId: 's1', title: '首次绑定视频工程只读状态' }, { id: 's2' }, {}, { sessionId: '' }] } });
  assert.deepEqual(items.map(item => item.sessionId), ['s1', 's2']);
  assert.equal(items[0].title, '首次绑定视频工程只读状态');
  assert.equal(items[1].title, 's2');
  assert.equal(client.chat.sessionListItems({ value: { sessions: 'nope' } }), null);
  assert.equal(client.chat.sessionListItems(undefined), null);
  // 宿主没有 list / 读失败 → null，调用方回退到新建
  assert.equal(await client.chat.listSessions({ session: {} }), null);
  assert.equal(await client.chat.listSessions({ session: { list: async () => { throw new Error('no') } } }), null);
  // 工程标识提取：只认带身份标记的那条用户消息
  const marked = '当前编辑工程身份：' + JSON.stringify({ editorKind: 'image', projectId: 'proj-a' }) + '\n用户指令：\n改标题';
  const records = [{ event: { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: marked }] } } } }];
  assert.equal(client.chat.projectIdFromRecords(records), 'proj-a');
  assert.equal(client.chat.projectMismatch(records, 'proj-a'), null);
  assert.equal(client.chat.projectMismatch(records, 'proj-b'), 'proj-a', '不同工程必须能被识别出来');
  assert.equal(client.chat.projectIdFromRecords([]), null);
  assert.equal(client.chat.projectMismatch([], 'proj-a'), null, '没有标记不拒绝，交给 read_state/审批把关');
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

