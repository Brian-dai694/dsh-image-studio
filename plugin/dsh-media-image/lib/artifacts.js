// 导出产物落盘。为什么需要它：编辑器导出的 artifactRef 是页面内 blob: URL，
// Host 打不开；relay 单帧上限 64 KiB，几 MB 的 PSD 根本过不来。
// 所以由页面把字节 POST 到插件自己的同源路由，这里负责存盘、算 sha256、给出真实路径。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_ARTIFACTS = 64;

/** 允许的产物类型 → 落盘扩展名。PSD 是主目标，PNG/JPEG 供预览与截图复用。 */
const EXTENSIONS = {
  'image/vnd.adobe.photoshop': 'psd',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/octet-stream': 'bin',
};

export function extensionFor(mime) {
  return EXTENSIONS[mime] ?? null;
}

const isDir = dir => typeof dir === 'string' && dir.length > 0;

/**
 * 产物库。没给 dir 时不可用（返回 null 构造），路由层据此报 ARTIFACTS_UNAVAILABLE——
 * 不往临时目录写东西冒充"已持久化"。
 */
export function createArtifactStore({
  dir = null,
  maxArtifactBytes = MAX_ARTIFACT_BYTES,
  maxTotalBytes = MAX_ARTIFACT_TOTAL_BYTES,
  maxArtifacts = MAX_ARTIFACTS,
} = {}) {
  const root = isDir(dir) ? resolve(dir) : null;
  /** @type {Map<string, {artifactId:string,path:string,bytes:number,sha256:string,name:string,mime:string,createdAt:number}>} */
  const entries = new Map();
  let totalBytes = 0;

  if (root) {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    // 索引不存在时按目录内容重建：宁可多扫一次，也不让重启后路径失效。
    for (const file of existsSync(root) ? readdirSync(root) : []) {
      if (!/^[a-f0-9]{32}\.[a-z]+$/.test(file)) continue;
      const artifactId = file.slice(0, 32);
      const full = join(root, file);
      const bytes = statSync(full).size;
      const mime = Object.entries(EXTENSIONS).find(([, ext]) => file.endsWith(`.${ext}`))?.[0] ?? 'application/octet-stream';
      entries.set(artifactId, {
        artifactId, path: full, bytes,
        sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
        name: file, mime, createdAt: statSync(full).mtimeMs,
      });
      totalBytes += bytes;
    }
  }

  const fail = (code, message) => Object.assign(new Error(message), { code });

  return {
    available: Boolean(root),
    root,

    /** 存一份产物；超出单文件/总量/个数上限时明确拒绝，不静默丢弃。 */
    save({ bytes, name = 'artifact', mime = 'application/octet-stream' } = {}) {
      if (!root) throw fail('ARTIFACTS_UNAVAILABLE', '未配置 dataDir，导出产物无法落盘。');
      const ext = extensionFor(mime);
      if (!ext) throw fail('UNSUPPORTED_ARTIFACT_TYPE', `不支持的产物类型：${mime}`);
      const size = bytes?.length ?? 0;
      if (!size) throw fail('INVALID_REQUEST', '产物为空。');
      if (size > maxArtifactBytes) throw fail('PAYLOAD_TOO_LARGE', `产物超过单文件上限（${maxArtifactBytes} 字节）。`);
      if (entries.size >= maxArtifacts) throw fail('ARTIFACT_STORE_FULL', `产物数量已达上限（${maxArtifacts}）。`);
      if (totalBytes + size > maxTotalBytes) throw fail('ARTIFACT_STORE_FULL', `产物总量已达上限（${maxTotalBytes} 字节）。`);

      const artifactId = randomBytes(16).toString('hex');
      const path = join(root, `${artifactId}.${ext}`);
      writeFileSync(path, bytes);
      const entry = {
        artifactId, path, bytes: size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        name: String(name).slice(0, 120), mime, createdAt: Date.now(),
      };
      entries.set(artifactId, entry);
      totalBytes += size;
      return { ...entry };
    },

    get(artifactId) {
      const entry = entries.get(artifactId);
      if (!entry || !root) return null;
      if (!existsSync(entry.path)) { entries.delete(artifactId); totalBytes -= entry.bytes; return null; }
      return { ...entry, bytes: readFileSync(entry.path) };
    },

    meta(artifactId) { return entries.get(artifactId) ? { ...entries.get(artifactId) } : null; },

    list() { return [...entries.values()].map(item => ({ ...item })); },

    /** 清掉超龄或超量的旧产物（插件启动/落盘前调用，避免目录无限增长）。 */
    sweep({ maxAgeDays = 7, maxTotalBytes: cap = maxTotalBytes } = {}) {
      if (!root) return { removed: 0 };
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      let removed = 0;
      const ordered = [...entries.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const entry of ordered) {
        const overCap = totalBytes > cap;
        if (entry.createdAt >= cutoff && !overCap) continue;
        if (entries.size <= 1) break; // 至少留一份
        try { unlinkSync(entry.path); } catch { /* 文件已不在 */ }
        entries.delete(entry.artifactId);
        totalBytes -= entry.bytes;
        removed += 1;
      }
      return { removed };
    },

    get totalBytes() { return totalBytes; },
  };
}
