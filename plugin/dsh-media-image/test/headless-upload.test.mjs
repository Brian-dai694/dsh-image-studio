// A3 的唯一通路：把本地文件推进素材库。必须借无头实例的页面令牌，
// 因为上传路由要同源 + 页面令牌，Host 侧两样都没有。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

const execOf = () => ({ agent: { id: 's1', session: { id: 's1' } }, callId: 'c1' });

function build({ headless }) {
  const tools = new Map();
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition), guard: () => {} } }, {
    bridge: { editorKind: 'image', readState: async () => ({}), getPage: () => null },
    approvals: createApprovalStore(), bindings: fixtureBindings, headless,
  });
  return tools;
}

test('没有无头能力时不注册上传工具', () => {
  assert.equal(build({ headless: null }).has('media_image_upload_asset'), false);
});

test('上传真实文件：回 asset id 与可用的 sourceRef', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-'));
  try {
    const file = join(dir, 'layer.png');
    writeFileSync(file, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    let received = null;
    const tools = build({
      headless: { enabled: true, allowHighRisk: true, isHeadless: () => true, upload: async input => { received = input; return { id: 'a'.repeat(48), name: 'layer.png', bytes: input.bytes.length }; } },
    });
    const value = await tools.get('media_image_upload_asset').execute({ path: file }, execOf());
    assert.equal(value.status, 'applied', JSON.stringify(value));
    assert.equal(value.detail.sourceRef, `asset:${'a'.repeat(48)}`);
    assert.equal(received.mime, 'image/png');
    assert.equal(received.name, 'layer.png');
    assert.equal(received.bytes.length, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('文件不存在时明确失败，不假装上传成功', async () => {
  const tools = build({ headless: { enabled: true, upload: async () => { throw new Error('不应被调用'); } } });
  const value = await tools.get('media_image_upload_asset').execute({ path: 'C:/definitely/not/here.png' }, execOf());
  assert.equal(value.status, 'rejected');
});

test('上传失败如实回错误码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-'));
  try {
    const file = join(dir, 'a.jpg');
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
    const tools = build({ headless: { enabled: true, upload: async () => { throw Object.assign(new Error('store full'), { code: 'ASSET_STORE_FULL' }); } } });
    const value = await tools.get('media_image_upload_asset').execute({ path: file }, execOf());
    assert.equal(value.status, 'rejected');
    assert.equal(value.error.code, 'ASSET_STORE_FULL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
