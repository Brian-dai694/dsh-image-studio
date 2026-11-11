// 产物落盘的单元验证：往返、sha256、上限、无 dataDir 时诚实不可用、sweep 清旧。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifactStore, extensionFor } from '../lib/artifacts.js';

const withStore = (options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-'));
  const store = createArtifactStore({ dir, ...options });
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test('落盘往返：字节、sha256 与路径都对得上', () => {
  const { store, dir, cleanup } = withStore();
  try {
    const bytes = Buffer.from('8BPS fake psd payload');
    const saved = store.save({ bytes, name: 'product.psd', mime: 'image/vnd.adobe.photoshop' });
    assert.match(saved.artifactId, /^[a-f0-9]{32}$/);
    assert.equal(saved.bytes, bytes.length);
    assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(saved.path, join(dir, `${saved.artifactId}.psd`));
    assert.deepEqual(readFileSync(saved.path), bytes);

    const readBack = store.get(saved.artifactId);
    assert.deepEqual(Buffer.from(readBack.bytes), bytes);
    assert.equal(readBack.sha256, saved.sha256);
  } finally { cleanup(); }
});

test('未配置 dataDir：明确不可用，不往临时目录写', () => {
  const store = createArtifactStore({ dir: null });
  assert.equal(store.available, false);
  assert.throws(() => store.save({ bytes: Buffer.from('x'), mime: 'image/png' }), { code: 'ARTIFACTS_UNAVAILABLE' });
  assert.equal(store.get('nope'), null);
});

test('类型与上限：未知 mime、空内容、单文件超额都拒绝', () => {
  const { store, cleanup } = withStore({ maxArtifactBytes: 16 });
  try {
    assert.throws(() => store.save({ bytes: Buffer.from('x'), mime: 'text/plain' }), { code: 'UNSUPPORTED_ARTIFACT_TYPE' });
    assert.throws(() => store.save({ bytes: Buffer.alloc(0), mime: 'image/png' }), { code: 'INVALID_REQUEST' });
    assert.throws(() => store.save({ bytes: Buffer.alloc(17), mime: 'image/png' }), { code: 'PAYLOAD_TOO_LARGE' });
  } finally { cleanup(); }
});

test('数量上限与 sweep：超量拒绝，sweep 至少保留一份', () => {
  const { store, cleanup } = withStore({ maxArtifacts: 2 });
  try {
    store.save({ bytes: Buffer.from('a'), mime: 'image/png' });
    store.save({ bytes: Buffer.from('b'), mime: 'image/png' });
    assert.throws(() => store.save({ bytes: Buffer.from('c'), mime: 'image/png' }), { code: 'ARTIFACT_STORE_FULL' });
    // 全部视为超龄：最多删到只剩一份
    const result = store.sweep({ maxAgeDays: -1 });
    assert.equal(result.removed, 1);
    assert.equal(store.list().length, 1);
  } finally { cleanup(); }
});

test('重启后按目录重建索引，引用仍然可用', () => {
  const { store, dir, cleanup } = withStore();
  try {
    const saved = store.save({ bytes: Buffer.from('persist me'), mime: 'image/png' });
    const reopened = createArtifactStore({ dir });
    const meta = reopened.meta(saved.artifactId);
    assert.ok(meta, '重启后要能按 id 找到');
    assert.equal(meta.sha256, saved.sha256);
    assert.deepEqual(Buffer.from(reopened.get(saved.artifactId).bytes), Buffer.from('persist me'));
  } finally { cleanup(); }
});

test('扩展名映射：PSD/PNG/JPEG 认识，其他不猜', () => {
  assert.equal(extensionFor('image/vnd.adobe.photoshop'), 'psd');
  assert.equal(extensionFor('image/png'), 'png');
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('application/pdf'), null);
});
