// 批量生成队列：把 N 条提示词排进一个有并发上限的队列，逐项独立成败。
//
// 设计取舍（与 generation.js 的语义保持一致）：
// - **拉取式推进**：状态只在 status() 时推进，不起后台定时器。好处是行为确定、可在 Node 里
//   用假后端精确断言并发与逐项状态；代价是需要有人来"查"，页面轮询或模型查一次都算。
// - **失败不自动重试**：单条失败只记证据（错误码在 item 上），整批照常往下跑；
//   想重试就显式重提一次（那是新作业，不是把旧作业重放）。
// - **partial 是独立状态**：3 成 2 败既不是 succeeded 也不是 failed。
// - 只存在内存里：进程重启即失效，与素材库/生成作业同一口径。

import { randomUUID } from 'node:crypto';

export const MAX_PROMPTS_PER_BATCH = 20;
export const DEFAULT_CONCURRENCY = 2;
const BATCH_TTL_MS = 30 * 60_000;
const MAX_BATCHES = 16;

export class BatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BatchError';
    this.code = code;
  }
}

const isActive = item => item.status === 'queued' || item.status === 'running' || item.status === 'unknown';

export function createBatchQueue({ generation, maxConcurrency = DEFAULT_CONCURRENCY, now = () => Date.now() } = {}) {
  if (!generation || typeof generation.submit !== 'function') throw new TypeError('generation service is required');
  const batches = new Map();
  const byIdempotencyKey = new Map();

  const sweep = () => {
    const cutoff = now() - BATCH_TTL_MS;
    for (const [id, batch] of batches) {
      if (batch.status !== 'running' && batch.createdAt < cutoff) {
        batches.delete(id);
        if (batch.idempotencyKey) byIdempotencyKey.delete(batch.idempotencyKey);
      }
    }
  };

  const summarize = batch => {
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0 };
    for (const item of batch.items) counts[item.status] += 1;
    if (counts.running + counts.queued + counts.unknown > 0) batch.status = 'running';
    else if (counts.succeeded === batch.items.length) batch.status = 'succeeded';
    else if (counts.succeeded === 0) batch.status = 'failed';
    else batch.status = 'partial';
    batch.counts = counts;
    batch.updatedAt = now();
    return batch;
  };

  const publicBatch = batch => ({
    batchId: batch.batchId,
    provider: batch.provider,
    status: batch.status,
    counts: { ...batch.counts },
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    items: batch.items.map(item => ({
      index: item.index,
      prompt: item.prompt,
      status: item.status,
      ...(item.jobId ? { jobId: item.jobId } : {}),
      ...(item.assetRef ? { assetRef: item.assetRef } : {}),
      ...(item.error ? { error: item.error } : {}),
    })),
  });

  // 一次推进：先把在途的查一遍，再按并发上限补位。
  async function drive(batch) {
    if (batch.status !== 'running') return batch;
    for (const item of batch.items) {
      if (!item.jobId || !isActive(item)) continue;
      try {
        const job = await generation.status(item.jobId);
        item.status = job.status === 'succeeded' ? 'succeeded'
          : job.status === 'failed' ? 'failed'
            : job.status === 'unknown' ? 'unknown' : 'running';
        if (job.assetRef) item.assetRef = job.assetRef;
        if (job.error) item.error = job.error;
      } catch (error) {
        // 查不到不是"生成失败"：保持 unknown，下次再查。
        item.status = 'unknown';
        item.error = error?.message || '查询作业状态失败';
      }
    }
    summarize(batch);

    while (batch.status === 'running') {
      const active = batch.items.filter(item => item.status === 'running').length;
      if (active >= batch.concurrency) break;
      const next = batch.items.find(item => item.status === 'queued');
      if (!next) break;
      next.status = 'running';
      try {
        const job = await generation.submit({
          provider: batch.provider, prompt: next.prompt, width: batch.width, height: batch.height,
        });
        next.jobId = job.jobId;
        next.status = job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' ? 'failed' : 'running';
        if (job.assetRef) next.assetRef = job.assetRef;
        if (job.error) next.error = job.error;
      } catch (error) {
        next.status = 'failed';
        next.error = error?.message || '提交失败';
      }
      summarize(batch);
    }
    return batch;
  }

  return {
    async submit({ provider, prompts, width, height, idempotencyKey, concurrency } = {}) {
      sweep();
      if (!Array.isArray(prompts) || !prompts.length) throw new BatchError('INVALID_REQUEST', 'prompts 必须是非空数组');
      if (prompts.length > MAX_PROMPTS_PER_BATCH) throw new BatchError('INVALID_REQUEST', `一批最多 ${MAX_PROMPTS_PER_BATCH} 条`);
      const cleaned = prompts.map(prompt => (typeof prompt === 'string' ? prompt.trim() : ''));
      if (cleaned.some(prompt => !prompt || prompt.length > 4000)) throw new BatchError('INVALID_REQUEST', '每条提示词必须是 1..4000 字符');
      if (idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200) throw new BatchError('INVALID_REQUEST', 'idempotencyKey 必须是 1..200 字符');
        const existing = byIdempotencyKey.get(idempotencyKey);
        if (existing && batches.has(existing)) return publicBatch(batches.get(existing));
      }
      if (batches.size >= MAX_BATCHES) throw new BatchError('BATCH_BUSY', '并发批次过多，请先处理已有批次');
      const limit = Number.isSafeInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 4) : maxConcurrency;

      const batch = {
        batchId: randomUUID(), provider, width, height,
        concurrency: limit, idempotencyKey: idempotencyKey ?? null,
        status: 'running', counts: { queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0 },
        createdAt: now(), updatedAt: now(),
        items: cleaned.map((prompt, index) => ({ index, prompt, status: 'queued', jobId: null, assetRef: null, error: null })),
      };
      batches.set(batch.batchId, batch);
      if (batch.idempotencyKey) byIdempotencyKey.set(batch.idempotencyKey, batch.batchId);
      await drive(batch);
      return publicBatch(batch);
    },
    async status(batchId) {
      sweep();
      const batch = batches.get(batchId);
      if (!batch) throw new BatchError('BATCH_NOT_FOUND', '找不到该批次（可能已过期）');
      return publicBatch(await drive(batch));
    },
    list() {
      sweep();
      return [...batches.values()].map(batch => ({ batchId: batch.batchId, provider: batch.provider, status: batch.status, counts: { ...batch.counts } }));
    },
    clear() { batches.clear(); byIdempotencyKey.clear(); },
  };
}
