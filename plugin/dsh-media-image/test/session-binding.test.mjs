import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBindings, trustedSessionId, createApprovalStore } from '../lib/gate.js';
import { registerMediaTools } from '../lib/tools.js';
import { COMMAND_VALIDATORS } from '../lib/bridge.js';
const exec = id => ({ agent: { id, session: { id } } });
const binding = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', pageId: 'page1' };

test('identity uses matching live Agent.session only; string/name/self-reported identity rejected', () => {
  for (const value of [{}, { agent: 's1' }, { agent: { name: 's1' } }, { agent: { id: 's1' } }, { agent: { id: 's1', session: { id: 's2' } } }]) assert.throws(() => trustedSessionId(value), { code: 'SESSION_IDENTITY_REQUIRED' });
  assert.equal(trustedSessionId(exec('s1')), 's1');
});

test('Host register requires verified page ownership, then rejects cross-session, project omission and stale page', () => {
  let page = { pageId: 'page1', sessionId: 's1' };
  const registry = createSessionBindings({ resolvePage: () => page });
  assert.throws(() => registry.register(exec('s2'), binding), { code: 'SESSION_BINDING_MISMATCH' });
  registry.register(exec('s1'), binding);
  assert.equal(registry.assert(exec('s1'), 'image', binding).projectId, 'p1');
  assert.throws(() => registry.assert(exec('s2'), 'image', binding), { code: 'SESSION_BINDING_REQUIRED' });
  assert.throws(() => registry.assert(exec('s1'), 'image', { instanceId: 'i1' }), { code: 'SESSION_BINDING_MISMATCH' });
  assert.throws(() => registry.assert(exec('s1'), 'video', binding), { code: 'SESSION_BINDING_MISMATCH' });
  page = { pageId: 'page2', sessionId: 's1' };
  assert.throws(() => registry.assert(exec('s1'), 'image', binding), { code: 'SESSION_BINDING_STALE' });
  page.pageId = 'page1';
  assert.throws(() => registry.assert(exec('s1'), 'image', binding), { code: 'SESSION_BINDING_STALE' });
});

test('unwired production registration fails closed; no tool reaches editor without identity/binding', async () => {
  assert.throws(() => createSessionBindings().register(exec('s1'), binding), { code: 'SESSION_BINDING_UNAVAILABLE' });
  const tools = new Map(); let calls = 0;
  const bridge = { readState: async () => { calls++; throw new Error('must not reach'); } };
  registerMediaTools({ tools: { register: d => tools.set(d.name, d) } }, { bridge: bridge, approvals: createApprovalStore() });
  for (const [name, tool] of tools) {
    const kind = name.includes('image') ? 'image' : 'video';
    const args = { editorKind: kind, projectId: 'p1', instanceId: 'i1', commandId: 'c1', expectedRevision: 0, operation: kind === 'image' ? 'history.undo' : 'media.video.history.undo', params: {}, format: kind === 'image' ? 'png' : 'webm', exportId: 'x1' };
    // 生成工具不碰工程，没有会话绑定可查；它的 fail-closed 是"没配后端就拒绝"，
    // 与编辑器工具的 SESSION_* 是两回事，分开断言而不是放宽循环。
    if (name === 'media_image_generate') {
      const generated = await tool.execute({ editorKind: 'image' }, exec('s1'));
      assert.equal(generated.status, 'rejected');
      assert.equal(generated.error.code, 'PROVIDER_UNAVAILABLE');
      continue;
    }
    for (const context of [{}, exec('s1')]) {
      const result = await tool.execute(args, context);
      assert.equal(result.status, 'rejected');
      assert.match(result.error.code, /^SESSION_(IDENTITY_REQUIRED|BINDING_REQUIRED)$/);
    }
  }
  assert.equal(calls, 0);
});

test('first batch commands validate the exact image contract', () => {
  for (const [type, payload] of [['history.undo', {}], ['history.redo', {}], ['history.undo', { targetCommandId: 'c1', afterDigest: 'd1' }], ['canvas.resize', { width: 500, height: 400 }], ['canvas.crop', { x: 1, y: 2, width: 300, height: 200 }], ['layer.remove', { layerId: 'l1' }], ['layer.set_transform', { layerId: 'l1', x: 3, scaleX: 2 }]]) COMMAND_VALIDATORS.image({ type, payload });
  for (const [type, payload] of [['history.undo', { targetCommandId: 'c1' }], ['canvas.crop', { x: -1, y: 0, width: 1, height: 2 }], ['canvas.resize', { width: 0, height: 5 }], ['layer.set_transform', { layerId: 'l1', transform: { x: 1 } }]]) assert.throws(() => COMMAND_VALIDATORS.image({ type, payload }), { code: 'INVALID_REQUEST' });
});
