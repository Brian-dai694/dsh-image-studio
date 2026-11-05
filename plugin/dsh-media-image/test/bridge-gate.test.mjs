// Adapter and gate semantics without a browser: revision conflict, idempotency,
// unknown-outcome non-replay, approval binding TTL/single-use/session binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaBridge } from '../lib/bridge.js';
import { createApprovalStore, digestOf, createGuard } from '../lib/gate.js';

const imageState = revision => ({
  editorKind: 'image',
  editorInstanceId: 'i1',
  documentId: 'p1',
  revision,
  stateDigest: `digest-${revision}`,
  canvas: { width: 640, height: 480 },
  layers: [],
  history: { canUndo: revision > 0, canRedo: false },
});

function makeRelay(handler) {
  const messages = [];
  return { messages, relay: { request: async message => { messages.push(message); return handler(message); } } };
}

test('read_state rejects a mismatched project and a non-image payload', async () => {
  const { relay } = makeRelay(() => imageState(0));
  const bridge = createMediaBridge({ relay, editorKind: 'image' });
  assert.equal((await bridge.readState({ instanceId: 'i1' })).revision, 0);
  await assert.rejects(bridge.readState({ instanceId: 'i1', projectId: 'other' }), { code: 'DOCUMENT_MISMATCH' });
  const bad = createMediaBridge({ relay: { request: async () => ({ ...imageState(0), editorKind: 'video' }) }, editorKind: 'image' });
  await assert.rejects(bad.readState({ instanceId: 'i1' }), { code: 'EDITOR_ERROR' });
});

test('editor-enforced revision conflict propagates and is not cached as applied', async () => {
  let writes = 0;
  const { relay } = makeRelay(message => {
    if (message.type === 'editor.read_state') return imageState(3);
    writes += 1;
    throw Object.assign(new Error('stale'), { code: 'REVISION_CONFLICT', revision: 3 });
  });
  const bridge = createMediaBridge({ relay, editorKind: 'image' });
  const input = { instanceId: 'i1', projectId: 'p1', commandId: 'c1', expectedRevision: 2, command: { type: 'layer.update_text', payload: { layerId: 'l1', text: 'x' } } };
  await assert.rejects(bridge.applyCommand(input), { code: 'REVISION_CONFLICT', revision: 3 });
  assert.equal(writes, 1);
  await assert.rejects(bridge.applyCommand(input), { code: 'REVISION_CONFLICT' });
  assert.equal(writes, 2);
});

test('duplicate commandId coalesces and returns the audited outcome once', async () => {
  let writes = 0;
  let revision = 1;
  const { relay } = makeRelay(message => {
    if (message.type === 'editor.read_state') return imageState(revision);
    writes += 1;
    revision += 1;
    return { editorKind: 'image', documentId: 'p1', commandId: message.commandId, revision, changedObjectIds: ['l1'] };
  });
  const bridge = createMediaBridge({ relay, editorKind: 'image' });
  const input = { instanceId: 'i1', projectId: 'p1', commandId: 'c9', expectedRevision: 1, command: { type: 'layer.update_text', payload: { layerId: 'l1', text: 'x' } } };
  const [first, second] = await Promise.all([bridge.applyCommand(input), bridge.applyCommand(input)]);
  assert.equal(writes, 1);
  assert.equal(first.revision, 2);
  assert.equal(first.stateDigest, 'digest-2');
  assert.deepEqual(first.history, { canUndo: true, canRedo: false });
  assert.equal(second.revision, 2);
  const third = await bridge.applyCommand(input);
  assert.equal(third.revision, 2);
  assert.equal(writes, 1);
});

test('a timed-out write blocks replay until the original commandId is queried', async () => {
  const { relay, messages } = makeRelay(message => {
    if (message.type === 'editor.apply_command') return new Promise(() => {});
    return { status: 'unknown', originalResult: null };
  });
  const bridge = createMediaBridge({ relay, editorKind: 'image', timeoutMs: 10 });
  const input = { instanceId: 'i1', projectId: 'p1', commandId: 'c7', expectedRevision: 0, command: { type: 'layer.update_text', payload: { layerId: 'l1', text: 'x' } } };
  await assert.rejects(bridge.applyCommand(input), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  await assert.rejects(bridge.applyCommand(input), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' });
  assert.equal(messages.filter(m => m.type === 'editor.apply_command').length, 1);
  const queried = await bridge.getCommandResult({ instanceId: 'i1', commandId: 'c7' });
  assert.equal(queried.status, 'unknown');
});

test('post-write audit mismatch remains unknown and blocks replay', async () => {
  let writes = 0;
  const bridge = createMediaBridge({ editorKind: 'image', relay: { request: async message => {
    if (message.type === 'editor.read_state') return imageState(3);
    writes++;
    return { editorKind: 'image', documentId: 'p1', commandId: message.commandId, revision: 2, changedObjectIds: [] };
  } } });
  const input = { instanceId: 'i1', projectId: 'p1', commandId: 'audit-mismatch', expectedRevision: 1, command: { type: 'history.undo', payload: {} } };
  await assert.rejects(bridge.applyCommand(input), { code: 'EDITOR_AUDIT_OUTCOME_UNKNOWN', outcomeUnknown: true });
  await assert.rejects(bridge.applyCommand(input), { code: 'EDITOR_AUDIT_OUTCOME_UNKNOWN' });
  assert.equal(writes, 1);
});

test('approval store binds session, project, operation, params, revision and digest', () => {
  const store = createApprovalStore({ ttlMs: 1000, now: () => 0 });
  const binding = { agentId: 'agent-a', projectId: 'p1', commandId: 'c1', operation: 'layer.remove', paramsDigest: digestOf({ layerId: 'x' }), revision: 2, stateDigest: 'digest-2' };
  const { record } = store.issue(binding);
  const reused = store.issue(binding);
  assert.equal(reused.reused, true);
  assert.equal(reused.record.approvalId, record.approvalId);
  assert.equal(store.take({ ...binding, approvalId: record.approvalId, agentId: 'agent-b' }).code, 'APPROVAL_MISMATCH');
  assert.equal(store.take({ ...binding, approvalId: record.approvalId }).code, 'APPROVAL_CONSUMED');
  const fresh = store.issue({ ...binding, commandId: 'c2' }).record;
  assert.equal(store.take({ ...binding, commandId: 'c2', approvalId: fresh.approvalId, revision: 3 }).code, 'REVISION_CONFLICT');
});

test('approval store expires and rejects unknown ids', () => {
  let clock = 0;
  const store = createApprovalStore({ ttlMs: 100, now: () => clock });
  const binding = { agentId: 'a', projectId: 'p', commandId: 'c', operation: 'layer.remove', paramsDigest: 'd', revision: 0, stateDigest: 's' };
  const { record } = store.issue(binding);
  clock = 101;
  assert.equal(store.take({ ...binding, approvalId: record.approvalId }).code, 'APPROVAL_EXPIRED');
  assert.equal(store.take({ ...binding, approvalId: 'nope' }).code, 'APPROVAL_NOT_FOUND');
});

test('guard is synchronous and only denies', () => {
  const guard = createGuard();
  assert.equal(guard({ name: 'media_image_read_state', arguments: { editorKind: 'image' } }), undefined);
  assert.match(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation: 'canvas.crop', mode: 'autonomous' } }), /not authorized/);
  assert.equal(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation: 'layer.update_text', mode: 'autonomous' } }), undefined);
  assert.match(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'video' } }), /targets the image editor/);
  assert.match(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation: 'media.video.clip.move' } }), /layer.* operations/);
});
