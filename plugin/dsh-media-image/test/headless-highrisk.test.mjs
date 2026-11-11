// 本人 2026-11-11 明确同意：无头实例可以执行高危命令（没有人能给它点审批）。
// 这条策略必须收得很紧：只对"本插件拉起且配置显式开启"的无头实例生效，
// 人打开的面板页仍然逐次审批，执行结果要带 autonomous:true 供审计。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

const execOf = () => ({ agent: { id: 's1', session: { id: 's1' } }, callId: 'c1' });
const args = {
  editorKind: 'image', projectId: 'p1', instanceId: 'inst-headless',
  commandId: 'cmd-1', expectedRevision: 2,
  operation: 'layer.add_image',
  params: { sourceRef: 'asset:aabb', x: 0, y: 0, width: 10, height: 10 },
};
const state = { editorKind: 'image', editorInstanceId: 'inst-headless', documentId: 'p1', revision: 2, stateDigest: 'd2', canvas: { width: 10, height: 10 }, layers: [] };

function build({ headless, applied = true } = {}) {
  const tools = new Map();
  const calls = [];
  const bridge = {
    editorKind: 'image',
    readState: async () => state,
    applyCommand: async input => {
      calls.push(input);
      if (!applied) throw Object.assign(new Error('editor refused'), { code: 'EDITOR_ERROR' });
      return { editorKind: 'image', documentId: 'p1', commandId: input.commandId, revision: 3, changedObjectIds: ['l2'], stateDigest: 'd3', afterDigest: 'd3' };
    },
    getCommandResult: async () => null,
  };
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition), guard: () => {} } }, {
    bridge, approvals: createApprovalStore(), bindings: fixtureBindings, headless,
  });
  return { tool: tools.get('media_image_apply_command'), calls };
}

test('无头实例 + allowHighRisk：高危命令直接执行，回执标注 autonomous', async () => {
  const { tool, calls } = build({ headless: { enabled: true, allowHighRisk: true, isHeadless: id => id === 'inst-headless' } });
  const value = await tool.execute(args, execOf());
  assert.equal(value.status, 'applied', JSON.stringify(value));
  assert.equal(value.autonomous, true);
  assert.match(value.note, /不需要人工确认|本人授权|autonomous/);
  assert.equal(value.approvalId, undefined, '不该再发审批单');
  assert.equal(calls.length, 1, '必须真的写了一次');
});

test('人打开的面板页（非无头实例）仍然要审批', async () => {
  const { tool, calls } = build({ headless: { enabled: true, allowHighRisk: true, isHeadless: () => false } });
  const value = await tool.execute({ ...args, instanceId: 'inst-human' }, execOf());
  assert.equal(value.status, 'pending');
  assert.equal(value.error.code, 'HUMAN_CONFIRMATION_REQUIRED');
  assert.equal(calls.length, 0, '没审批就不能写');
});

test('部署没开 allowHighRisk：即使是无头实例也要审批', async () => {
  const { tool } = build({ headless: { enabled: true, allowHighRisk: false, isHeadless: () => true } });
  const value = await tool.execute(args, execOf());
  assert.equal(value.status, 'pending');
});

test('完全没有 headless 配置时行为不变（要审批）', async () => {
  const { tool } = build({ headless: null });
  const value = await tool.execute(args, execOf());
  assert.equal(value.status, 'pending');
});
