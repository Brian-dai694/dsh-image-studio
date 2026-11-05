// Trusted same-origin parent for the packaged miniPaint page.
// It only wires the editor into the image relay: boot token, MessageChannel transport and
// the relay polling loop. Tool calls stay in the model session (media_image_*); this page
// never touches the DSH tool surface and never writes project files.
import { createIframeTransport } from '/media/host/iframe-transport.mjs';
import { startBrowserRelay } from '/media/host/browser-relay.mjs';

const $ = id => document.getElementById(id);
const show = value => { $('output').textContent = JSON.stringify(value, null, 2); };
const fail = error => show({ code: error.code || 'UI_ERROR', message: error.message, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) });

let accessToken = null;
let transport = null;
let relay = null;
let connecting = null;

async function boot() {
  if (accessToken) return accessToken;
  const response = await fetch('/media/boot', { credentials: 'same-origin' });
  if (!response.ok) throw Object.assign(new Error(`无法获取同源令牌（HTTP ${response.status}）`), { code: 'BOOT_FAILED' });
  accessToken = (await response.json()).accessToken;
  return accessToken;
}

async function connect() {
  if (relay) return relay;
  if (connecting) return connecting;
  connecting = (async () => {
    await boot();
    transport = createIframeTransport({ iframe: $('editor'), origin: location.origin });
    relay = await startBrowserRelay({
      transport,
      accessToken,
      baseUrl: '/media/image-relay',
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
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'media.binding.read') return;
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
