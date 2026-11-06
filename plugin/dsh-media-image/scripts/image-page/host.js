// Trusted same-origin parent for the packaged miniPaint page.
// It only wires the editor into the image relay: boot token, MessageChannel transport and
// the relay polling loop. Tool calls stay in the model session (media_image_*); this page
// never touches the DSH tool surface and never writes project files.
import { createIframeTransport } from '/media-image/host/iframe-transport.mjs';
import { startBrowserRelay } from '/media-image/host/browser-relay.mjs';

const $ = id => document.getElementById(id);
const show = value => { $('output').textContent = JSON.stringify(value, null, 2); };
const fail = error => show({ code: error.code || 'UI_ERROR', message: error.message, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) });

window.addEventListener('message', async event => {
  if (event.source !== $('editor')?.contentWindow || event.origin !== location.origin || event.data?.type !== 'dsh.asset.token.request' || typeof event.data.requestId !== 'string') return;
  // 编辑器可能先于本页 boot() 就绪：先确保拿到令牌再应答，否则请求会被静默丢弃、编辑器 5 秒后超时。
  let token;
  try { token = await boot(); } catch (error) { fail(error); return; }
  $('editor').contentWindow.postMessage({ type: 'dsh.asset.token', requestId: event.data.requestId, token }, location.origin);
});

let accessToken = null;
let transport = null;
let relay = null;
let connecting = null;

export async function uploadImageAsset(file, { fetchImpl = fetch, baseUrl = '/media-image/assets' } = {}) {
  if (!(file instanceof Blob) || file.size < 1) throw new Error('请选择非空图片文件');
  if (file.size > 32 * 1024 * 1024) throw new Error('图片不能超过 32 MiB');
  const token = await boot();
  const name = file.name || 'generated-image';
  const response = await fetchImpl(`${baseUrl}/upload`, {
    method: 'POST', credentials: 'same-origin', body: file,
    headers: { Authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1', 'x-dsh-media-asset': '1', 'x-dsh-media-name': encodeURIComponent(name) },
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message || '素材上传失败'), { code: result.code || 'ASSET_UPLOAD_FAILED' });
  return result.asset;
}

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
    const token = await boot();
    transport = createIframeTransport({
      iframe: $('editor'), origin: location.origin, connectPayload: { assetToken: token },
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
// 统一的本插件路由调用：同源 + Bearer + 自定义头（桌面端不带 Sec-Fetch-*，靠自定义头过判据）。
async function api(pathname, { method = 'GET', body } = {}) {
  const token = await boot();
  const headers = { authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1', 'x-dsh-media-asset': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(pathname, {
    method, credentials: 'same-origin', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(value?.message || `HTTP ${response.status}`), { code: value?.code || 'REQUEST_FAILED' });
  return value;
}

const setPill = (id, state) => {
  const pill = $(id);
  if (!pill) return;
  pill.textContent = state || 'idle';
  pill.className = `pill ${state || ''}`.trim();
};

// 本页已知素材：素材库没有列表路由，这里只记本页产生/导入的，别谎称是"全部"。
const knownAssets = [];

function renderAssets() {
  const list = $('asset-list');
  if (!list) return;
  list.textContent = '';
  for (const asset of knownAssets) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${asset.name || 'image'} · ${asset.bytes} B · asset:${String(asset.id).slice(0, 8)}…`;
    const copy = document.createElement('button');
    copy.textContent = '复制引用';
    copy.addEventListener('click', () => {
      const ref = `asset:${asset.id}`;
      void navigator.clipboard?.writeText(ref).then(
        () => { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制引用'; }, 1200); },
        () => { $('asset-status').textContent = ref; },
      );
    });
    item.append(label, copy);
    // 每个素材都能直接插成图层（带确认对话框）。
    const insert = document.createElement('button');
    insert.textContent = '插入为图层';
    insert.addEventListener('click', () => void insertAssetAsLayer(asset));
    item.append(insert);
    list.append(item);
  }
}

function rememberAsset(asset) {
  if (!asset?.id || knownAssets.some(item => item.id === asset.id)) return;
  knownAssets.unshift(asset);
  renderAssets();
}

// ── 面板内直接插入图层 ──
// 走 editor.apply_command（和模型工具同一条编辑器契约）。人工确认由本页的对话框承担：
// 点击者就是用户本人，所以不需要再走一次宿主审批。未知结果只允许按 commandId 查询，绝不重发。
function askConfirm({ title, details, maskAvailable }) {
  return new Promise(resolve => {
    const modal = $('confirm-modal');
    if (!modal || typeof modal.showModal !== 'function') { resolve({ ok: false, reason: 'NO_MODAL' }); return; }
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = details;
    const maskRow = $('confirm-mask-row');
    const maskBox = $('confirm-mask');
    maskRow.style.display = maskAvailable ? 'block' : 'none';
    if (maskBox) maskBox.checked = false;
    const done = value => {
      modal.removeEventListener('close', onClose);
      resolve(typeof value === 'string' ? { ok: value === 'ok', useMask: !!(maskBox && maskBox.checked && maskAvailable) } : { ok: false, reason: 'DISMISSED' });
    };
    const onClose = () => done(modal.returnValue);
    modal.addEventListener('close', onClose);
    modal.returnValue = '';
    modal.showModal();
  });
}

let lastInsert = null;

async function insertAssetAsLayer(asset) {
  if (!asset?.id) return;
  const statusEl = $('asset-status');
  try {
    const connection = await connect();
    const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
    const sourceRef = `asset:${asset.id}`;
    const maskAvailable = !!(state.selection && state.selection.width > 0 && state.selection.height > 0);
    const answer = await askConfirm({
      title: '插入为图层',
      details: [
        `sourceRef  ${sourceRef}`,
        `目标工程  ${state.documentId} · R${state.revision}`,
        `画布      ${state.canvas.width}×${state.canvas.height}`,
        maskAvailable ? `蒙版      当前选区 ${state.selection.width}×${state.selection.height}` : '蒙版      无（未检测到选区）',
      ].join('\n'),
      maskAvailable,
    });
    if (!answer.ok) { statusEl.textContent = '已取消，没有发送任何命令。'; return; }

    const params = { sourceRef, name: asset.name || '插入的素材' };
    if (answer.useMask) { params.maskRef = 'selection:'; }
    const commandId = crypto.randomUUID();
    const result = await transport.request({
      type: 'editor.apply_command',
      requestId: crypto.randomUUID(),
      editorInstanceId: connection.editorInstanceId,
      documentId: state.documentId,
      expectedRevision: state.revision,
      commandId,
      command: { type: 'layer.add_image', payload: params },
    }, { timeoutMs: 15000 });

    lastInsert = { commandId, revision: result?.revision, changed: result?.changedObjectIds || [] };
    statusEl.textContent = `已插入图层 · R${result?.revision}${answer.useMask ? '（带选区蒙版）' : ''}`;
    show(await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId }));
  } catch (error) {
    const code = error.code || 'INSERT_FAILED';
    if (code === 'REVISION_CONFLICT') {
      statusEl.textContent = '工程已变化（REVISION_CONFLICT）：请重新点一次插入，会用最新 revision。';
    } else if (code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' || error.outcomeUnknown) {
      statusEl.textContent = `结果未知（${lastInsert?.commandId || '命令已发出'}）：不要重发，用该 commandId 查询结果。`;
    } else {
      statusEl.textContent = `${code}：${error.message}`;
    }
  }
}

// 生成完成后的结果也能一键插入（同样带确认）。
async function insertGenerated() {
  const text = $('gen-result')?.textContent || '';
  const match = /"assetRef":\s*"asset:([a-f0-9]{48})"/.exec(text);
  if (!match) { $('gen-status').textContent = '当前没有可插入的生成结果（需要 succeeded 且带 assetRef）。'; return; }
  await insertAssetAsLayer({ id: match[1], name: '生成的图片' });
}

$('asset-upload')?.addEventListener('click', async () => {
  const file = $('asset-file')?.files?.[0];
  if (!file) { $('asset-status').textContent = '先选择一张图片。'; return; }
  try {
    $('asset-status').textContent = '正在上传并校验图片…';
    const asset = await uploadImageAsset(file);
    $('asset-status').textContent = `已注册临时素材 · ${asset.bytes} bytes`;
    $('asset-result').textContent = JSON.stringify({ ...asset, sourceRef: `asset:${asset.id}` }, null, 2);
    rememberAsset(asset);
  } catch (error) {
    $('asset-status').textContent = `${error.code || 'UPLOAD_FAILED'}：${error.message}`;
  }
});

$('asset-import')?.addEventListener('click', async () => {
  const url = $('asset-url')?.value?.trim();
  if (!url) { $('asset-status').textContent = '先填一个图片 URL。'; return; }
  try {
    $('asset-status').textContent = '正在拉取并校验远程图片…';
    const value = await api('/media-image/assets/import', { method: 'POST', body: { url } });
    $('asset-status').textContent = `已导入 · ${value.asset.bytes} bytes`;
    $('asset-result').textContent = JSON.stringify(value, null, 2);
    rememberAsset(value.asset);
  } catch (error) {
    $('asset-status').textContent = `${error.code || 'IMPORT_FAILED'}：${error.message}`;
  }
});

// ── 生成面板：提交 → 按 jobId 轮询；unknown 继续查，绝不重新提交 ──
let genTimer = null;
let genJobId = null;

async function loadProviders() {
  const select = $('gen-provider');
  if (!select) return;
  try {
    const value = await api('/media-image/generate');
    select.textContent = '';
    const providers = value.providers || [];
    if (!providers.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '（未配置后端）';
      select.append(option);
      setPill('gen-pill', 'idle');
      $('gen-status').textContent = '未配置任何生成后端：设置 generation.providers 或 DSH_MEDIA_IMAGE_PROVIDERS 后重载插件。';
      return;
    }
    for (const provider of providers) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = `${provider.id}（${provider.kind}）`;
      select.append(option);
    }
    $('gen-status').textContent = `已发现 ${providers.length} 个后端。`;
  } catch (error) {
    setPill('gen-pill', 'failed');
    $('gen-status').textContent = `${error.code || 'PROVIDER_LIST_FAILED'}：${error.message}`;
  }
}

function stopPolling() {
  if (genTimer !== null) { clearTimeout(genTimer); genTimer = null; }
}

async function pollJob(jobId) {
  try {
    const value = await api(`/media-image/generate/${encodeURIComponent(jobId)}`);
    const job = value.job;
    setPill('gen-pill', job.status);
    $('gen-result').textContent = JSON.stringify(job, null, 2);
    if (job.status === 'succeeded') {
      $('gen-status').textContent = `完成 · ${job.assetRef}（用 layer.add_image 落层）`;
      genTimer = null;
      return;
    }
    if (job.status === 'failed') {
      $('gen-status').textContent = `失败：${job.error || '未知原因'}（不要重放同一作业）`;
      genTimer = null;
      return;
    }
    // queued / running / unknown 都继续查；unknown 只代表"这次没查到"，不代表失败。
    $('gen-status').textContent = job.status === 'unknown'
      ? `结果未知：${job.error || ''} 继续查询同一个 jobId…`
      : `作业进行中（${job.status}）…`;
    genTimer = setTimeout(() => void pollJob(jobId), 1500);
  } catch (error) {
    setPill('gen-pill', 'unknown');
    $('gen-status').textContent = `${error.code || 'POLL_FAILED'}：${error.message}`;
    genTimer = setTimeout(() => void pollJob(jobId), 2500);
  }
}

$('gen-refresh')?.addEventListener('click', () => void loadProviders());
$('gen-insert')?.addEventListener('click', () => void insertGenerated());

$('gen-submit')?.addEventListener('click', async () => {
  const provider = $('gen-provider')?.value;
  const prompt = $('gen-prompt')?.value?.trim();
  if (!provider) { $('gen-status').textContent = '先选一个后端（点「刷新」）。'; return; }
  if (!prompt) { $('gen-status').textContent = '先写提示词。'; return; }
  const width = Number($('gen-width')?.value) || undefined;
  const height = Number($('gen-height')?.value) || undefined;
  stopPolling();
  setPill('gen-pill', 'queued');
  $('gen-status').textContent = '正在提交…';
  try {
    const value = await api('/media-image/generate', { method: 'POST', body: { provider, prompt, width, height } });
    const job = value.job;
    genJobId = job.jobId;
    setPill('gen-pill', job.status);
    $('gen-result').textContent = JSON.stringify(job, null, 2);
    if (job.status === 'succeeded') {
      $('gen-status').textContent = `完成 · ${job.assetRef}`;
      if (job.assetRef) rememberAsset({ id: job.assetRef.slice('asset:'.length), name: `generated-${provider}`, bytes: 0 });
      return;
    }
    $('gen-status').textContent = `已提交 jobId=${job.jobId}，开始轮询…`;
    genTimer = setTimeout(() => void pollJob(job.jobId), 1200);
  } catch (error) {
    setPill('gen-pill', 'failed');
    $('gen-status').textContent = `${error.code || 'SUBMIT_FAILED'}：${error.message}`;
  }
});

// ── 字体面板：登记后拿到 /media-image/fonts/<id> 供 layer.add_text 的 fontUrl ──
async function loadFonts() {
  const list = $('font-list');
  if (!list) return;
  try {
    const value = await api('/media-image/fonts');
    list.textContent = '';
    for (const font of value.fonts || []) {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${font.family} · ${font.mime} · ${font.bytes} B`;
      const copy = document.createElement('button');
      copy.textContent = '复制 fontUrl';
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(font.url).then(
          () => { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制 fontUrl'; }, 1200); },
          () => { $('font-status').textContent = font.url; },
        );
      });
      item.append(label, copy);
      list.append(item);
    }
    if (!list.children.length) $('font-status').textContent = '还没有登记字体。';
  } catch (error) {
    $('font-status').textContent = `${error.code || 'FONT_LIST_FAILED'}：${error.message}`;
  }
}

$('font-refresh')?.addEventListener('click', () => void loadFonts());

$('font-register')?.addEventListener('click', async () => {
  const url = $('font-url')?.value?.trim();
  const family = $('font-family')?.value?.trim();
  if (!url || !family) { $('font-status').textContent = 'URL 与字体族名都要填。'; return; }
  try {
    $('font-status').textContent = '正在拉取并校验字体…';
    const value = await api('/media-image/fonts', { method: 'POST', body: { url, family } });
    $('font-status').textContent = `已登记 ${value.font.family} · ${value.font.url}`;
    await loadFonts();
  } catch (error) {
    $('font-status').textContent = `${error.code || 'FONT_REGISTER_FAILED'}：${error.message}`;
  }
});

// ── 批量面板：一行一条提示词，逐项状态可见 ──
let batchTimer = null;
let currentBatchId = null;

function renderBatch(batch) {
  const list = $('batch-list');
  if (!list) return;
  list.textContent = '';
  for (const item of batch.items) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `#${item.index + 1} ${item.prompt.slice(0, 28)}${item.prompt.length > 28 ? '…' : ''}`;
    const pill = document.createElement('span');
    pill.className = `pill ${item.status}`;
    pill.textContent = item.assetRef ? `${item.status} · ${item.assetRef.slice(0, 12)}…` : item.status;
    row.append(label, pill);
    list.append(row);
  }
}

async function pollBatch(batchId) {
  try {
    const value = await api(`/media-image/generate/batch/${encodeURIComponent(batchId)}`);
    const batch = value.batch;
    setPill('batch-pill', batch.status);
    renderBatch(batch);
    const { succeeded, failed, unknown, queued, running } = batch.counts;
    $('batch-status').textContent = `成功 ${succeeded} · 失败 ${failed} · 未知 ${unknown} · 进行中 ${running + queued}`;
    if (batch.status === 'running') {
      batchTimer = setTimeout(() => void pollBatch(batchId), 1500);
    } else {
      batchTimer = null;
      if (failed > 0) $('batch-status').textContent += '（失败项需重新提交，不会自动重试）';
    }
  } catch (error) {
    setPill('batch-pill', 'unknown');
    $('batch-status').textContent = `${error.code || 'BATCH_POLL_FAILED'}：${error.message}`;
    batchTimer = setTimeout(() => void pollBatch(batchId), 2500);
  }
}

$('batch-submit')?.addEventListener('click', async () => {
  const provider = $('gen-provider')?.value;
  const prompts = ($('batch-prompts')?.value || '').split('\n').map(line => line.trim()).filter(Boolean);
  if (!provider) { $('batch-status').textContent = '先在上方「生成」面板选一个后端。'; return; }
  if (!prompts.length) { $('batch-status').textContent = '至少写一条提示词。'; return; }
  if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
  setPill('batch-pill', 'queued');
  try {
    const value = await api('/media-image/generate/batch', {
      method: 'POST',
      body: { provider, prompts, width: Number($('gen-width')?.value) || undefined, height: Number($('gen-height')?.value) || undefined },
    });
    currentBatchId = value.batch.batchId;
    setPill('batch-pill', value.batch.status);
    renderBatch(value.batch);
    $('batch-status').textContent = `已提交 ${value.batch.items.length} 条 · batchId=${value.batch.batchId}`;
    batchTimer = setTimeout(() => void pollBatch(currentBatchId), 1200);
  } catch (error) {
    setPill('batch-pill', 'failed');
    $('batch-status').textContent = `${error.code || 'BATCH_SUBMIT_FAILED'}：${error.message}`;
  }
});

$('batch-refresh')?.addEventListener('click', () => {
  if (!currentBatchId) { $('batch-status').textContent = '还没有批次。'; return; }
  if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
  void pollBatch(currentBatchId);
});

window.addEventListener('pagehide', () => { if (batchTimer !== null) clearTimeout(batchTimer); stopPolling(); void relay?.stop(); });
