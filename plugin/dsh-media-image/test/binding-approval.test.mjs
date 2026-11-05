import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBindings, createApprovalStore } from '../lib/gate.js';
import { registerMediaTools } from '../lib/tools.js';
const exec = { agent: { id: 's1', session: { id: 's1' } }, callId: 'real-call' };
const args = { editorKind: 'image', instanceId: 'i1', projectId: 'p1' };
const state = { documentId: 'p1', revision: 0, stateDigest: 'd0' };
test('native approval grants exact tuple without a client-provided session identity', async () => {
  const registry = createSessionBindings({ resolvePage: () => ({ pageId: 'page1' }) });
  let reason;
  const grant = await registry.authorize(exec, { ...args, readState: async () => state, approve: async text => { reason = text; return { allowed: true }; } });
  assert.equal(grant.sessionId, 's1'); assert.ok(grant.grantId);
  assert.match(reason, /pageId=page1/); assert.match(reason, /documentId=p1/);
  assert.equal(registry.assert(exec, 'image', args).pageId, 'page1');
  await assert.rejects(registry.authorize(exec, { ...args }), { code: 'SESSION_BINDING_STALE' });
});
test('read_state bind path invokes native approval with real call identity before allowing later reads', async () => {
  for (const outcome of ['allowed-once', 'rejected', 'unavailable', 'cancelled']) {
    const tools = new Map(); const asks = [];
    const bridge = { getPage: () => ({ pageId: 'page1' }), readState: async () => ({ ...state, editorKind: 'image', editorInstanceId: 'i1', canvas: { width: 10, height: 10 }, layers: [] }) };
    registerMediaTools({ tools: { register: d => tools.set(d.name, d) }, approval: { request: async request => { asks.push(request); return outcome; } } }, { bridge: bridge, approvals: createApprovalStore() });
    const tool = tools.get('media_image_read_state');
    const first = await tool.execute({ instanceId: 'i1', projectId: 'p1', bind: true }, exec);
    assert.equal(asks.length, 1); assert.equal(asks[0].agent, exec.agent); assert.equal(asks[0].callId, 'real-call');
    assert.match(asks[0].reason, /instanceId=i1/);
    assert.equal(first.status, outcome === 'allowed-once' ? 'applied' : 'rejected');
    const later = await tool.execute({ instanceId: 'i1', projectId: 'p1' }, exec);
    assert.equal(later.status, outcome === 'allowed-once' ? 'applied' : 'rejected');
    assert.equal(asks.length, 1);
  }
});

test('denied native approval and changed snapshots never register a grant', async () => {
  for (const changed of [false, true]) {
    let reads = 0;
    const registry = createSessionBindings({ resolvePage: () => ({ pageId: 'page1' }) });
    await assert.rejects(registry.authorize(exec, { ...args, readState: async () => ({ ...state, revision: reads++ }), approve: async () => changed ? { allowed: true } : { allowed: false, code: 'APPROVAL_DENIED', message: 'denied' } }), { code: changed ? 'SESSION_BINDING_STALE' : 'APPROVAL_DENIED' });
    assert.throws(() => registry.assert(exec, 'image', args), { code: 'SESSION_BINDING_REQUIRED' });
  }
});
