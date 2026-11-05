// Trusted same-origin parent for the packaged miniPaint page.
// It only wires the editor into the image relay: boot token, MessageChannel transport and
// the relay polling loop. Tool calls stay in the model session (media_image_*); this page
// never touches the DSH tool surface and never writes project files.
import { createIframeTransport } from '/media-image/host/iframe-transport.mjs';
import { startBrowserRelay } from '/media-image/host/browser-relay.mjs';

const $ = id => document.getElementById(id);
const show = value => { $('output').textContent = JSON.stringify(value, null, 2); };
const fail = error => show({ code: error.code || 'UI_ERROR', message: error.message, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) });

let accessToken = null;
let transport = null;
let relay = null;
let connecting = null;

async function boot() {
  if (accessToken) return accessToken;
  // 自定义头是同源判据：跨源页要带它必须先过 CORS 预检，而服务端不响应预检。
  // 桌面端（Electron/webview）不带 Sec-Fetch-*，只靠那几个头会把同源页自己挡成 403。
  const response = await fetch('/media-image/boot', { credentials: 'same-origin', headers: { 'x-dsh-media-boot': '1' } });
  if (!response.ok) {
    // 403 正文带着服务端观测到的请求头：只报状态码的话，用户没法把真实原因告诉我们。
    let detail = '';
    try {
      const body = await response.json();
      detail = [body.reason, body.observed ? JSON.stringify(body.observed) : ''].filter(Boolean).join(' · ');
    } catch { /* 响应不是 JSON 就只报状态码 */ }
    throw Object.assign(new Error(`无法获取同源令牌（HTTP ${response.status}）${detail ? '：' + detail : ''}`), { code: 'BOOT_FAILED' });
  }
  accessToken = (await response.json()).accessToken;
  return accessToken;
}

async function connect() {
  if (relay) return relay;
  if (connecting) return connecting;
  connecting = (async () => {
    await boot();
    transport = createIframeTransport({
      iframe: $('editor'), origin: location.origin,
      // 只读推送：转给面板渲染建议，不在这里缓存成第二份文档状态。
      onEvent: frame => {
        if (frame && frame.type === 'editor.selection_changed') {
          parent.postMessage({ type: 'media.selection.changed', editorInstanceId: frame.editorInstanceId, revision: frame.revision, selectedObjectIds: frame.selectedObjectIds || [], objectKind: frame.objectKind || null, at: frame.at || Date.now() }, location.origin);
        }
      },
    });
    relay = await startBrowserRelay({
      transport,
      accessToken,
      baseUrl: '/media-image/relay',
      editorKind: 'image',
      onError: error => { $('status').textContent = `连接异常：${error.message}；未完成命令的结果可能未知`; },
    });
    $('status').textContent = `已绑定 image relay · 实例 ${relay.editorInstanceId} · page ${relay.pageId}`;
    return relay;
  })();
  try { return await connecting; } finally { connecting = null; }
}

// Diagnostic read only: goes straight through the MessageChannel transport, not the tools.
async function readState() {
  const connection = await connect();
  show(await transport.request({
    type: 'editor.read_state',
    requestId: crypto.randomUUID(),
    editorInstanceId: connection.editorInstanceId,
  }));
}

async function reconnect() {
  const previous = relay?.editorInstanceId;
  await relay?.stop();
  relay = null;
  const current = await connect();
  if (previous && previous !== current.editorInstanceId) {
    show({ status: 'unknown', message: '编辑器实例已变化；原命令结果未知，禁止自动重放，请用原 commandId 查询' });
  }
}

for (const [id, action] of [['connect', connect], ['reconnect', reconnect], ['read', readState]]) {
  $(id).addEventListener('click', () => void action().catch(fail));
}

// Embedded as a sidebar panel there is no one to press "connect": bind on load so the
// editor is registered with the relay before the user or the model touches it.
$('editor').addEventListener('load', () => {
  if (relay) return;
  $('status').textContent = '编辑器已加载，正在自动连接 image relay…';
  void connect().catch(fail);
});
// Parent client can read identity, never dispatch writes through this channel.
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== parent || typeof event.data?.type !== 'string') return;
  // Real save entry for an agent export: the Host keeps only a synthetic artifact ref, so the
  // file can only be produced here, inside the page that holds the editor.
  if (event.data.type === 'media.export.download') {
    const requestId = event.data.requestId, format = event.data.format === 'jpeg' ? 'jpeg' : 'png';
    try {
      const connection = await connect();
      const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
      const result = await transport.request({
        type: 'editor.export_start', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId,
        documentId: state.documentId, expectedRevision: state.revision, commandId: crypto.randomUUID(), format,
      });
      if (!result || result.status !== 'completed' || !result.artifactRef) throw new Error('导出未完成，无法保存');
      const link = document.createElement('a');
      link.href = result.artifactRef; link.download = 'image.' + (format === 'jpeg' ? 'jpg' : 'png');
      link.click();
      parent.postMessage({ type: 'media.export.result', requestId, ok: true, artifactRef: result.artifactRef, bytes: result.bytes ?? null }, location.origin);
    } catch (error) {
      parent.postMessage({ type: 'media.export.result', requestId, ok: false, error: error.message }, location.origin);
    }
    return;
  }
  if (event.data.type === 'media.highlight.request') {
    const requestId = event.data.requestId;
    try {
      const connection = await connect();
      const result = await transport.request({
        type: 'editor.highlight', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId,
        objectIds: event.data.objectIds, ttlMs: event.data.ttlMs,
      }, { timeoutMs: 2000 });
      parent.postMessage({ type: 'media.highlight.result', requestId, ok: true, matched: result?.matched || [], missing: result?.missing || [] }, location.origin);
    } catch (error) {
      parent.postMessage({ type: 'media.highlight.result', requestId, ok: false, error: { code: error.code || 'EDITOR_ERROR', message: error.message } }, location.origin);
    }
    return;
  }
  // 面板授权：本人点一次「授权此会话读写本工程」。票据由 Host 签发、一次性、5 分钟，
  // Agent 既没有这个入口也不能代点；这里只负责把点击转成一次同源 POST 并把结果回给面板。
  if (event.data.type === 'media.bind.request' || event.data.type === 'media.bind.revoke') {
    const requestId = event.data.requestId;
    const revoke = event.data.type === 'media.bind.revoke';
    try {
      const connection = await connect();
      const token = await boot();
      const payload = { sessionId: event.data.sessionId };
      if (revoke) payload.action = 'revoke';
      else {
        const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
        payload.instanceId = connection.editorInstanceId;
        payload.projectId = state.documentId;
      }
      const response = await fetch('/media-image/bind', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1' },
        body: JSON.stringify(payload),
      });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.message || '授权失败'), { code: value.code });
      parent.postMessage({ type: revoke ? 'media.bind.revoked' : 'media.bind.result', requestId, ok: true, ...(value.ticket ? { ticket: value.ticket } : {}) }, location.origin);
    } catch (error) {
      parent.postMessage({ type: revoke ? 'media.bind.revoked' : 'media.bind.result', requestId, ok: false, error: { code: error.code || 'BIND_FAILED', message: error.message } }, location.origin);
    }
    return;
  }
  if (event.data.type !== 'media.binding.read') return;
  const requestId = event.data.requestId;
  try {
    const connection = await connect();
    const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
    parent.postMessage({ type: 'media.binding.result', requestId, binding: { editorKind: 'image', projectId: state.documentId, documentId: state.documentId, editorInstanceId: connection.editorInstanceId, pageId: connection.pageId } }, location.origin);
  } catch (error) {
    parent.postMessage({ type: 'media.binding.result', requestId, error: error.message }, location.origin);
  }
});
window.addEventListener('pagehide', () => { void relay?.stop(); });
