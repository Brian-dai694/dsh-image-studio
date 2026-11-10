// Contract tests for the image editor: pre-validation of layer.add_text, tolerance for
// the legacy changedLayerIds field, and — most important — never reporting a write that
// advanced the revision as a clean `rejected`.
import test from 'node:test';
import { fixtureBindings } from './host-fixture.mjs';
import assert from 'node:assert/strict';
import { createMediaBridge, COMMAND_VALIDATORS, DSH_EFFECT_RANGES } from '../lib/bridge.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore, HIGH_RISK_OPERATIONS } from '../lib/gate.js';
import { readFileSync } from 'node:fs';

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
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: 'asset:' + 'a'.repeat(48) }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: 'layer:l0' }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: tinyPng }));
  const assetRef = 'asset:' + 'b'.repeat(48);
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: assetRef, x: 0, y: 0, width: 800, height: 600, fit: 'contain', name: '前景' }));
  assert.throws(() => imageCmd('layer.add_image', { x: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: 'https://example.com/a.png' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: 'data:image/svg+xml;base64,PHN2Zz4=' }), { code: 'INVALID_REQUEST' });
  // 解码后超过 256 KB 的内联图必须在 Host 侧拒绝，而不是塞给编辑器。
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: `data:image/png;base64,${'A'.repeat(400000)}` }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, width: 800 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, width: 0, height: 10 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, fit: 'fill' }), { code: 'INVALID_REQUEST' });

  // 蒙版：三种引用形态都可用；不带 maskRef 的附属参数必须拒绝，不能静默忽略。
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: 'layer:product' }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: assetRef, maskMode: 'luminance', maskInvert: true, featherPx: 8 }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: assetRef, maskMode: 'alpha', featherPx: 0 }));
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, featherPx: 4 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskInvert: true }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: assetRef, maskMode: 'chroma' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: assetRef, maskInvert: 'yes' }), { code: 'INVALID_REQUEST' });
  for (const featherPx of [-1, 65, 1.5]) assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: assetRef, featherPx }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: 'https://example.com/m.png' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: 'asset:short' }), { code: 'INVALID_REQUEST' });
  // 选区与显式矩形：selection: 只能当蒙版；矩形只接受整数，且与 maskRef 互斥。
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: 'selection:' }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRect: { x: 10, y: 20, width: 100, height: 50 } }));
  assert.doesNotThrow(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRect: { x: -10, y: 0, width: 1, height: 1 }, maskInvert: true, featherPx: 3 }));
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: 'selection:' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRef: 'selection:', maskRect: { x: 0, y: 0, width: 10, height: 10 } }), { code: 'INVALID_REQUEST' });
  for (const maskRect of [{ x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10 }, { x: 0.5, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10, extra: 1 }]) {
    assert.throws(() => imageCmd('layer.add_image', { sourceRef: assetRef, maskRect }), { code: 'INVALID_REQUEST' }, JSON.stringify(maskRect));
  }

  assert.doesNotThrow(() => imageCmd('layer.set_frame', { layerId: 'l1', width: 10, height: 10 }));
  // 外观三元组：至少一项；枚举与数值域都要在 Host 侧挡住。
  assert.doesNotThrow(() => imageCmd('layer.set_appearance', { layerId: 'l1', opacity: 40 }));
  assert.doesNotThrow(() => imageCmd('layer.set_appearance', { layerId: 'l1', blendMode: 'multiply', name: '背景' }));
  assert.doesNotThrow(() => imageCmd('layer.set_appearance', { layerId: 'l1', opacity: 0 }));
  assert.doesNotThrow(() => imageCmd('layer.set_appearance', { layerId: 'l1', opacity: 100 }));
  assert.throws(() => imageCmd('layer.set_appearance', { layerId: 'l1' }), { code: 'INVALID_REQUEST' });
  for (const opacity of [-1, 101, Number.NaN]) assert.throws(() => imageCmd('layer.set_appearance', { layerId: 'l1', opacity }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_appearance', { layerId: 'l1', blendMode: 'carve' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_appearance', { layerId: 'l1', name: '' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_appearance', { layerId: 'l1', name: '  ' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_appearance', { layerId: 'l1', opacity: 40, extra: 1 }), { code: 'INVALID_REQUEST' });  assert.throws(() => imageCmd('layer.set_frame', { layerId: 'l1' }), { code: 'INVALID_REQUEST' });
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

test('layer.duplicate / rasterize / merge_down / paint_stroke validate their fields before reaching the editor', () => {
  // duplicate：偏移量是可正可负的整数，name 给了就必须非空。
  assert.doesNotThrow(() => imageCmd('layer.duplicate', { layerId: 'l1' }));
  assert.doesNotThrow(() => imageCmd('layer.duplicate', { layerId: 'l1', offsetX: -40, offsetY: 25, name: '副本 A' }));
  for (const offset of [1.5, 16385, -16385, '10']) {
    assert.throws(() => imageCmd('layer.duplicate', { layerId: 'l1', offsetX: offset }), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => imageCmd('layer.duplicate', { layerId: 'l1', name: '   ' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.duplicate', { layerId: 'l1', scaleX: 2 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.duplicate', {}), { code: 'INVALID_REQUEST' });

  // rasterize / merge_down：只认目标层与可选名称。
  for (const command of ['layer.rasterize', 'layer.merge_down']) {
    assert.doesNotThrow(() => imageCmd(command, { layerId: 'l1' }));
    assert.doesNotThrow(() => imageCmd(command, { layerId: 'l1', name: '结果层' }));
    assert.throws(() => imageCmd(command, { layerId: 'l1', offsetX: 5 }), { code: 'INVALID_REQUEST' });
    assert.throws(() => imageCmd(command, { layerId: 'l1', name: '' }), { code: 'INVALID_REQUEST' });
    assert.throws(() => imageCmd(command, {}), { code: 'INVALID_REQUEST' });
  }

  // paint_stroke：点数、坐标、颜色、粗细、不透明度逐项校验。
  const stroke = points => ({ layerId: 'l1', points });
  assert.doesNotThrow(() => imageCmd('layer.paint_stroke', stroke([{ x: 1, y: 2 }, { x: 30, y: 40 }])));
  assert.doesNotThrow(() => imageCmd('layer.paint_stroke', { layerId: 'l1', points: [[0, 0], [10, 10]], color: '#FF0000', size: 12, opacity: 0.5 }));
  assert.doesNotThrow(() => imageCmd('layer.paint_stroke', { layerId: 'l1', points: [[0, 0], [1, 1]], opacity: 0 }));
  assert.throws(() => imageCmd('layer.paint_stroke', stroke([{ x: 1, y: 2 }])), { code: 'INVALID_REQUEST' }, '少于两点');
  assert.throws(() => imageCmd('layer.paint_stroke', stroke(Array.from({ length: 201 }, () => ({ x: 1, y: 1 })))), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.paint_stroke', stroke([{ x: 'a', y: 1 }, { x: 2, y: 2 }])), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.paint_stroke', stroke([{ x: 20000, y: 1 }, { x: 2, y: 2 }])), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.paint_stroke', stroke([{ x: 1, y: 1, z: 3 }, { x: 2, y: 2 }])), { code: 'INVALID_REQUEST' }, '点上不能有别的键');
  assert.throws(() => imageCmd('layer.paint_stroke', stroke([[0, 0, 9], [1, 1]])), { code: 'INVALID_REQUEST' }, '数组点必须是两元组');
  assert.throws(() => imageCmd('layer.paint_stroke', { layerId: 'l1', points: [[0, 0], [1, 1]], color: 'red' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.paint_stroke', { layerId: 'l1', points: [[0, 0], [1, 1]], size: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.paint_stroke', { layerId: 'l1', points: [[0, 0], [1, 1]], size: 201 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.paint_stroke', { layerId: 'l1', points: [[0, 0], [1, 1]], opacity: 1.5 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.paint_stroke', { layerId: 'l1', points: [[0, 0], [1, 1]], hardness: 0.5 }), { code: 'INVALID_REQUEST' });
});

test('layer.set_effect / remove_effect validate the vocabulary and value ranges', () => {
  assert.doesNotThrow(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'brightness', value: 1.2 }));
  assert.doesNotThrow(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'blur', value: 0 }));
  assert.doesNotThrow(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'hueRotate', value: -180 }));
  assert.doesNotThrow(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'grayscale', value: null }), 'null = 删除这一项');
  // 词表之外
  assert.throws(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'sharpen', value: 1 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'constructor', value: 1 }), { code: 'INVALID_REQUEST' }, '原型链上的键不算词表');
  // 越界 / 类型
  assert.throws(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'brightness', value: 5 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'blur', value: 51 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'hueRotate', value: 181 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'grayscale', value: '1' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_effect', { layerId: 'l1', effect: 'grayscale', value: 0.5, extra: 1 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.set_effect', { layerId: 'l1', value: 1 }), { code: 'INVALID_REQUEST' });
  // remove_effect：省略 effect = 清空整叠；给了就必须合法。
  assert.doesNotThrow(() => imageCmd('layer.remove_effect', { layerId: 'l1' }));
  assert.doesNotThrow(() => imageCmd('layer.remove_effect', { layerId: 'l1', effect: 'sepia' }));
  assert.throws(() => imageCmd('layer.remove_effect', { layerId: 'l1', effect: 'nope' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.remove_effect', {}), { code: 'INVALID_REQUEST' });
});

test('宿主的 dshEffects 词表与编辑器逐项一致（含顺序：CSS filter 先后会改变结果）', () => {
  // 两侧各有一份表（宿主做前置校验，编辑器做执行），必须完全同步。
  // 用源码解析而不是 import：编辑器模块是浏览器 ESM，宿主测试不该把它拉进来。
  const source = readFileSync(new URL('../../../miniPaint/src/js/dsh-editor-bridge.js', import.meta.url), 'utf8');
  const literal = /const DSH_EFFECT_RANGES = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(literal, '编辑器里必须存在 DSH_EFFECT_RANGES');
  const entries = [...literal[1].matchAll(/(\w+):\s*\[(-?\d+),\s*(-?\d+)\]/g)].map(m => [m[1], [Number(m[2]), Number(m[3])]]);
  assert.ok(entries.length >= 9, `编辑器词表解析到 ${entries.length} 项`);
  const editorTable = Object.fromEntries(entries);
  assert.deepEqual(Object.keys(editorTable), Object.keys(DSH_EFFECT_RANGES), '词表的键与顺序必须一致');
  assert.deepEqual(editorTable, DSH_EFFECT_RANGES, '取值域必须一致');
});

test('layer.update_mask validates the live-mask surface and refuses params the renderer ignores', () => {
  assert.doesNotThrow(() => imageCmd('layer.update_mask', { layerId: 'l1', invert: true }));
  assert.doesNotThrow(() => imageCmd('layer.update_mask', { layerId: 'l1', sourceLayerId: 'l2' }));
  assert.doesNotThrow(() => imageCmd('layer.update_mask', { layerId: 'l1', remove: true }));
  assert.doesNotThrow(() => imageCmd('layer.update_mask', { layerId: 'l1', invert: false, sourceLayerId: 'l2' }));
  // 什么都没给 = 无意义写入
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1' }), { code: 'INVALID_REQUEST' });
  // 互斥
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1', remove: true, invert: true }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1', remove: true, sourceLayerId: 'l2' }), { code: 'INVALID_REQUEST' });
  // 类型
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1', invert: 'yes' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1', remove: 'yes' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1', sourceLayerId: '' }), { code: 'INVALID_REQUEST' });
  // 活蒙版渲染不读的字段必须直接拒绝，而不是收下装作生效
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1', featherPx: 4 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1', mode: 'luminance' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.update_mask', { layerId: 'l1', density: 0.5 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.update_mask', {}), { code: 'INVALID_REQUEST' });
});

test('the four new structural commands are on the autonomous whitelist (owner authorization)', async () => {
  const { AUTONOMOUS_CAPABILITIES, createGuard } = await import('../lib/gate.js');
  const guard = createGuard();
  for (const operation of ['layer.duplicate', 'layer.rasterize', 'layer.merge_down', 'layer.paint_stroke']) {
    assert.equal(AUTONOMOUS_CAPABILITIES.image.has(operation), true, `${operation} 必须可自主执行`);
    assert.equal(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation, mode: 'autonomous' } }), undefined, `${operation} 不应被 guard 拒绝`);
  }
});

test('media_image_preview forwards crop/layerId/gridStep and surfaces the effective region + scale', async () => {
  const seen = [];
  const previewResult = {
    dataUrl: 'data:image/png;base64,AAAA', width: 200, height: 100, bytes: 3,
    crop: { x: 100, y: 50, width: 200, height: 100 }, scale: 0.5, layerId: 'l1', gridStep: 50,
  };
  const relay = { request: async message => {
    seen.push(message);
    if (message.type === 'editor.read_state') return imageState(3);
    if (message.type === 'editor.preview_png') return previewResult;
    throw new Error(`unexpected ${message.type}`);
  } };
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } }, {
    bridge: createMediaBridge({ relay, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings,
  });
  const definition = tools.get('media_image_preview');
  const args = {
    editorKind: 'image', projectId: 'doc-1', instanceId: 'e1',
    crop: { x: 100, y: 50, width: 200, height: 100 }, layerId: 'l1', gridStep: 50, maxWidth: 400,
  };
  const value = await definition.execute(args, { agent: { id: 'a' } });
  assert.equal(value.status, 'applied', JSON.stringify(value));
  // 参数必须原样到编辑器：漏传会让"局部放大"静默变成整幅预览。
  const sent = seen.find(message => message.type === 'editor.preview_png');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.crop)), { x: 100, y: 50, width: 200, height: 100 });
  assert.equal(sent.layerId, 'l1');
  assert.equal(sent.gridStep, 50);
  assert.equal(sent.maxWidth, 400);
  // 回执里要带上"实际用了哪个区域、缩放多少"，这是把预览坐标换算回画布坐标的依据。
  assert.deepEqual(JSON.parse(JSON.stringify(value.preview.crop)), { x: 100, y: 50, width: 200, height: 100 });
  assert.equal(value.preview.scale, 0.5);
  assert.equal(value.preview.layerId, 'l1');
  assert.equal(value.preview.gridStep, 50);
  assert.equal(value.revision, 3, '预览不得推进 revision');
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

test('layer.align validates intent enums and margin, and surfaces the editor-computed landing box', async () => {
  // 形状/取值域在 Host 侧就挡住，不把注定失败的写入发给编辑器。
  assert.doesNotThrow(() => imageCmd('layer.align', { layerId: 'l1', h: 'left' }));
  assert.doesNotThrow(() => imageCmd('layer.align', { layerId: 'l1', v: 'middle' }));
  assert.doesNotThrow(() => imageCmd('layer.align', { layerId: 'l1', h: 'right', v: 'bottom', margin: 24 }));
  assert.doesNotThrow(() => imageCmd('layer.align', { layerId: 'l1', h: 'center', to: 'canvas' }));
  assert.doesNotThrow(() => imageCmd('layer.align', { layerId: 'l1', h: 'left', margin: 0 }));
  // h/v 都没给 = 无意义写入
  assert.throws(() => imageCmd('layer.align', { layerId: 'l1' }), { code: 'INVALID_REQUEST' });
  // 枚举错位：把 h 的取值用给 v（或反之）
  assert.throws(() => imageCmd('layer.align', { layerId: 'l1', h: 'middle' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.align', { layerId: 'l1', v: 'center' }), { code: 'INVALID_REQUEST' });
  // margin 取值域与非整数
  for (const margin of [-1, 1.5, 4097, '10']) {
    assert.throws(() => imageCmd('layer.align', { layerId: 'l1', h: 'left', margin }), { code: 'INVALID_REQUEST' });
  }
  // to 目前只支持 canvas
  assert.throws(() => imageCmd('layer.align', { layerId: 'l1', h: 'left', to: 'selection' }), { code: 'INVALID_REQUEST' });
  // 多余字段不能静默忽略
  assert.throws(() => imageCmd('layer.align', { layerId: 'l1', h: 'left', x: 10 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => imageCmd('layer.align', { h: 'left' }), { code: 'INVALID_REQUEST' });
});

test('the editor-computed detail from layer.align comes back in the tool result', async () => {
  const detail = { aligned: { layerId: 'l1', x: 676, y: 626, width: 300, height: 150, h: 'right', v: 'bottom', margin: 24, canvas: { width: 1000, height: 800 } } };
  // 写后审计会再读一次状态：让它跟着写入推进 revision，否则会被如实判成"结果未知"。
  let revision = 3;
  const relay = { request: async message => {
    if (message.type !== 'editor.read_state') revision += 1;
    return message.type === 'editor.read_state'
      ? imageState(revision)
      : { documentId: 'doc-1', revision, commandId: message.commandId, changedObjectIds: ['l1'], commandDetail: detail };
  } };
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } }, {
    bridge: createMediaBridge({ relay }), approvals: createApprovalStore(), bindings: fixtureBindings,
  });
  const read = tools.get('media_image_apply_command');
  const args = {
    editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', commandId: 'c-align', expectedRevision: 3,
    operation: 'layer.align', params: { layerId: 'l1', h: 'right', v: 'bottom', margin: 24 },
  };
  const value = await read.execute(args, { agent: { id: 'a' } });
  assert.equal(value.status, 'applied', JSON.stringify(value));
  assert.deepEqual(value.detail, detail, '落点必须回到回执里，调用方不用再读一次状态');
  // 回执也要能被人读到，而不是只存在于结构化字段里。
  const text = read.output.render(args, value).map(block => block.text).join('\n');
  assert.match(text, /detail \{"aligned"/);
  assert.match(text, /"x":676/);
});
