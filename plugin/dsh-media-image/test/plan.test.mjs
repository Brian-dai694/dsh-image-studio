// media_image_run_plan：批量执行 + 失败整体回滚。这是「模型能执行」的入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaBridge } from '../lib/bridge.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

function harness({ failOn = null } = {}) {
  let revision = 0;
  let digest = 'fnv1a64-start';
  const applied = [];
  const undos = [];
  const relay = {
    request: async message => {
      if (message.type === 'editor.read_state') {
        return { editorKind: 'image', editorInstanceId: 'e1', documentId: 'doc-1', revision, stateDigest: digest,
          canvas: { width: 100, height: 100 }, layers: [], history: { canUndo: undos.length + applied.length > 0, canRedo: false,
            ...(applied.length && undos.length === 0 ? { lastCommandId: applied[applied.length - 1], afterDigest: digest } : {}) } };
      }
      if (message.type === 'editor.apply_command') {
        const type = message.command.type;
        if (failOn && type === failOn) throw Object.assign(new Error(`${type} failed`), { code: 'LAYER_NOT_FOUND' });
        if (type === 'history.undo') { undos.push(message.commandId); revision += 1; digest = `fnv1a64-u${undos.length}`; return { editorKind: 'image', documentId: 'doc-1', commandId: message.commandId, revision, changedObjectIds: [] }; }
        applied.push(message.commandId);
        revision += 1;
        digest = `fnv1a64-${applied.length}`;
        return { editorKind: 'image', documentId: 'doc-1', commandId: message.commandId, revision, changedObjectIds: ['l1'] };
      }
      throw new Error(`unexpected ${message.type}`);
    },
  };
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } },
    { bridge: createMediaBridge({ relay, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings });
  return { tools, applied, undos };
}

const call = (tools, args) => tools.get('media_image_run_plan').execute({ editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', ...args }, { agent: { id: 'a' } });

test('批量执行：三步按顺序跑完，每步一个独立 commandId', async () => {
  const { tools, applied } = harness();
  const value = await call(tools, {
    commandId: 'plan-1', expectedRevision: 0,
    steps: [
      { operation: 'layer.add_text', params: { text: 'A', x: 1, y: 2 } },
      { operation: 'layer.set_appearance', params: { layerId: 'l1', opacity: 50 } },
      { operation: 'layer.set_visibility', params: { layerId: 'l1', visible: false } },
    ],
  });
  assert.equal(value.status, 'applied', JSON.stringify(value));
  assert.equal(value.steps.length, 3);
  assert.deepEqual(applied, ['plan-1-1', 'plan-1-2', 'plan-1-3']);
  assert.equal(value.revision, 3);
});

test('中途失败：已执行的步骤被撤销，并如实报告是否回到原状', async () => {
  const { tools, applied, undos } = harness({ failOn: 'layer.set_visibility' });
  const value = await call(tools, {
    commandId: 'plan-2', expectedRevision: 0,
    steps: [
      { operation: 'layer.add_text', params: { text: 'A', x: 1, y: 2 } },
      { operation: 'layer.set_appearance', params: { layerId: 'l1', opacity: 50 } },
      { operation: 'layer.set_visibility', params: { layerId: 'l1', visible: false } },
    ],
  });
  assert.equal(value.status, 'rejected');
  assert.equal(value.error.code, 'LAYER_NOT_FOUND');
  assert.equal(applied.length, 2, '只执行了两步');
  assert.equal(undos.length, 2, '两步都要撤销');
  assert.equal(value.rolledBack.undone, 2);
});

test('高危命令不能进批量计划，且不会写入任何一步', async () => {
  const { tools, applied, undos } = harness();
  const value = await call(tools, {
    commandId: 'plan-3', expectedRevision: 0,
    steps: [{ operation: 'layer.add_text', params: { text: 'A' } }, { operation: 'layer.remove', params: { layerId: 'l1' } }],
  });
  assert.equal(value.status, 'rejected');
  assert.equal(value.error.code, 'HIGH_RISK_IN_PLAN');
  assert.match(value.error.message, /layer\.remove/);
  assert.equal(applied.length, 0);
  assert.equal(undos.length, 0);
});

test('步骤数与 revision 冲突都明确拒绝', async () => {
  const { tools } = harness();
  const empty = await call(tools, { commandId: 'plan-4', expectedRevision: 0, steps: [] });
  assert.equal(empty.error.code, 'INVALID_REQUEST');
  const many = await call(tools, { commandId: 'plan-5', expectedRevision: 0, steps: Array.from({ length: 13 }, () => ({ operation: 'layer.add_text', params: { text: 'x' } })) });
  assert.equal(many.error.code, 'INVALID_REQUEST');
  const stale = await call(tools, { commandId: 'plan-6', expectedRevision: 99, steps: [{ operation: 'layer.add_text', params: { text: 'x' } }] });
  assert.equal(stale.error.code, 'REVISION_CONFLICT');
  assert.equal(stale.error.retryable, true);
});
