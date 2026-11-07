// Configurable background-removal adapter. Sends one uploaded asset to an authenticated
// rembg-compatible endpoint and stores the returned transparent PNG as a new asset.
import { sniffImage } from './assets.js';

export class BackgroundRemovalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackgroundRemovalError';
    this.code = code;
  }
}

function pngHasAlpha(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  // IHDR color type: 4 = gray+alpha, 6 = RGBA. Palette transparency via tRNS is also valid.
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'tRNS') return true;
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return false;
}

export function createBackgroundRemovalService({ endpoint, apiKey, assets, fetchImpl = globalThis.fetch, timeoutMs = 90_000 } = {}) {
  if (!assets || typeof assets.get !== 'function' || typeof assets.add !== 'function') throw new TypeError('assets store is required');
  if (!endpoint) return null;
  let url;
  try { url = new URL(endpoint); } catch { throw new BackgroundRemovalError('BACKGROUND_REMOVAL_CONFIG', 'backgroundRemoval.endpoint must be an absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new BackgroundRemovalError('BACKGROUND_REMOVAL_CONFIG', 'backgroundRemoval.endpoint must use http or https');
  if (typeof fetchImpl !== 'function') throw new BackgroundRemovalError('BACKGROUND_REMOVAL_CONFIG', 'fetch is unavailable');

  return {
    describe() { return { ready: true, endpoint: url.origin, hasApiKey: !!apiKey }; },
    async remove({ assetRef }) {
      const match = /^asset:([a-f0-9]{48})$/.exec(String(assetRef || ''));
      if (!match) throw new BackgroundRemovalError('INVALID_ASSET_REF', 'Choose an uploaded image first.');
      const source = assets.get(match[1]);
      if (!source) throw new BackgroundRemovalError('ASSET_NOT_FOUND', 'The source image expired; upload it again.');

      const form = new FormData();
      form.append('image_file', new Blob([source.bytes], { type: source.mime }), source.name || 'image.png');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: apiKey ? { 'x-api-key': apiKey } : {},
          body: form,
          signal: controller.signal,
        });
      } catch (error) {
        throw new BackgroundRemovalError('BACKGROUND_REMOVAL_UNREACHABLE', `Background-removal service unavailable: ${error?.message || 'network error'}`);
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new BackgroundRemovalError('BACKGROUND_REMOVAL_FAILED', `Background-removal service returned HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!sniffImage(bytes) || !pngHasAlpha(bytes)) {
        throw new BackgroundRemovalError('BACKGROUND_REMOVAL_INVALID_OUTPUT', 'Service output is not a PNG with transparency; no result was saved.');
      }
      const asset = assets.add({ bytes, name: `${source.name || 'image'}-background-removed.png` });
      return { asset, sourceRef: `asset:${asset.id}`, sourceAssetRef: assetRef };
    },
  };
}
