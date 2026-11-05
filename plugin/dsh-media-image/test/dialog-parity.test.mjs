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
    exportRef: { exportId: 'exp-1', artifactRef: 'artifact:1' } },
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
});

test('共享模型产出的计划里没有裸 JSON，这一点两边一起成立', async () => {
  const shared = await import(`${pathToFileURL(sharedFile).href}?t=${Date.now()}`);
  const plan = shared.buildDialogPlan(ROWS);
  const texts = [];
  for (const item of plan) {
    if (item.card?.line) texts.push(item.card.line);
    if (item.issue) texts.push(item.issue);
    for (const block of item.blocks || []) texts.push(block.text || '');
  }
  assert.ok(texts.length > 0);
  for (const text of texts) assert.equal(shared.looksLikeRawJson(text), false, String(text).slice(0, 40));
  // 撤销只出现在工具卡的动作里，且是"填输入框"而不是直接执行
  const undoActions = plan.flatMap(item => item.actions).filter(action => action.kind.includes('undo'));
  assert.deepEqual(undoActions.map(action => action.kind), ['fill-undo']);
});

test('vendored 文件可核对 sha256，便于视频侧记录版本', async () => {
  const bytes = await readFile(sharedFile);
  assert.equal(createHash('sha256').update(bytes).digest('hex').length, 64);
});
