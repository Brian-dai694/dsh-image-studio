// 受控远程拉取：联网取素材/字体只走这一条路。
//
// 为什么要有守卫：这是插件里唯一"由外部 URL 驱动出站请求"的地方，直接照 URL 下载等于给
// 任意地址开一个代理（SSRF）。所以固定四条：只允许 http/https、默认拦内网与回环、
// 限字节数、跳转逐跳复核（不能靠 redirect: follow 蒙过去）。
//
// 注意：本模块只负责"把字节安全拿回来"，内容是不是合法图片/字体由各自的 store 用文件签名判断。

export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const isPrivateHost = host => {
  const name = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name === '0.0.0.0') return true;
  if (name === '::1' || name.startsWith('fc') || name.startsWith('fd') || name.startsWith('fe80')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a === 0;
};

const hostAllowed = (host, allowHosts) => {
  if (!Array.isArray(allowHosts) || !allowHosts.length) return true;
  const name = String(host).toLowerCase();
  return allowHosts.some(entry => {
    const allowed = String(entry).toLowerCase();
    return name === allowed || name.endsWith(`.${allowed}`);
  });
};

export class RemoteError extends Error {
  constructor(code, message) { super(message); this.name = 'RemoteError'; this.code = code; }
}

function parseTarget(raw, { allowHosts, allowPrivate }) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new RemoteError('URL_INVALID', 'URL 无法解析'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new RemoteError('URL_INVALID', '只允许 http/https');
  if (!allowPrivate && isPrivateHost(url.hostname)) throw new RemoteError('URL_FORBIDDEN', `拒绝访问内网/回环地址：${url.hostname}`);
  if (!hostAllowed(url.hostname, allowHosts)) throw new RemoteError('URL_FORBIDDEN', `该主机不在允许清单内：${url.hostname}`);
  return url;
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RemoteError('PAYLOAD_TOO_LARGE', `内容超过 ${maxBytes} 字节上限`);
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new RemoteError('PAYLOAD_TOO_LARGE', `内容超过 ${maxBytes} 字节上限`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* 已断开就算了 */ }
      throw new RemoteError('PAYLOAD_TOO_LARGE', `内容超过 ${maxBytes} 字节上限`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchRemoteBytes(rawUrl, {
  fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = 15_000, allowHosts = null, allowPrivate = false,
} = {}) {
  let target = parseTarget(rawUrl, { allowHosts, allowPrivate });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(target.href, { redirect: 'manual', signal: controller.signal });
    } catch (error) {
      throw new RemoteError('URL_UNREACHABLE', `拉取失败：${error?.message || 'network error'}`);
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.('location');
      if (!location) throw new RemoteError('URL_INVALID', '跳转缺少 Location');
      // 逐跳复核：跳转目标同样要过协议/内网/清单检查，否则 allowlist 形同虚设。
      target = parseTarget(new URL(location, target).href, { allowHosts, allowPrivate });
      continue;
    }
    if (!response.ok) throw new RemoteError('URL_UNREACHABLE', `拉取失败：HTTP ${response.status}`);
    const bytes = await readCapped(response, maxBytes);
    return { bytes, contentType: response.headers?.get?.('content-type') || null, finalUrl: target.href };
  }
  throw new RemoteError('URL_INVALID', '跳转次数过多');
}
