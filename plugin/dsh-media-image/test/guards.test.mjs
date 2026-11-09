// 0.20.0 三条护栏：
// 1) 中继类型清单必须覆盖页面真正会发的每种请求（0.19.0 漏了 export_inpaint_inputs，运行时被拒）；
// 2) 同一调用失败两次后熔断，避免模型原地重试；
// 3) 套版文字命令带槽宽 meta，页面据此收缩字号。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditorRelay } from '../lib/relay.js';
import { EDITOR_REQUEST_TYPES } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

test('中继允许的类型覆盖页面会发的每一种 editor.* 请求', () => {
  const hostSource = readFileSync(resolve(pluginRoot, 'scripts/image-page/host.js'), 'utf8');
  const bridgeSource = readFileSync(resolve(pluginRoot, '../../miniPaint/src/js/dsh-editor-bridge.js'), 'utf8');
  // 页面里出现的 type: 'editor.xxx' 与 iframe 认识的分发项都要有登记。
  const fromHost = new Set([...hostSource.matchAll(/type:\s*'(editor\.[a-z_]+)'/g)].map(m => m[1]));
  const fromBridge = new Set([...bridgeSource.matchAll(/request\.type === '(editor\.[a-z_]+)'/g)].map(m => m[1]));
  const used = new Set([...fromHost, ...fromBridge]);
  assert.ok(used.size >= 6, `至少应识别出 6 种请求，实际 ${JSON.stringify([...used])}`);
  for (const type of used) {
    assert.ok(EDITOR_REQUEST_TYPES.includes(type), `${type} 没有登记进 relay 白名单，运行时会被拒成 INVALID_REQUEST`);
  }
  // 反向：登记了但谁都不发的类型留着没坏处，但必须是真实契约的一部分。
  assert.ok(EDITOR_REQUEST_TYPES.includes('editor.export_inpaint_inputs'));
  assert.ok(EDITOR_REQUEST_TYPES.includes('editor.measure_text'));
});

test('未登记的请求类型被 relay 明确拒绝，不是静默成功', async () => {
  const relay = createEditorRelay({ editorKind: 'image', allowedTypes: EDITOR_REQUEST_TYPES });
  const page = relay.register({ editorInstanceId: 'inst-1' });
  await assert.rejects(
    () => relay.request({ type: 'editor.not_a_real_type', requestId: 'r1', editorInstanceId: 'inst-1' }),
    error => error.code === 'INVALID_REQUEST',
  );
  assert.ok(page.pageToken, '注册成功才说明上面的拒绝来自类型检查而不是未连接');
  relay.close();
});

test('同一调用失败两次后熔断：第三次直接拒绝，换参数才放行', async () => {
  const { fixtureBindings } = await import('./host-fixture.mjs');
  const { createMediaBridge } = await import('../lib/bridge.js');
  const { registerMediaTools } = await import('../lib/tools.js');
  const { createApprovalStore } = await import('../lib/gate.js');
  const imageState = revision => ({ editorKind: 'image', editorInstanceId: 'e1', documentId: 'doc-1', revision,
    stateDigest: `fnv1a64-${revision}`, canvas: { width: 100, height: 100 }, layers: [], history: { canUndo: false, canRedo: false } });
  let attempts = 0;
  const relay = { request: async message => {
    if (message.type === 'editor.read_state') return imageState(0);
    attempts += 1;
    throw Object.assign(new Error('no such layer'), { code: 'LAYER_NOT_FOUND' });
  } };
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } },
    { bridge: createMediaBridge({ relay, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings });
  const definition = tools.get('media_image_apply_command');
  const call = commandId => definition.execute({
    editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', commandId, expectedRevision: 0,
    operation: 'layer.set_appearance', params: { layerId: 'missing', opacity: 50 },
  }, { agent: { id: 'a' } });

  const first = await call('c1');
  const second = await call('c2');
  assert.equal(first.error.code, 'LAYER_NOT_FOUND');
  assert.equal(second.error.code, 'LAYER_NOT_FOUND');
  assert.equal(attempts, 2, '前两次真的打到编辑器');

  const third = await call('c3');
  assert.equal(third.error.code, 'REPEATED_FAILURE', JSON.stringify(third));
  assert.equal(third.error.retryable, false);
  assert.equal(attempts, 2, '熔断后不得再打编辑器');

  // 换参数等于换了一个新调用，应该重新尝试。
  const other = await definition.execute({
    editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', commandId: 'c4', expectedRevision: 0,
    operation: 'layer.set_appearance', params: { layerId: 'missing', opacity: 60 },
  }, { agent: { id: 'a' } });
  assert.equal(other.error.code, 'LAYER_NOT_FOUND', '不同参数不应被熔断');
  assert.equal(attempts, 3);
});

test('套版文字命令带槽宽 meta，且 meta 不进入 payload（否则会被白名单拒）', async () => {
  const template = { canvas: { width: 400, height: 200 }, slots: [
    { id: 'slot-1', name: '标题', type: 'text', rect: { x: 10, y: 10, width: 120, height: 30 }, visible: true, text: '一个很长的标题文案', fontSize: 40 },
  ] };
  const { planTemplateApply } = await import('../lib/template.js');
  const plan = planTemplateApply(template, {});
  const command = plan.commands.find(item => item.type === 'layer.add_text');
  assert.equal(command.meta.slotWidth, 120, '必须把槽宽交给页面');
  assert.equal(command.meta.slotId, 'slot-1');
  assert.equal('slotWidth' in command.payload, false, 'payload 不能多字段，否则命令被拒');
  assert.deepEqual(Object.keys(command.payload).sort(), ['style', 'text', 'x', 'y'].sort());
});
