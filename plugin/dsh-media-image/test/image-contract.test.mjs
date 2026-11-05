// Contract tests for the image editor: pre-validation of layer.add_text, tolerance for
// the legacy changedLayerIds field, and — most important — never reporting a write that
// advanced the revision as a clean `rejected`.
import test from 'node:test';
import { fixtureBindings } from './host-fixture.mjs';
import assert from 'node:assert/strict';
import { createMediaBridge } from '../lib/bridge.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';

const imageState = revision => ({
  editorKind: 'image', editorInstanceId: 'e1', documentId: 'doc-1', revision, stateDigest: `fnv1a64-${revision}`,
  canvas: { width: 337, height: 390 }, layers: [], history: { canUndo: revision > 0, canRedo: false },
});

function relayFor(handler) {
  const messages = [];
  return { messages, relay: { request: async message => { messages.push(message); return handler(message); } } };
}

test('layer.add_text accepts omitted x/y (editor centers) and rejects a half-specified point', async () => {
  const { relay, messages } = relayFor(message => message.type === 'editor.apply_command'
    ? { editorKind: 'image', documentId: 'doc-1', commandId: message.commandId, revision: 1, changedObjectIds: ['layer-1'] }
    : imageState(1));
  const bridge = createMediaBridge({ relay, editorKind: 'image' });
  const base = { instanceId: 'e1', projectId: 'doc-1', expectedRevision: 0, command: { type: 'layer.add_text', payload: { text: 'hi' } } };
  const applied = await bridge.applyCommand({ ...base, commandId: 'c-center' });
  assert.equal(applied.revision, 1);
  assert.equal(messages.filter(m => m.type === 'editor.apply_command').length, 1);

  await assert.rejects(bridge.applyCommand({ ...base, commandId: 'c-half', command: { type: 'layer.add_text', payload: { text: 'hi', x: 10 } } }), { code: 'INVALID_REQUEST' });
  await assert.rejects(bridge.applyCommand({ ...base, commandId: 'c-nan', command: { type: 'layer.add_text', payload: { text: 'hi', x: 'left', y: 2 } } }), { code: 'INVALID_REQUEST' });
  assert.equal(messages.filter(m => m.type === 'editor.apply_command').length, 1);
});

test('a mutation result using the legacy changedLayerIds field still counts as applied', async () => {
  const { relay } = relayFor(message => message.type === 'editor.apply_command'
    ? { editorKind: 'image', documentId: 'doc-1', commandId: message.commandId, revision: 1, changedLayerIds: ['layer-9'] }
    : imageState(1));
  const bridge = createMediaBridge({ relay, editorKind: 'image' });
  const result = await bridge.applyCommand({ instanceId: 'e1', projectId: 'doc-1', commandId: 'c1', expectedRevision: 0, command: { type: 'layer.add_text', payload: { text: 'hi', x: 10, y: 20 } } });
  assert.equal(result.revision, 1);
  assert.deepEqual(result.changedObjectIds, ['layer-9']);
});

test('a written revision with a broken result shape surfaces as unknown, not rejected', async () => {
  const { tools, calls } = (() => {
    const calls = [];
    const relay = { request: async message => {
      if (message.type === 'editor.read_state') return imageState(0);
      calls.push(message);
      return { documentId: 'doc-1', revision: 1, commandId: message.commandId }; // revision advanced, no changed ids
    } };
    const tools = new Map();
    const bridge = createMediaBridge({ relay, editorKind: 'image' });
    registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } }, {
      bridge: bridge, approvals: createApprovalStore(), bindings: fixtureBindings,
    });
    return { tools, calls };
  })();
  const definition = tools.get('media_image_apply_command');
  const value = await definition.execute({
    editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', commandId: 'risky-1', expectedRevision: 0,
    operation: 'layer.add_text', params: { text: 'hi', x: 1, y: 2 },
  }, { agent: { id: 'a' } });
  assert.equal(value.status, 'unknown', JSON.stringify(value));
  assert.equal(value.error.code, 'EDITOR_RESULT_INVALID_OUTCOME_UNKNOWN');
  assert.equal(value.error.retryable, false);
});

test('after an unknown outcome the same commandId is not replayed', async () => {
  let writes = 0;
  const relay = { request: async message => {
    if (message.type === 'editor.read_state') return imageState(0);
    writes += 1;
    return { documentId: 'doc-1', revision: 1, commandId: message.commandId };
  } };
  const bridge = createMediaBridge({ relay, editorKind: 'image' });
  const input = { instanceId: 'e1', projectId: 'doc-1', commandId: 'risky-2', expectedRevision: 0, command: { type: 'layer.add_text', payload: { text: 'hi', x: 1, y: 2 } } };
  await assert.rejects(bridge.applyCommand(input), { code: 'EDITOR_RESULT_INVALID_OUTCOME_UNKNOWN' });
  await assert.rejects(bridge.applyCommand(input), { code: 'EDITOR_RESULT_INVALID_OUTCOME_UNKNOWN' });
  assert.equal(writes, 1);
});

test('a genuinely failed write that did not advance the revision stays rejected', async () => {
  const relay = { request: async message => {
    if (message.type === 'editor.read_state') return imageState(0);
    return { documentId: 'doc-1', revision: 0, commandId: message.commandId };
  } };
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } }, {
    bridge: createMediaBridge({ relay }),
    approvals: createApprovalStore(), bindings: fixtureBindings,
  });
  const value = await tools.get('media_image_apply_command').execute({
    editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', commandId: 'c-fail', expectedRevision: 0,
    operation: 'layer.add_text', params: { text: 'hi', x: 1, y: 2 },
  }, { agent: { id: 'a' } });
  assert.equal(value.status, 'rejected');
  assert.equal(value.error.code, 'EDITOR_ERROR');
});
