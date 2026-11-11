// P0-2 回归：无头编辑器工具的三条硬约束。
//   1) 未启用时不注册工具（不是注册了再报错）
//   2) 启用但没给 origin → 明确 HEADLESS_ORIGIN_REQUIRED，不去猜端口
//   3) 拉起成功后回执必须带 instanceId/projectId，并把"下一步要 bind"写清
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMediaTools } from '../lib/tools.js';
import { createSessionBindings } from '../lib/gate.js';

const execOf = () => ({ agent: { id: 'session-h', session: { id: 'session-h' } } });

function build({ headless }) {
  const tools = new Map();
  const ctx = {
    tools: { register: definition => tools.set(definition.name, definition), guard: () => {} },
    approval: { request: async () => 'rejected' },
  };
  const bridge = { getPage: () => null, readState: async () => ({ documentId: 'p0', revision: 0 }) };
  registerMediaTools(ctx, {
    bridge,
    approvals: { store: new Map() },
    bindings: createSessionBindings({ resolvePage: () => null }),
    assets: null,
    generation: null,
    recipes: null,
    photoshop: null,
    headless,
  });
  return tools;
}

test('未启用无头能力时不注册 ensure_editor 工具', () => {
  const tools = build({ headless: null });
  assert.equal(tools.has('media_image_ensure_editor'), false);
  assert.equal(tools.has('media_image_read_state'), true, '其他工具不受影响');
});

test('启用但没有 origin：明确报 HEADLESS_ORIGIN_REQUIRED，不猜端口', async () => {
  const tools = build({ headless: { enabled: true, origin: '', ensure: async () => { throw new Error('不应被调用'); } } });
  const tool = tools.get('media_image_ensure_editor');
  const value = await tool.execute({}, execOf());
  assert.equal(value.status, 'rejected');
  assert.equal(value.error.code, 'HEADLESS_ORIGIN_REQUIRED');
});

test('拉起成功后回执带 instanceId/projectId，并提示下一步要 bind', async () => {
  let asked = null;
  const tools = build({
    headless: {
      enabled: true,
      origin: 'http://127.0.0.1:49852',
      ensure: async options => { asked = options; return { instanceId: 'i-1', pageId: 'pg-1', projectId: 'p-1', reused: false }; },
    },
  });
  const tool = tools.get('media_image_ensure_editor');
  const value = await tool.execute({}, execOf());
  assert.equal(value.status, 'applied');
  assert.equal(value.projectId, 'p-1');
  assert.equal(value.detail.instanceId, 'i-1');
  assert.equal(asked.origin, 'http://127.0.0.1:49852');
  assert.match(value.note, /bind: true/);
});

test('复用已有实例时如实标注 reused，不谎称新启动', async () => {
  const tools = build({
    headless: { enabled: true, origin: 'http://x', ensure: async () => ({ instanceId: 'i-2', pageId: 'pg-2', projectId: 'p-2', reused: true }) },
  });
  const value = await tools.get('media_image_ensure_editor').execute({}, execOf());
  assert.equal(value.detail.reused, true);
  assert.match(value.note, /复用/);
});

test('缺少可信会话身份时拒绝（不能靠参数自报）', async () => {
  const tools = build({ headless: { enabled: true, origin: 'http://x', ensure: async () => ({ instanceId: 'i', pageId: 'p', projectId: 'pr', reused: false }) } });
  const value = await tools.get('media_image_ensure_editor').execute({}, { agent: { id: 'a', session: { id: 'b' } } });
  assert.equal(value.status, 'rejected');
});
