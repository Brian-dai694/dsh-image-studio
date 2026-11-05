// A write whose audit cannot confirm the document must surface as `unknown` at the
// tool layer too: never `rejected` (the write may have landed) and never cached as done.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaBridgeError } from '../lib/bridge.js';
import { createApprovalStore, createSessionBindings } from '../lib/gate.js';
import { registerMediaTools } from '../lib/tools.js';

const state = { documentId: 'p1', revision: 0, stateDigest: 'd0', editorKind: 'image', editorInstanceId: 'i1', canvas: { width: 10, height: 10 }, layers: [], history: { canUndo: false, canRedo: false } };
const exec = { agent: { id: 's1', session: { id: 's1' } }, callId: 'call-1' };

function register(bridge) {
  const tools = new Map();
  const bindings = createSessionBindings({ resolvePage: () => ({ pageId: 'page1' }) });
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition) }, approval: { request: async () => 'allowed-once' } }, { bridge: bridge, approvals: createApprovalStore(), bindings });
  return { tools, bindings };
}

test('an unverifiable post-write audit stays unknown and is never cached as applied', async () => {
  let writes = 0;
  const bridge = {
    getPage: () => ({ pageId: 'page1' }),
    readState: async () => state,
    applyCommand: async () => { writes += 1; throw new MediaBridgeError('EDITOR_AUDIT_OUTCOME_UNKNOWN', 'Mutation returned but audit could not verify it.', { outcomeUnknown: true }); },
  };
  const { tools, bindings } = register(bridge);
  await bindings.authorize(exec, { editorKind: 'image', instanceId: 'i1', projectId: 'p1', readState: async () => state, approve: async () => ({ allowed: true }) });
  const apply = tools.get('media_image_apply_command');
  const input = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'c1', expectedRevision: 0, operation: 'layer.update_text', params: { layerId: 'l1', text: 'x' } };
  const first = await apply.execute(input, exec);
  assert.equal(first.status, 'unknown');
  assert.equal(first.error.code, 'EDITOR_AUDIT_OUTCOME_UNKNOWN');
  assert.equal(first.error.retryable, false);
  const second = await apply.execute(input, exec);
  assert.equal(second.status, 'unknown');
  assert.notEqual(second.status, 'applied');
  assert.equal(writes, 2);
});

test('a plain timeout on a possibly-applied write is unknown and retryable only by query', async () => {
  const bridge = {
    getPage: () => ({ pageId: 'page1' }),
    readState: async () => state,
    applyCommand: async () => { throw new MediaBridgeError('EDITOR_TIMEOUT_OUTCOME_UNKNOWN', 'Editor did not answer in time.', { outcomeUnknown: true }); },
  };
  const { tools, bindings } = register(bridge);
  await bindings.authorize(exec, { editorKind: 'image', instanceId: 'i1', projectId: 'p1', readState: async () => state, approve: async () => ({ allowed: true }) });
  const result = await tools.get('media_image_apply_command').execute({ editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'c2', expectedRevision: 0, operation: 'layer.update_text', params: { layerId: 'l1', text: 'y' } }, exec);
  assert.equal(result.status, 'unknown');
  assert.equal(result.error.retryable, true);
});
