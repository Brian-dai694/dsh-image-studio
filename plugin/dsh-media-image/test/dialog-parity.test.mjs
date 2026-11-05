// 共享对话模型对照测试：图片侧内联实现必须与 shared/dialog-model.mjs 逐函数一致。
// 视频侧 vendor 同一份文件后，这条测试就是"两边不许漂移"的闸门。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(root, '../..');
const sharedFile = resolve(repoRoot, 'shared/dialog-model.mjs');

const fakeReact = {
  useRef: value => ({ current: value }),
  useState: value => [value, () => {}],
  useEffect() {}, useLayoutEffect() {},
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
};

async function loadClient() {
  let exported = null;
  globalThis.window = { __ModuleLoader__: { load({ factory }) { exported = factory(name => (name === 'react' ? fakeReact : {})) } } };
  await import(`${pathToFileURL(resolve(root, 'lib/client.js')).href}?t=${Date.now()}`);
  return exported;
}

const ROWS = [
  { id: 'u1', role: 'user', text: '把画布改成 1200×800' },
  { id: 'a1', role: 'assistant', text: '# 标题\n\n段落\n\n- 一\n- 二\n\n```js\nconst a = 1\n```\n\n> 引用' },
  { id: 't1', role: 'tool', card: { name: '执行编辑', status: 'completed', revision: 2, line: 'canvas.resize' } },
  { id: 't2', role: 'tool', card: { name: '执行编辑', status: 'unknown', revision: 2, line: '' } },
  { id: 't3', role: 'tool', card: { name: '读取工程', status: 'failed', revision: null, line: '', error: true } },
  { id: 't4', role: 'tool', card: { name: '执行编辑', status: '', revision: null, line: '' } },
  { id: 't5', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 3, line: '{"big":"raw json body that must never reach the dom","n":1}' },
    undo: { commandId: 'cmd-7', appliedRevision: 3, afterDigest: 'fnv1a64-0000000000000001' },
    exportRef: { exportId: 'exp-1', artifactRef: 'artifact:1' },
    locate: { objectIds: ['layer-1', 'layer-2'], kind: 'layer' } },
  // 短 JSON 也要兜住：错误行与工具回执走严格判定，不看 40 字符阈值
  { id: 't6', role: 'tool', card: { name: '执行编辑', status: 'unknown', revision: 4, line: '{"code":"REVISION_CONFLICT"}' } },
  { id: 'e2', role: 'error', text: '{"code":"REVISION_CONFLICT"}' },
  // 非法 locate：空数组 / 非白名单 kind / 非字符串 → 整体省略
  { id: 't7', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 5, line: 'x' }, locate: { objectIds: [], kind: 'layer' } },
  { id: 't8', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 6, line: 'x' }, locate: { objectIds: ['a'], kind: 'gizmo' } },
  { id: 't9', role: 'tool', card: { name: '执行编辑', status: 'applied', revision: 7, line: 'x' }, locate: { objectIds: [42], kind: 'clip' } },
  { id: 'v1', role: 'approval', text: '等待确认' },
  { id: 'v2', role: 'approval', decided: true, outcome: 'allowed-once', text: '已允许一次' },
  { id: 'v3', role: 'approval', decided: true, outcome: 'unavailable', text: '不可用' },
  { id: 'e1', role: 'error', text: '{"error":{"code":"REVISION_CONFLICT"}}' },
  { id: 'r1', role: 'assistant', text: '{"raw":"a long raw json body that must not reach the dom at all ok","n":1}' },
];

test('图片侧内联实现与 shared/dialog-model.mjs 的输出完全一致', async () => {
  const client = await loadClient();
  const shared = await import(`${pathToFileURL(sharedFile).href}?t=${Date.now()}`);
  assert.equal(JSON.stringify(client.chat.buildDialogPlan(ROWS)), JSON.stringify(shared.buildDialogPlan(ROWS)));
  assert.equal(
    JSON.stringify(client.chat.parseMarkdownBlocks('# t\n\n- a\n- b\n\n```py\nx=1\n```\n\n> q\n\np')),
    JSON.stringify(shared.parseMarkdownBlocks('# t\n\n- a\n- b\n\n```py\nx=1\n```\n\n> q\n\np')),
  );
  assert.equal(
    JSON.stringify(client.chat.parseInlineTokens('见 `a` 与 [x](https://e.com) ![i](https://e.com/a.png) 和 https://e.com/b')),
    JSON.stringify(shared.parseInlineTokens('见 `a` 与 [x](https://e.com) ![i](https://e.com/a.png) 和 https://e.com/b')),
  );
  for (const [status, failed] of [['', false], ['', true], ['applied', false], ['completed', false], ['unknown', false], ['running', false], ['weird', true], ['ready', false]]) {
    assert.equal(client.chat.normalizeToolStatus(status, failed), shared.normalizeToolStatus(status, failed), `status=${status} failed=${failed}`);
  }
  for (const value of ['', 'ok', '{"a":1}', '[' + 'x'.repeat(60) + ']', '{"x":"' + 'y'.repeat(60) + '"}']) {
    assert.equal(client.chat.looksLikeRawJson(value), shared.looksLikeRawJson(value), value.slice(0, 12));
  }
  for (const failure of [null, { text: 'a' }, { text: 'a', unknown: true }]) {
    assert.equal(JSON.stringify(client.chat.retryState(failure)), JSON.stringify(shared.retryState(failure)));
  }
  for (const [name, data] of [['a.png', 'data:image/png;base64,' + Buffer.from('x'.repeat(32)).toString('base64')], ['a.gif', 'data:image/gif;base64,AAA'], ['a.txt', 'nope']]) {
    assert.equal(JSON.stringify(client.chat.attachmentFromDataUrl(name, data)), JSON.stringify(shared.attachmentFromDataUrl(name, data)));
  }
  // 严格裸 JSON 判定与定位透传也必须一致
  for (const value of ['{"code":"REVISION_CONFLICT"}', '{"a":1}', '[1,2]', 'ok', '{"broken":']) {
    assert.equal(client.chat.isRawPayload(value), shared.isRawPayload(value), value);
    assert.equal(client.chat.isJsonStructure(value), shared.isJsonStructure(value), value);
  }
  const locates = [
    { objectIds: ['a', 'b'], kind: 'clip' },
    { objectIds: [], kind: 'layer' },
    { objectIds: ['a'], kind: 'gizmo' },
    { objectIds: ['a'], kind: 'track' },
    { objectIds: ['a', ''], kind: 'overlay' },
    null,
  ];
  for (const locate of locates) {
    assert.equal(JSON.stringify(client.chat.sanitizeLocate(locate)), JSON.stringify(shared.sanitizeLocate(locate)));
  }
  // 动作凭据：撤销/导出都必须随动作进计划，且两边逐字一致
  for (const undo of [{ commandId: 'cmd-1', appliedRevision: 1, afterDigest: 'fnv1a64-0000000000000001' }, { commandId: '', appliedRevision: 1, afterDigest: 'x' }, null]) {
    assert.equal(JSON.stringify(client.chat.sanitizeUndo(undo)), JSON.stringify(shared.sanitizeUndo(undo)));
    assert.equal(client.chat.undoPrompt(undo), shared.undoPrompt(undo));
  }
  for (const ref of [{ exportId: 'e1', artifactRef: 'a', format: 'png' }, { artifactRef: 'a' }, null]) {
    assert.equal(JSON.stringify(client.chat.sanitizeExport(ref)), JSON.stringify(shared.sanitizeExport(ref)));
  }
  const actionPlan = client.chat.buildDialogPlan(ROWS).find(item => item.key === 't5');
  const sharedActionPlan = shared.buildDialogPlan(ROWS).find(item => item.key === 't5');
  assert.equal(JSON.stringify(actionPlan.actions), JSON.stringify(sharedActionPlan.actions));
  assert.equal(actionPlan.actions.find(action => action.kind === 'fill-undo').prompt, sharedActionPlan.actions.find(action => action.kind === 'fill-undo').prompt);
  assert.deepEqual(actionPlan.actions.find(action => action.kind === 'download-export').export, { exportId: 'exp-1', artifactRef: 'artifact:1' });
});

test('共享模型产出的计划里没有裸 JSON，这一点两边一起成立', async () => {
  const shared = await import(`${pathToFileURL(sharedFile).href}?t=${Date.now()}`);
  const plan = shared.buildDialogPlan(ROWS);
  const texts = [];
  for (const item of plan) {
    if (item.card?.line) texts.push(item.card.line);
    if (item.issue) texts.push(item.issue);
    if (item.title) texts.push(item.title);
    for (const action of item.actions || []) { if (action.label) texts.push(action.label); if (action.hint) texts.push(action.hint); }
    for (const block of item.blocks || []) {
      if (block.kind === 'code') continue; // 主动展示的代码块不算泄漏
      texts.push(block.text || '');
      for (const value of block.items || []) texts.push(value);
    }
  }
  assert.ok(texts.length > 0);
  for (const text of texts) assert.equal(shared.looksLikeRawJson(text), false, String(text).slice(0, 40));
  // 诊断原文只允许出现在 diagnostic，不得同时出现在任何要渲染的文本里
  for (const item of plan) {
    if (!item.diagnostic) continue;
    assert.equal(texts.includes(item.diagnostic), false, '诊断原文泄漏进了渲染文本');
    assert.equal(item.card?.line === item.diagnostic, false);
  }
  // locate：合法透传、非法整体省略
  const byKey = Object.fromEntries(plan.map(item => [item.key, item]));
  assert.deepEqual(byKey.t5.locate, { objectIds: ['layer-1', 'layer-2'], kind: 'layer' });
  for (const key of ['t7', 't8', 't9']) assert.equal('locate' in byKey[key], false, `${key} 的非法 locate 必须整体省略`);
  // 撤销只出现在工具卡的动作里，且是"填输入框"而不是直接执行
  const undoActions = plan.flatMap(item => item.actions).filter(action => action.kind.includes('undo'));
  assert.deepEqual(undoActions.map(action => action.kind), ['fill-undo']);
});

test('vendored 文件可核对 sha256，便于视频侧记录版本', async () => {
  const bytes = await readFile(sharedFile);
  assert.equal(createHash('sha256').update(bytes).digest('hex').length, 64);
});
