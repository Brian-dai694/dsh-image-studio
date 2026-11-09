// 命令行局部重绘后端：用一个真实的本地进程验证「插件 ← 文件契约 → 外部模型脚本」这条路。
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssetStore } from '../lib/assets.js';
import { createGenerationService } from '../lib/generation.js';
import { fillPlaceholders } from '../lib/inpaint-command.js';

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

test('命令行 provider 不提供文生图能力，文本生图请求不会走到它', async () => {
  const { service, assets } = serviceWith(stubScript(COPY_SCRIPT));
  const job = await service.submit({ provider: 'local-cli', prompt: 'a cat', width: 512, height: 512 });
  assert.equal(job.status, 'failed', '没有 start() 的文生图请求必须失败而不是静默');
  assert.ok(assets.list().length === 0);
});
