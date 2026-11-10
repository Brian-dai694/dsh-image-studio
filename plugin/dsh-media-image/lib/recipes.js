// 预录流程（recipe）：把一串白名单命令存成有名字、可带参数的"动作"。
//
// 对应 Photoshop 的 .atn 思路：效果由人预先定义并审阅，模型只负责挑选与填参。
// 约束与 run_plan 一致：1..12 步、只允许白名单命令、不能含历史命令、不能含高危命令。
// 落盘与否取决于是否给了 dir（与素材库同一套生命周期）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_COMMANDS, HIGH_RISK_COMMANDS } from './bridge.js';

export const MAX_RECIPE_STEPS = 12;
const NAME_PATTERN = /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .-]{0,39}$/;

export function validateRecipeSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_RECIPE_STEPS) {
    throw Object.assign(new Error(`steps 必须是 1..${MAX_RECIPE_STEPS} 条`), { code: 'INVALID_RECIPE' });
  }
  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw Object.assign(new Error(`step ${index + 1} 必须是对象`), { code: 'INVALID_RECIPE' });
    }
    const extra = Object.keys(step).find(key => !['operation', 'params', 'note'].includes(key));
    if (extra) throw Object.assign(new Error(`step ${index + 1} 有未支持字段 ${extra}`), { code: 'INVALID_RECIPE' });
    if (typeof step.operation !== 'string' || !ALLOWED_COMMANDS.image.has(step.operation)) {
      throw Object.assign(new Error(`step ${index + 1} 的命令不在白名单：${step.operation}`), { code: 'INVALID_RECIPE' });
    }
    if (step.operation.startsWith('history.')) {
      throw Object.assign(new Error(`step ${index + 1}：流程里不能包含历史命令`), { code: 'INVALID_RECIPE' });
    }
    if (HIGH_RISK_COMMANDS.has(step.operation)) {
      throw Object.assign(new Error(`step ${index + 1}：${step.operation} 需要单独审批，不能存进流程`), { code: 'HIGH_RISK_IN_RECIPE' });
    }
    if (step.params !== undefined && (typeof step.params !== 'object' || Array.isArray(step.params))) {
      throw Object.assign(new Error(`step ${index + 1} 的 params 必须是对象`), { code: 'INVALID_RECIPE' });
    }
    return { operation: step.operation, params: step.params ?? {}, ...(step.note ? { note: String(step.note).slice(0, 120) } : {}) };
  });
}

/** 把 `${key}` 占位符替换成调用方给的参数；缺参数就明确报错，不用空串糊过去。 */
export function fillRecipeParams(steps, params = {}) {
  const missing = new Set();
  const fill = value => {
    if (typeof value === 'string') {
      return value.replace(/\$\{([\w.-]+)\}/g, (_match, key) => {
        if (params[key] === undefined || params[key] === null) { missing.add(key); return ''; }
        return String(params[key]);
      });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = fill(item);
      return out;
    }
    return value;
  };
  const filled = steps.map(step => ({ operation: step.operation, params: fill(step.params ?? {}), ...(step.note ? { note: step.note } : {}) }));
  if (missing.size) {
    throw Object.assign(new Error(`缺少参数：${[...missing].join('、')}`), { code: 'RECIPE_PARAMS_MISSING', missing: [...missing] });
  }
  return filled;
}

/** 流程里用到的占位符名字（供 UI/文档展示，避免调用方瞎猜）。 */
export function recipeParamsOf(steps) {
  const names = new Set();
  const scan = value => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([\w.-]+)\}/g)) names.add(match[1]);
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  scan(steps);
  return [...names];
}

export function createRecipeStore({ dir = null } = {}) {
  const root = typeof dir === 'string' && dir ? dir : null;
  const indexPath = root ? join(root, 'recipes.json') : null;
  const recipes = new Map();

  const metadata = recipe => ({
    name: recipe.name,
    description: recipe.description || '',
    stepCount: recipe.steps.length,
    operations: recipe.steps.map(step => step.operation),
    params: recipeParamsOf(recipe.steps),
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
  });

  const persist = () => {
    if (!indexPath) return;
    const rows = [...recipes.values()];
    const tmp = `${indexPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
    renameSync(tmp, indexPath);
  };

  let restored = 0;
  if (root) {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    if (existsSync(indexPath)) {
      try {
        const rows = JSON.parse(readFileSync(indexPath, 'utf8'));
        for (const row of Array.isArray(rows) ? rows : []) {
          try {
            const steps = validateRecipeSteps(row?.steps);
            if (typeof row.name !== 'string' || !NAME_PATTERN.test(row.name)) throw new Error('bad name');
            recipes.set(row.name, { name: row.name, description: String(row.description || '').slice(0, 200), steps,
              createdAt: Number(row.createdAt) || Date.now(), updatedAt: Number(row.updatedAt) || Date.now() });
            restored += 1;
          } catch { /* 坏行跳过，不让插件起不来 */ }
        }
      } catch { /* 索引坏了就当空库 */ }
    }
  }

  return {
    save({ name, description = '', steps }) {
      if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
        throw Object.assign(new Error('流程名 1..40 字，允许中英文、数字、空格、点、横线、下划线'), { code: 'INVALID_RECIPE_NAME' });
      }
      const clean = validateRecipeSteps(steps);
      const existing = recipes.get(name);
      const now = Date.now();
      const recipe = { name, description: String(description || '').slice(0, 200), steps: clean,
        createdAt: existing?.createdAt ?? now, updatedAt: now };
      recipes.set(name, recipe);
      persist();
      return { ...metadata(recipe), replaced: !!existing };
    },
    get(name) { return recipes.get(name) ?? null; },
    list() { return [...recipes.values()].map(metadata); },
    remove(name) {
      const existed = recipes.delete(name);
      if (existed) persist();
      return existed;
    },
    get persistent() { return !!root; },
    get restoredCount() { return restored; },
  };
}
