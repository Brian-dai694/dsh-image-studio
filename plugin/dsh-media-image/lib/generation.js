// 生成后端接口层：本地 ComfyUI 或云端 HTTP API。
//
// 设计约束（与本插件其他部分的约定一致）：
// 1) 只做"提交 → 轮询 → 拿字节 → 进素材库"这一条路，结果就是 asset:<id>，
//    后续复用 layer.add_image 的白名单/审批/撤销，不另开写入通道。
// 2) 网络歧义不能当成失败：轮询抛错一律记为 unknown，保留 remoteId，允许再次查询；
//    只有后端明确回失败才是 failed。
// 3) 永不回显 apiKey；错误原文只在 error.message 里，且不含凭据。
//
// 本轮只提供接口与适配器，不内置任何真实后端；未配置 provider 时返回 PROVIDER_UNAVAILABLE。

import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 20_000;
const JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 64;

export class GenerationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
    Object.assign(this, details);
  }
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const trimSlash = value => String(value).replace(/\/+$/, '');

async function requestJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    // 传输层失败：可能是没起来、超时、被中断 —— 调用方必须当成"未知"，不能当"后端拒绝"。
    throw new GenerationError('GENERATION_UNREACHABLE', `生成服务不可达：${error?.message || 'network error'}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new GenerationError('GENERATION_FAILED', `生成服务返回 HTTP ${response.status}`);
  return response.json();
}

async function requestBytes(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new GenerationError('GENERATION_FAILED', `读取生成结果失败：HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError('GENERATION_UNREACHABLE', `读取生成结果失败：${error?.message || 'network error'}`);
  } finally {
    clearTimeout(timer);
  }
}

function imageBytesFromBase64(value) {
  if (typeof value !== 'string' || !value) throw new GenerationError('GENERATION_FAILED', '后端返回了空的图片数据');
  // 允许带 data: 前缀，也允许裸 base64。
  const bare = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const bytes = Buffer.from(bare, 'base64');
  if (!bytes.length) throw new GenerationError('GENERATION_FAILED', '后端返回的图片数据无法解码');
  return bytes;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

// ── ComfyUI 适配器 ────────────────────────────────────────────────────
// 提交：POST {baseUrl}/prompt  body {prompt: <API 格式工作流>, client_id}
// 轮询：GET  {baseUrl}/history/{prompt_id}
// 取图：GET  {baseUrl}/view?filename=&subfolder=&type=output
// 提示词注入点由配置给出（promptNode.nodeId + promptNode.field），不猜工作流结构。
export function createComfyUiProvider({ id, baseUrl, workflow, promptNode = null, widthNode = null, heightNode = null, apiKey = null, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!isObject(workflow)) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 缺少 workflow（ComfyUI API 格式 JSON）`);
  if (!baseUrl) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 缺少 baseUrl`);
  const root = trimSlash(baseUrl);
  const headers = { 'content-type': 'application/json', ...authHeaders(apiKey) };

  const graph = (prompt, width, height) => {
    const copy = JSON.parse(JSON.stringify(workflow));
    if (promptNode) {
      const node = copy?.[promptNode.nodeId];
      if (!isObject(node?.inputs)) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的 promptNode 指向不存在的节点`);
      node.inputs[promptNode.field || 'text'] = prompt;
    }
    for (const [spec, value] of [[widthNode, width], [heightNode, height]]) {
      if (!spec || value === undefined) continue;
      const node = copy?.[spec.nodeId];
      if (!isObject(node?.inputs)) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的尺寸节点不存在`);
      node.inputs[spec.field || 'value'] = value;
    }
    return copy;
  };

  return {
    id,
    kind: 'comfyui',
    describe() { return { id, kind: 'comfyui', baseUrl: root, hasApiKey: !!apiKey }; },
    async start({ prompt, width, height }) {
      const payload = await requestJson(fetchImpl, `${root}/prompt`, {
        method: 'POST', headers, body: JSON.stringify({ prompt: graph(prompt, width, height), client_id: randomUUID() }),
      }, timeoutMs);
      if (!payload?.prompt_id) throw new GenerationError('GENERATION_FAILED', 'ComfyUI 没有返回 prompt_id');
      return { remoteId: String(payload.prompt_id) };
    },
    async poll({ remoteId }) {
      const history = await requestJson(fetchImpl, `${root}/history/${encodeURIComponent(remoteId)}`, { headers }, timeoutMs);
      const entry = isObject(history) ? history[remoteId] : null;
      if (!entry) return { status: 'running' };
      for (const output of Object.values(entry.outputs || {})) {
        const image = Array.isArray(output?.images) ? output.images[0] : null;
        if (!image?.filename) continue;
        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
        const bytes = await requestBytes(fetchImpl, `${root}/view?${query.toString()}`, { headers }, timeoutMs);
        return { status: 'succeeded', bytes };
      }
      if (entry.status?.status_str === 'error') return { status: 'failed', error: 'ComfyUI 工作流执行失败' };
      return { status: 'running' };
    },
  };
}

// ── 通用云端 HTTP 适配器 ──────────────────────────────────────────────
// 提交：POST {baseUrl}{submitPath} body {prompt,width,height,...extra}
//   响应可以是：{image_base64} / {image_url}（同步出图），或 {job_id}（异步）
// 轮询：GET {baseUrl}{pollPath}，pollPath 里的 {jobId} 会被替换
export function createHttpJsonProvider({ id, baseUrl, submitPath = '/generate', pollPath = '/jobs/{jobId}', apiKey = null, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!baseUrl) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 缺少 baseUrl`);
  const root = trimSlash(baseUrl);
  const headers = { 'content-type': 'application/json', ...authHeaders(apiKey) };

  const bytesFrom = async payload => {
    if (typeof payload?.image_base64 === 'string') return imageBytesFromBase64(payload.image_base64);
    if (typeof payload?.image_url === 'string') return requestBytes(fetchImpl, payload.image_url, { headers }, timeoutMs);
    return null;
  };

  return {
    id,
    kind: 'http-json',
    describe() { return { id, kind: 'http-json', baseUrl: root, submitPath, hasApiKey: !!apiKey }; },
    async start({ prompt, width, height, extra }) {
      const payload = await requestJson(fetchImpl, `${root}${submitPath}`, {
        method: 'POST', headers, body: JSON.stringify({ prompt, width, height, ...(isObject(extra) ? extra : {}) }),
      }, timeoutMs);
      const bytes = await bytesFrom(payload);
      if (bytes) return { bytes };
      const jobId = payload?.job_id ?? payload?.id;
      if (!jobId) throw new GenerationError('GENERATION_FAILED', '云端响应既没有图片也没有 job_id');
      return { remoteId: String(jobId) };
    },
    async poll({ remoteId }) {
      const payload = await requestJson(fetchImpl, `${root}${pollPath.replace('{jobId}', encodeURIComponent(remoteId))}`, { headers }, timeoutMs);
      const state = String(payload?.status ?? '').toLowerCase();
      if (['failed', 'error', 'cancelled'].includes(state)) return { status: 'failed', error: payload?.error ? String(payload.error) : '云端生成失败' };
      const bytes = await bytesFrom(payload);
      if (bytes) return { status: 'succeeded', bytes };
      return { status: 'running' };
    },
  };
}

export function buildProvider(definition, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isObject(definition) || typeof definition.id !== 'string' || !definition.id) {
    throw new GenerationError('PROVIDER_INVALID', 'provider 需要一个非空 id');
  }
  if (definition.kind === 'comfyui') return createComfyUiProvider({ ...definition, fetchImpl, timeoutMs });
  if (definition.kind === 'http-json') return createHttpJsonProvider({ ...definition, fetchImpl, timeoutMs });
  throw new GenerationError('PROVIDER_INVALID', `未知的 provider kind: ${String(definition.kind)}`);
}

/**
 * 异步作业服务：提交拿 jobId，status() 驱动轮询；成功即写入素材库并给出 asset:<id>。
 * assets 是 lib/assets.js 的实例（同一份内存素材表），因此生成结果和手工上传走同一条回流路径。
 */
export function createGenerationService({ providers = [], assets, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!assets || typeof assets.add !== 'function') throw new TypeError('assets store is required');
  const registry = new Map();
  for (const definition of providers) {
    const provider = buildProvider(definition, { fetchImpl, timeoutMs });
    if (registry.has(provider.id)) throw new GenerationError('PROVIDER_INVALID', `provider id 重复: ${provider.id}`);
    registry.set(provider.id, provider);
  }
  const jobs = new Map();
  const byIdempotencyKey = new Map();

  const sweep = () => {
    const cutoff = now() - JOB_TTL_MS;
    for (const [jobId, job] of jobs) {
      if (job.createdAt < cutoff && job.status !== 'running') {
        jobs.delete(jobId);
        if (job.idempotencyKey) byIdempotencyKey.delete(job.idempotencyKey);
      }
    }
  };

  const publicJob = job => ({
    jobId: job.jobId,
    provider: job.provider,
    status: job.status,
    prompt: job.prompt,
    ...(job.width !== undefined ? { width: job.width } : {}),
    ...(job.height !== undefined ? { height: job.height } : {}),
    ...(job.assetRef ? { assetRef: job.assetRef } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });

  const settle = (job, outcome) => {
    job.updatedAt = now();
    if (outcome.status === 'succeeded') {
      const asset = assets.add({ bytes: outcome.bytes, name: `generated-${job.provider}-${job.jobId}` });
      job.status = 'succeeded';
      job.assetRef = `asset:${asset.id}`;
      job.error = null;
      return;
    }
    if (outcome.status === 'failed') {
      job.status = 'failed';
      job.error = outcome.error || '生成失败';
      return;
    }
    if (outcome.status === 'unknown') {
      // 歧义：保留 remoteId，下一次 status() 还能再查，不判死。
      job.status = 'unknown';
      job.error = outcome.error || '结果未知，请再次查询';
      return;
    }
    job.status = 'running';
  };

  return {
    list() {
      return [...registry.values()].map(provider => provider.describe());
    },
    configured() { return registry.size > 0; },
    async submit({ provider, prompt, width, height, extra, idempotencyKey } = {}) {
      sweep();
      const adapter = registry.get(provider);
      if (!adapter) {
        throw new GenerationError(registry.size ? 'PROVIDER_UNKNOWN' : 'PROVIDER_UNAVAILABLE',
          registry.size ? `未配置的 provider: ${String(provider)}` : '未配置任何生成后端；请设置 generation.providers 或 DSH_MEDIA_IMAGE_PROVIDERS');
      }
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
        throw new GenerationError('INVALID_REQUEST', 'prompt 必须是 1..4000 字符');
      }
      for (const [key, value] of [['width', width], ['height', height]]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 16 || value > 8192)) {
          throw new GenerationError('INVALID_REQUEST', `${key} 必须是 16..8192 的整数`);
        }
      }
      if (idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200) {
          throw new GenerationError('INVALID_REQUEST', 'idempotencyKey 必须是 1..200 字符');
        }
        const existing = byIdempotencyKey.get(idempotencyKey);
        if (existing && jobs.has(existing)) return publicJob(jobs.get(existing));
      }
      if (jobs.size >= MAX_JOBS) throw new GenerationError('GENERATION_BUSY', '并发作业过多，请先处理已有作业');

      const job = {
        jobId: randomUUID(), provider: adapter.id, prompt, width, height,
        status: 'queued', remoteId: null, assetRef: null, error: null,
        idempotencyKey: idempotencyKey ?? null, createdAt: now(), updatedAt: now(),
      };
      jobs.set(job.jobId, job);
      if (job.idempotencyKey) byIdempotencyKey.set(job.idempotencyKey, job.jobId);
      try {
        const started = await adapter.start({ prompt, width, height, extra });
        if (started.bytes) settle(job, { status: 'succeeded', bytes: started.bytes });
        else { job.remoteId = started.remoteId; job.status = 'running'; job.updatedAt = now(); }
      } catch (error) {
        // 提交阶段失败是真的失败：还没拿到 remoteId，后端没开始干活。
        job.status = 'failed';
        job.error = error?.message || '提交生成任务失败';
        job.updatedAt = now();
      }
      return publicJob(job);
    },
    async status(jobId) {
      sweep();
      const job = jobs.get(jobId);
      if (!job) throw new GenerationError('JOB_NOT_FOUND', '找不到该生成作业（可能已过期）');
      if (job.status === 'succeeded' || job.status === 'failed') return publicJob(job);
      const adapter = registry.get(job.provider);
      if (!adapter || !job.remoteId) {
        job.status = 'failed';
        job.error = '生成后端已不可用';
        job.updatedAt = now();
        return publicJob(job);
      }
      try {
        settle(job, await adapter.poll({ remoteId: job.remoteId }));
      } catch (error) {
        // 轮询出任何传输层问题都不是"没生成"，而是"不知道"。
        settle(job, { status: 'unknown', error: error?.message || '轮询生成结果失败' });
      }
      return publicJob(job);
    },
  };
}
