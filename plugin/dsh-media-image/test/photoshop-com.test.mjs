import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPhotoshopService, PHOTOSHOP_ACTIONS } from '../lib/photoshop-com.js';
import { createAssetStore } from '../lib/assets.js';
import { createMediaBridge } from '../lib/bridge.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore, createGuard } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

const SCRIPT = 'var d = app.activeDocument; d.name = "reviewed";';
const bridgePath = resolve('scripts/photoshop-bridge.ps1');
// gate.js 的 trustedSessionId 要求执行上下文里带真实 agent+session。
const trustedExec = { agent: { id: 'agent-ps', session: { id: 'agent-ps' } }, callId: 'ps-call' };

function fakeResult({ status = 0, stdout = '', stderr = '', error = undefined } = {}) {
  return { status, stdout, stderr, error };
}

test('默认关闭；启用后只提供已声明的 action，参数/路径/超时均校验', () => {
  assert.equal(createPhotoshopService({ enabled: false }), null);
  assert.throws(() => createPhotoshopService({ enabled: true, timeoutMs: 0 }), { code: 'PHOTOSHOP_TIMEOUT_INVALID' });
  assert.throws(() => createPhotoshopService({ enabled: true, progId: 'Bad ProgId' }), { code: 'PHOTOSHOP_PROGID_INVALID' });
  const service = createPhotoshopService({ enabled: true, spawnSyncImpl: () => fakeResult({ stdout: JSON.stringify({ ok: true }) }) });
  assert.deepEqual(service.describe().actions, PHOTOSHOP_ACTIONS);
  assert.equal(service.describe().arbitraryJsx, true, '任意 ExtendScript 能力已按本人要求暴露');
  // action 枚举之外的仍然拒绝（run_jsx 现在是合法 action，所以换一个真正不存在的名字）。
  assert.throws(() => service.runAction({ action: 'quit_app', arguments: {}, confirm: true }), { code: 'PHOTOSHOP_ACTION_INVALID' });
  assert.throws(() => service.runAction({ action: 'open_image', arguments: { path: 'https://example.com/a.png' }, confirm: true }), { code: 'PHOTOSHOP_PATH_INVALID' });
  assert.throws(() => service.runAction({ action: 'export_active', arguments: { outputPath: 'C:/tmp/out.png' } }), { code: 'PHOTOSHOP_CONFIRM_REQUIRED' });
});

test('固定 action 通过 PowerShell bridge 的 JSON stdin 传递，不走 shell；写 action 确认后执行', () => {
  let call;
  const service = createPhotoshopService({ enabled: true, progId: 'Photoshop.Application.2026', spawnSyncImpl: (command, args, options) => {
    call = { command, args, options };
    return fakeResult({ stdout: JSON.stringify({ ok: true, progId: 'Photoshop.Application.2026', attached: true, result: 'created', document: { documentCount: 1 } }) });
  } });
  const result = service.runAction({ action: 'create_document', arguments: { widthPx: 1200, heightPx: 800, name: 'test-doc' }, confirm: true });
  assert.equal(result.result, 'created');
  assert.equal(result.progId, 'Photoshop.Application.2026');
  assert.equal(call.command, 'powershell.exe');
  assert.equal(call.args[call.args.indexOf('-Action') + 1], 'create_document');
  assert.equal(call.args.includes('-File'), true);
  assert.equal(call.args[call.args.indexOf('-File') + 1], bridgePath);
  assert.equal(call.options.shell, false);
  assert.deepEqual(JSON.parse(call.options.input), { widthPx: 1200, heightPx: 800, name: 'test-doc' });
  assert.equal(call.options.input.includes('app.activeDocument'), false, '模型参数中不能携带 JSX');
});

test('启用 Photoshop 后注册结构化动作工具；confirm 必填，autonomous 不再等审批但会如实标注', async () => {
  let approvals = 0, spawned = 0;
  const photoshop = createPhotoshopService({ enabled: true, spawnSyncImpl: () => { spawned += 1; return fakeResult({ stdout: JSON.stringify({ ok: true, progId: 'Photoshop.Application', attached: true, result: 'ok' }) }); } });
  const tools = new Map();
  const ctx = {
    tools: { register: def => tools.set(def.name, def), guard: () => {} },
    approval: { request: async () => { approvals += 1; return 'allowed-once'; } },
  };
  registerMediaTools(ctx, { bridge: createMediaBridge({ relay: { request: async () => { throw new Error('not used'); } }, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings, photoshop });
  const actionTool = tools.get('media_image_photoshop_action');
  const handoffTool = tools.get('media_image_assistant_photoshop_action');
  assert.ok(actionTool);
  assert.ok(handoffTool);
  assert.ok(actionTool.parameters.properties.confirm);

  // confirm 是调用方的显式声明，仍然是硬门槛（与审批无关）。
  const denied = await actionTool.execute({ action: 'create_document', arguments: { widthPx: 1200, heightPx: 800 }, confirm: false }, { ...trustedExec, callId: 'denied' });
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.error.code, 'PHOTOSHOP_CONFIRM_REQUIRED');
  assert.equal(spawned, 0, '没有 confirm 时连 bridge 都不启动');

  // 本人已授权：autonomous 下不再等人工审批，直接执行并标注 autonomous。
  const autonomous = await handoffTool.execute({ action: 'status', arguments: {}, confirm: true }, { ...trustedExec, callId: 'autonomous', autonomous: true });
  assert.equal(autonomous.status, 'applied', JSON.stringify(autonomous));
  assert.equal(approvals, 0, 'autonomous 不得再走人工审批');
  assert.equal(spawned, 1);

  const writeAutonomous = await actionTool.execute({ action: 'create_document', arguments: { widthPx: 1200, heightPx: 800 }, confirm: true }, { ...trustedExec, callId: 'auto-write', autonomous: true });
  assert.equal(writeAutonomous.status, 'applied', JSON.stringify(writeAutonomous));
  assert.equal(writeAutonomous.autonomous, true);
  assert.match(writeAutonomous.note, /不在 miniPaint 的撤销栈里/);
  assert.equal(approvals, 0);
  assert.equal(spawned, 2);
});

test('Photoshop action native approval 拒绝后绝不执行写 action', async () => {
  const spawned = [];
  const photoshop = createPhotoshopService({ enabled: true, spawnSyncImpl: (_c, args) => {
    spawned.push(args[args.indexOf('-Action') + 1]);
    return fakeResult({ stdout: JSON.stringify({ ok: true, progId: 'Photoshop.Application', document: { documentCount: 0 } }) });
  } });
  const tools = new Map();
  const ctx = {
    tools: { register: def => tools.set(def.name, def), guard: () => {} },
    approval: { request: async () => 'denied' },
  };
  registerMediaTools(ctx, { bridge: createMediaBridge({ relay: { request: async () => ({}) }, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings, photoshop });
  const actionTool = tools.get('media_image_photoshop_action');
  const result = await actionTool.execute({ action: 'export_active', arguments: { outputPath: 'C:/tmp/new.png' }, confirm: true }, { agent: { id: 'a', session: { id: 'a' } }, callId: 'deny-call' });
  assert.equal(result.status, 'rejected');
  // 审批前唯一允许发生的是只读 status 探测（用来在确认卡上写清目标文档），写 action 一次都不许跑。
  assert.deepEqual(spawned, ['status']);
});

test('任意 JSX 能力已暴露：run_jsx 校验大小/空串，脚本原样进 stdin，不经 PowerShell 模板', async () => {
  let call;
  const service = createPhotoshopService({ enabled: true, spawnSyncImpl: (command, args, options) => {
    call = { command, args, options };
    return fakeResult({ stdout: JSON.stringify({ ok: true, progId: 'Photoshop.Application', attached: true, result: 'done' }) });
  } });
  // 带 $ / 引号 / 反引号 / 换行的脚本：这类字符最容易被 PowerShell 二次展开，必须原样到达。
  const jsx = 'var s = "a $HOME `b`";\nvar app2 = app; app2.activeDocument.name = s; "ok"';
  const result = service.runAction({ action: 'run_jsx', arguments: { jsx }, confirm: true });
  assert.equal(result.result, 'done');
  assert.equal(call.args[call.args.indexOf('-Action') + 1], 'run_jsx');
  assert.deepEqual(JSON.parse(call.options.input), { jsx }, '脚本放在 JSON stdin 里，不进命令行参数');
  assert.equal(call.args.join(' ').includes('activeDocument'), false, '脚本不得出现在进程命令行上');

  // 空串/纯空白/超限都必须拒绝，且带稳定错误码。
  assert.throws(() => service.runAction({ action: 'run_jsx', arguments: { jsx: '   ' }, confirm: true }), { code: 'PHOTOSHOP_JSX_INVALID' });
  assert.throws(() => service.runAction({ action: 'run_jsx', arguments: { jsx: 42 }, confirm: true }), { code: 'PHOTOSHOP_JSX_INVALID' });
  assert.throws(() => service.runAction({ action: 'run_jsx', arguments: { jsx: 'x'.repeat(64 * 1024 + 1) }, confirm: true }), { code: 'PHOTOSHOP_JSX_TOO_LARGE' });
  // 写 action 仍然必须 confirm:true。
  assert.throws(() => service.runAction({ action: 'run_jsx', arguments: { jsx: 'var a = 1;' } }), { code: 'PHOTOSHOP_CONFIRM_REQUIRED' });
  assert.equal(service.describe().arbitraryJsx, true);
});

test('bridge 源码里 run_jsx 分支不把脚本插值进 here-string', () => {
  const source = readFileSync(bridgePath, 'utf8');
  assert.match(source, /'run_jsx'/);
  // 关键性质：这条分支直接取 $args.jsx 交给 DoJavaScript，前面没有 $p = Js-Literal 的插值路径。
  assert.match(source, /\$script = \[string\]\$args\.jsx/);
  assert.match(source, /\$app\.DoJavaScript\(\$script\)/);
  // 脚本变量不得被写进任何 here-string 模板。
  assert.doesNotMatch(source, /@\"[\s\S]*\$script[\s\S]*?\"@/);
});

test('run_jsx 工具注册：confirm 必填，autonomous 直接执行且不走审批', async () => {
  let approvals = 0;
  const photoshop = createPhotoshopService({ enabled: true, spawnSyncImpl: () => fakeResult({ stdout: JSON.stringify({ ok: true, progId: 'Photoshop.Application', attached: true, result: 'ran' }) }) });
  const tools = new Map();
  const ctx = {
    tools: { register: def => tools.set(def.name, def), guard: () => {} },
    approval: { request: async () => { approvals += 1; return 'allowed-once'; } },
  };
  registerMediaTools(ctx, { bridge: createMediaBridge({ relay: { request: async () => ({}) }, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings, photoshop });
  const tool = tools.get('media_image_photoshop_run_jsx');
  assert.ok(tool, '必须注册任意 JSX 工具');
  assert.equal(tool.parameters.properties.confirm.type, 'boolean', 'confirm 必须是布尔声明');
  assert.equal(tool.parameters.properties.jsx.type, 'string');

  const rejected = await tool.execute({ jsx: 'var a = 1;', confirm: false }, { ...trustedExec, callId: 'jsx-no-confirm' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.error.code, 'PHOTOSHOP_CONFIRM_REQUIRED');
  assert.equal(approvals, 0);

  const autonomous = await tool.execute({ jsx: 'var a = 1; a;', confirm: true, timeoutMs: 5000 }, { ...trustedExec, callId: 'jsx-auto', autonomous: true });
  assert.equal(autonomous.status, 'applied', JSON.stringify(autonomous));
  assert.equal(autonomous.autonomous, true);
  assert.equal(approvals, 0, 'autonomous 不发起人工审批');
  assert.equal(autonomous.photoshop.result, 'ran');

  // assist 模式仍然要人审：审批被拒就绝不执行。
  assert.equal(createGuard()({ name: 'media_image_photoshop_run_jsx', arguments: { mode: 'autonomous' } }), undefined, 'autonomous 下 gate 不再拦任意 JSX');
});

test('host gate 在 autonomous 下放行全部 Photoshop 工具，且三个工具都登记在 TOOL_KINDS', async () => {
  const guard = createGuard();
  const { TOOL_KINDS } = await import('../lib/gate.js');
  for (const name of ['media_image_photoshop_action', 'media_image_photoshop_run_jsx', 'media_image_assistant_photoshop_action']) {
    assert.equal(guard({ name, arguments: { editorKind: 'image', mode: 'autonomous' } }), undefined, `${name} 在 autonomous 下已获授权`);
    assert.equal(TOOL_KINDS[name], 'image', `${name} 必须登记在 TOOL_KINDS 里`);
  }
  // 放行是按"已登记的工具名"来的：没登记的同前缀名字不在我们的管辖范围，也不会被我们宣称放行。
  assert.equal(TOOL_KINDS.media_image_photoshop_nonexistent, undefined);
});

test('PS bridge spawnSync timeout is an explicit unknown outcome, not a retry', async () => {
  const service = createPhotoshopService({ enabled: true, spawnSyncImpl: (_command, _args, options) => {
    assert.equal(options.timeout, 60_000);
    return fakeResult({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null });
  } });
  // runAction 是同步的：超时必须当场抛「结果未知」，不能变成可重放的重试。
  assert.throws(
    () => service.runAction({ action: 'export_active', arguments: { outputPath: 'C:/tmp/out.png' }, confirm: true }),
    error => error.code === 'PHOTOSHOP_RESULT_UNKNOWN' && error.outcomeUnknown === true,
  );
});

test('未启用 Photoshop COM 时不注册任何 Photoshop 工具', () => {
  const tools = new Map();
  const ctx = { tools: { register: def => tools.set(def.name, def), guard: () => {} } };
  registerMediaTools(ctx, { bridge: createMediaBridge({ relay: { request: async () => ({}) }, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings, photoshop: null });
  assert.equal(tools.has('media_image_photoshop_action'), false);
  assert.equal(tools.has('media_image_assistant_photoshop_action'), false);
});

test('Photoshop tools registration is opt-in and adds the fixed-action, JSX and handoff tools', async () => {
  const register = photoshop => {
    const tools = new Map();
    const ctx = { tools: { register: def => tools.set(def.name, def), guard: () => {} } };
    registerMediaTools(ctx, { bridge: createMediaBridge({ relay: { request: async () => ({}) }, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings, photoshop });
    return tools;
  };
  const defaults = register(null);
  const enabled = register(createPhotoshopService({ enabled: true, spawnSyncImpl: () => fakeResult({ stdout: '{"ok":true}' }) }));
  assert.equal(defaults.has('media_image_photoshop_action'), false);
  assert.equal(defaults.has('media_image_photoshop_run_jsx'), false);
  assert.equal(enabled.has('media_image_photoshop_action'), true);
  assert.equal(enabled.has('media_image_photoshop_run_jsx'), true);
  assert.equal(enabled.has('media_image_assistant_photoshop_action'), true);
  assert.equal(enabled.size, defaults.size + 3);
  const { TOOL_KINDS } = await import('../lib/gate.js');
  assert.equal(TOOL_KINDS.media_image_photoshop_action, 'image');
  assert.equal(TOOL_KINDS.media_image_assistant_photoshop_action, 'image');
});

test('PowerShell bridge 使用 stdin JSON 输入，错误输出为 JSON；源码不生成 JSX 临时文件', () => {
  const source = readFileSync(bridgePath, 'utf8');
  assert.match(source, /Console\]::In\.ReadToEnd/);
  assert.match(source, /DoJavaScript\(\s*\[string\]\$jsx\s*\)/);
  assert.match(source, /ok = \$false; action = \$Action; error/);
  assert.doesNotMatch(source, /WriteAllText|Out-File|Set-Content/);
  assert.equal(existsSync(bridgePath), true);
});
