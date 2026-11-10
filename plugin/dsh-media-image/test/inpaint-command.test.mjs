// 命令行局部重绘后端：用一个真实的本地进程验证「插件 ← 文件契约 → 外部模型脚本」这条路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetStore } from '../lib/assets.js';
import { createGenerationService } from '../lib/generation.js';
import { fillPlaceholders } from '../lib/inpaint-command.js';
import { createCommandProvider } from '../lib/inpaint-command.js';
import { EventEmitter } from 'node:events';

// 1×1 PNG（合法签名 + 尺寸），store 只做签名校验。
function png(width = 16, height = 16) {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** 写一个真实可执行的 node 脚本当「模型」：把源图复制到输出（模拟重绘）。 */
function stubScript(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stub-'));
  const path = join(dir, 'stub.mjs');
  writeFileSync(path, body, 'utf8');
  return path;
}

const COPY_SCRIPT = `
import { readFileSync, writeFileSync } from 'node:fs';
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
writeFileSync(arg('--out'), readFileSync(arg('--image')));
`;
const FAIL_SCRIPT = `process.stderr.write('model exploded'); process.exit(3);`;
const NO_OUTPUT_SCRIPT = `process.exit(0);`;

function serviceWith(scriptPath, extra = {}) {
  const assets = createAssetStore();
  const service = createGenerationService({
    providers: [{ id: 'local-cli', kind: 'command', command: process.execPath,
      args: [scriptPath, '--image', '{image}', '--mask', '{mask}', '--out', '{output}'], ...extra }],
    assets,
  });
  return { service, assets };
}

test('占位符替换只认已知键，未知键原样保留', () => {
  assert.equal(fillPlaceholders('a{image}b{mask}', { image: 'X', mask: 'Y' }), 'aXbY');
  assert.equal(fillPlaceholders('{unknown}', { image: 'X' }), '{unknown}');
});

test('command provider：真实进程写出 PNG，结果进入素材库', async () => {
  const { service, assets } = serviceWith(stubScript(COPY_SCRIPT));
  const image = assets.add({ bytes: png(), name: 'source.png' });
  const mask = assets.add({ bytes: png(), name: 'mask.png' });
  assert.equal(service.list()[0].capabilities.inpaint, true);
  assert.equal(service.list()[0].capabilities.textToImage, false);
  assert.equal(service.supportsInpaint('local-cli'), true);

  const job = await service.submitInpaint({ provider: 'local-cli', prompt: 'fill', width: 16, height: 16,
    imageRef: `asset:${image.id}`, maskRef: `asset:${mask.id}` });
  assert.equal(job.status, 'succeeded', JSON.stringify(job));
  assert.match(job.assetRef, /^asset:[a-f0-9]{48}$/);
  assert.equal(assets.list().length, 3, '源图 + 蒙版 + 结果');
});

test('命令失败/不写输出/输出不是 PNG 都给出稳定错误码，不假装成功', async () => {
  for (const [script, code] of [[FAIL_SCRIPT, 'INPAINT_COMMAND_FAILED'], [NO_OUTPUT_SCRIPT, 'INPAINT_OUTPUT_MISSING']]) {
    const { service, assets } = serviceWith(stubScript(script));
    const image = assets.add({ bytes: png(), name: 's.png' });
    const mask = assets.add({ bytes: png(), name: 'm.png' });
    const job = await service.submitInpaint({ provider: 'local-cli', prompt: 'x', width: 16, height: 16,
      imageRef: `asset:${image.id}`, maskRef: `asset:${mask.id}` });
    assert.equal(job.status, 'failed', `${code} 应判失败`);
    assert.match(String(job.error), /退出码|没有在|PNG/, `实际错误：${job.error}`);
  }
});

test('HTTP /inpaint 全链路：提交 → 轮询 → 结果进素材库（命令后端）', async () => {
  const { createMediaRouter } = await import('../lib/http.js');
  const { service, assets } = serviceWith(stubScript(COPY_SCRIPT));
  const token = 'cmd-token';
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets, generation: service });
  const call = async ({ method = 'POST', url, body, headers = {} }) => {
    const out = { status: 0, body: '' };
    const res = { writeHead(s) { out.status = s; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = { method, url, headers: { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1', 'content-type': 'application/json', ...headers },
      async *[Symbol.asyncIterator]() { if (bytes) yield bytes; } };
    await router(req, res);
    return { status: out.status, value: JSON.parse(out.body) };
  };
  const image = assets.add({ bytes: png(), name: 's.png' });
  const mask = assets.add({ bytes: png(), name: 'm.png' });
  const submitted = await call({ url: '/media-image/inpaint', body: { provider: 'local-cli', prompt: 'fill', width: 16, height: 16, imageRef: `asset:${image.id}`, maskRef: `asset:${mask.id}` } });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.value));
  const job = submitted.value.job;
  assert.equal(job.status, 'succeeded', '命令后端是同步的，提交即完成');
  assert.match(job.assetRef, /^asset:[a-f0-9]{48}$/);
  const polled = await call({ method: 'GET', url: `/media-image/inpaint/${job.jobId}` });
  assert.equal(polled.status, 200);
  assert.equal(polled.value.job.status, 'succeeded');
  const capabilities = await call({ method: 'GET', url: '/media-image/inpaint' });
  assert.equal(capabilities.value.providers[0].capabilities.inpaint, true);
});


test('outputName 只能是临时目录内的文件名，超时配置必须是有限正整数', () => {
  const base = { id: 'validation', kind: 'command', command: process.execPath, args: [] };
  for (const outputName of ['', '.', '..', '../escape.png', 'sub/out.png', 'C:\\temp\\out.png', '/tmp/out.png']) {
    assert.throws(() => createCommandProvider({ ...base, outputName }), { code: 'PROVIDER_INVALID' }, outputName);
  }
  for (const timeoutMs of [0, -1, 1.5, Infinity, 900_001]) {
    assert.throws(() => createCommandProvider({ ...base, timeoutMs }), { code: 'PROVIDER_INVALID' }, String(timeoutMs));
  }
  assert.doesNotThrow(() => createCommandProvider({ ...base, timeoutMs: 1 }));
});

test('spawn 同步抛错与异步 error 都变成稳定的启动错误码', async () => {
  const base = { id: 'spawn-error', kind: 'command', command: process.execPath, args: [] };
  const input = { imageName: { bytes: png() }, maskName: { bytes: png() } };

  const syncProvider = createCommandProvider(base, { spawnImpl: () => { throw new Error('spawn exploded'); } });
  await assert.rejects(syncProvider.startInpaint(input), error => error.code === 'INPAINT_COMMAND_FAILED' && /spawn exploded/.test(error.message));

  const malformedProvider = createCommandProvider(base, { spawnImpl: () => ({}) });
  await assert.rejects(malformedProvider.startInpaint(input), error => error.code === 'INPAINT_COMMAND_FAILED' && /没有返回有效的子进程/.test(error.message));

  const asyncProvider = createCommandProvider(base, { spawnImpl: () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    return child;
  } });
  await assert.rejects(asyncProvider.startInpaint(input), error => error.code === 'INPAINT_COMMAND_FAILED' && /ENOENT/.test(error.message));
});

test('超时先终止并等待 close，再清理临时目录', async () => {
  const events = [];
  let spawnedCwd = null;
  const provider = createCommandProvider({ id: 'timeout-wait', kind: 'command', command: 'fake', args: [], timeoutMs: 5 }, {
    spawnImpl: (_command, _args, options) => {
      spawnedCwd = options.cwd;
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = signal => {
        events.push(`kill:${signal}`);
        if (signal === 'SIGTERM') setTimeout(() => { events.push('close'); child.emit('close', null); }, 25);
        return true;
      };
      return child;
    },
  });
  const started = Date.now();
  await assert.rejects(provider.startInpaint({ imageName: { bytes: png() }, maskName: { bytes: png() } }), error => error.code === 'INPAINT_TIMEOUT' && /子进程已退出/.test(error.message));
  assert.ok(Date.now() - started >= 20, 'timeout 不应在 close 前就返回');
  assert.deepEqual(events, ['kill:SIGTERM', 'close']);
  assert.equal(existsSync(spawnedCwd), false, '确认 close 之后才清理临时目录');
});

test('无法确认子进程退出时报告 termination_unknown 并保留临时目录', async () => {
  let spawnedCwd = null;
  const provider = createCommandProvider({ id: 'timeout-unknown', kind: 'command', command: 'fake', args: [], timeoutMs: 5 }, {
    spawnImpl: (_command, _args, options) => {
      spawnedCwd = options.cwd;
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => true;
      return child;
    },
  });
  await assert.rejects(provider.startInpaint({ imageName: { bytes: png() }, maskName: { bytes: png() } }), error => {
    assert.equal(error.code, 'INPAINT_TERMINATION_UNKNOWN');
    assert.equal(error.preserveTempDir, true);
    assert.equal(error.tempDir, spawnedCwd);
    return true;
  });
  assert.equal(existsSync(spawnedCwd), true, '子进程状态未知时不能删除它可能仍在用的输入目录');
  await rm(spawnedCwd, { recursive: true, force: true });
});

test('命令行 provider 不提供文生图能力，文本生图请求不会走到它', async () => {
  const { service, assets } = serviceWith(stubScript(COPY_SCRIPT));
  const job = await service.submit({ provider: 'local-cli', prompt: 'a cat', width: 512, height: 512 });
  assert.equal(job.status, 'failed', '没有 start() 的文生图请求必须失败而不是静默');
  assert.ok(assets.list().length === 0);
});

