import { randomBytes } from 'node:crypto';

export const MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_ASSET_STORE_BYTES = 256 * 1024 * 1024;
export const MAX_ASSETS = 128;

const MIME_BY_SIGNATURE = [
  { mime: 'image/png', ext: 'png', test: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  { mime: 'image/jpeg', ext: 'jpg', test: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: bytes => bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
];

export function sniffImage(bytes) {
  return MIME_BY_SIGNATURE.find(item => item.test(bytes)) ?? null;
}

export function createAssetStore({ maxAssetBytes = MAX_ASSET_BYTES, maxTotalBytes = MAX_ASSET_STORE_BYTES, maxAssets = MAX_ASSETS } = {}) {
  const assets = new Map();
  let totalBytes = 0;

  function metadata(asset) {
    return { id: asset.id, name: asset.name, mime: asset.mime, bytes: asset.bytes.length, createdAt: asset.createdAt };
  }

  return {
    add({ bytes, name = 'generated-image' }) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 1) throw Object.assign(new Error('Image data is empty.'), { code: 'INVALID_IMAGE' });
      if (bytes.length > maxAssetBytes) throw Object.assign(new Error(`Image exceeds ${maxAssetBytes} byte limit.`), { code: 'PAYLOAD_TOO_LARGE' });
      const type = sniffImage(bytes);
      if (!type) throw Object.assign(new Error('Only PNG, JPEG and WebP assets are supported.'), { code: 'UNSUPPORTED_IMAGE_TYPE' });
      if (assets.size >= maxAssets || totalBytes + bytes.length > maxTotalBytes) throw Object.assign(new Error('Temporary image asset storage is full.'), { code: 'ASSET_STORE_FULL' });
      const safeName = typeof name === 'string' ? name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120) || `image.${type.ext}` : `image.${type.ext}`;
      const asset = { id: randomBytes(24).toString('hex'), name: safeName, mime: type.mime, bytes: Buffer.from(bytes), createdAt: Date.now() };
      assets.set(asset.id, asset);
      totalBytes += asset.bytes.length;
      return metadata(asset);
    },
    get(id) { return assets.get(id) ?? null; },
    list() { return [...assets.values()].map(metadata); },
    get totalBytes() { return totalBytes; },
    clear() { assets.clear(); totalBytes = 0; },
  };
}
