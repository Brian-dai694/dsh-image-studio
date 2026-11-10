import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, chatTurn, OP_TYPES } from '../lib/assist.js';

const actionSurface = { enabled: true, actions: ['status', 'create_document', 'add_text_layer', 'export_active'] };
const payload = ops => JSON.stringify({ reply: '准备操作 Photoshop', ops });

test('Photoshop op 未启用时被丢弃；启用后只接受 action allowlist 内一个结构化 op', () => {
  assert.equal(OP_TYPES.includes('photoshopAction'), true);
  const disabled = parsePlan(payload([{ type: 'photoshopAction', action: 'create_document', arguments: { widthPx: 800, heightPx: 600 } }]), { photoshop: { enabled: false, actions: [] } });
  assert.equal(disabled.ops.length, 0);
  assert.equal(disabled.droppedOps, 1);

  const accepted = parsePlan(payload([{ type: 'photoshopAction', action: 'create_document', arguments: { widthPx: 800, heightPx: 600 } }]), { photoshop: actionSurface });
  assert.equal(accepted.ops.length, 1);
  assert.equal(accepted.ops[0].action, 'create_document');

  const unknown = parsePlan(payload([{ type: 'photoshopAction', action: 'run_jsx', arguments: { jsx: 'app.quit()' } }]), { photoshop: actionSurface });
  assert.equal(unknown.ops.length, 0, 'JSX/未授权 action 不得由助手路由');
  const smuggled = parsePlan(payload([{ type: 'photoshopAction', action: 'status', arguments: {}, jsx: 'evil' }]), { photoshop: actionSurface });
  assert.equal(smuggled.ops.length, 0, '拒绝额外字段');
});

test('Photoshop op 不可与 miniPaint 原子 plan 混在同一组', () => {
  const plan = { type: 'plan', steps: [{ operation: 'layer.add_text', params: { text: 'hi' } }] };
  const ps = { type: 'photoshopAction', action: 'status', arguments: {} };
  const parsed = parsePlan(payload([plan, ps]), { photoshop: actionSurface });
  assert.equal(parsed.ops.length, 0, '跨应用执行不可伪称一个事务');
  assert.equal(parsed.droppedOps, 2);
});

test('模型上下文只公开启用时的结构化 Photoshop capability', async () => {
  let seenSystem = '', seenUser = '';
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'llm') return { prepareCall: async () => ({ config: {}, async *stream(input) { seenSystem = input.system; seenUser = input.messages[0].content[0].text; yield { type: 'text-delta', text: payload([]) }; } }) };
      return null;
    },
  };
  await chatTurn(ctx, { message: '查询 Photoshop', photoshop: { enabled: true, actions: ['status', 'create_document'] } });
  assert.match(seenSystem, /photoshopAction/);
  assert.match(seenUser, /Photoshop COM 已启用/);
  assert.match(seenUser, /status、create_document/);
  await chatTurn(ctx, { message: '查询 Photoshop', photoshop: { enabled: false, actions: [] } });
  assert.match(seenUser, /Photoshop COM 未启用/);
});
