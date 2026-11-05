// The model only sees the render text, never the canonical value, so read_state must
// surface projectId / stateDigest / revision / undo state, and writes must work when
// projectId is omitted (resolved from the instance's current document).
import test from 'node:test';
import { fixtureBindings } from './host-fixture.mjs';
import assert from 'node:assert/strict';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';

const state = kind => ({
  editorKind: kind,
  editorInstanceId: kind === 'image' ? 'e1' : 'v1',
  documentId: 'doc-123',
  revision: 7,
  stateDigest: 'fnv1a32-deadbeef',
  canvas: { width: 640, height: 480 },
  layers: [],
  timeline: { duration: 4.18, fps: 30, currentTime: 0 },
  tracks: [{ id: 't', kind: 'video', clips: [] }],
  clips: [],
  overlays: [],
  history: { canUndo: true, canRedo: false },
  capabilities: { webm: true, mp4: 'unknown' },
});

function makeTools() {
  const tools = new Map();
  const calls = [];
  const bridge = kind => ({
    editorKind: kind,
    readState: async () => state(kind),
    applyCommand: async input => { calls.push({ kind, op: 'apply', input }); return { editorKind: kind, documentId: input.projectId, commandId: input.commandId, revision: 8, changedObjectIds: [], stateDigest: 'fnv1a32-next', history: { canUndo: true, canRedo: false } }; },
    getCommandResult: async () => ({ status: 'unknown', originalResult: null }),
    startExport: async input => { calls.push({ kind, op: 'export', input }); return { editorKind: kind, commandId: input.commandId, exportId: 'exp-9', status: 'ready', artifactRef: 'artifact://exp-9', stateDigest: 'fnv1a32-next' }; },
    getExportStatus: async () => ({ editorKind: kind, exportId: 'exp-9', status: 'ready', artifactRef: 'artifact://exp-9' }),
  });
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } }, {
    bridge: bridge('image'), approvals: createApprovalStore(), bindings: fixtureBindings,
  });
  return { tools, calls };
}

test('read_state render exposes projectId, digest, revision and undo state', async () => {
  const { tools } = makeTools();
  for (const name of ['media_image_read_state']) {
    const definition = tools.get(name);
    const args = { projectId: 'doc-123', instanceId: name.includes('image') ? 'e1' : 'v1' };
    const value = await definition.execute(args, { agent: { id: 'a' } });
    const text = definition.output.render(args, value).map(block => block.text).join('\n');
    assert.match(text, /doc-123/, `${name}: missing projectId`);
    assert.match(text, /fnv1a32-deadbeef/, `${name}: missing stateDigest`);
    assert.match(text, /R7/, `${name}: missing revision`);
    assert.match(text, /undo yes/, `${name}: missing undo state`);
    assert.match(text, /redo no/, `${name}: missing redo state`);
  }
});

test('apply_command uses the explicit bound projectId', async () => {
  const { tools, calls } = makeTools();
  for (const [name, kind] of [['media_image_apply_command', 'image']]) {
    const definition = tools.get(name);
    const args = {
      editorKind: kind, projectId: 'doc-123', instanceId: kind === 'image' ? 'e1' : 'v1', commandId: `c-${kind}`, expectedRevision: 7,
      operation: kind === 'image' ? 'layer.update_text' : 'media.video.clip.move', params: {},
    };
    const value = await definition.execute(args, { agent: { id: 'a' } });
    assert.equal(value.status, 'applied', `${name}: ${JSON.stringify(value)}`);
    assert.equal(value.projectId, 'doc-123', `${name}: projectId must be resolved`);
    const call = calls.find(entry => entry.kind === kind && entry.op === 'apply');
    assert.equal(call.input.projectId, 'doc-123', `${name}: bridge must receive the resolved document`);
  }
});

test('export_start uses explicit projectId and records the revision', async () => {
  const { tools, calls } = makeTools();
  const definition = tools.get('media_image_export_start');
  const args = { editorKind: 'image', projectId: 'doc-123', instanceId: 'e1', commandId: 'exp-1', expectedRevision: 7, format: 'png' };
  const value = await definition.execute(args, { agent: { id: 'a' } });
  assert.equal(value.status, 'applied');
  assert.equal(value.projectId, 'doc-123');
  assert.equal(value.stateDigest, 'fnv1a32-deadbeef');
  const call = calls.find(entry => entry.op === 'export');
  assert.equal(call.input.projectId, 'doc-123');
});

test('duplicate tool invocation returns first outcome without replay', async () => {
  const { tools, calls } = makeTools();
  const tool = tools.get('media_image_apply_command');
  const args = { editorKind: 'image', projectId: 'doc-123', instanceId: 'e1', commandId: 'dedupe', expectedRevision: 7, operation: 'layer.update_text', params: {} };
  const first = await tool.execute(args, { agent: { id: 'a' } });
  const second = await tool.execute(args, { agent: { id: 'a' } });
  assert.deepEqual(second, first);
  assert.equal(calls.filter(call => call.op === 'apply').length, 1);
  const reused = await tool.execute({ ...args, params: { text: 'different' } }, { agent: { id: 'a' } });
  assert.equal(reused.error.code, 'COMMAND_ID_REUSED');
});

test('an explicit projectId still must match the live document', async () => {
  const { tools } = makeTools();
  const definition = tools.get('media_image_read_state');
  const value = await definition.execute({ instanceId: 'v1', projectId: 'other-doc' }, { agent: { id: 'a' } });
  // the fake bridge ignores projectId; the real bridge raises DOCUMENT_MISMATCH, which
  // surfaces as a rejected envelope, so assert the envelope shape here.
  assert.equal(value.status, 'rejected');
  assert.equal(value.error.code, 'DOCUMENT_MISMATCH');
});
