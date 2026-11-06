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

// 用户偏好减动效时，一切进度都改成瞬时到位，不起帧循环。
const REDUCE_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// 进度条：由 rAF 推进 transform:scaleX（合成友好），到终态立刻停帧。
// 只推进 CSS 变量里的一个值，不做 per-poll 的 DOM 结构重排。
function createMeter(id) {
  const bar = $(id);
  const fill = bar?.firstElementChild;
  let frame = null;
  let value = 0;
  let target = 0;
  const paint = () => { if (fill) fill.style.transform = `scaleX(${value.toFixed(4)})`; };
  const tick = () => {
    const delta = target - value;
    if (Math.abs(delta) < 0.004) {
      value = target;
      paint();
      frame = null;
      return; // 到达目标 → 停帧，不空转
    }
    value += delta * 0.18;
    paint();
    frame = requestAnimationFrame(tick);
  };
  return {
    show(on) { bar?.classList.toggle('on', !!on); },
    set(ratio) {
      target = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
      if (REDUCE_MOTION) { value = target; paint(); return; }
      if (frame === null) frame = requestAnimationFrame(tick);
    },
    done(failed) {
      target = 1;
      value = 1;
      paint();
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      if (fill) fill.style.background = failed ? 'var(--fail)' : 'var(--ok)';
      setTimeout(() => { bar?.classList.remove('on'); if (fill) fill.style.background = 'var(--run)'; }, 900);
    },
    reset() {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      value = 0; target = 0; paint();
      if (fill) fill.style.background = 'var(--run)';
    },
  };
}

const genMeter = createMeter('gen-meter');
const batchMeter = createMeter('batch-meter');

// 空态与结果区分开：有内容才显示 <pre>，空态给出"下一步做什么"。
function toggleEmpty(emptyId, preId, hasContent) {
  const empty = $(emptyId);
  const pre = $(preId);
  if (empty) empty.hidden = hasContent;
  if (pre) pre.hidden = !hasContent;
}

// 本页已知素材：素材库没有列表路由，这里只记本页产生/导入的，别谎称是"全部"。
const knownAssets = [];

// 按 id 增量更新列表：存在就改文字，不存在才插入 —— 轮询不再整表重建，
// 键盘焦点与滚动位置都不会被打掉。
function keyedRow(list, key, build) {
  let row = list.querySelector(`[data-key="${key}"]`);
  if (row) return { row, fresh: false };
  row = document.createElement('li');
  row.dataset.key = key;
  list.append(row);
  build(row);
  return { row, fresh: true };
}

function renderAssets() {
  const list = $('asset-list');
  if (!list) return;
  toggleEmpty('asset-empty', 'asset-result', knownAssets.length > 0);
  for (const asset of knownAssets) {
    const { row, fresh } = keyedRow(list, `asset:${asset.id}`, el => {
      const label = document.createElement('span');
      label.dataset.role = 'label';
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      const copy = document.createElement('button');
      copy.className = 'ghost';
      copy.textContent = '复制引用';
      copy.addEventListener('click', () => {
        const ref = `asset:${asset.id}`;
        void navigator.clipboard?.writeText(ref).then(
          () => { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制引用'; }, 1200); },
          () => { $('asset-status').textContent = ref; },
        );
      });
      const insert = document.createElement('button');
      insert.textContent = '插入为图层';
      insert.addEventListener('click', () => void insertAssetAsLayer(asset));
      actions.append(copy, insert);
      el.append(label, actions);
    });
    if (!fresh) {
      const label = row.querySelector('[data-role="label"]');
      if (label) label.textContent = `${asset.name || 'image'} · ${asset.bytes} B · asset:${String(asset.id).slice(0, 8)}…`;
    } else {
      row.querySelector('[data-role="label"]').textContent = `${asset.name || 'image'} · ${asset.bytes} B · asset:${String(asset.id).slice(0, 8)}…`;
    }
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
    toggleEmpty('asset-empty', 'asset-result', true);
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
    toggleEmpty('asset-empty', 'asset-result', true);
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
  if ($('gen-stop')) $('gen-stop').hidden = true;
}

const running = () => { const b = $('gen-stop'); if (b) b.hidden = false; };

async function pollJob(jobId) {
  try {
    const value = await api(`/media-image/generate/${encodeURIComponent(jobId)}`);
    const job = value.job;
    setPill('gen-pill', job.status);
    const result = $('gen-result');
    if (result) result.textContent = JSON.stringify(job, null, 2);
    toggleEmpty('gen-result-empty', 'gen-result', true);
    // 进度用"轮询了第几次"粗略推进，只到 0.9 —— 剩下 0.1 留给真正拿到终态，不假装知道服务端百分比。
    genMeter.set(Math.min(0.9, 0.25 + genPolls * 0.12));
    genPolls += 1;
    if (job.status === 'succeeded') {
      $('gen-status').textContent = `完成 · ${job.assetRef}（用「插入图层」落层）`;
      genMeter.done(false);
      genTimer = null;
      if ($('gen-stop')) $('gen-stop').hidden = true;
      return;
    }
    if (job.status === 'failed') {
      $('gen-status').innerHTML = `<span class="err">失败：${job.error || '未知原因'}</span> · 不要重放同一作业；改提示词后重新提交`;
      genMeter.done(true);
      genTimer = null;
      if ($('gen-stop')) $('gen-stop').hidden = true;
      return;
    }
    // queued / running / unknown 都继续查；unknown 只代表"这次没查到"，不代表失败。
    $('gen-status').textContent = job.status === 'unknown'
      ? `结果未知：${job.error || ''} · 继续查询同一个 jobId，不重新提交`
      : `作业进行中（${job.status}）· 已查询 ${genPolls} 次`;
    genTimer = setTimeout(() => void pollJob(jobId), 1500);
  } catch (error) {
    setPill('gen-pill', 'unknown');
    $('gen-status').innerHTML = `<span class="err">${error.code || 'POLL_FAILED'}</span>：${error.message} · 稍后自动重查`;
    genTimer = setTimeout(() => void pollJob(jobId), 2500);
  }
}

let genPolls = 0;

$('gen-refresh')?.addEventListener('click', () => void loadProviders());
$('gen-insert')?.addEventListener('click', () => void insertGenerated());
// 「停止查询」只停本页轮询，不取消 Host 侧作业（取消作业是另一件事，这里不冒充）。
$('gen-stop')?.addEventListener('click', () => {
  stopPolling();
  $('gen-status').textContent = `已停止查询（jobId 仍有效，可用同一 id 再查，不会重建作业）`;
});

$('gen-submit')?.addEventListener('click', async () => {
  const provider = $('gen-provider')?.value;
  const prompt = $('gen-prompt')?.value?.trim();
  if (!provider) { $('gen-status').textContent = '先选一个后端（点「刷新」）。'; return; }
  if (!prompt) { $('gen-status').textContent = '先写提示词。'; return; }
  const width = Number($('gen-width')?.value) || undefined;
  const height = Number($('gen-height')?.value) || undefined;
  stopPolling();
  genPolls = 0;
  genMeter.reset();
  genMeter.show(true);
  running();
  setPill('gen-pill', 'queued');
  $('gen-status').textContent = '正在提交…';
  const submit = $('gen-submit');
  if (submit) submit.disabled = true;
  try {
    const value = await api('/media-image/generate', { method: 'POST', body: { provider, prompt, width, height } });
    const job = value.job;
    genJobId = job.jobId;
    setPill('gen-pill', job.status);
    const result = $('gen-result');
    if (result) result.textContent = JSON.stringify(job, null, 2);
    toggleEmpty('gen-result-empty', 'gen-result', true);
    if (job.status === 'succeeded') {
      $('gen-status').textContent = `完成 · ${job.assetRef}`;
      genMeter.done(false);
      stopPolling();
      if (job.assetRef) rememberAsset({ id: job.assetRef.slice('asset:'.length), name: `generated-${provider}`, bytes: 0 });
      return;
    }
    $('gen-status').textContent = `已提交 jobId=${job.jobId} · 开始轮询`;
    genTimer = setTimeout(() => void pollJob(job.jobId), 1200);
  } catch (error) {
    setPill('gen-pill', 'failed');
    $('gen-status').innerHTML = `<span class="err">${error.code || 'SUBMIT_FAILED'}</span>：${error.message} · 检查后端是否在运行`;
    genMeter.done(true);
    stopPolling();
  } finally {
    if (submit) submit.disabled = false;
  }
});

// ── 字体面板：登记后拿到 /media-image/fonts/<id> 供 layer.add_text 的 fontUrl ──
async function loadFonts() {
  const list = $('font-list');
  if (!list) return;
  try {
    const value = await api('/media-image/fonts');
    const fonts = value.fonts || [];
    // 同样按 key 增量更新：刷新列表不该把「复制 fontUrl」按钮换掉、也不该丢焦点。
    for (const font of fonts) {
      const { row, fresh } = keyedRow(list, `font:${font.id}`, el => {
        const label = document.createElement('span');
        label.dataset.role = 'label';
        const copy = document.createElement('button');
        copy.className = 'ghost';
        copy.textContent = '复制 fontUrl';
        copy.addEventListener('click', () => {
          void navigator.clipboard?.writeText(font.url).then(
            () => { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制 fontUrl'; }, 1200); },
            () => { $('font-status').textContent = font.url; },
          );
        });
        el.append(label, copy);
      });
      const label = row.querySelector('[data-role="label"]');
      if (label) label.textContent = `${font.family} · ${font.mime} · ${font.bytes} B`;
      if (fresh) row.dataset.key = `font:${font.id}`;
    }
    // 已被删除的字体行要收走（否则会留下点了报错的按钮）
    const alive = new Set(fonts.map(font => `font:${font.id}`));
    for (const row of [...list.children]) if (!alive.has(row.dataset.key)) row.remove();
    if (!list.children.length) {
      $('font-status').textContent = '还没有登记字体：填 URL + 族名后点「登记字体」。';
    }
  } catch (error) {
    $('font-status').innerHTML = `<span class="err">${error.code || 'FONT_LIST_FAILED'}</span>：${error.message}`;
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

// 批量列表按 index 增量更新：轮询只改变的那几行，不重建整表，
// 也不会把用户正在点的「重试」按钮换掉。失败的项单独给一个重试按钮。
function renderBatch(batch) {
  const list = $('batch-list');
  if (!list) return;
  toggleEmpty('batch-empty', 'batch-list', batch.items.length > 0);
  batch.items.forEach((item, index) => {
    const key = `${batch.batchId}:${item.index}`;
    const { row, fresh } = keyedRow(list, key, el => {
      const label = document.createElement('span');
      label.dataset.role = 'label';
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      const pill = document.createElement('span');
      pill.dataset.role = 'pill';
      pill.className = `pill ${item.status}`;
      actions.append(pill);
      if (item.status === 'failed') {
        const retry = document.createElement('button');
        retry.className = 'ghost';
        retry.textContent = '重试';
        retry.dataset.role = 'retry';
        retry.addEventListener('click', () => void retryBatchItem(batch.batchId, item.prompt, retry));
        actions.append(retry);
      }
      el.append(label, actions);
      el.style.order = String(index);
    });
    const label = row.querySelector('[data-role="label"]');
    if (label) label.textContent = `#${item.index + 1} ${item.prompt.slice(0, 26)}${item.prompt.length > 26 ? '…' : ''}`;
    const pill = row.querySelector('[data-role="pill"]');
    if (pill) {
      pill.className = `pill ${item.status}`;
      pill.textContent = item.assetRef ? `${item.status} · ${item.assetRef.slice(6, 14)}…` : item.status;
    }
    // 状态由 failed 变成别的：把重试按钮拿掉（不能留一个点了没用的按钮）。
    const retry = row.querySelector('[data-role="retry"]');
    if (retry && item.status !== 'failed') retry.remove();
    row.style.order = String(index);
  });
}

// 单条重试 = 用同一条提示词重新提交一个**新作业**（不是重放旧作业），走已有批量路由（1 条）。
async function retryBatchItem(batchId, prompt, button) {
  const provider = $('gen-provider')?.value;
  if (!provider) { $('batch-status').textContent = '重试需要先选后端。'; return; }
  if (button) { button.disabled = true; button.textContent = '提交中…'; }
  try {
    const value = await api('/media-image/generate/batch', {
      method: 'POST',
      body: { provider, prompts: [prompt], width: Number($('gen-width')?.value) || undefined, height: Number($('gen-height')?.value) || undefined },
    });
    const batch = value.batch;
    $('batch-status').textContent = `已为失败项重新提交 · 新批次 ${batch.batchId.slice(0, 8)}…（旧批次的失败记录保留）`;
    renderBatch(batch);
    if (batchTimer !== null) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => void pollBatch(batch.batchId), 1200);
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '重试'; }
    $('batch-status').innerHTML = `<span class="err">${error.code || 'RETRY_FAILED'}</span>：${error.message}`;
  }
}

async function pollBatch(batchId) {
  try {
    const value = await api(`/media-image/generate/batch/${encodeURIComponent(batchId)}`);
    const batch = value.batch;
    setPill('batch-pill', batch.status);
    renderBatch(batch);
    const { succeeded, failed, unknown, queued, running } = batch.counts;
    const total = batch.items.length || 1;
    batchMeter.set(Math.min(0.95, (succeeded + failed) / total));
    $('batch-status').textContent = `成功 ${succeeded} · 失败 ${failed} · 未知 ${unknown} · 进行中 ${running + queued}`;
    if (batch.status === 'running') {
      batchTimer = setTimeout(() => void pollBatch(batchId), 1500);
    } else {
      batchTimer = null;
      batchMeter.done(failed > 0);
      if ($('batch-stop')) $('batch-stop').hidden = true;
      if (failed > 0) $('batch-status').innerHTML += ' · <span class="err">失败项可单条重试</span>（重试=新作业）';
    }
  } catch (error) {
    setPill('batch-pill', 'unknown');
    $('batch-status').innerHTML = `<span class="err">${error.code || 'BATCH_POLL_FAILED'}</span>：${error.message} · 稍后自动重查`;
    batchTimer = setTimeout(() => void pollBatch(batchId), 2500);
  }
}

$('batch-submit')?.addEventListener('click', async () => {
  const provider = $('gen-provider')?.value;
  const prompts = ($('batch-prompts')?.value || '').split('\n').map(line => line.trim()).filter(Boolean);
  if (!provider) { $('batch-status').textContent = '先在上方「生成」面板选一个后端。'; return; }
  if (!prompts.length) { $('batch-status').textContent = '至少写一条提示词。'; return; }
  if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
  batchMeter.reset();
  batchMeter.show(true);
  if ($('batch-stop')) $('batch-stop').hidden = false;
  setPill('batch-pill', 'queued');
  try {
    const value = await api('/media-image/generate/batch', {
      method: 'POST',
      body: { provider, prompts, width: Number($('gen-width')?.value) || undefined, height: Number($('gen-height')?.value) || undefined },
    });
    currentBatchId = value.batch.batchId;
    setPill('batch-pill', value.batch.status);
    renderBatch(value.batch);
    $('batch-status').textContent = `已提交 ${value.batch.items.length} 条（并发 2）· batchId=${value.batch.batchId.slice(0, 8)}…`;
    batchTimer = setTimeout(() => void pollBatch(currentBatchId), 1200);
  } catch (error) {
    setPill('batch-pill', 'failed');
    $('batch-status').innerHTML = `<span class="err">${error.code || 'BATCH_SUBMIT_FAILED'}</span>：${error.message}`;
    batchMeter.done(true);
    if ($('batch-stop')) $('batch-stop').hidden = true;
  }
});

$('batch-refresh')?.addEventListener('click', () => {
  if (!currentBatchId) { $('batch-status').textContent = '还没有批次。'; return; }
  if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
  void pollBatch(currentBatchId);
});

// 「停止查询」同上：只停本页轮询，Host 侧批次与逐项记录都不受影响。
$('batch-stop')?.addEventListener('click', () => {
  if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
  if ($('batch-stop')) $('batch-stop').hidden = true;
  $('batch-status').textContent = '已停止查询（批次仍在 Host 侧推进，可点「刷新进度」继续看）';
});

// ── 真实模型通路 ──
// 走宿主 llm（Host 侧 /media-image/assist）：模型只回 {reply, ops}，执行由本页负责 ——
// 页面拥有编辑器，所以"提议"与"已执行"不会混为一谈。模型不可用时降级到本地指令并标注。
const assistHistory = [];
let assistEngine = ''; // 模型名；空串表示本地指令

async function assistContext() {
  try {
    const connection = await connect();
    const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
    return {
      width: state.canvas.width,
      height: state.canvas.height,
      layers: state.layers.length,
      // 模型要提议图层命令就必须拿到真实 id —— 只给数量等于让它编 id。
      layerList: state.layers.slice(0, 12).map(layer => ({ id: layer.id, name: layer.name, type: layer.type, visible: layer.visible })),
      hasSelection: !!(state.selection && state.selection.width > 0),
      lastAssetRef: lastAssetRef || null,
    };
  } catch {
    return null;
  }
}

async function refreshEngineLabel() {
  const who = $('assist-who');
  if (!who) return;
  try {
    const value = await api('/media-image/assist');
    if (value.ready) {
      assistEngine = value.model || 'model';
      who.textContent = value.model || '已连模型';
      who.title = `宿主默认模型 · ${value.provider || ''}`;
    } else {
      assistEngine = '';
      who.textContent = '本地指令·模型未连接';
      who.title = 'Host 没有可用的默认模型；点「帮助」看本地能做什么';
    }
  } catch {
    assistEngine = '';
    who.textContent = '本地指令';
  }
}

// ops 由页面执行：只认白名单，逐个跑并回报结果。
async function execOps(ops) {
  for (const op of ops || []) {
    if (op.type === 'generate') {
      const provider = assistProvider();
      if (!provider) { bubble('bot', '收到生成指令，但这个部署没配后端。'); continue; }
      const size = { width: op.width || assistSize().width, height: op.height || assistSize().height };
      const line = bubble('bot', `正在生成：${String(op.prompt || '').slice(0, 40)}…`);
      try {
        const value = await api('/media-image/generate', { method: 'POST', body: { provider, prompt: String(op.prompt || '').trim(), ...size } });
        let job = value.job;
        for (let i = 0; i < 20 && job.status !== 'succeeded' && job.status !== 'failed'; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 800));
          job = (await api(`/media-image/generate/${encodeURIComponent(job.jobId)}`)).job;
        }
        if (job.status === 'succeeded') {
          lastAssetRef = job.assetRef;
          rememberAsset({ id: job.assetRef.slice(6), name: '助手生成的图片', bytes: 0 });
          line.textContent = '图好了。说「插入图层」就落到画布上。';
          const ref = document.createElement('span');
          ref.className = 'ref';
          ref.textContent = job.assetRef;
          line.append(ref);
        } else {
          line.textContent = `生成失败：${job.error || job.status}`;
        }
      } catch (error) {
        line.textContent = `${error.code || 'GENERATE_FAILED'}：${error.message}`;
      }
      continue;
    }
    if (op.type === 'batch') {
      const provider = assistProvider();
      if (!provider) { bubble('bot', '收到批量指令，但这个部署没配后端。'); continue; }
      const prompts = (op.prompts || []).map(p => String(p).trim()).filter(Boolean).slice(0, 20);
      if (!prompts.length) { bubble('bot', '批量指令里没有可用提示词。'); continue; }
      try {
        const value = await api('/media-image/generate/batch', { method: 'POST', body: { provider, prompts, ...assistSize() } });
        bubble('bot', `已排队 ${prompts.length} 条（并发 2）。失败项可单条重试。`);
        void pollBatch(value.batch.batchId);
      } catch (error) {
        bubble('bot', `${error.code || 'BATCH_FAILED'}：${error.message}`);
      }
      continue;
    }
    if (op.type === 'import') {
      try {
        const value = await api('/media-image/assets/import', { method: 'POST', body: { url: op.url } });
        rememberAsset(value.asset);
        bubble('bot', `已导入 ${value.asset.bytes} bytes。说「插入图层」就落层。`, `asset:${value.asset.id}`);
      } catch (error) {
        bubble('bot', `${error.code || 'IMPORT_FAILED'}：${error.message}`);
      }
      continue;
    }
    if (op.type === 'insert') {
      const match = /asset:([a-f0-9]{48})/.exec(lastAssetRef || '');
      if (!match) { bubble('bot', '还没有可插入的结果：先让我生成或导入一张。'); continue; }
      await insertAssetAsLayer({ id: match[1], name: '助手插入的图片' });
      continue;
    }
    if (op.type === 'status') { await routeAssist('状态'); continue; }
    if (op.type === 'fontList') { await routeAssist('字体列表'); continue; }
    if (op.type === 'command') {
      // 人机协作的关键闸门：模型只能**提议**，落地必须由人点确认。
      const command = op.command || {};
      const risky = ['layer.remove', 'canvas.crop', 'layer.add_image'].includes(command.type);
      try {
        const connection = await connect();
        const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
        const answer = await askConfirm({
          title: risky ? `模型提议（高影响）：${command.type}` : `模型提议：${command.type}`,
          details: [
            `命令      ${command.type}`,
            `参数      ${JSON.stringify(command.payload)}`,
            `目标工程  ${state.documentId} · R${state.revision}`,
            '模型没有执行它，点击前它不会生效',
          ].join('\n'),
          maskAvailable: false,
        });
        if (!answer.ok) { bubble('bot', '已取消，没有发送任何命令。'); continue; }
        const result = await transport.request({
          type: 'editor.apply_command',
          requestId: crypto.randomUUID(),
          editorInstanceId: connection.editorInstanceId,
          documentId: state.documentId,
          expectedRevision: state.revision,
          commandId: crypto.randomUUID(),
          command: { type: command.type, payload: command.payload },
        }, { timeoutMs: 15000 });
        bubble('bot', `已执行 ${command.type} · 现在 R${result?.revision}`);
      } catch (error) {
        const code = error.code || 'COMMAND_FAILED';
        if (code === 'REVISION_CONFLICT') bubble('bot', '工程已变化（REVISION_CONFLICT），这次没执行；再说一次我会用最新版本重新提议。');
        else if (code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN') bubble('bot', '结果未知：不要重发，用该 commandId 查询。');
        else bubble('bot', `${code}：${error.message}`);
      }
      continue;
    }
  }
}

// 一轮真实对话：模型回答 → 渲染 → 执行它提议的 ops。失败才降级本地指令。
async function modelTurn(text) {
  const pending = bubble('bot', '…');
  try {
    const value = await api('/media-image/assist', {
      method: 'POST',
      body: { message: text, history: assistHistory.slice(-6), context: await assistContext() },
    });
    pending.remove();
    bubble('bot', value.reply || '（模型没有给回复）');
    assistHistory.push({ role: 'user', text }, { role: 'assistant', text: value.reply || '' });
    if (value.droppedOps) bubble('bot', `（有 ${value.droppedOps} 个不认识的提议被忽略）`);
    if (assistEngine !== (value.engine || 'model')) {
      assistEngine = value.engine || 'model';
      const who = $('assist-who');
      if (who) { who.textContent = assistEngine; who.title = `宿主默认模型 · ${value.provider || ''}`; }
    }
    if (value.ops?.length) await execOps(value.ops);
    return true;
  } catch (error) {
    pending.remove();
    if (['ASSIST_UNAVAILABLE', 'ASSIST_FAILED'].includes(error.code)) {
      bubble('bot', `模型这次没连上（${error.code}），先用本地指令处理。`);
      return false;
    }
    bubble('bot', `${error.code || 'ASSIST_FAILED'}：${error.message}`);
    return true; // 不是"模型不可用"，不再重复走本地
  }
}
const assistLog = $('assist-log');
const assistText = $('assist-text');
const assistSend = $('assist-send');

function bubble(role, text, ref) {
  if (!assistLog) return;
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  el.textContent = text;
  if (ref) {
    const code = document.createElement('span');
    code.className = 'ref';
    code.textContent = ref;
    el.append(code);
  }
  assistLog.append(el);
  assistLog.scrollTop = assistLog.scrollHeight;
  return el;
}

const CHIPS = [
  ['生成', '生成：柔和晨光，浅灰色调'],
  ['批量', '批量：晨光|夜景|木桌'],
  ['上传', '@upload'],
  ['导入', '导入：https://example.com/a.png'],
  ['字体', '字体列表'],
  ['状态', '状态'],
  ['帮助', '能做什么'],
];

// 助手自己持有后端与尺寸（面板列已隐藏），所以这里的值就是唯一来源。
const assistProvider = () => $('assist-provider')?.value || $('gen-provider')?.value || '';
const assistSize = () => ({
  width: Number($('assist-width')?.value) || Number($('gen-width')?.value) || 1024,
  height: Number($('assist-height')?.value) || Number($('gen-height')?.value) || 1024,
});

async function fillProviders() {
  const select = $('assist-provider');
  if (!select) return 0;
  try {
    const value = await api('/media-image/generate');
    const providers = value.providers || [];
    select.textContent = '';
    if (!providers.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '未配置后端';
      select.append(option);
      return 0;
    }
    for (const provider of providers) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.id;
      select.append(option);
    }
    return providers.length;
  } catch (error) {
    bubble('bot', `拿不到后端列表：${error.code || ''} ${error.message}`);
    return 0;
  }
}

function renderChips() {
  const box = $('assist-chips');
  if (!box) return;
  box.textContent = '';
  for (const [label, command] of CHIPS) {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => {
      if (command === '@upload') { $('assist-file')?.click(); return; }
      void sendAssist(command);
    });
    box.append(button);
  }
}

// 本地文件上传：面板列隐藏后，入口在这里（选完文件立刻上传并回执）。
$('assist-file')?.addEventListener('change', async event => {
  const file = event.target?.files?.[0];
  if (!file) return;
  bubble('me', `上传：${file.name}（${Math.round(file.size / 1024)} KB）`);
  const pending = bubble('bot', '正在上传并校验…');
  try {
    const asset = await uploadImageAsset(file);
    rememberAsset(asset);
    pending.textContent = '已上传。要我插入图层就说「插入图层」。';
    const ref = document.createElement('span');
    ref.className = 'ref';
    ref.textContent = `asset:${asset.id}`;
    pending.append(ref);
  } catch (error) {
    pending.textContent = `${error.code || 'UPLOAD_FAILED'}：${error.message}`;
  } finally {
    event.target.value = '';
  }
});

const HELP = [
  '面板已经收起来了，下面这些都在这儿说（走插件已有能力，不调模型）：',
  '· 生成：<提示词>             → 出一张图，完成后可插入图层',
  '· 批量：<提示词>|<提示词>    → 排队生成（并发 2），逐项状态，失败可单条重试',
  '· 上传（点上面那颗按钮）      → 本地图片入库（PNG/JPEG/WebP ≤32 MiB）',
  '· 导入：<图片 URL>           → 受控拉取远程素材（拦内网）',
  '· 字体：<URL> <族名>         → 登记字体；「字体列表」看已登记的',
  '· 插入图层                  → 把最近一次结果落成图层（会弹确认框）',
  '· 状态                      → 读一次编辑器：文档、版本、图层数',
].join('\n');

// 最近一次生成的 assetRef —— 面板不再可见，状态由助手自己持有。
let lastAssetRef = '';

// 一句话 → 动作。返回给用户看的文本；失败要说清是哪个环节。
async function routeAssist(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  const say = (msg, ref) => bubble('bot', msg, ref);

  if (/^(帮助|能做什么|help|\?)$/i.test(text)) { say(HELP); return; }

  if (/^(字体列表|看字体|字体)$/.test(text)) {
    try {
      const value = await api('/media-image/fonts');
      const fonts = value.fonts || [];
      if (!fonts.length) { say('还没有登记字体。用「字体：<URL> <族名>」登记一个。'); return; }
      say(`已登记 ${fonts.length} 个字体：\n${fonts.map((font, index) => `${index + 1}. ${font.family} · ${font.mime} · ${font.bytes}B`).join('\n')}`);
    } catch (error) {
      say(`${error.code || 'FONT_LIST_FAILED'}：${error.message}`);
    }
    return;
  }

  if (/^(状态|看看画布|read state)$/i.test(text)) {
    try {
      const connection = await connect();
      const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
      say(`工程 ${String(state.documentId).slice(0, 8)}… · R${state.revision} · 画布 ${state.canvas.width}×${state.canvas.height} · 图层 ${state.layers.length} 个${state.selection ? ` · 有选区 ${state.selection.width}×${state.selection.height}` : ''}`);
    } catch (error) {
      say(`${error.code || 'READ_FAILED'}：${error.message}（先在编辑器里画点东西，或点「重新连接」）`);
    }
    return;
  }

  if (/^(插入|落层|插入图层|放进去)/.test(text)) {
    const match = /asset:([a-f0-9]{48})/.exec(lastAssetRef || $('gen-result')?.textContent || '');
    if (!match) { say('还没有可插入的结果。先用「生成：…」出一张，或点「上传」。'); return; }
    await insertAssetAsLayer({ id: match[1], name: '助手插入的图片' });
    say('已发出插入请求，确认框里点「确认插入」才真正落层。');
    return;
  }

  const gen = /^生成[:：]\s*(.+)$/s.exec(text);
  if (gen) {
    const provider = assistProvider();
    if (!provider) { say('还没选后端：点控制条上的「刷新」，选一个后端再试。'); return; }
    const size = assistSize();
    const pill = bubble('bot', '正在提交生成…');
    try {
      const value = await api('/media-image/generate', { method: 'POST', body: { provider, prompt: gen[1].trim(), width: size.width, height: size.height } });
      let job = value.job;
      for (let i = 0; i < 20 && job.status !== 'succeeded' && job.status !== 'failed'; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 800));
        job = (await api(`/media-image/generate/${encodeURIComponent(job.jobId)}`)).job;
      }
      if (job.status === 'succeeded') {
        lastAssetRef = job.assetRef;
        pill.textContent = '生成完成。要我插入图层就说「插入图层」。';
        const ref = document.createElement('span');
        ref.className = 'ref';
        ref.textContent = job.assetRef;
        pill.append(ref);
        rememberAsset({ id: job.assetRef.slice(6), name: '助手生成的图片', bytes: 0 });
      } else {
        pill.textContent = `生成失败：${job.error || job.status} · 改提示词后重新提交（不重放旧作业）`;
      }
    } catch (error) {
      pill.textContent = `${error.code || 'GENERATE_FAILED'}：${error.message}`;
    }
    return;
  }

  const batch = /^批量[:：]\s*(.+)$/s.exec(text);
  if (batch) {
    const provider = assistProvider();
    if (!provider) { say('还没选后端：先在上方「生成」面板点「刷新」。'); return; }
    const prompts = batch[1].split(/[|｜\n]/).map(line => line.trim()).filter(Boolean);
    try {
      const value = await api('/media-image/generate/batch', { method: 'POST', body: { provider, prompts } });
      $('batch-prompts').value = prompts.join('\n');
      currentBatchId = value.batch.batchId;
      say(`已排入 ${prompts.length} 条（并发 2）。进度看「批量」面板；失败项不会自动重试。`, `batchId ${value.batch.batchId}`);
      void pollBatch(currentBatchId);
    } catch (error) {
      say(`${error.code || 'BATCH_FAILED'}：${error.message}`);
    }
    return;
  }

  const imported = /^导入[:：]\s*(https?:\/\/\S+)$/i.exec(text);
  if (imported) {
    try {
      const value = await api('/media-image/assets/import', { method: 'POST', body: { url: imported[1] } });
      rememberAsset(value.asset);
      say(`已导入 ${value.asset.bytes} bytes · 说「插入图层」就落层。`, `asset:${value.asset.id}`);
    } catch (error) {
      say(`${error.code || 'IMPORT_FAILED'}：${error.message}`);
    }
    return;
  }

  const font = /^字体[:：]\s*(https?:\/\/\S+)\s+(.+)$/i.exec(text);
  if (font) {
    try {
      const value = await api('/media-image/fonts', { method: 'POST', body: { url: font[1], family: font[2].trim() } });
      say(`已登记字体 ${value.font.family}。`, value.font.url);
      await loadFonts();
    } catch (error) {
      say(`${error.code || 'FONT_FAILED'}：${error.message}`);
    }
    return;
  }

  say('还没听懂。点下面的快捷按钮，或说「帮助」看全部说法。');
}

let assistBusy = false;
async function sendAssist(raw) {
  const text = String(raw ?? assistText?.value ?? '').trim();
  if (!text || assistBusy) return;
  bubble('me', text);
  if (assistText) assistText.value = '';
  assistBusy = true;
  if (assistSend) assistSend.disabled = true;
  try {
    // 先走真实模型；只有"模型不可用"才退回本地指令（并明确告诉用户）。
    const handled = await modelTurn(text);
    if (!handled) {
      const who = $('assist-who');
      if (who) who.textContent = '本地指令·模型未连接';
      await routeAssist(text);
    }
  } catch (error) {
    bubble('bot', `${error.code || 'ASSIST_FAILED'}：${error.message}`);
  } finally {
    assistBusy = false;
    if (assistSend) assistSend.disabled = false;
  }
}

$('assist-refresh')?.addEventListener('click', async () => {
  const count = await fillProviders();
  bubble('bot', count ? `已发现 ${count} 个后端，选一个就能生成。` : '这个部署没有配置生成后端；素材/字体/导入仍可用。');
});

function openAssist(open) {
  const card = $('assist-card');
  const launcher = $('assist-open');
  if (!card) return;
  const next = open ?? !card.classList.contains('open');
  card.classList.toggle('open', next);
  if (launcher) launcher.style.display = next ? 'none' : '';
  if (next) {
    if (!assistLog.children.length) bubble('bot', '这是一个图片工作台：直接说你想干什么，我来做（模型连不上时会退回本地指令）。');
    if (!$('assist-provider')?.value) void fillProviders();
    void refreshEngineLabel();
    assistText?.focus();
  }
}

$('assist-open')?.addEventListener('click', () => openAssist(true));
$('assist-close')?.addEventListener('click', () => openAssist(false));
$('assist-reset')?.addEventListener('click', () => { if (assistLog) assistLog.textContent = ''; openAssist(true); });
$('assist-send')?.addEventListener('click', () => void sendAssist());
$('assist-text')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void sendAssist(); } });
renderChips();

window.addEventListener('pagehide', () => { if (batchTimer !== null) clearTimeout(batchTimer); stopPolling(); void relay?.stop(); });
