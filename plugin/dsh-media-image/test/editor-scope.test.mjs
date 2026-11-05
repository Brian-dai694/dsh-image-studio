// The image package is image-only: its tools, schemas, adapter and relay must not
// accept video operations or kind, and every registered tool belongs to this editor family.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { TOOL_KINDS } from '../lib/gate.js';
import { createMediaBridge } from '../lib/bridge.js';
import { createEditorRelay } from '../lib/relay.js';

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
  assert.equal(tools.size, 5);
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
  for (const operation of ['layer.add_text', 'layer.update_text', 'layer.remove', 'canvas.resize', 'canvas.crop', 'history.undo', 'history.redo']) assert.equal(check(operation), undefined, operation);
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
