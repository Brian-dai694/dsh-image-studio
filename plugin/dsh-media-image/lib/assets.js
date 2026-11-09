import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_ASSET_STORE_BYTES = 256 * 1024 * 1024;
export const MAX_ASSETS = 128;
const MEMORY_CACHE = 8;

const MIME_BY_SIGNATURE = [
  { mime: 'image/png', ext: 'png', test: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mime: 'image/jpeg', ext: 'jpg', test: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: bytes => bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
];

export function sniffImage(bytes) {
  return MIME_BY_SIGNATURE.find(item => item.test(bytes)) ?? null;
}

const isDir = dir => typeof dir === 'string' && dir.length > 0;

/**
 * 素材库。给了 dir 就落盘（索引 assets.json + blobs/<id>），否则只在内存里。
 * 落盘时字节默认懒读，内存只留最近几次用过的，避免一次启动把几百 MB 读进来。
 */
export function createAssetStore({ dir = null, maxAssetBytes = MAX_ASSET_BYTES, maxTotalBytes = MAX_ASSET_STORE_BYTES, maxAssets = MAX_ASSETS } = {}) {
  const root = isDir(dir) ? dir : null;
  const blobsDir = root ? join(root, 'blobs') : null;
  const indexPath = root ? join(root, 'assets.json') : null;
  const assets = new Map();
  const cache = new Map();
  let totalBytes = 0;

  const metadata = asset => ({ id: asset.id, name: asset.name, mime: asset.mime, bytes: asset.size, createdAt: asset.createdAt });

  const blobPath = id => (blobsDir ? join(blobsDir, id) : null);

  function persistIndex() {
    if (!indexPath) return;
    const rows = [...assets.values()].map(asset => ({ id: asset.id, name: asset.name, mime: asset.mime, size: asset.size, createdAt: asset.createdAt, persisted: !!asset.persisted }));
    const tmp = `${indexPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
    renameSync(tmp, indexPath);
  }

  function remember(asset) {
    cache.set(asset.id, asset);
    while (cache.size > MEMORY_CACHE) cache.delete(cache.keys().next().value);
  }

  function hydrate() {
    if (!root) return { loaded: 0, skipped: 0 };
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    if (!existsSync(blobsDir)) mkdirSync(blobsDir, { recursive: true });
    if (!existsSync(indexPath)) return { loaded: 0, skipped: 0 };
    let rows = [];
    try { rows = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { return { loaded: 0, skipped: 0 }; }
    if (!Array.isArray(rows)) return { loaded: 0, skipped: 0 };
    let loaded = 0, skipped = 0;
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !/^[a-f0-9]{48}$/.test(row.id) || typeof row.size !== 'number') { skipped += 1; continue; }
      if (assets.size >= maxAssets || totalBytes + row.size > maxTotalBytes) { skipped += 1; continue; }
      if (!existsSync(blobPath(row.id))) { skipped += 1; continue; }
      assets.set(row.id, { id: row.id, name: String(row.name || 'image'), mime: String(row.mime || 'image/png'), size: row.size, createdAt: Number(row.createdAt) || Date.now(), persisted: true });
      totalBytes += row.size;
      loaded += 1;
    }
    return { loaded, skipped };
  }

  const restored = hydrate();

  return {
    add({ bytes, name = 'generated-image' }) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1) throw Object.assign(new Error('Image data is empty.'), { code: 'INVALID_IMAGE' });
      if (bytes.length > maxAssetBytes) throw Object.assign(new Error(`Image exceeds ${maxAssetBytes} byte limit.`), { code: 'PAYLOAD_TOO_LARGE' });
      const type = sniffImage(bytes);
      if (!type) throw Object.assign(new Error('Only PNG, JPEG and WebP assets are supported.'), { code: 'UNSUPPORTED_IMAGE_TYPE' });
      if (assets.size >= maxAssets || totalBytes + bytes.length > maxTotalBytes) throw Object.assign(new Error('Temporary image asset storage is full.'), { code: 'ASSET_STORE_FULL' });
      const safeName = typeof name === 'string' ? name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120) || `image.${type.ext}` : `image.${type.ext}`;
      const id = randomBytes(24).toString('hex');
      const asset = { id, name: safeName, mime: type.mime, size: bytes.length, createdAt: Date.now(), persisted: false, bytes: Buffer.from(bytes) };
      if (root) {
        try {
          writeFileSync(blobPath(id), bytes);
          asset.persisted = true;
          delete asset.bytes;
        } catch {
          // 落盘失败不能让上传失败：退回内存态，并把 persisted 标成 false。
          asset.persisted = false;
        }
      }
      assets.set(id, asset);
      totalBytes += asset.size;
      remember(asset);
      persistIndex();
      return metadata(asset);
    },
    get(id) {
      const asset = assets.get(id);
      if (!asset) return null;
      if (asset.bytes) return { id: asset.id, name: asset.name, mime: asset.mime, bytes: asset.bytes, createdAt: asset.createdAt };
      if (!asset.persisted) return null;
      try {
        const bytes = readFileSync(blobPath(asset.id));
        asset.bytes = bytes;
        remember(asset);
        return { id: asset.id, name: asset.name, mime: asset.mime, bytes, createdAt: asset.createdAt };
      } catch {
        return null;
      }
    },
    list() { return [...assets.values()].map(metadata); },
    get totalBytes() { return totalBytes; },
    get persistent() { return !!root; },
    get restoredCount() { return restored.loaded; },
    // 只清内存缓存；落盘的素材属于用户，不在这里删。
    clear() {
      if (!root) { assets.clear(); totalBytes = 0; cache.clear(); return; }
      cache.clear();
      for (const asset of assets.values()) delete asset.bytes;
    },
    // 仅用于测试/运维：真正删掉落盘文件。
    purge() {
      assets.clear(); cache.clear(); totalBytes = 0;
      if (root) { try { rmSync(blobsDir, { recursive: true, force: true }); rmSync(indexPath, { force: true }); } catch { /* 已经不在 */ } }
    },
  };
}
