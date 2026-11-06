// 本地模拟 ComfyUI 后端：仅用于端到端验证 dsh-media-image 的生成链路。
//
// 严格照 ComfyUI 的三个真实端点实现，方便插件用同一套适配器说话：
//   POST /prompt              → { prompt_id }
//   GET  /history/<id>        → 未完成时 {}；完成后 {<id>: { outputs: { node: { images: [{filename}] } } }}
//   GET  /view?filename=…     → 图片字节
//
// 生成的 PNG 由提示词哈希决定配色，因此"不同提示词出不同图"是可观察的，不是同一张占位图。
// 本文件只用于 dev 验证，不在 npm 包的 files 白名单里。

import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_COMFY_PORT || 8199);
const SIZE = 96;
const READY_AFTER_MS = 1200;
const jobs = new Map();

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = buffer => {
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

// 按提示词哈希取两个基色，做对角渐变 + 网格线，便于肉眼区分不同提示词的结果。
function renderPng(prompt) {
  const digest = createHash('sha256').update(prompt).digest();
  const base = [digest[0], digest[1], digest[2]];
  const alt = [digest[3], digest[4], digest[5]];
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
  let offset = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const t = (x + y) / (2 * (SIZE - 1));
      for (let c = 0; c < 3; c += 1) {
        let value = Math.round(base[c] * (1 - t) + alt[c] * t);
        if (x % 16 === 0 || y % 16 === 0) value = Math.min(255, value + 28);
        raw[offset] = value;
        offset += 1;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const json = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  if (req.method === 'POST' && url.pathname === '/prompt') {
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      let prompt = '';
      try {
        const parsed = JSON.parse(body);
        prompt = parsed?.prompt?.['6']?.inputs?.text ?? '';
        if (!parsed?.client_id) return json(400, { error: 'client_id required' });
      } catch {
        return json(400, { error: 'invalid json' });
      }
      const promptId = randomUUID();
      jobs.set(promptId, { prompt, createdAt: Date.now() });
      console.log(`[mock-comfy] prompt ${promptId.slice(0, 8)} ← ${JSON.stringify(prompt).slice(0, 60)}`);
      json(200, { prompt_id: promptId, number: jobs.size, node_errors: {} });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
    const promptId = url.pathname.slice('/history/'.length);
    const job = jobs.get(promptId);
    if (!job) return json(200, {});
    if (Date.now() - job.createdAt < READY_AFTER_MS) return json(200, {}); // 模拟"还在跑"
    return json(200, {
      [promptId]: { status: { status_str: 'success', completed: true }, outputs: { '9': { images: [{ filename: `${promptId}.png`, subfolder: '', type: 'output' }] } } },
    });
  }

  if (req.method === 'GET' && url.pathname === '/view') {
    const promptId = String(url.searchParams.get('filename') || '').replace(/\.png$/, '');
    const job = jobs.get(promptId);
    if (!job) return json(404, { error: 'unknown image' });
    const png = renderPng(job.prompt);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/queue') return json(200, { queue_running: [], queue_pending: [] });
  json(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-comfy] listening on http://127.0.0.1:${PORT} (SIZE=${SIZE}, ready after ${READY_AFTER_MS}ms)`);
});
