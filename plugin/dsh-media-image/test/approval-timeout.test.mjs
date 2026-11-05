// Approval-wait semantics: the human decision is bounded, cancellation closes the
// pending approval, and neither a cancelled nor a late grant can register a binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_WAIT_MS, createApprovalStore, createSessionBindings, requestHumanApproval } from '../lib/gate.js';
import { registerMediaTools } from '../lib/tools.js';

const state = { documentId: 'p1', revision: 0, stateDigest: 'd0', editorKind: 'image', editorInstanceId: 'i1', canvas: { width: 10, height: 10 }, layers: [] };
const args = { editorKind: 'image', instanceId: 'i1', projectId: 'p1' };
const exec = signal => ({ agent: { id: 's1', session: { id: 's1' } }, callId: 'call-1', signal });

test('the approval wait is bounded, aborts the native request, and never accepts a late grant', async () => {
  let seen;
  let settle;
  const ctx = { approval: { request: request => { seen = request.signal; return new Promise(resolve => { settle = resolve; }); } } };
  const decision = await requestHumanApproval(ctx, { agent: {}, toolName: 't', callId: 'c', reason: 'r', timeoutMs: 20 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'APPROVAL_TIMEOUT');
  assert.equal(seen.aborted, true);
  // A grant arriving after the deadline resolves an already-abandoned request.
  settle('allowed-once');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(decision.allowed, false);
});

test('caller cancellation closes the pending approval and reports APPROVAL_CANCELLED', async () => {
  const controller = new AbortController();
  let seen;
  const ctx = { approval: { request: request => { seen = request.signal; return new Promise(resolve => request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })); } } };
  const pending = requestHumanApproval(ctx, { agent: {}, toolName: 't', callId: 'c', reason: 'r', signal: controller.signal });
  controller.abort();
  const decision = await pending;
  assert.equal(decision.code, 'APPROVAL_CANCELLED');
  assert.equal(seen.aborted, true);
});

test('a rejected native request is a denial, never an error to retry blindly', async () => {
  const ctx = { approval: { request: async () => 'rejected' } };
  assert.deepEqual(await requestHumanApproval(ctx, { agent: {}, toolName: 't', callId: 'c', reason: 'r' }), {
    allowed: false, code: 'APPROVAL_DENIED', message: 'Approval outcome was rejected.',
  });
  const failing = { approval: { request: async () => { throw new Error('boom'); } } };
  assert.equal((await requestHumanApproval(failing, { agent: {}, toolName: 't', callId: 'c', reason: 'r' })).code, 'APPROVAL_FAILED');
});

test('cancelling during the binding wait registers no grant and later writes stay blocked', async () => {
  const controller = new AbortController();
  const registry = createSessionBindings({ resolvePage: () => ({ pageId: 'page1' }) });
  await assert.rejects(registry.authorize(exec(controller.signal), {
    ...args,
    readState: async () => state,
    approve: async () => { controller.abort(); return { allowed: true }; },
  }), { code: 'APPROVAL_CANCELLED' });
  assert.throws(() => registry.assert(exec(controller.signal), 'image', args), { code: 'SESSION_BINDING_REQUIRED' });
});

test('an already-cancelled request asks for no approval at all', async () => {
  const controller = new AbortController();
  controller.abort();
  let asked = 0;
  const registry = createSessionBindings({ resolvePage: () => ({ pageId: 'page1' }) });
  await assert.rejects(registry.authorize(exec(controller.signal), {
    ...args,
    readState: async () => state,
    approve: async () => { asked += 1; return { allowed: true }; },
  }), { code: 'APPROVAL_CANCELLED' });
  assert.equal(asked, 0);
});

test('a binding invalidated during the wait never registers', async () => {
  const registry = createSessionBindings({ resolvePage: () => ({ pageId: 'page1' }) });
  await assert.rejects(registry.authorize(exec(), {
    ...args,
    readState: async () => state,
    approve: async () => { registry.invalidate('s1'); return { allowed: true }; },
  }), { code: 'SESSION_BINDING_STALE' });
  assert.throws(() => registry.assert(exec(), 'image', args), { code: 'SESSION_BINDING_STALE' });
});

test('a denied high-risk approval never reaches the editor', async () => {
  let writes = 0;
  const tools = new Map();
  const bridge = {
    getPage: () => ({ pageId: 'page1' }),
    readState: async () => state,
    applyCommand: async () => { writes += 1; return { revision: 1 }; },
  };
  const bindings = createSessionBindings({ resolvePage: () => ({ pageId: 'page1' }) });
  await bindings.authorize(exec(), { ...args, readState: async () => state, approve: async () => ({ allowed: true }) });
  const ctx = { tools: { register: definition => tools.set(definition.name, definition) }, approval: { request: async () => 'rejected' } };
  registerMediaTools(ctx, { bridge: bridge, approvals: createApprovalStore(), bindings });
  const apply = tools.get('media_image_apply_command');
  const pending = await apply.execute({ editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'c1', expectedRevision: 0, operation: 'layer.remove', params: { layerId: 'l1' } }, exec());
  assert.equal(pending.status, 'pending');
  assert.equal(pending.error.code, 'HUMAN_CONFIRMATION_REQUIRED');
  const denied = await apply.execute({ editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'c1', expectedRevision: 0, operation: 'layer.remove', params: { layerId: 'l1' }, approvalId: pending.approvalId }, exec());
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.error.code, 'APPROVAL_DENIED');
  assert.equal(writes, 0);
});

test('only calls that may wait for a human get the long budget; media calls stay short', () => {
  const tools = new Map();
  const bridge = { getPage: () => ({ pageId: 'page1' }), readState: async () => state, applyCommand: async () => ({ revision: 1 }), startExport: async () => ({ exportId: 'e1' }), getExportStatus: async () => ({ status: 'ready', exportId: 'e1' }) };
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition) }, approval: { request: async () => 'rejected' } }, { bridge: bridge, approvals: createApprovalStore() });
  for (const name of ['media_image_read_state', 'media_image_apply_command']) {
    assert.ok(tools.get(name).timeoutMs > APPROVAL_WAIT_MS, `${name} must exceed the approval wait`);
  }
  for (const name of ['media_image_get_command_result', 'media_image_export_start', 'media_image_export_status']) {
    assert.equal(tools.get(name).timeoutMs, 10_000, `${name} keeps the short media budget`);
  }
});
