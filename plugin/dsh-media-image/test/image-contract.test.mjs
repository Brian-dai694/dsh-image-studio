// Contract tests for the image editor: pre-validation of layer.add_text, tolerance for
// the legacy changedLayerIds field, and — most important — never reporting a write that
// advanced the revision as a clean `rejected`.
import test from 'node:test';
import { fixtureBindings } from './host-fixture.mjs';
import assert from 'node:assert/strict';
import { createMediaBridge, COMMAND_VALIDATORS } from '../lib/bridge.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore, HIGH_RISK_OPERATIONS } from '../lib/gate.js';

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

const imageCmd = (type, payload) => COMMAND_VALIDATORS.image({ type, payload });

test('placement/blend/color commands validate exact field domains', () => {
  const tinyPng = 'data:image/png;base64,iVBORw0KGgo=';
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: 'asset:asset-1' }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: 'layer:l0' }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: tinyPng }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: 'asset:asset-1', x: 0, y: 0, width: 800, height: 600, fit: 'contain', name: '前景' }));
  assert.throws(() => imageCmd('layer.add_image', { x: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: 'https://example.com/a.png' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: 'data:image/svg+xml;base64,PHN2Zz4=' }), { code: 'INVALID_REQUEST' });
  // 解码后超过 256 KB 的内联图必须在 Host 侧拒绝，而不是塞给编辑器。
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: `data:image/png;base64,${'A'.repeat(400000)}` }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: 'asset:asset-1', width: 800 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: 'asset:asset-1', width: 0, height: 10 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: 'asset:asset-1', fit: 'fill' }), { code: 'INVALID_REQUEST' });

  assert.doesNotThrow(() => imageCmd('layer.set_frame', { layerId: 'l1', width: 10, height: 10 }));
  assert.throws(() => imageCmd('layer.set_frame', { layerId: 'l1' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_frame', { layerId: 'l1', width: 10 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_frame', { layerId: 'l1', anchor: 'bottom' }), { code: 'INVALID_REQUEST' });

  assert.doesNotThrow(() => imageCmd('layer.feather', { layerId: 'l1', radiusPx: 8 }));
  for (const radiusPx of [0, 65, 1.5]) assert.throws(() => imageCmd('layer.feather', { layerId: 'l1', radiusPx }), { code: 'INVALID_REQUEST' });

  assert.doesNotThrow(() => imageCmd('layer.color_match', { layerId: 'l1', method: 'reinhard' }));
  assert.doesNotThrow(() => imageCmd('layer.color_match', { layerId: 'l1', method: 'reinhard', strength: 0.5, reference: 'below' }));
  assert.doesNotThrow(() => imageCmd('layer.color_match', { layerId: 'l1', method: 'reinhard', reference: { x: 0, y: 0, width: 10, height: 10 } }));
  assert.throws(() => imageCmd('layer.color_match', { layerId: 'l1', method: 'histogram' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.color_match', { layerId: 'l1', method: 'reinhard', strength: 1.2 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.color_match', { layerId: 'l1', method: 'reinhard', reference: { x: 0, y: 0, width: 10 } }), { code: 'INVALID_REQUEST' });

  // drop_shadow 本轮不做：必须连白名单都进不去，否则模型会发出无法实现的命令。
  assert.throws(() => imageCmd('layer.drop_shadow', { layerId: 'l1', offsetX: 4, offsetY: 6, blurPx: 12, color: '#000000', opacity: 0.4 }), { code: 'UNSUPPORTED_COMMAND' });
});

test('layer.add_image is human-confirmed and read_state keeps placement metadata', async () => {
  assert.equal(HIGH_RISK_OPERATIONS.image.has('layer.add_image'), true);
  const layer = { id: 'l1', type: 'image', sourceRef: 'asset:asset-1', frame: { x: 1, y: 2, width: 8, height: 9 }, hasAlpha: true, maskSource: 'alpha', feather: { radiusPx: 8, fromDigest: 'd0' }, colorMatch: { applied: true, strength: 1, fromDigest: 'd0' } };
  const relay = { request: async message => message.type === 'editor.read_state'
    ? { ...imageState(3), layers: [layer], assets: [{ id: 'asset-1', name: '前景.png', width: 8, height: 9, bytes: 1234, mime: 'image/png' }] }
    : { documentId: 'doc-1', revision: 4, commandId: message.commandId, changedObjectIds: ['l1'] } };
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } }, {
    bridge: createMediaBridge({ relay, editorKind: 'image' }),
    approvals: createApprovalStore(), bindings: fixtureBindings,
  });
  const read = tools.get('media_image_read_state');
  const args = { projectId: 'doc-1', instanceId: 'e1' };
  const value = await read.execute(args, { agent: { id: 'a' } });
  const text = read.output.render(args, value).map(block => block.text).join('\n');
  assert.match(text, /asset:asset-1/);
  assert.match(text, /"maskSource":"alpha"/);
  assert.match(text, /"fromDigest":"d0"/);
  assert.match(text, /"hasAlpha":true/);
  assert.match(text, /"name":"前景.png"/);
  // 素材只暴露元数据，像素/快照内容绝不能出现在模型可见文本里。
  assert.doesNotMatch(text, /base64|_dshBaseSnapshot|data:image/);
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
