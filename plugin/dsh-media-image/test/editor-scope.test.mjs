// The image package is image-only: its tools, schemas, adapter and relay must not
// accept video operations or kind, and every registered tool belongs to this editor family.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { TOOL_KINDS } from '../lib/gate.js';
import { createMediaBridge } from '../lib/bridge.js';
import { createEditorRelay } from '../lib/relay.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

const exec = { agent: { id: 's1', session: { id: 's1' } } };

function makeContext() {
  const tools = new Map();
  const guards = [];
  const ctx = {
    tools: {
      register: definition => { tools.set(definition.name, definition); return () => {}; },
      guard: guard => { guards.push(guard); return () => {}; },
    },
    webServer: { register: () => () => {} },
    approval: { request: async () => 'allowed-once' },
    effect: (factory) => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  return { ctx, tools, guards };
}

test('every registered tool and metric kind belongs to the image editor', () => {
  const { ctx, tools } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/image-scope' });
  assert.equal(tools.size, 7);
  for (const name of tools.keys()) assert.match(name, /^media_image_/);
  assert.deepEqual([...new Set(Object.values(TOOL_KINDS))], ['image']);
  for (const definition of tools.values()) {
    assert.deepEqual(definition.parameters.properties.editorKind.enum, ['image']);
  }
  assert.deepEqual(tools.get('media_image_export_start').parameters.properties.format.enum, ['png', 'jpeg']);
});

test('the guard accepts only image operations and still denies video ones', () => {
  const { ctx, guards } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/image-scope' });
  const guard = guards[0];
  const check = operation => guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation } });
  for (const operation of ['layer.add_image', 'layer.add_text', 'layer.update_text', 'layer.set_appearance', 'layer.remove', 'canvas.resize', 'canvas.crop', 'history.undo', 'history.redo']) assert.equal(check(operation), undefined, operation);
  for (const operation of ['media.video.clip.move', 'media.video.history.undo', 'media.video.overlay.add', 'overlay.add', 'clip.trim']) assert.match(check(operation), /layer\.\* operations/, operation);
  assert.match(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'video', operation: 'media.video.clip.move' } }), /targets the image editor/);
});

test('the relay defaults to the image kind and still refuses the video kind', () => {
  const relay = createEditorRelay();
  const page = relay.register({ editorInstanceId: 'default-kind' });
  assert.equal(page.kind, 'image');
  assert.equal(relay.getPage('default-kind').kind, 'image');
  relay.close();
  assert.throws(() => createEditorRelay({ editorKind: 'video' }), { name: 'TypeError' });
});

test('the bridge defaults to the image kind and still refuses the video kind', () => {
  const bridge = createMediaBridge({ relay: { request: async () => ({}) } });
  assert.equal(bridge.editorKind, 'image');
  assert.throws(() => createMediaBridge({ relay: { request: async () => ({}) }, editorKind: 'video' }), { name: 'TypeError' });
});

test('export renders carry the exportId/artifactRef the model needs; writes stay compact', async () => {
  const tools = new Map();
  const bridge = {
    editorKind: 'image',
    readState: async () => ({ editorKind: 'image', editorInstanceId: 'i1', documentId: 'p1', revision: 2, stateDigest: 'd2', canvas: { width: 10, height: 10 }, layers: [] }),
    applyCommand: async input => ({ editorKind: 'image', documentId: 'p1', commandId: input.commandId, revision: 3, changedObjectIds: [], stateDigest: 'd3', afterDigest: 'd3' }),
    startExport: async input => ({ editorKind: 'image', commandId: input.commandId, exportId: 'exp-1', status: 'ready', artifactRef: 'artifact://exp-1' }),
    getExportStatus: async () => ({ editorKind: 'image', exportId: 'exp-1', status: 'ready', artifactRef: 'artifact://exp-1' }),
  };
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition), guard: () => {} } }, { bridge, approvals: createApprovalStore(), bindings: fixtureBindings });
  const render = (name, args, value) => tools.get(name).output.render(args, value).map(block => block.text).join('\n');
  const startArgs = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'e-1', expectedRevision: 2, format: 'png' };
  assert.match(render('media_image_export_start', startArgs, await tools.get('media_image_export_start').execute(startArgs, exec)), /exportId exp-1/);
  const statusArgs = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', exportId: 'exp-1' };
  assert.match(render('media_image_export_status', statusArgs, await tools.get('media_image_export_status').execute(statusArgs, exec)), /artifactRef artifact:\/\/exp-1/);
  const applyArgs = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'c-plain', expectedRevision: 2, operation: 'layer.update_text', params: {} };
  const applyText = render('media_image_apply_command', applyArgs, await tools.get('media_image_apply_command').execute(applyArgs, exec));
  assert.doesNotMatch(applyText, /exportId|artifactRef/);
});

test('tool meta carries structured credentials so panels never parse the text line', async () => {
  const tools = new Map();
  const bridge = {
    editorKind: 'image',
    readState: async () => ({ editorKind: 'image', editorInstanceId: 'i1', documentId: 'p1', revision: 2, stateDigest: 'd2', canvas: { width: 10, height: 10 }, layers: [] }),
    applyCommand: async input => ({ editorKind: 'image', documentId: 'p1', commandId: input.commandId, revision: 3, changedObjectIds: [], stateDigest: 'd3', afterDigest: 'd3' }),
    startExport: async input => ({ editorKind: 'image', commandId: input.commandId, exportId: 'exp-1', status: 'ready', artifactRef: 'artifact://exp-1' }),
    getExportStatus: async () => ({ editorKind: 'image', exportId: 'exp-1', status: 'ready', artifactRef: 'artifact://exp-1' }),
  };
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition), guard: () => {} } }, { bridge, approvals: createApprovalStore(), bindings: fixtureBindings });
  const meta = (name, args, value) => tools.get(name).output.presentationMeta(args, value);
  const startArgs = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'e-1', expectedRevision: 2, format: 'png' };
  const startMeta = meta('media_image_export_start', startArgs, await tools.get('media_image_export_start').execute(startArgs, exec));
  assert.equal(startMeta.commandId, 'e-1');
  assert.equal(startMeta.exportId, 'exp-1');
  assert.equal(startMeta.artifactRef, 'artifact://exp-1');
  assert.equal(startMeta.format, 'png');
  const applyArgs = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'c-meta', expectedRevision: 2, operation: 'layer.update_text', params: {} };
  const applied = await tools.get('media_image_apply_command').execute(applyArgs, exec);
  const applyMeta = meta('media_image_apply_command', applyArgs, applied);
  assert.equal(applyMeta.commandId, 'c-meta');
  assert.equal(applyMeta.appliedRevision, 3);
  assert.equal(applyMeta.afterDigest, 'd3');
  // 文本行格式保持不变，面板改读 meta。
  assert.equal(tools.get('media_image_apply_command').output.render(applyArgs, applied).map(block => block.text).join('\n'), 'applied · c-meta · R3');
  const staleArgs = { ...applyArgs, commandId: 'c-stale', expectedRevision: 1 };
  const stale = await tools.get('media_image_apply_command').execute(staleArgs, exec);
  assert.equal(stale.status, 'rejected');
  assert.equal(meta('media_image_apply_command', staleArgs, stale).errorCode, 'REVISION_CONFLICT');
});

test('meta.changedObjectIds reports exactly the edited objects, including undo', async () => {
  const tools = new Map();
  const bridge = {
    editorKind: 'image',
    readState: async () => ({ editorKind: 'image', editorInstanceId: 'i1', documentId: 'p1', revision: 2, stateDigest: 'd2', canvas: { width: 10, height: 10 }, layers: [] }),
    applyCommand: async input => {
      const base = { editorKind: 'image', documentId: 'p1', commandId: input.commandId, revision: 3, stateDigest: 'd3', afterDigest: 'd3' };
      if (input.command.type === 'layer.update_text') return { ...base, changedObjectIds: ['obj-1'] };
      if (input.command.type === 'media.video.history.undo' || input.command.type === 'history.undo') return { ...base, changedObjectIds: ['obj-2'], objectKind: 'layer' };
      return { ...base, changedObjectIds: [] };
    },
  };
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition), guard: () => {} } }, { bridge, approvals: createApprovalStore(), bindings: fixtureBindings });
  const meta = (args, value) => tools.get('media_image_apply_command').output.presentationMeta(args, value);
  const writeArgs = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'c-w', expectedRevision: 2, operation: 'layer.update_text', params: {} };
  const written = await tools.get('media_image_apply_command').execute(writeArgs, exec);
  const writeMeta = meta(writeArgs, written);
  assert.deepEqual(writeMeta.changedObjectIds, ['obj-1']);
  assert.equal(writeMeta.objectKind, 'layer');
  assert.equal(writeMeta.changedObjectIds.includes('obj-2'), false);
  const undoArgs = { ...writeArgs, commandId: 'c-u', operation: 'history.undo', params: {} };
  const undone = await tools.get('media_image_apply_command').execute(undoArgs, exec);
  const undoMeta = meta(undoArgs, undone);
  assert.deepEqual(undoMeta.changedObjectIds, ['obj-2']);
  assert.equal(undoMeta.objectKind, 'layer');
  const noopArgs = { ...writeArgs, commandId: 'c-n', operation: 'layer.set_visibility' };
  const noopMeta = meta(noopArgs, await tools.get('media_image_apply_command').execute(noopArgs, exec));
  assert.equal('changedObjectIds' in noopMeta, false, 'no empty array');
  // 与文本行/stateDigest 同源，不互相矛盾
  assert.equal(writeMeta.stateDigest, written.stateDigest);
  assert.match(tools.get('media_image_apply_command').output.render(writeArgs, written).map(block => block.text).join('\n'), /applied · c-w · R3/);
});
