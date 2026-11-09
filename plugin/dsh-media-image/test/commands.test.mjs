// 命令目录与就绪度：与白名单不漂移、未知命令给近似名、按当前选择判断能否执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_COMMANDS } from '../lib/bridge.js';
import { COMMAND_NEEDS, COMMAND_PARAMS, describeCommands, suggestOperation, summarize } from '../lib/commands.js';

const textState = (overrides = {}) => ({
  editorKind: 'image', editorInstanceId: 'e1', documentId: 'doc-1', revision: 3, stateDigest: 'fnv1a64-1',
  canvas: { width: 640, height: 480 },
  selectedLayerId: 'l-text', selection: null,
  layers: [{ id: 'l-text', name: '标题', type: 'text' }, { id: 'l-img', name: '商品', type: 'image' }],
  history: { canUndo: true, canRedo: false },
  ...overrides,
});

test('目录与白名单不漂移：每条命令都有 needs 与参数契约', () => {
  const ids = [...ALLOWED_COMMANDS.image].sort();
  for (const id of ids) {
    assert.ok(COMMAND_NEEDS[id], `${id} 缺少 needs`);
    assert.ok(COMMAND_PARAMS[id], `${id} 缺少参数契约`);
  }
  assert.deepEqual(Object.keys(COMMAND_NEEDS).sort(), ids, '目录不得多出白名单外的命令');
});

test('没有状态时如实回 enabled:null，不假装可用', () => {
  const commands = describeCommands();
  assert.ok(commands.length > 0);
  for (const command of commands) {
    assert.equal(command.enabled, null);
    assert.equal(command.disabledReason, 'state-unavailable');
  }
});

test('选中文字层：文字命令可用，像素命令给出具体原因', () => {
  const commands = describeCommands(textState());
  const byId = Object.fromEntries(commands.map(item => [item.id, item]));
  assert.equal(byId['layer.update_text'].enabled, true);
  assert.equal(byId['layer.feather'].enabled, false);
  assert.equal(byId['layer.feather'].disabledReason, 'selected-layer-is-text-not-image');
  assert.equal(byId['layer.add_text'].enabled, true, '新增类命令不依赖选择');
  assert.equal(byId['layer.add_text'].disabledReason, null);
  assert.equal(byId['layer.remove'].highRisk, true);
  assert.equal(byId['layer.add_text'].highRisk, false);
});

test('没有选中图层时，依赖选择的命令都说 no-selected-layer；没有文档说 no-document', () => {
  const none = describeCommands(textState({ selectedLayerId: null }));
  assert.equal(none.find(item => item.id === 'layer.set_frame').disabledReason, 'no-selected-layer');
  const blank = describeCommands(textState({ documentId: '' }));
  assert.ok(blank.every(item => item.enabled === false && item.disabledReason === 'no-document'), JSON.stringify(blank.filter(i => i.enabled !== false)));
});

test('summarize 只抽可用性需要的事实，不外泄整份状态', () => {
  const summary = summarize(textState());
  assert.deepEqual(Object.keys(summary).sort(), ['canRedo', 'canUndo', 'hasDocument', 'hasSelection', 'selectedId', 'selectedType'].sort());
  assert.equal(summary.selectedType, 'text');
});

test('media_image_list_commands 已注册，并在能读到状态时给出就绪度', async () => {
  const { fixtureBindings } = await import('./host-fixture.mjs');
  const { createMediaBridge } = await import('../lib/bridge.js');
  const { registerMediaTools } = await import('../lib/tools.js');
  const { createApprovalStore } = await import('../lib/gate.js');
  const state = textState({ stateDigest: 'fnv1a64-1' });
  const bridge = createMediaBridge({ relay: { request: async message => (message.type === 'editor.read_state' ? state : state) }, editorKind: 'image' });
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } },
    { bridge, approvals: createApprovalStore(), bindings: fixtureBindings });
  const definition = tools.get('media_image_list_commands');
  assert.ok(definition, '必须注册命令目录工具');
  const value = await definition.execute({ editorKind: 'image', projectId: 'doc-1', instanceId: 'e1' }, { agent: { id: 'a' } });
  assert.equal(value.status, 'applied');
  assert.ok(Array.isArray(value.commands) && value.commands.length >= 15, JSON.stringify(value.commands?.length));
  assert.equal(value.counts.total, value.commands.length);
  assert.equal(value.counts.enabled + value.counts.disabled + value.counts.unknown, value.counts.total);
  assert.equal(value.commands.find(item => item.id === 'layer.update_text').enabled, true);
  assert.equal(value.commands.find(item => item.id === 'layer.feather').enabled, false);
  assert.equal(value.context.selectedType, 'text');
  assert.equal('state' in value, false, '目录工具不该把整份状态塞回去');
});

test('未知命令给近似名（含长短写与点号错位）', () => {
  assert.ok(suggestOperation('layer.update_txt').includes('layer.update_text'));
  assert.ok(suggestOperation('canvas.cropx').includes('canvas.crop'));
  assert.ok(suggestOperation('layer.add_image').includes('layer.add_image'), '正确名字也要能命中自己');
  assert.deepEqual(suggestOperation('totally.unrelated.thing'), []);
});
