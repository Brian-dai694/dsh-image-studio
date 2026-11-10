// 预录流程（recipe）：保存/复用/参数化，执行仍是一条历史。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecipeStore, validateRecipeSteps, fillRecipeParams, recipeParamsOf } from '../lib/recipes.js';
import { createMediaBridge } from '../lib/bridge.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

const STEPS = [
  { operation: 'layer.add_text', params: { text: '${title}', x: 10, y: 10, style: { size: 24 } } },
  { operation: 'layer.set_appearance', params: { layerId: 'l1', opacity: 80 } },
];

test('步骤校验：白名单、禁历史命令、禁高危、步数上限', () => {
  assert.equal(validateRecipeSteps(STEPS).length, 2);
  assert.throws(() => validateRecipeSteps([]), /1\.\.12/);
  assert.throws(() => validateRecipeSteps(Array.from({ length: 13 }, () => ({ operation: 'layer.add_text', params: {} }))), /1\.\.12/);
  assert.throws(() => validateRecipeSteps([{ operation: 'media.video.clip.move' }]), /不在白名单/);
  assert.throws(() => validateRecipeSteps([{ operation: 'history.undo' }]), /历史命令/);
  assert.throws(() => validateRecipeSteps([{ operation: 'layer.remove', params: { layerId: 'l1' } }]), /单独审批/);
  assert.throws(() => validateRecipeSteps([{ operation: 'layer.add_text', extra: 1 }]), /未支持字段/);
});

test('参数填充：缺参数明确报错，占位符名字可枚举', () => {
  const filled = fillRecipeParams(STEPS, { title: '春季新品' });
  assert.equal(filled[0].params.text, '春季新品');
  assert.equal(filled[1].params.opacity, 80, '非字符串值原样透传');
  assert.deepEqual(recipeParamsOf(STEPS), ['title']);
  assert.throws(() => fillRecipeParams(STEPS, {}), /缺少参数：title/);
});

test('流程库：保存/读取/覆盖/删除，且重启后仍在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recipes-'));
  try {
    const store = createRecipeStore({ dir });
    assert.equal(store.persistent, true);
    const saved = store.save({ name: '春季标题', description: '加标题并调透明度', steps: STEPS });
    assert.equal(saved.replaced, false);
    assert.equal(saved.stepCount, 2);
    assert.deepEqual(saved.params, ['title']);
    assert.equal(store.get('春季标题').steps.length, 2);
    const again = store.save({ name: '春季标题', steps: STEPS });
    assert.equal(again.replaced, true, '同名是替换不是新增');
    assert.equal(store.list().length, 1);

    const reopened = createRecipeStore({ dir });
    assert.equal(reopened.restoredCount, 1, '重启后恢复');
    assert.equal(reopened.get('春季标题').name, '春季标题');

    assert.equal(store.remove('春季标题'), true);
    assert.equal(store.remove('春季标题'), false);
    assert.equal(createRecipeStore({ dir }).restoredCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('流程名与坏索引都不会让流程库崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recipes-bad-'));
  try {
    const store = createRecipeStore({ dir });
    assert.throws(() => store.save({ name: '', steps: STEPS }), /1\.\.40/);
    assert.throws(() => store.save({ name: 'a/b', steps: STEPS }), /1\.\.40/);
    // 手写一个坏索引
    writeFileSync(join(dir, 'recipes.json'), JSON.stringify([{ name: 'ok', steps: [{ operation: 'history.undo' }] }]), 'utf8');
    const reopened = createRecipeStore({ dir });
    assert.equal(reopened.list().length, 0, '非法步骤的条目被跳过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('media_image_recipe 已注册，run 走一条 history.batch 且缺参数时报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recipes-run-'));
  try {
    const recipes = createRecipeStore({ dir });
    recipes.save({ name: '标题流程', steps: STEPS });
    let revision = 3;
    const writes = [];
    const relay = {
      request: async message => {
        if (message.type === 'editor.read_state') {
          return { editorKind: 'image', editorInstanceId: 'e1', documentId: 'doc-1', revision, stateDigest: `fnv1a64-${revision}`,
            canvas: { width: 100, height: 100 }, layers: [], history: { canUndo: true, canRedo: false } };
        }
        if (message.type === 'editor.apply_command') {
          writes.push(message.command);
          revision += 1;
          return { editorKind: 'image', documentId: 'doc-1', commandId: message.commandId, revision, changedObjectIds: ['l1'] };
        }
        throw new Error(`unexpected ${message.type}`);
      },
    };
    const tools = new Map();
    registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } },
      { bridge: createMediaBridge({ relay, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings, recipes });
    const tool = tools.get('media_image_recipe');
    assert.ok(tool, '必须注册流程工具');

    const listed = await tool.execute({ action: 'list' }, { agent: { id: 'a' } });
    assert.equal(listed.recipeList.length, 1);

    const missing = await tool.execute({ action: 'run', name: '标题流程', editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', commandId: 'r1', expectedRevision: 3, params: {} }, { agent: { id: 'a' } });
    assert.equal(missing.status, 'rejected');
    assert.equal(missing.error.code, 'RECIPE_PARAMS_MISSING');
    assert.equal(writes.length, 0, '缺参数不得触达编辑器');

    const ran = await tool.execute({ action: 'run', name: '标题流程', editorKind: 'image', projectId: 'doc-1', instanceId: 'e1', commandId: 'r2', expectedRevision: 3, params: { title: '春季新品' } }, { agent: { id: 'a' } });
    assert.equal(ran.status, 'applied', JSON.stringify(ran));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].type, 'history.batch');
    assert.deepEqual(writes[0].payload.steps.map(step => step.type), ['layer.add_text', 'layer.set_appearance']);
    assert.equal(writes[0].payload.steps[0].payload.text, '春季新品', '参数要真的填进去');
    assert.equal(ran.revision, 4);

    const saved = await tool.execute({ action: 'save', name: '新流程', steps: STEPS }, { agent: { id: 'a' } });
    assert.equal(saved.status, 'applied');
    assert.equal(saved.recipe.stepCount, 2);
    const removed = await tool.execute({ action: 'delete', name: '新流程' }, { agent: { id: 'a' } });
    assert.equal(removed.status, 'applied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
