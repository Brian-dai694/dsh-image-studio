// 素材落盘：设了 dataDir 就重启不丢；落盘失败退回内存；未设 dataDir 时行为不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetStore } from '../lib/assets.js';

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from('persisted-asset-fixture'),
]);

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-assets-'));
}

test('没有 dataDir 时保持纯内存（行为不变）', () => {
  const store = createAssetStore();
  assert.equal(store.persistent, false);
  const asset = store.add({ bytes: PNG, name: 'a.png' });
  assert.equal(store.get(asset.id).bytes.length, PNG.length);
  store.clear();
  assert.equal(store.list().length, 0);
});

test('给了目录就落盘：新实例能读回同样的字节与元数据', () => {
  const dir = tempDir();
  try {
    const first = createAssetStore({ dir });
    assert.equal(first.persistent, true);
    const asset = first.add({ bytes: PNG, name: '商品图.png' });
    assert.ok(existsSync(join(dir, 'blobs', asset.id)), '字节要写到 blobs/<id>');
    assert.ok(existsSync(join(dir, 'assets.json')), '要写索引');

    const second = createAssetStore({ dir });
    assert.equal(second.restoredCount, 1, '重启后应恢复 1 个素材');
    const rows = second.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '商品图.png');
    assert.equal(rows[0].bytes, PNG.length);
    const back = second.get(asset.id);
    assert.ok(back, '懒读应拿回字节');
    assert.deepEqual(back.bytes, PNG, '字节必须逐字节一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重启后 id 不变，引用仍然可用；clear 不删用户文件', () => {
  const dir = tempDir();
  try {
    const first = createAssetStore({ dir });
    const asset = first.add({ bytes: PNG, name: 'keep.png' });
    const second = createAssetStore({ dir });
    assert.equal(second.list()[0].id, asset.id, 'id 必须稳定，否则 asset:<id> 引用会断');
    second.clear();
    assert.equal(second.list().length, 1, 'clear 只清内存缓存，不删落盘素材');
    assert.ok(existsSync(join(dir, 'blobs', asset.id)));
    assert.ok(second.get(asset.id), '清缓存后仍能读回');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('索引损坏时不让插件起不来：跳过坏行，其余照常', () => {
  const dir = tempDir();
  try {
    const first = createAssetStore({ dir });
    const asset = first.add({ bytes: PNG, name: 'ok.png' });
    writeFileSync(join(dir, 'assets.json'), JSON.stringify([{ id: 'not-a-valid-id', size: 10 }, { id: asset.id, name: 'ok.png', mime: 'image/png', size: PNG.length }]), 'utf8');
    const second = createAssetStore({ dir });
    assert.equal(second.list().length, 1, '只恢复合法行');
    assert.equal(second.list()[0].id, asset.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('上限仍然生效：超过 maxAssets 的旧素材不会被恢复', () => {
  const dir = tempDir();
  try {
    const first = createAssetStore({ dir });
    first.add({ bytes: PNG, name: 'a.png' });
    first.add({ bytes: PNG, name: 'b.png' });
    const capped = createAssetStore({ dir, maxAssets: 1 });
    assert.equal(capped.restoredCount, 1);
    assert.equal(capped.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
