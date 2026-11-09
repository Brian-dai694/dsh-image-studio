// Trusted same-origin parent for the packaged miniPaint page.
// It only wires the editor into the image relay: boot token, MessageChannel transport and
// the relay polling loop. Tool calls stay in the model session (media_image_*); this page
// never touches the DSH tool surface and never writes project files.
import { createIframeTransport } from '/media-image/host/iframe-transport.mjs';
import { startBrowserRelay } from '/media-image/host/browser-relay.mjs';

const $ = id => document.getElementById(id);
const show = value => { $('output').textContent = JSON.stringify(value, null, 2); };
const fail = error => show({ code: error.code || 'UI_ERROR', message: error.message, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) });

// ── 宿主主题跟随 ────────────────────────────────────────────────────
// DSH 面板把令牌值发到本页；本页自己上色，并转发给内嵌的编辑器 iframe。
// 编辑器可能晚于消息加载，所以缓存最后一份，在 iframe load 时补发。
let dshTheme = null;
const THEME_FIELDS = { bg: '--dsh-bg', surface: '--dsh-surface', sunken: '--dsh-surface-sunken', text: '--dsh-text',
  textMuted: '--dsh-text-muted', border: '--dsh-border', hover: '--dsh-hover', accent: '--dsh-accent', accentContrast: '--dsh-accent-contrast' };
const COLOR_SHAPE = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\s/deg]+\))$/i;

function applyHostTheme(tokens) {
  if (!tokens || typeof tokens !== 'object') return;
  let applied = 0;
  for (const [field, cssName] of Object.entries(THEME_FIELDS)) {
    const value = tokens[field];
    if (typeof value !== 'string' || value.length > 64 || !COLOR_SHAPE.test(value.trim())) continue;
    document.documentElement.style.setProperty(cssName, value.trim());
    applied += 1;
  }
  if (applied) document.documentElement.setAttribute('data-dsh-theme', String(tokens.mode || 'dsh'));
}

function forwardThemeToEditor() {
  const frame = $('editor');
  if (!dshTheme || !frame?.contentWindow) return;
  frame.contentWindow.postMessage({ type: 'dsh.theme', tokens: dshTheme }, location.origin);
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'dsh.theme') return;
  dshTheme = event.data.tokens;
  applyHostTheme(dshTheme);
  forwardThemeToEditor();
});

window.addEventListener('load', () => { $('editor')?.addEventListener('load', forwardThemeToEditor); });

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
  // 面板隐藏时没有列表 DOM，但素材状态仍必须记录，供助手“插入图层”使用。
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

// 最近一次「可插入」的素材 —— 生成 / 上传 / 导入 三者都写它。
// 早先只有生成写，导致"上传完说插入图层"被判成没有素材（真 bug）。
let lastAssetRef = '';

function rememberAsset(asset) {
  if (!asset?.id) return;
  if (!knownAssets.some(item => item.id === asset.id)) knownAssets.unshift(asset);
  lastAssetRef = `asset:${asset.id}`;
  renderAssets();
}

/** 最近可插入素材的显示名（上传的文件名 / 生成来源）。 */
function nearestAssetName() {
  const id = lastAssetRef.replace(/^asset:/, '');
  return knownAssets.find(item => item.id === id)?.name || '助手插入的图片';
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
  if (!asset?.id) return { applied: false, error: 'NO_ASSET' };
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
    if (!answer.ok) { statusEl.textContent = '已取消，没有发送任何命令。'; return { applied: false, cancelled: true }; }

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
    return { applied: true, revision: result?.revision, commandId };
  } catch (error) {
    const code = error.code || 'INSERT_FAILED';
    if (code === 'REVISION_CONFLICT') {
      statusEl.textContent = '工程已变化（REVISION_CONFLICT）：请重新点一次插入，会用最新 revision。';
      return { applied: false, error: code };
    } else if (code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' || error.outcomeUnknown) {
      statusEl.textContent = `结果未知（${lastInsert?.commandId || '命令已发出'}）：不要重发，用该 commandId 查询结果。`;
      return { applied: false, unknown: true, commandId: lastInsert?.commandId };
    } else {
      statusEl.textContent = `${code}：${error.message}`;
      return { applied: false, error: code, message: error.message };
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
      // 素材清单：模型要知道"手里有哪些图"，否则上传过的它也看不见。
      assetList: knownAssets.slice(0, 5).map(item => ({ id: `asset:${item.id}`, name: item.name || 'image', bytes: item.bytes })),
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
    if (op.type === 'removeBackground') {
      const line = bubble('bot', '正在抠图：原图不会修改，结果会另存为透明 PNG…');
      try {
        const value = await api(`/media-image/background-removal/${encodeURIComponent(String(op.assetRef).slice(6))}`, { method: 'POST', body: {} });
        rememberAsset(value.asset);
        lastAssetRef = value.sourceRef;
        line.textContent = '抠图完成，原图保留；这是一张新的透明 PNG。说「插入图层」后会先弹确认框。';
        const ref = document.createElement('span');
        ref.className = 'ref';
        ref.textContent = value.sourceRef;
        line.append(ref);
      } catch (error) {
        line.textContent = error.code === 'BACKGROUND_REMOVAL_UNAVAILABLE'
          ? '当前没有配置背景移除服务，所以这次不能抠图。配置 backgroundRemoval.endpoint 后重启插件再试。'
          : `${error.code || 'BACKGROUND_REMOVAL_FAILED'}：${error.message}。原图未修改；确认服务可用后可以重试。`;
      }
      continue;
    }
    if (op.type === 'insert') {
      // 优先用模型点名的素材（上传/导入/生成都算），否则用最近一张。
      const wanted = typeof op.assetRef === 'string' ? op.assetRef : lastAssetRef;
      const match = /asset:([a-f0-9]{48})/.exec(wanted || '');
      if (!match) { bubble('bot', '还没有可插入的素材：先「上传」一张，或让我生成一张。'); continue; }
      const known = knownAssets.find(item => item.id === match[1]);
      await insertAssetAsLayer({ id: match[1], name: known?.name || '助手插入的图片' });
      continue;
    }
    if (op.type === 'status') { await routeAssist('状态'); continue; }
    if (op.type === 'fontList') { await routeAssist('字体列表'); continue; }
    if (op.type === 'plan') {
      // 一串步骤一次确认：人同意的是"这一整套"，不是逐条弹框；失败会整体回滚。
      const steps = Array.isArray(op.steps) ? op.steps.filter(step => step && typeof step.operation === 'string') : [];
      if (!steps.length) { bubble('bot', '模型给的计划是空的，没有执行。'); continue; }
      const risky = steps.filter(step => ['layer.remove', 'canvas.crop', 'layer.add_image'].includes(step.operation));
      if (risky.length) { bubble('bot', `计划里有需要单独确认的命令（${risky.map(step => step.operation).join('、')}），已拒绝整串执行。`); continue; }
      const state = await fetchEditorState();
      const answer = await askConfirm({
        title: `模型计划（${steps.length} 步，一次确认）`,
        details: [
          ...steps.slice(0, 6).map((step, index) => `${index + 1}. ${step.operation}  ${JSON.stringify(step.params ?? {}).slice(0, 120)}`),
          steps.length > 6 ? `… 还有 ${steps.length - 6} 步` : '',
          `目标工程  ${state.documentId} · R${state.revision}`,
          '任一步失败会撤销已执行的步骤；模型没有写任何东西，点击后才会生效',
        ].filter(Boolean).join('\n'),
        maskAvailable: false,
      });
      if (!answer.ok) { bubble('bot', '已取消，画布没有改动。'); continue; }
      try {
        const outcome = await runPlanOnEditor(steps);
        bubble('bot', `计划已执行：${outcome.applied} 步合成一步撤销（现在 R${outcome.revision}）。`);
        await reportSelfCheck('计划');
      } catch (error) {
        const code = error.code || 'PLAN_FAILED';
        bubble('bot', String(code).startsWith('EDITOR_TIMEOUT')
          ? `计划结果未知（${code}）：不要重放，先读状态确认画布是否已变。`
          : `计划未生效（${code}：${error.message}）。编辑器整串回滚，不会留下半步。`);
      }
      continue;
    }
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
            commandTargetSummary(state, command.type, command.payload || {}),
            `参数      ${JSON.stringify(command.payload)}`,
            `目标工程  ${state.documentId} · R${state.revision}`,
            '模型没有执行它，点击前它不会生效',
          ].filter(Boolean).join('\n'),
          maskAvailable: false,
        });
        if (!answer.ok) { bubble('bot', '已取消，没有发送任何命令；后面的步骤也一并停止。'); return; }
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
        if (code === 'REVISION_CONFLICT') bubble('bot', '工程已变化（REVISION_CONFLICT），这次没执行；后面的步骤已停止，再说一次我会用最新版本重新提议。');
        else if (code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN') bubble('bot', '结果未知：不要重发，用该 commandId 查询；后面的步骤已停止。');
        else bubble('bot', `${code}：${error.message}（后面的步骤已停止）`);
        // 任一步失败后，后续命令引用的图层 id 与 revision 都可能过期，绝不接着跑。
        return;
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
  ['套版', '@psd'],
  ['局部重绘', '局部重绘：'],
  ['抠图', '抠图'],,
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
      if (command === '@psd') { $('assist-psd')?.click(); return; }
      if (command === '局部重绘：') { if (assistText) { assistText.value = command; assistText.focus(); } return; }
      void sendAssist(command);
    });
    box.append(button);
  }
}

// 套版入口：选一个 .psd 模板，解析槽位后逐步确认执行。
$('assist-psd')?.addEventListener('change', async event => {
  const file = event.target?.files?.[0];
  if (!file) return;
  bubble('me', `套版模板：${file.name}（${Math.round(file.size / 1024)} KB）`);
  await applyTemplateFlow(file);
  if (event.target) event.target.value = '';
});

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
  '· 局部重绘：<描述>          → 当前只认选区/绑定蒙版；后端需配置 inpaint workflow，否则明确拒绝',
  '· 上传（点上面那颗按钮）      → 本地图片入库（PNG/JPEG/WebP ≤32 MiB）',
  '· 导入：<图片 URL>           → 受控拉取远程素材（拦内网）',
  '· 字体：<URL> <族名>         → 登记字体；「字体列表」看已登记的',
  '· 插入图层                  → 把最近一次结果落成图层（会弹确认框）',
  '· 套版（点按钮选 .psd）      → 先给预览：候选商品槽 #1..#n、将沿用的文案、还原不了的装饰层',
  '· 套版：2                    → 用第 2 个候选槽放商品图（不再弹选择框）',
  '· 批量套版                  → 用已上传的每张商品各出一份 PNG 入素材库（画布最后恢复原状）',
  '· 合成蒙版                  → 选择已绑定蒙版层，按最新蒙版新增结果副本（需确认）',
  '· 状态                      → 读一次编辑器：文档、版本、图层数',
].join('\n');

// 最近可插入素材的唯一指针在文件上方定义（生成/上传/导入都写它）。

// 一句话 → 动作。返回给用户看的文本；失败要说清是哪个环节。
// 本地自动去背景：不需要坐标、不依赖外部模型。白底/纯色底商品图可直接得到透明图；
// 背景复杂时编辑器会回 BACKGROUND_NOT_DETECTED，此时如实告诉用户需要 AI 抠图服务。
async function sendInpaint({ provider, prompt, connection, state, sourceLayerId, maskLayerId }) {
  const exported = await transport.request({ type: 'editor.export_inpaint_inputs', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId, documentId: state.documentId, sourceLayerId, maskLayerId });
  if (exported.revision !== state.revision) throw Object.assign(new Error('导出期间画布发生变化，请刷新状态并重新开始。'), { code: 'REVISION_CONFLICT' });
  const uploadDataUrl = async (dataUrl, name) => {
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], name, { type: 'image/png' });
    const asset = await uploadImageAsset(file);
    rememberAsset(asset);
    return `asset:${asset.id}`;
  };
  const imageRef = await uploadDataUrl(exported.imageDataUrl, `inpaint-source-${sourceLayerId}.png`);
  const maskRef = await uploadDataUrl(exported.maskDataUrl, `inpaint-mask-${maskLayerId}.png`);
  const started = await api('/media-image/inpaint', { method: 'POST', body: {
    provider, prompt, width: exported.width, height: exported.height, imageRef, maskRef,
    idempotencyKey: crypto.randomUUID(),
  } });
  let job = started.job;
  for (let i = 0; i < 120 && !['succeeded', 'failed', 'unknown'].includes(job.status); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    job = (await api(`/media-image/inpaint/${encodeURIComponent(job.jobId)}`)).job;
  }
  return { job, sourceLayerId, maskLayerId, documentId: state.documentId, revision: exported.revision };
}

async function applyInpaintToCanvas(result) {
  const job = result.job;
  if (job.status === 'unknown') { bubble('bot', `局部重绘结果未知（${job.jobId}），请查询原作业；不得重新提交。`); return; }
  if (job.status !== 'succeeded' || !job.assetRef) { bubble('bot', `局部重绘失败：${job.error || job.status}`); return; }
  const connection = await connect();
  const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
  if (state.documentId !== result.documentId) { bubble('bot', '画布文档已切换，生成结果保留为素材；没有写入当前画布。'); return; }
  const mask = state.layers.find(layer => layer.id === result.maskLayerId);
  const source = state.layers.find(layer => layer.id === result.sourceLayerId);
  if (!mask || !source || mask.mask?.sourceLayerId !== source.id) { bubble('bot', '源图或绑定蒙版已变化；生成图保留为素材，请先重新检查蒙版关系。'); return; }
  const answer = await askConfirm({
    title: '将局部重绘结果添加为新图层',
    details: [`源图层  ${source.name}`, `蒙版层  ${mask.name}`, `结果素材 ${job.assetRef}`, '原图和蒙版均不会修改；新图层会带同一张蒙版。'].join('\\n'),
    maskAvailable: true,
  });
  if (!answer.ok) { bubble('bot', '已取消落层，生成结果仍保留在素材库。'); return; }
  const fresh = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
  if (fresh.documentId !== result.documentId || fresh.revision !== state.revision) { bubble('bot', '确认期间工程发生变化，已停止写入；生成结果仍在素材库。请重新核对后再落层。'); return; }
  const applied = await transport.request({ type: 'editor.apply_command', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId,
    documentId: fresh.documentId, expectedRevision: fresh.revision, commandId: crypto.randomUUID(),
    command: { type: 'layer.add_image', payload: { sourceRef: job.assetRef, maskRef: `layer:${mask.id}`, maskMode: 'alpha', x: source.x || 0, y: source.y || 0, width: source.width, height: source.height, fit: 'contain', name: `局部重绘·${source.name}` } } }, { timeoutMs: 20000 });
  bubble('bot', `局部重绘结果已添加为独立蒙版图层 · R${applied.revision}。原图与蒙版仍保留。`);
}

async function composeMaskLayer(maskId) {
  const connection = await connect();
  const read = () => transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
  const before = await read();
  const masks = before.layers.filter(layer => layer.mask?.sourceLayerId);
  const mask = maskId ? masks.find(layer => layer.id === maskId)
    : masks.find(layer => layer.id === before.selectedLayerId) || (masks.length === 1 ? masks[0] : null);
  if (!mask) throw Object.assign(new Error('请选择一张带源图绑定的蒙版层，再说「合成蒙版」。'), { code: 'MASK_TARGET_REQUIRED' });
  const source = before.layers.find(layer => layer.id === mask.mask.sourceLayerId);
  if (!source) throw Object.assign(new Error('蒙版对应的源图已删除，请先撤销删除或重新建立蒙版。'), { code: 'MASK_SOURCE_MISSING' });
  const answer = await askConfirm({ title: '用最新蒙版生成副本', details: '源图：' + source.name + '\n蒙版：' + mask.name + '\n读取当前蒙版像素，新增结果层。原图与蒙版均不改动。', maskAvailable: false });
  if (!answer.ok) { bubble('bot', '已取消合成，现有图层保持不变。'); return; }
  const state = await read();
  if (state.documentId !== before.documentId || state.revision !== before.revision) throw Object.assign(new Error('确认期间画布发生变化，请检查最新蒙版后重新合成。'), { code: 'REVISION_CONFLICT' });
  const result = await transport.request({ type: 'editor.apply_command', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId,
    documentId: state.documentId, expectedRevision: state.revision, commandId: crypto.randomUUID(),
    command: { type: 'layer.add_image', payload: { sourceRef: 'layer:' + source.id, maskRef: 'layer:' + mask.id, maskMode: 'alpha',
      x: source.x || 0, y: source.y || 0, width: source.width, height: source.height, fit: 'stretch', name: '蒙版结果·' + source.name } } }, { timeoutMs: 20000 });
  bubble('bot', '已新增蒙版结果层 · R' + result.revision + '。这是合成快照；继续修蒙版后可再次合成，不会覆盖旧结果。');
}

async function localCutout(assetHint) {
  const line = bubble('bot', '正在自动去背景：先取边界背景色，再按连通区域擦除…');
  try {
    let connection = await connect();
    const readState = () => transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
    let state = await readState();
    const images = state.layers.filter(layer => layer.type === 'image');
    let target = images.find(layer => String(layer.id) === String(state.selectedLayerId)) || images[images.length - 1] || null;

    if (assetHint || !target) {
      const id = assetHint || (/asset:([a-f0-9]{48})/.exec(lastAssetRef || '') || [])[1];
      if (!id) {
        line.textContent = '还没有可抠的图层或素材：先点「上传」选一张图片，再说「抠图」。';
        return;
      }
      const known = knownAssets.find(item => item.id === id);
      const inserted = await insertAssetAsLayer({ id, name: known?.name || '待抠图素材' });
      if (!inserted?.applied) {
        line.textContent = inserted?.cancelled ? '已取消，画布没有改动。' : '插入没有完成，先看上一条回执。';
        return;
      }
      connection = await connect();
      state = await readState();
      const fresh = state.layers.filter(layer => layer.type === 'image');
      target = fresh.find(layer => String(layer.id) === String(state.selectedLayerId)) || fresh[fresh.length - 1] || null;
      if (!target) { line.textContent = '插入后没找到图片图层，请手动确认。'; return; }
    }

    // 人类做法（Photoshop/miniPaint 同构）：先加一个蒙版图层，再用它把商品"抠"出来。
    // 好处：原图完全不动；蒙版是普通图层，之后人还能用画笔补/擦，属于可继续修的非破坏式流程。
    const W = target.width || 1, H = target.height || 1;

    const maskAnswer = await askConfirm({
      title: '添加蒙版图层',
      details: [
        `源图层    ${target.name || target.id}（${W}×${H}）`,
        '做法      按边界背景色生成蒙版：白色=保留、透明=挖掉',
        '影响      只新建一张「蒙版」图层，原图一个像素都不改',
        '后续      你可以在这张蒙版上用画笔继续补/擦',
      ].join('\n'),
      maskAvailable: false,
    });
    if (!maskAnswer.ok) { line.textContent = '已取消，画布没有改动。'; return; }

    let revision = state.revision;
    const maskResult = await transport.request({
      type: 'editor.apply_command',
      requestId: crypto.randomUUID(),
      editorInstanceId: connection.editorInstanceId,
      documentId: state.documentId,
      expectedRevision: revision,
      commandId: crypto.randomUUID(),
      command: { type: 'layer.add_mask_layer', payload: { sourceLayerId: String(target.id), mode: 'subject', tolerance: 12, featherPx: 1 } },
    }, { timeoutMs: 20000 });
    revision = maskResult?.revision ?? revision + 1;
    const maskLayerId = (maskResult?.changedObjectIds || [])[0];
    if (!maskLayerId) { line.textContent = '蒙版图层没有返回 id，已停止（画布只多了这张蒙版，可撤销）。'; return; }
    bubble('bot', `蒙版图层已建立（${maskLayerId}）· R${revision}。可以随时用画笔修它。`);

    await composeMaskLayer(maskLayerId);
    line.textContent = '蒙版已建立。修好后说「合成蒙版」，会读取最新蒙版并新增结果层；原图不变。';
  } catch (error) {
    line.textContent = error.code === 'BACKGROUND_NOT_DETECTED'
      ? '这张图的背景与商品太接近，蒙版没有可用边界。画布已保持原样；这类图需要配置 AI 抠图服务（backgroundRemoval.endpoint）。'
      : `${error.code || 'MASK_CUTOUT_FAILED'}：${error.message}`;
  }
}

// 套版：PSD 模板 → 预览候选槽 → 逐层合成底图 → 规划 → 逐条确认执行。
let psdTemplate = null;
let psdFile = null;
async function apiRaw(pathname, bytes, name, extraHeaders = {}) {
  const token = await boot();
  const response = await fetch(pathname, {
    method: 'POST', credentials: 'same-origin', body: bytes,
    headers: { authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1', 'x-dsh-media-asset': '1', 'x-psd-name': encodeURIComponent(name || 'template.psd'), ...extraHeaders },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(value?.message || `HTTP ${response.status}`), { code: value?.code || 'REQUEST_FAILED' });
  return value;
}

/** 执行一条已规划命令：每次重新读 revision、每次弹确认；失败即停。 */
async function runPlannedCommand(command, label) {
  const connection = await connect();
  const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
  const risky = ['layer.remove', 'canvas.crop', 'layer.add_image'].includes(command.type);
  const answer = await askConfirm({
    title: risky ? `套版（高影响）：${command.type}` : `套版：${command.type}`,
    details: [
      label || '',
      `命令      ${command.type}`,
      `参数      ${JSON.stringify(command.payload).slice(0, 400)}`,
      `目标工程  ${state.documentId} · R${state.revision}`,
      '确认后才会写入画布；可用撤销回退',
    ].filter(Boolean).join('\n'),
    maskAvailable: false,
  });
  if (!answer.ok) return { ok: false, cancelled: true };
  const result = await transport.request({
    type: 'editor.apply_command',
    requestId: crypto.randomUUID(),
    editorInstanceId: connection.editorInstanceId,
    documentId: state.documentId,
    expectedRevision: state.revision,
    commandId: crypto.randomUUID(),
    command: { type: command.type, payload: command.payload },
  }, { timeoutMs: 20000 });
  return { ok: true, revision: result?.revision };
}

/** 套版预览：先把「哪个槽放商品、哪些槽还原不了」摊开给用户看，再执行。 */
function templatePreview(template) {
  const imageSlots = template.slots.filter(slot => slot.type === 'image' && slot.visible !== false);
  const textSlots = template.slots.filter(slot => slot.type === 'text' && slot.visible !== false);
  const canvasArea = template.canvas.width * template.canvas.height;
  const candidates = imageSlots
    .filter(slot => slot.rect.width * slot.rect.height < canvasArea * 0.98)
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  const lines = [`模板 ${template.name}：${template.canvas.width}×${template.canvas.height}，图片槽 ${imageSlots.length}、文字槽 ${textSlots.length}`];
  if (candidates.length) {
    lines.push(`可选商品槽：${candidates.slice(0, 5).map((slot, index) => `#${index + 1} ${slot.name || slot.id}（${Math.round(slot.rect.width * slot.rect.height / canvasArea * 100)}%）`).join('、')}`);
    lines.push('默认用 #1；想换就说「套版：2」。');
  } else {
    lines.push('这张模板没有可放商品图的图片槽。');
  }
  const texts = textSlots.filter(slot => String(slot.text || '').trim()).map(slot => `「${String(slot.text).slice(0, 24)}」`);
  if (texts.length) lines.push(`文字沿用 PSD：${texts.slice(0, 4).join('、')}${texts.length > 4 ? '…' : ''}`);
  lines.push('执行时会把装饰层逐层合成进底图（文字层与商品槽留空）；合成失败才退化为纯色背景。');
  return lines.join('\n');
}

/**
 * 按槽宽收缩文字字号：先量再画，缩不下去就如实报告（不静默溢出）。
 * 测量失败时保留原字号，并把失败原因说出来。
 */
async function fitTextCommands(plan) {
  const texts = (plan.commands || []).filter(command => command.type === 'layer.add_text' && command.meta?.slotWidth);
  if (!texts.length) return { fitted: [], failed: [] };
  const state = await fetchEditorState();
  const fitted = [], failed = [];
  for (const command of texts) {
    try {
      const measured = await transport.request({
        type: 'editor.measure_text', requestId: crypto.randomUUID(), editorInstanceId: state.editorInstanceId,
        text: command.payload.text, style: command.payload.style, maxWidth: command.meta.slotWidth,
      }, { timeoutMs: 10000 });
      const before = command.payload.style.size;
      if (measured.fittedSize && measured.fittedSize < before) {
        command.payload.style.size = measured.fittedSize;
        fitted.push({ slotId: command.meta.slotId, from: before, to: measured.fittedSize });
      }
      if (measured.fits === false) failed.push({ slotId: command.meta.slotId, reason: '即使缩到最小字号仍超出槽宽' });
    } catch (error) {
      failed.push({ slotId: command.meta.slotId, reason: `${error.code || 'MEASURE_FAILED'}：${error.message}` });
    }
  }
  return { fitted, failed };
}

async function applyTemplateFlow(file, slotIndex = null) {
  const line = bubble('bot', file ? '正在解析 PSD 模板……' : '按已解析的模板重新规划……');
  try {
    let template = psdTemplate;
    if (file) {
      psdFile = file;
      const parsed = await apiRaw('/media-image/psd/slots', await file.arrayBuffer(), file.name);
      template = parsed.template;
      psdTemplate = template;
      line.textContent = templatePreview(template);
    }
    if (!template || !psdFile) { line.textContent = '还没有套版模板：先点「套版」选一个 .psd 文件。'; return; }
    if (!lastAssetRef) { bubble('bot', '还没有商品图：先点「上传」选一张（白底图更好），我再套版。'); return; }
    const candidates = (template.slots || []).filter(slot => slot.type === 'image' && slot.visible !== false);
    let slotId = null;
    if (slotIndex !== null) {
      const canvasArea = template.canvas.width * template.canvas.height;
      const ordered = candidates
        .filter(slot => slot.rect.width * slot.rect.height < canvasArea * 0.98)
        .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
      const picked = ordered[slotIndex - 1];
      if (!picked) { line.textContent = `没有第 ${slotIndex} 个可选图片槽（共 ${ordered.length} 个）。`; return; }
      slotId = picked.id;
    }
    // 一次上传完成「逐层合成底图 + 规划」：装饰层回到画布，商品槽与文字层留空。
    const applied = await apiRaw('/media-image/template/apply', await psdFile.arrayBuffer(), psdFile.name, {
      'x-psd-product-asset': lastAssetRef,
      'x-psd-background': '#f4f5f7',
      ...(slotId ? { 'x-psd-slot': slotId } : {}),
    });
    const plan = applied.plan;
    if (applied.base) {
      rememberAsset({ id: applied.base.assetRef.slice(6), name: '模板底图', bytes: 0 });
      bubble('bot', `装饰层已合成进底图（${applied.base.composited} 层${applied.base.skipped ? `，${applied.base.skipped} 层跳过` : ''}）。`);
    } else if (applied.baseError) {
      bubble('bot', `底图合成失败（${applied.baseError.code}），改用纯色背景：PSD 装饰层不会还原。`);
    }
    bubble('bot', `规划 ${plan.summary.commands} 步（图片 ${plan.summary.images}、文字 ${plan.summary.texts}）${plan.summary.productSlot ? `；商品进槽 ${plan.summary.productSlot}` : ''}${plan.skipped.length ? `；${plan.skipped.length} 处无法还原` : ''}。逐步确认后生效。`);
    const fit = await fitTextCommands(plan);
    if (fit.fitted.length) {
      bubble('bot', `文字按槽宽收缩：${fit.fitted.map(item => `${item.from}→${item.to}px`).join('、')}`);
    }
    if (fit.failed.length) {
      bubble('bot', `文字排版有问题：${fit.failed.map(item => `${item.slotId}（${item.reason}）`).join('；')}`);
    }
    for (const command of plan.commands) {
      const result = await runPlannedCommand(command, command.note);
      if (result.cancelled) { bubble('bot', '已取消，后续步骤停止；画布保留已确认的部分。'); return; }
      bubble('bot', `已执行 ${command.type} · 现在 R${result.revision}`);
    }
    if (plan.skipped.length) {
      bubble('bot', `未还原：${plan.skipped.slice(0, 4).map(item => `${item.name || item.slotId || item.kind}（${item.reason}）`).join('；')}`);
    }
    bubble('bot', '套版完成。要换文案或换商品槽再说一次（会另起一次规划）。');
  } catch (error) {
    line.textContent = error.code === 'PSD_BAD_SIGNATURE'
      ? '这不是 PSD 文件。请选择 .psd 模板；PNG/JPG 请走「上传」。'
      : `${error.code || 'TEMPLATE_FAILED'}：${error.message}`;
  }
}

/** 把当前画布导出成 PNG 并入库；导出不写画布，也不推进 revision。 */
async function exportCanvasAsAsset(name) {
  const state = await fetchEditorState();
  const result = await transport.request({
    type: 'editor.export_start', requestId: crypto.randomUUID(), editorInstanceId: state.editorInstanceId,
    documentId: state.documentId, expectedRevision: state.revision, commandId: crypto.randomUUID(), format: 'png',
  }, { timeoutMs: 30000 });
  if (result?.status !== 'completed' || !result.artifactRef) throw Object.assign(new Error('导出未完成'), { code: 'EXPORT_FAILED' });
  const blob = await (await fetch(result.artifactRef)).blob();
  const file = new File([blob], `${name || 'variant'}.png`, { type: 'image/png' });
  const asset = await uploadImageAsset(file);
  rememberAsset(asset);
  return asset;
}

/**
 * 撤销最近 n 条命令，回到批量开始前的状态。
 * 第一步用精确凭据证明栈顶就是我们刚写的命令；桥接 undo 后会清掉 lastCommandId，
 * 所以后续只能走普通撤销，最后用内容摘要核对是否真的回到原状。
 */
async function undoApplied(count, startDigest) {
  let undone = 0;
  for (let i = 0; i < count; i += 1) {
    const state = await fetchEditorState();
    const history = state.history || {};
    if (!history.canUndo) break;
    const payload = (i === 0 && history.lastCommandId && history.afterDigest)
      ? { targetCommandId: history.lastCommandId, afterDigest: history.afterDigest }
      : {};
    await applyEditorCommand(state, { type: 'history.undo', payload });
    undone += 1;
  }
  const after = await fetchEditorState();
  return { undone, digest: after.contentDigest, restored: startDigest ? after.contentDigest === startDigest : null };
}

/** 读一次编辑器状态给批量流程用（返回对象，不打印）。 */
async function fetchEditorState() {
  const connection = await connect();
  return transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
}

async function applyEditorCommand(state, command) {
  return transport.request({
    type: 'editor.apply_command', requestId: crypto.randomUUID(), editorInstanceId: state.editorInstanceId,
    documentId: state.documentId, expectedRevision: state.revision, commandId: crypto.randomUUID(), command,
  }, { timeoutMs: 20000 });
}

/** 批量套版：一次确认，逐份执行→导出→撤销，最后画布回到原状。 */
async function runTemplateBatch() {
  if (!psdTemplate || !psdFile) { bubble('bot', '还没有套版模板：先点「套版」选一个 .psd 文件。'); return; }
  const products = knownAssets.filter(asset => asset.id).slice(0, 20);
  if (products.length === 0) { bubble('bot', '没有商品素材：先「上传」几张商品图，再用批量套版。'); return; }
  if (products.length === 1) { bubble('bot', '目前只有 1 张商品素材；批量套版需要多张，先多上传几张。'); return; }
  const answer = await askConfirm({
    title: `批量套版：${products.length} 份`,
    details: [
      `模板     ${psdTemplate.name}`,
      `商品     ${products.map(asset => asset.name || asset.id).slice(0, 5).join('、')}${products.length > 5 ? '…' : ''}`,
      '做法     逐份：写入画布 → 导出 PNG 入库 → 撤销回原状',
      '影响     画布最终保持现在的样子；成品是素材库里的 PNG',
    ].join('\n'),
    maskAvailable: false,
  });
  if (!answer.ok) { bubble('bot', '已取消，没有写入任何内容。'); return; }

  const line = bubble('bot', '正在提交批量套版规划……');
  let batch;
  try {
    const applied = await apiRaw('/media-image/template/batch', await psdFile.arrayBuffer(), psdFile.name, {
      'x-psd-background': '#f4f5f7',
      'x-psd-products': encodeURIComponent(JSON.stringify(products.map(asset => ({ assetRef: `asset:${asset.id}`, name: asset.name })))),
    });
    batch = applied;
  } catch (error) {
    line.textContent = `${error.code || 'TEMPLATE_BATCH_FAILED'}：${error.message}`;
    return;
  }
  if (batch.baseError) bubble('bot', `底图合成失败（${batch.baseError.code}），改用纯色背景：装饰层不会还原。`);
  const created = [];
  for (const variant of batch.variants) {
    const startState = await fetchEditorState();
    let applied = 0;
    try {
      let revision = startState.revision;
      for (const command of variant.plan.commands) {
        const result = await applyEditorCommand({ ...startState, revision }, command);
        revision = result.revision;
        applied += 1;
      }
      const asset = await exportCanvasAsAsset(`套版-${variant.index}-${variant.name || '商品'}`);
      created.push({ index: variant.index, assetRef: `asset:${asset.id}`, name: asset.name });
      line.textContent = `已出第 ${variant.index}/${batch.variants.length} 份：${asset.name}`;
    } catch (error) {
      const undo = await undoApplied(applied, startState.contentDigest);
      bubble('bot', `第 ${variant.index} 份失败（${error.code || 'TEMPLATE_VARIANT_FAILED'}：${error.message}），已撤销 ${undo.undone} 步${undo.restored === false ? '，但画布未完全恢复，请手动检查' : ''}；批量停止。已完成 ${created.length} 份。`);
      break;
    }
    const undo = await undoApplied(applied, startState.contentDigest);
    if (undo.undone !== applied) {
      bubble('bot', `第 ${variant.index} 份导出成功，但只撤销了 ${undo.undone}/${applied} 步；请检查画布后手动撤销剩余部分。`);
      break;
    }
    if (undo.restored === false) {
      bubble('bot', `第 ${variant.index} 份已撤销 ${undo.undone} 步，但画布摘要与批量前不一致（可能有人同时改了画布）；已停止，请检查。`);
      break;
    }
  }
  if (!created.length) { line.textContent = '批量套版没有产出成品。'; return; }
  const refs = created.map(item => item.assetRef).join(' ');
  line.textContent = `批量套版完成：${created.length} 份 PNG 已入素材库（${created.map(item => item.name).join('、')}）。画布已恢复。说「插入图层」可把最近一份放上画布。`;
  lastAssetRef = created[created.length - 1].assetRef;
  const ref = document.createElement('span');
  ref.className = 'ref';
  ref.textContent = refs;
  line.append(ref);
}

/**
 * 一串命令 → 编辑器里的一条历史记录（history.batch）。
 * Bundle_action 自带"任一步失败就回滚已做的"，所以这里不再手动撤销，撤销栈里也只有一步。
 */
async function runPlanOnEditor(steps) {
  const connection = await connect();
  const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
  const result = await transport.request({
    type: 'editor.apply_command', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId,
    documentId: state.documentId, expectedRevision: state.revision, commandId: crypto.randomUUID(),
    command: { type: 'history.batch', payload: { steps: steps.map(step => ({ type: step.operation, payload: step.params ?? {} })) } },
  }, { timeoutMs: 30000 });
  return { ok: true, applied: steps.length, revision: result?.revision };
}

/**
 * 把命令里的图层 id 翻译成人能核对的内容（名字 · 类型 · 坐标尺寸）。
 * 确认框里只显示 {"layerId":"3"} 时，人没法判断会不会改错层。
 */
function commandTargetSummary(state, command, payload = {}) {
  const layers = state?.layers || [];
  const byId = new Map(layers.map(layer => [String(layer.id), layer]));
  const one = id => {
    const layer = byId.get(String(id));
    if (!layer) return `${id}（图层已不存在）`;
    const rect = `${layer.x ?? 0},${layer.y ?? 0} ${layer.width ?? 0}×${layer.height ?? 0}`;
    return `${layer.name || id} · ${layer.type || 'layer'} · ${rect}`;
  };
  if (payload.layerId !== undefined) return `目标图层  ${one(payload.layerId)}`;
  if (payload.sourceLayerId !== undefined) return `源图层    ${one(payload.sourceLayerId)}`;
  if (command === 'canvas.crop' || command === 'canvas.resize') return `画布      ${state?.canvas?.width ?? '?'}×${state?.canvas?.height ?? '?'}`;
  return '';
}

/** 执行完量一遍：只报数值与需要留意的地方，不评价"好不好看"。 */
async function reportSelfCheck(label) {
  try {
    const state = await fetchEditorState();
    const analysis = await transport.request({ type: 'editor.analyze', requestId: crypto.randomUUID(), editorInstanceId: state.editorInstanceId }, { timeoutMs: 10000 });
    if (!analysis) return;
    const parts = [];
    if (Number.isFinite(analysis.luminance?.mean)) parts.push(`平均亮度 ${analysis.luminance.mean}`);
    if (Number.isFinite(analysis.clipping?.highlights)) parts.push(`高光裁切 ${(analysis.clipping.highlights * 100).toFixed(1)}%`);
    if (Number.isFinite(analysis.clipping?.shadows)) parts.push(`暗部裁切 ${(analysis.clipping.shadows * 100).toFixed(1)}%`);
    const flags = [];
    const layers = analysis.layers || {};
    if ((layers.offCanvas || []).length) flags.push(`${layers.offCanvas.length} 层越界`);
    if ((layers.zeroSize || []).length) flags.push(`${layers.zeroSize.length} 层空尺寸`);
    if ((layers.textOverflow || []).length) flags.push(`${layers.textOverflow.length} 处文字超框`);
    if (!parts.length) return;
    bubble('bot', `${label}自检：${parts.join(' · ')}${flags.length ? ` · 注意 ${flags.join('、')}` : ''}`);
  } catch { /* 测不出来就不说，别编数字 */ }
}

/**
 * 同义说法 → 既有指令（声明式，便于追加）。
 * 只做"改写"，不新增执行路径：改写后的句子仍然走下面同一批分支。
 */
const INTENT_SYNONYMS = [
  [/^(把|将)?(背景|底色)(去掉|删除|移除|拿掉)$/, '抠图'],
  [/^(去掉|删除|移除)(背景|底色)$/, '抠图'],
  [/^抠(图|一下|出来)?$/, '抠图'],
  [/^(再|重新)?合成(一下|蒙版)?$/, '合成蒙版'],
  [/^(撤销|回退|undo)$/i, '撤销'],
  [/^(重做|redo)$/i, '重做'],
  [/^(删掉这层|删除这层|删除当前图层|删除图层)$/, '删除这层'],
  [/^透明度\s*(\d{1,3})\s*%?$/, matched => `透明度 ${matched[1]}`],
  [/^(导出|导出图片|导出png|保存成?png)$/i, '导出PNG'],
  [/^(看看画布|看状态|现在怎么样)$/, '状态'],
  [/^(能做什么|怎么用|有什么功能)$/, '帮助'],
];

/** 未命中时的建议：从 HELP 里挑几条最常用的，带例子。 */
const INTENT_SUGGESTIONS = [
  '抠图', '合成蒙版', '套版', '批量套版', '撤销', '透明度 60%', '导出PNG', '状态', '帮助',
];

function canonicalIntent(text) {
  const value = String(text || '').trim();
  for (const [pattern, target] of INTENT_SYNONYMS) {
    const matched = pattern.exec(value);
    if (!matched) continue;
    return typeof target === 'function' ? target(matched) : target;
  }
  return value;
}

async function routeAssist(raw) {
  const rawText = String(raw || '').trim();
  if (!rawText) return;
  // 同义说法归一到既有指令，避免用户必须背关键词。
  const text = canonicalIntent(rawText);
  const say = (msg, ref) => bubble('bot', msg, ref);

  if (/^(帮助|能做什么|help|\?)$/i.test(text)) { say(HELP); return; }

  if (/^(撤销|回退|undo)$/i.test(text)) {
    try {
      const state = await fetchEditorState();
      if (!state?.history?.canUndo) { say('没有可撤销的操作。'); return; }
      const result = await applyEditorCommand(state, { type: 'history.undo', payload: {} });
      say(`已撤销一步 · 现在 R${result.revision}`);
    } catch (error) { say(`${error.code || 'UNDO_FAILED'}：${error.message}`); }
    return;
  }

  if (/^(重做|redo)$/i.test(text)) {
    try {
      const state = await fetchEditorState();
      if (!state?.history?.canRedo) { say('没有可重做的操作。'); return; }
      const result = await applyEditorCommand(state, { type: 'history.redo', payload: {} });
      say(`已重做一步 · 现在 R${result.revision}`);
    } catch (error) { say(`${error.code || 'REDO_FAILED'}：${error.message}`); }
    return;
  }

  const deleteLayer = /^(删除这层|删除当前图层|删掉这层|删除图层)$/.exec(text);
  if (deleteLayer) {
    try {
      const state = await fetchEditorState();
      const layer = (state.layers || []).find(item => item.id === state.selectedLayerId);
      if (!layer) { say('先在图层面板选中要删除的图层。'); return; }
      const answer = await askConfirm({
        title: '删除图层（高影响）',
        details: [`图层      ${layer.name || layer.id} · ${layer.type}`, `位置      ${layer.x ?? 0},${layer.y ?? 0} ${layer.width ?? 0}×${layer.height ?? 0}`, '删除后可用「撤销」找回'].join('\n'),
        maskAvailable: false,
      });
      if (!answer.ok) { say('已取消，没有删除。'); return; }
      const result = await applyEditorCommand(state, { type: 'layer.remove', payload: { layerId: String(layer.id) } });
      say(`已删除「${layer.name || layer.id}」· 现在 R${result.revision}（要反悔就说「撤销」）`);
    } catch (error) { say(`${error.code || 'REMOVE_FAILED'}：${error.message}`); }
    return;
  }

  const opacity = /^透明度\s*(\d{1,3})\s*%?$/.exec(text);
  if (opacity) {
    const value = Number(opacity[1]);
    if (!(value >= 0 && value <= 100)) { say('透明度要 0..100。'); return; }
    try {
      const state = await fetchEditorState();
      const layer = (state.layers || []).find(item => item.id === state.selectedLayerId);
      if (!layer) { say('先选中一个图层再调透明度。'); return; }
      const result = await applyEditorCommand(state, { type: 'layer.set_appearance', payload: { layerId: String(layer.id), opacity: value } });
      say(`「${layer.name || layer.id}」透明度 → ${value}% · 现在 R${result.revision}`);
    } catch (error) { say(`${error.code || 'APPEARANCE_FAILED'}：${error.message}`); }
    return;
  }

  if (/^(导出|导出png|导出图片)$/i.test(text)) {
    try {
      const state = await fetchEditorState();
      const result = await transport.request({ type: 'editor.export_start', requestId: crypto.randomUUID(), editorInstanceId: state.editorInstanceId,
        documentId: state.documentId, expectedRevision: state.revision, commandId: crypto.randomUUID(), format: 'png' }, { timeoutMs: 30000 });
      if (!result?.artifactRef) { say('导出没有完成。'); return; }
      const link = document.createElement('a');
      link.href = result.artifactRef;
      link.download = `image-${state.revision}.png`;
      link.click();
      say(`已导出 PNG（${Math.round((result.bytes || 0) / 1024)} KB）· 导出不改画布`);
    } catch (error) { say(`${error.code || 'EXPORT_FAILED'}：${error.message}`); }
    return;
  }

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

  if (/^局部重绘[:：]\s*([\s\S]+)$/.test(text)) {
    const prompt = /^局部重绘[:：]\s*([\s\S]+)$/.exec(text)[1].trim();
    const connection = await connect();
    const state = await transport.request({ type: 'editor.read_state', requestId: crypto.randomUUID(), editorInstanceId: connection.editorInstanceId });
    const selected = state.layers.find(layer => layer.id === state.selectedLayerId);
    const selectedMask = selected?.mask?.sourceLayerId ? selected : null;
    const sourceLayerId = selectedMask?.mask.sourceLayerId || (selected?.type === 'image' ? selected.id : null);
    const maskLayerId = selectedMask?.id || null;
    if (!sourceLayerId || (!maskLayerId && !state.selection)) {
      say('局部重绘需要：选中带源图绑定的蒙版层，或选中图片层并保持选区。先用画笔修好蒙版/选区，再重试。');
      return;
    }
    const provider = assistProvider();
    const providerList = await api('/media-image/inpaint');
    const capable = (providerList.providers || []).find(p => p.id === provider && p.capabilities?.inpaint === true);
    if (!capable) {
      const configured = (providerList.providers || []).map(p => `${p.id}${p.capabilities?.inpaint ? '（局部重绘）' : '（仅普通生图）'}`).join('、');
      say(`当前后端不支持局部重绘${configured ? `：${configured}` : ''}。需要在插件配置中为 ComfyUI provider 声明 editImageNode 与 editMaskNode，并使用支持 inpaint 的 API workflow；没有提交生成作业。`);
      return;
    }
    const pending = bubble('bot', '正在读取源图与当前选区/蒙版，并提交局部重绘……');
    try {
      const result = await sendInpaint({ provider, prompt, connection, state, sourceLayerId, maskLayerId });
      pending.textContent = result.job.status === 'succeeded' ? '局部重绘已完成；结果还只是素材，等待确认后才写入画布。' : `局部重绘作业状态：${result.job.status}`;
      if (result.job.status === 'succeeded') await applyInpaintToCanvas(result);
      else if (result.job.status === 'unknown') bubble('bot', `结果未知，不能重提；作业 ${result.job.jobId} 可查询。`);
      else if (result.job.status === 'failed') bubble('bot', `局部重绘失败：${result.job.error || '后端返回失败'}`);
    } catch (error) { pending.textContent = `${error.code || 'INPAINT_FAILED'}：${error.message}`; }
    return;
  }

  const templateChoice = /^套版(?::\s*(\d+))?$/.exec(text);
  if (templateChoice) {
    if (!psdTemplate) { say('还没有套版模板：点「套版」选一个 .psd 文件，解析后再说「套版」。'); return; }
    await applyTemplateFlow(null, templateChoice[1] ? Number(templateChoice[1]) : null);
    return;
  }

  if (/^批量套版$/.test(text)) { await runTemplateBatch(); return; }


  const remove = /^抠图(?:[:：]\s*(.+))?$/.exec(text);
  if (remove) {
    // 优先走本地自动去背景（无外部服务也能用）；用户点名了某张已上传素材时才走 AI 服务路径。
    const wanted = remove[1];
    const asset = wanted
      ? knownAssets.find(item => item.name && item.name.toLowerCase().includes(wanted.trim().toLowerCase()))
      : null;
    if (!wanted) { await localCutout(); return; }
    if (asset) {
      const pending = bubble('bot', `准备用 AI 抠图服务处理「${asset.name}」…原图会保留，结果另存为透明 PNG。`);
      try {
        const value = await api(`/media-image/background-removal/${encodeURIComponent(asset.id)}`, { method: 'POST', body: {} });
        rememberAsset(value.asset);
        pending.textContent = 'AI 抠图完成，原图保留；结果是新的透明 PNG。说「插入图层」后先确认再落画布。';
        const ref = document.createElement('span');
        ref.className = 'ref';
        ref.textContent = value.sourceRef;
        pending.append(ref);
      } catch (error) {
        pending.textContent = error.code === 'BACKGROUND_REMOVAL_UNAVAILABLE'
          ? '没有配置 AI 抠图服务。可以直接说「抠图」，我用本地方式处理画布上的白底/纯色底图片。'
          : `${error.code || 'BACKGROUND_REMOVAL_FAILED'}：${error.message}。原图没有改动。`;
      }
      return;
    }
    await localCutout();
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

  say(`还没听懂「${rawText}」。可以试试：${INTENT_SUGGESTIONS.join(' / ')}；说「帮助」看全部说法。`);
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
    if (/^(合成|合成蒙版|重新合成)$/.test(text)) { await composeMaskLayer(); return; }
    // 抠图是确定性工具意图，不交给模型拒答或猜测；后端不可用会明确提示配置要求。
    if (/^抠图(?:[:：].*)?$/.test(text)) {
      await routeAssist(text);
      return;
    }
    // 明确的“插入图层”不需要让模型再猜一次：用最近上传/导入/生成的 asset，
    // 仍经同一个显式确认框与 editor.apply_command，绝不绕过人机闸门。
    if (/^(插入图层|插入|放到画布|把它放到画布上|落层)$/.test(text) && lastAssetRef) {
      const assetId = lastAssetRef.slice('asset:'.length);
      const asset = knownAssets.find(item => item.id === assetId);
      const result = await insertAssetAsLayer({ id: assetId, name: asset?.name || '最近的图片' });
      if (result?.applied) bubble('bot', `已插入「${asset?.name || '最近的图片'}」${result.revision ? ` · R${result.revision}` : ''}。`);
      else bubble('bot', result?.cancelled ? '已取消，没有发送任何命令。' : '插入请求结束；看上一条状态说明处理结果。');
      return;
    }

    // 先走真实模型；只有“模型不可用”才退回本地指令（并明确告诉用户）。
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
