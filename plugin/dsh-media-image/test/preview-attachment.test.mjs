// 预览 → 持久附件 → 图片块：这是"模型真的看到画面"的正规路径。
// DSH 的 ctx.attachments.saveImage() 把字节变成无损 JSON 引用，工具 render() 再把它变成 ImageBlock。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerMediaTools } from '../lib/tools.js';
import { fixtureBindings } from './host-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 假编辑器：readState + preview 都与真实 bridge 同形。 */
function fakeBridge() {
  const state = {
    editorKind: 'image', documentId: 'doc-1', revision: 7, contentDigest: 'fnv1a64-1',
    canvas: { width: 64, height: 48 }, layers: [], selectedLayerId: null, selection: null,
    history: { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 },
  };
  return {
    getPage: () => null,
    async readState() { return state; },
    async preview() { return { dataUrl: `data:image/png;base64,${ONE_PIXEL}`, width: 1, height: 1, bytes: 68 }; },
  };
}

function build({ attachments } = {}) {
  const bindings = {
    assert(exec, kind, args) {
      if (!args.projectId) throw new Error('projectId required');
      return { sessionId: 'fixture-session', editorKind: kind, instanceId: args.instanceId, projectId: args.projectId };
    },
    invalidate() {},
  };
  const tools = new Map();
  const ctx = {
    get: name => (name === 'attachments' ? attachments : undefined),
    tools: { register: definition => tools.set(definition.name, definition), guard: () => {} },
  };
  registerMediaTools(ctx, { bridge: fakeBridge(), approvals: { store: new Map() }, bindings, assets: null, generation: null, recipes: null, photoshop: null });
  return tools.get('media_image_preview');
}

const callArgs = { editorKind: 'image', projectId: 'doc-1', instanceId: 'media-image-1' };
const exec = { agent: { id: 'a' }, sessionId: 'fixture-session' };

test('有 attachments 服务时：结果带持久引用，render 产出真正的 image 块', async () => {
  const saved = [];
  const definition = build({
    attachments: {
      async saveImage(input) {
        saved.push(input);
        return { attachmentId: 'sha256:abc123', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1, name: input.name };
      },
    },
  });
  const value = await definition.execute(callArgs, exec);
  assert.equal(value.status, 'applied');
  assert.ok(value.preview.attachment, JSON.stringify(value.preview));
  assert.equal(value.preview.attachment.attachmentId, 'sha256:abc123');
  // 传给附件的必须是真 PNG 字节（不是 data URL 字符串）
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png');
  assert.ok(saved[0].data instanceof Uint8Array);
  assert.equal(saved[0].data[1], 0x50, '第二、三字节应是 PNG 的 P/N');

  const blocks = definition.output.render(callArgs, value);
  const image = blocks.find(block => block.type === 'image');
  assert.ok(image, `render 必须产出 image 块，实际 ${JSON.stringify(blocks.map(b => b.type))}`);
  assert.equal(image.attachment.attachmentId, 'sha256:abc123');
  assert.ok(blocks.some(block => block.type === 'text'), '文本块要保留（预览信息）');
  assert.match(value.note, /持久附件/);
});

test('没有 attachments 服务时：不伪造图片块，只给文本 + 可选落盘', async () => {
  const definition = build({ attachments: null });
  const value = await definition.execute(callArgs, exec);
  assert.equal(value.preview.attachment, undefined);
  const blocks = definition.output.render(callArgs, value);
  assert.equal(blocks.some(block => block.type === 'image'), false, '拿不到引用就不能发 image 块');
  assert.ok(blocks.some(block => block.type === 'text'));
});

test('附件写入失败时如实登记，不掩盖预览本身', async () => {
  const definition = build({
    attachments: {
      async saveImage() { throw Object.assign(new Error('磁盘满了'), { code: 'ATTACHMENT_WRITE_FAILED' }); },
    },
  });
  const value = await definition.execute(callArgs, exec);
  assert.equal(value.preview.attachment, undefined);
  assert.equal(value.preview.attachError.code, 'ATTACHMENT_WRITE_FAILED');
  assert.ok(value.preview.dataUrl, '预览数据仍要返回');
  assert.match(value.note, /附件写入失败/);
  const blocks = definition.output.render(callArgs, value);
  assert.equal(blocks.some(block => block.type === 'image'), false);
});

test('savePath 与附件可以同时生效，互不影响', async () => {
  const target = join(here, '..', '.tmp-preview-test.png');
  const definition = build({
    attachments: { async saveImage(input) { return { attachmentId: 'sha256:def456', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 }; } },
  });
  const value = await definition.execute({ ...callArgs, savePath: target }, exec);
  assert.ok(value.preview.attachment, '引用要在');
  assert.ok(value.preview.savedPath, '落盘也要在');
  assert.ok(readFileSync(value.preview.savedPath).length > 0);
  readFileSync; // 保证未使用告警不出现
  try { (await import('node:fs')).unlinkSync(value.preview.savedPath); } catch { /* 清理失败不影响断言 */ }
});
