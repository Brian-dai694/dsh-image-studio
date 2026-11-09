// media_image_run_plan：整串 = 一条 history.batch（编辑器 Bundle_action），一步撤销、失败整体回滚。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaBridge } from '../lib/bridge.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

function harness({ failEditor = false } = {}) {
  let revision = 0;
  const writes = [];
  const undos = [];
  const relay = {
    request: async message => {
      if (message.type === 'editor.read_state') {
        return { editorKind: 'image', editorInstanceId: 'e1', documentId: 'doc-1', revision, stateDigest: `fnv1a64-${revision}`,
          canvas: { width: 100, height: 100 }, layers: [], history: { canUndo: revision > 0, canRedo: false } };
      }
      if (message.type === 'editor.apply_command') {
        writes.push(message.command);
        if (failEditor) throw Object.assign(new Error('editor refused the batch'), { code: 'INVALID_REQUEST' });
        revision += 1;
        return { editorKind: 'image', documentId: 'doc-1', commandId: message.commandId, revision, changedObjectIds: ['l1'] };
      }
      throw new Error(`unexpected ${message.type}`);
    },
  };
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } },
    { bridge: createMediaBridge({ relay, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings });
  return { tools, writes, undos };
}

const call = (tools, args) => tools.get('media_image_run_plan').execute({ editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', ...args }, { agent: { id: 'a' } });
const STEPS = [
  { operation: 'layer.add_text', params: { text: 'A', x: 1, y: 2 } },
  { operation: 'layer.set_appearance', params: { layerId: 'l1', opacity: 50 } },
  { operation: 'layer.set_visibility', params: { layerId: 'l1', visible: false } },
];

test('整串只发一条 history.batch：一次写入、一次 revision', async () => {
  const { tools, writes } = harness();
  const value = await call(tools, { commandId: 'plan-1', expectedRevision: 0, steps: STEPS });
  assert.equal(value.status, 'applied', JSON.stringify(value));
  assert.equal(writes.length, 1, '三步必须合成一次写入');
  assert.equal(writes[0].type, 'history.batch');
  assert.deepEqual(writes[0].payload.steps.map(step => step.type), STEPS.map(step => step.operation));
  assert.equal(value.revision, 1, 'revision 只前进一步');
  assert.equal(value.steps.length, 3);
});

test('编辑器拒绝整串时，工具层不补写、不逐条撤销（回滚由 Bundle 负责）', async () => {
  const { tools, writes } = harness({ failEditor: true });
  const value = await call(tools, { commandId: 'plan-2', expectedRevision: 0, steps: STEPS });
  assert.equal(value.status, 'rejected');
  assert.equal(value.error.code, 'INVALID_REQUEST');
  assert.equal(writes.length, 1, '只尝试了一次批量，没有逐条重试');
  assert.equal(value.rolledBack, undefined, '不再由工具层编造回滚数字');
});

test('高危命令不能进批量计划，且一次写入都不会发生', async () => {
  const { tools, writes } = harness();
  const value = await call(tools, { commandId: 'plan-3', expectedRevision: 0,
    steps: [{ operation: 'layer.add_text', params: { text: 'A' } }, { operation: 'layer.remove', params: { layerId: 'l1' } }] });
  assert.equal(value.status, 'rejected');
  assert.equal(value.error.code, 'HIGH_RISK_IN_PLAN');
  assert.match(value.error.message, /layer\.remove/);
  assert.equal(writes.length, 0);
});

test('步骤数与 revision 冲突都明确拒绝', async () => {
  const { tools, writes } = harness();
  const empty = await call(tools, { commandId: 'plan-4', expectedRevision: 0, steps: [] });
  assert.equal(empty.error.code, 'INVALID_REQUEST');
  const many = await call(tools, { commandId: 'plan-5', expectedRevision: 0, steps: Array.from({ length: 13 }, () => ({ operation: 'layer.add_text', params: { text: 'x' } })) });
  assert.equal(many.error.code, 'INVALID_REQUEST');
  const stale = await call(tools, { commandId: 'plan-6', expectedRevision: 99, steps: [{ operation: 'layer.add_text', params: { text: 'x' } }] });
  assert.equal(stale.error.code, 'REVISION_CONFLICT');
  assert.equal(stale.error.retryable, true);
  assert.equal(writes.length, 0, '前置校验失败不得触达编辑器');
});
