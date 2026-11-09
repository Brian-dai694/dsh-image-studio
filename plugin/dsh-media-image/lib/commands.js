// 命令目录与就绪度（只读、纯函数）：让调用方在动手前知道「有哪些命令、现在能不能用、为什么不能」。
//
// 借鉴 LayerShop 的 engine.commands：每条命令带 enabled / disabledReason / needsDocument，
// 而不是让模型靠试错去发现前提（试错会白跑一次写入，还会触发熔断）。
//
// 单一事实来源：命令 id 直接取自 bridge 的白名单，避免目录和实现漂移（测试会逐条核对）。

import { ALLOWED_COMMANDS, HIGH_RISK_COMMANDS } from './bridge.js';

/** 每条命令需要什么前提。none=随时可发；layer=需要选中任意图层；text=需要选中文字层；image=需要选中图片层；history=看历史栈。 */
export const COMMAND_NEEDS = {
  'layer.add_text': 'none',
  'layer.add_image': 'none',
  'canvas.resize': 'none',
  'canvas.crop': 'none',
  'history.undo': 'history',
  'history.redo': 'history',
  'history.batch': 'none',
  'layer.update_text': 'text',
  'layer.set_transform': 'layer',
  'layer.set_visibility': 'layer',
  'layer.reorder': 'layer',
  'layer.set_appearance': 'layer',
  'layer.set_frame': 'layer',
  'layer.remove': 'layer',
  'layer.feather': 'image',
  'layer.color_match': 'image',
  'layer.remove_background': 'image',
  'layer.magic_erase': 'image',
  'layer.add_mask_layer': 'image',
};

/** 参数契约（给人看的字符串，不做 JSON Schema；与 assist 提示词里的描述同源）。 */
export const COMMAND_PARAMS = {
  'layer.add_text': '{text, x?, y?, style?:{size?,family?,fill_color?,bold?,italic?}, fontUrl?}',
  'layer.update_text': '{layerId, text, fontUrl?}',
  'layer.add_image': '{sourceRef, x?, y?, width?, height?, fit?, name?, maskRef?, maskRect?, maskMode?, maskInvert?, featherPx?}',
  'layer.set_transform': '{layerId, x?, y?, scaleX?, scaleY?, rotationDeg?}',
  'layer.set_visibility': '{layerId, visible}',
  'layer.reorder': '{layerId, toIndex}',
  'layer.set_appearance': '{layerId, opacity?, blendMode?, name?}',
  'layer.set_frame': '{layerId, x?, y?, width?, height?, fit?, anchor?}',
  'layer.remove': '{layerId}',
  'layer.feather': '{layerId, radiusPx}',
  'layer.color_match': '{layerId, method:"reinhard", strength?, reference?}',
  'layer.remove_background': '{layerId, tolerance?, featherPx?}',
  'layer.magic_erase': '{layerId, x, y, tolerance?, contiguous?}',
  'layer.add_mask_layer': '{sourceLayerId, mode?, tolerance?, featherPx?, name?}',
  'canvas.resize': '{width, height}',
  'canvas.crop': '{x, y, width, height}',
  'history.undo': '{targetCommandId, afterDigest}',
  'history.redo': '{}',
  'history.batch': '{steps:[{type,payload}] (1..12, no history.*, no high-risk), name?}',
};



const distance = (a, b) => {
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return rows[a.length][b.length];
};

/** 未知命令名 → 最多 3 个近似名（LayerShop 的 "did you mean" 做法）。 */
export function suggestOperation(input, limit = 3) {
  const value = String(input ?? '').trim().toLowerCase();
  if (!value) return [];
  const ids = [...ALLOWED_COMMANDS.image];
  return ids
    .map(id => {
      const lower = id.toLowerCase();
      const bump = lower.includes(value) || value.includes(lower.split('.').pop()) ? 1 : 0;
      return { id, score: distance(value, lower) - bump, exactSuffix: lower.split('.').pop() === value };
    })
    .sort((a, b) => a.score - b.score)
    .filter(item => item.score <= 4)
    .slice(0, limit)
    .map(item => item.id);
}

/**
 * 依据当前状态给出每条命令的可用性。state 缺省时 enabled 一律为 null（不知道，不假装）。
 * @returns {id, params, needs, highRisk, enabled, disabledReason}[]
 */
export function describeCommands(state = null) {
  const ids = [...ALLOWED_COMMANDS.image].sort();
  const work = state ? summarize(state) : null;
  return ids.map(id => {
    const needs = COMMAND_NEEDS[id] ?? 'none';
    const base = { id, params: COMMAND_PARAMS[id] ?? '', needs, highRisk: HIGH_RISK_COMMANDS.has(id) };
    if (!work) return { ...base, enabled: null, disabledReason: 'state-unavailable' };
    const verdict = verdictFor(needs, work);
    return { ...base, enabled: verdict.enabled, disabledReason: verdict.reason };
  });
}

/** 从 read_state 结果里抽出判断可用性需要的少量事实。 */
export function summarize(state) {
  const layers = Array.isArray(state?.layers) ? state.layers : [];
  const selected = layers.find(layer => layer.id === state?.selectedLayerId) || null;
  return {
    hasDocument: typeof state?.documentId === 'string' && state.documentId.length > 0,
    selectedType: selected?.type ?? null,
    selectedId: selected?.id ?? null,
    canUndo: !!state?.history?.canUndo,
    canRedo: !!state?.history?.canRedo,
    hasSelection: !!state?.selection,
  };
}

function verdictFor(needs, work) {
  if (!work.hasDocument) return { enabled: false, reason: 'no-document' };
  if (needs === 'none') return { enabled: true, reason: null };
  if (needs === 'history') return { enabled: true, reason: null }; // canUndo 由参数层判断，这里不预判
  if (!work.selectedId) return { enabled: false, reason: 'no-selected-layer' };
  if (needs === 'text' && work.selectedType !== 'text') return { enabled: false, reason: `selected-layer-is-${work.selectedType || 'unknown'}-not-text` };
  if (needs === 'image' && work.selectedType !== 'image') return { enabled: false, reason: `selected-layer-is-${work.selectedType || 'unknown'}-not-image` };
  return { enabled: true, reason: null };
}
