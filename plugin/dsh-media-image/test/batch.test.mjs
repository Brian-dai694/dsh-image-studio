// 批量队列：并发上限、逐项独立成败、partial 语义、失败不自动重试。
// 用假 generation service，直接控制每个作业的推进节奏，避免依赖真实后端与定时器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchQueue, MAX_PROMPTS_PER_BATCH, BatchError } from '../lib/batch.js';
import { createMediaRouter } from '../lib/http.js';

// 假后端：submit 只登记，status 由测试显式推进。
function fakeGeneration({ failIndices = [] } = {}) {
  const jobs = new Map();
  let inFlight = 0;
  let peak = 0;
  let seq = 0;
  return {
    get peak() { return peak; },
    get jobs() { return jobs; },
    async submit({ prompt }) {
      const jobId = `job-${++seq}`;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const fail = failIndices.includes(seq - 1);
      jobs.set(jobId, { prompt, state: 'running', fail, done: false });
      return { jobId, provider: 'fake', status: 'running' };
    },
    async status(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new Error('job missing');
      if (job.done) return { jobId, provider: 'fake', status: job.fail ? 'failed' : 'succeeded', ...(job.fail ? { error: '后端失败' } : { assetRef: `asset:${'a'.repeat(48)}` }) };
      return { jobId, provider: 'fake', status: 'running' };
    },
    finish(jobId) { const job = jobs.get(jobId); job.done = true; inFlight -= 1; },
    finishAll() { for (const [jobId, job] of jobs) if (!job.done) { job.done = true; inFlight -= 1; } },
  };
}

test('并发上限真的生效，且逐项独立推进', async () => {
  const generation = fakeGeneration();
  const queue = createBatchQueue({ generation, maxConcurrency: 2 });
  const batch = await queue.submit({ provider: 'fake', prompts: ['a', 'b', 'c', 'd'] });
  assert.equal(batch.items.length, 4);
  // 上限 2：只应有 2 条在跑，其余排队。
  assert.equal(batch.items.filter(item => item.status === 'running').length, 2);
  assert.equal(batch.items.filter(item => item.status === 'queued').length, 2);
  assert.equal(batch.status, 'running');

  // 完成第一条后，下一次推进才会补位。
  generation.finish(batch.items[0].jobId);
  const advanced = await queue.status(batch.batchId);
  assert.equal(advanced.items[0].status, 'succeeded');
  assert.match(advanced.items[0].assetRef, /^asset:/);
  assert.ok(advanced.items.filter(item => item.status === 'running').length <= 2, '并发不得超过上限');
  assert.ok(generation.peak <= 2, `实际并发峰值 ${generation.peak} 超过上限`);
});

test('部分成功给 partial，全部成功给 succeeded，全部失败给 failed', async () => {
  const okGen = fakeGeneration();
  const okQueue = createBatchQueue({ generation: okGen, maxConcurrency: 4 });
  const okBatch = await okQueue.submit({ provider: 'fake', prompts: ['a', 'b'] });
  okGen.finishAll();
  const okDone = await okQueue.status(okBatch.batchId);
  assert.equal(okDone.status, 'succeeded');
  assert.deepEqual(okDone.counts, { queued: 0, running: 0, succeeded: 2, failed: 0, unknown: 0 });

  // 第二条必然失败
  const mixedGen = fakeGeneration({ failIndices: [1] });
  const mixedQueue = createBatchQueue({ generation: mixedGen, maxConcurrency: 4 });
  const mixedBatch = await mixedQueue.submit({ provider: 'fake', prompts: ['a', 'b'] });
  mixedGen.finishAll();
  const mixed = await mixedQueue.status(mixedBatch.batchId);
  assert.equal(mixed.status, 'partial', '3 成 2 败不能报成 succeeded 或 failed');
  assert.equal(mixed.counts.succeeded, 1);
  assert.equal(mixed.counts.failed, 1);
  assert.match(mixed.items[1].error, /后端失败/);

  const allFailGen = fakeGeneration({ failIndices: [0, 1] });
  const allFailQueue = createBatchQueue({ generation: allFailGen, maxConcurrency: 4 });
  const allFailBatch = await allFailQueue.submit({ provider: 'fake', prompts: ['a', 'b'] });
  allFailGen.finishAll();
  assert.equal((await allFailQueue.status(allFailBatch.batchId)).status, 'failed');
});

test('失败项不会被自动重试——推进不会重新提交', async () => {
  const generation = fakeGeneration({ failIndices: [0] });
  const queue = createBatchQueue({ generation, maxConcurrency: 2 });
  const batch = await queue.submit({ provider: 'fake', prompts: ['a', 'b'] });
  const submitted = generation.jobs.size;
  generation.finishAll();
  await queue.status(batch.batchId);
  await queue.status(batch.batchId);
  await queue.status(batch.batchId);
  assert.equal(generation.jobs.size, submitted, '重复查询不得产生新作业（失败不重试）');
  assert.equal((await queue.status(batch.batchId)).status, 'partial');
});

test('查询异常保持 unknown 而不是 failed，且下一次推进还能恢复', async () => {
  const generation = fakeGeneration();
  const queue = createBatchQueue({ generation, maxConcurrency: 2 });
  const batch = await queue.submit({ provider: 'fake', prompts: ['a'] });
  const jobId = batch.items[0].jobId;
  const realStatus = generation.status.bind(generation);
  let thrown = false;
  generation.status = async id => { if (!thrown) { thrown = true; throw new Error('socket hang up'); } return realStatus(id); };
  const ambiguous = await queue.status(batch.batchId);
  assert.equal(ambiguous.items[0].status, 'unknown');
  assert.match(ambiguous.items[0].error, /socket hang up/);
  assert.equal(ambiguous.status, 'running', 'unknown 不是终态，批次仍在跑');

  generation.finish(jobId);
  const recovered = await queue.status(batch.batchId);
  assert.equal(recovered.items[0].status, 'succeeded');
  assert.equal(recovered.status, 'succeeded');
});

test('参数与幂等：超量、空提示、重复幂等键、未知批次', async () => {
  const generation = fakeGeneration();
  const queue = createBatchQueue({ generation });
  await assert.rejects(() => queue.submit({ provider: 'fake', prompts: [] }), { code: 'INVALID_REQUEST' });
  await assert.rejects(() => queue.submit({ provider: 'fake', prompts: ['  '] }), { code: 'INVALID_REQUEST' });
  await assert.rejects(() => queue.submit({ provider: 'fake', prompts: Array.from({ length: MAX_PROMPTS_PER_BATCH + 1 }, () => 'x') }), { code: 'INVALID_REQUEST' });
  await assert.rejects(() => queue.status('missing'), { code: 'BATCH_NOT_FOUND' });
  assert.throws(() => createBatchQueue({}), { name: 'TypeError' });

  const first = await queue.submit({ provider: 'fake', prompts: ['a'], idempotencyKey: 'k1' });
  const second = await queue.submit({ provider: 'fake', prompts: ['a'], idempotencyKey: 'k1' });
  assert.equal(second.batchId, first.batchId, '同一幂等键不得重复建批');
  assert.equal(generation.jobs.size, 1);
});

test('HTTP 路由：未配置 501、鉴权 403、提交 202、未知批次 404，且 batch 不被当成 jobId', async () => {
  const token = 'batch-token';
  const caller = router => async ({ method = 'GET', url, headers = {}, body }) => {
    const out = { status: 0, headers: {}, body: '' };
    const res = { writeHead(status, h) { out.status = status; out.headers = h ?? {}; return res; }, end(chunk) { out.body = chunk === undefined ? '' : String(chunk); } };
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    await router(req, res);
    let value = null;
    try { value = JSON.parse(out.body); } catch { value = null; }
    return { ...out, value };
  };
  const auth = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', authorization: `Bearer ${token}` };

  const withoutQueue = caller(createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.' }));
  assert.equal((await withoutQueue({ url: '/media-image/generate/batch', headers: auth })).status, 501);

  const generation = fakeGeneration();
  const queue = createBatchQueue({ generation, maxConcurrency: 2 });
  const call = caller(createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', batchQueue: queue }));

  const noAuth = await call({ method: 'POST', url: '/media-image/generate/batch', headers: { ...auth, authorization: 'Bearer nope' }, body: { provider: 'fake', prompts: ['a'] } });
  assert.equal(noAuth.status, 403);

  const submitted = await call({ method: 'POST', url: '/media-image/generate/batch', headers: auth, body: { provider: 'fake', prompts: ['a', 'b'] } });
  assert.equal(submitted.status, 202, 'batch 路由必须优先于单作业路由，否则会被当成 jobId 返回 404');
  assert.equal(submitted.value.batch.items.length, 2);
  const batchId = submitted.value.batch.batchId;

  const polled = await call({ url: `/media-image/generate/batch/${batchId}`, headers: auth });
  assert.equal(polled.status, 200);
  assert.equal(polled.value.batch.batchId, batchId);

  const missing = await call({ url: '/media-image/generate/batch/nope', headers: auth });
  assert.equal(missing.status, 404);
  assert.equal(missing.value.code, 'BATCH_NOT_FOUND');

  const badBody = await call({ method: 'POST', url: '/media-image/generate/batch', headers: auth, body: { provider: 'fake', prompts: [] } });
  assert.equal(badBody.status, 400);
});

test('提交阶段的失败只影响该条，其余继续', async () => {
  const generation = fakeGeneration();
  let calls = 0;
  const realSubmit = generation.submit.bind(generation);
  generation.submit = async args => {
    calls += 1;
    if (calls === 1) throw new Error('后端 502');
    return realSubmit(args);
  };
  const queue = createBatchQueue({ generation, maxConcurrency: 1 });
  const batch = await queue.submit({ provider: 'fake', prompts: ['a', 'b'] });
  assert.equal(batch.items[0].status, 'failed');
  assert.match(batch.items[0].error, /后端 502/);
  // 第一条被判失败后，并发位空出来，第二条应已被提交并在跑。
  assert.equal(batch.items[1].status, 'running');
  assert.equal(batch.status, 'running');
});
