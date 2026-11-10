// Verifies the packaged image page is self-contained: the entry page and every runtime
// asset it references must be served from public/image/ without touching the miniPaint
// source checkout. Runs against the real artifact, not a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { createMediaRouter } from '../lib/http.js';
import { createAssetStore } from '../lib/assets.js';

const publicImage = resolve(dirname(fileURLToPath(import.meta.url)), '../public/image');

function makeContext() {
  const routes = [];
  const assets = createAssetStore();
  const ctx = {
    tools: { register: () => () => {}, guard: () => () => {} },
    webServer: { register: route => { routes.push(route); return () => {}; } },
    approval: { request: async () => 'allowed-once' },
    effect: factory => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  return { ctx, routes, assets };
}

function caller(router) {
  const respond = () => {
    const out = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headers) { out.status = status; out.headers = headers ?? {}; return res; },
      end(chunk) { out.body = chunk === undefined ? '' : Buffer.isBuffer(chunk) && /^image\//.test(String(out.headers['content-type'] || '')) ? Buffer.from(chunk) : String(chunk); },
    };
    return { res, out };
  };
  return async ({ method = 'GET', url, headers = {}, body, rawBody }) => {
    const { res, out } = respond();
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (rawBody !== undefined) yield rawBody; else if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    const handled = await router(req, res);
    return { handled, ...out };
  };
}

test('packaged image page ships an entry, a bundle and its favicon', async () => {
  for (const file of ['index.html', 'dist/bundle.js', 'images/favicon.png', 'BUILD.json']) {
    assert.ok((await stat(join(publicImage, file))).isFile(), `${file} 未打包`);
  }
  const build = JSON.parse(await readFile(join(publicImage, 'BUILD.json'), 'utf8'));
  assert.equal(build.format, 'dsh-media-studio-image-page');
  assert.equal(build.entry, 'index.html');
  assert.match(build.bundleSha256, /^[0-9a-f]{64}$/);
});

test('BUILD.json lists every packaged file so the artifact stays auditable', async () => {
  const build = JSON.parse(await readFile(join(publicImage, 'BUILD.json'), 'utf8'));
  const paths = new Set(build.files.map(item => item.path));
  for (const required of ['index.html', 'dist/bundle.js', 'images/favicon.png', 'images/logo.svg']) {
    assert.ok(paths.has(required), `${required} 不在 BUILD.json 清单里`);
  }
  assert.equal(build.fileCount, build.files.length);
  assert.ok(build.totalBytes > 0);
});

test('router serves /media/image/ from the packaged tree without config', async () => {
  const { ctx, routes, assets } = makeContext();
  apply(ctx, { assets });
  const call = caller(routes[0].handler);

  const page = await call({ url: '/media-image/image/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /id="canvas_minipaint"/);
  assert.match(page.body, /dist\/bundle\.js/);

  const bundle = await call({ url: '/media-image/image/dist/bundle.js' });
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers['content-type'], /javascript/);
  assert.match(bundle.body, /dsh\.editor\.connect/);
  // The Host validator requires editorKind, and a laid-out-less iframe must not publish a
  // negative canvas size. Both regressions shipped together once; pin them here.
  assert.match(bundle.body, /editorKind:"image"/);
  assert.match(bundle.body, />100\?/, 'canvas 尺寸需要正数兜底');
  assert.match(bundle.body, /Math\.max\(1,/, 'readState 需要钳制非正尺寸');
  // A write used to land in the canvas while the tool reported rejected, because the
  // mutation result lacked the fields the Host validates.
  assert.match(bundle.body, /layer.add_image/, '打包编辑器必须实现生成图回流为图层');
  assert.match(bundle.body, /ASSET_FETCH_FAILED|ASSET_NOT_FOUND/, '素材获取失败必须返回明确错误');
  assert.match(bundle.body, /changedObjectIds/, 'mutation 结果需要 changedObjectIds');
  assert.equal(/changedLayerIds/.test(bundle.body), false, '旧字段名不应再出现');
  assert.match(bundle.body, /redo_button/, '页面需要可点击的重做控件');
  // Apple theme layer: one accent, neutral canvas, SF-style stack.
  assert.match(bundle.body, /--apple-accent:\s*#0071e3/);
  assert.match(bundle.body, /--background:\s*#f5f5f7/);
  assert.match(bundle.body, /-apple-system/, '需要 SF 风格字体栈');

  const icon = await call({ url: '/media-image/image/images/favicon.png' });
  assert.equal(icon.status, 200);
  assert.match(icon.headers['content-type'], /image\/png/);
});

test('same-origin asset route uploads bounded real image bytes and serves them by random id', async () => {
  const assets = createAssetStore();
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token: 'secret-token', publicDir: '.', assets });
  const call = caller(router);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  const headers = { host: 'localhost', origin: 'http://localhost', 'x-dsh-media-asset': '1', authorization: 'Bearer secret-token', 'content-type': 'image/png', 'content-length': String(png.length) };
  const uploaded = await call({ method: 'POST', url: '/media-image/assets/upload', headers, rawBody: png });
  assert.equal(uploaded.status, 201, uploaded.body);
  const uploadValue = JSON.parse(uploaded.body);
  assert.match(uploadValue.sourceRef, /^asset:[a-f0-9]{48}$/);
  assert.equal(uploadValue.asset.mime, 'image/png');
  const id = uploadValue.asset.id;
  const fetched = await call({ method: 'GET', url: `/media-image/assets/${id}`, headers: { host: 'localhost', origin: 'http://localhost', authorization: 'Bearer secret-token', 'x-dsh-media-asset': '1' } });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers['content-type'], 'image/png');
  assert.deepEqual(Buffer.from(fetched.body, 'binary'), png);
  assert.equal(assets.get(id).bytes.length, png.length);

  const spoofed = await call({ method: 'POST', url: '/media-image/assets/upload', headers: { ...headers, 'content-type': 'image/png' }, rawBody: Buffer.from('not a png') });
  assert.equal(spoofed.status, 400);
  assert.equal(JSON.parse(spoofed.body).code, 'UNSUPPORTED_IMAGE_TYPE');
  const cross = await call({ method: 'POST', url: '/media-image/assets/upload', headers: { ...headers, origin: 'http://evil.example' }, rawBody: png });
  assert.equal(cross.status, 403);
  const invalid = await call({ method: 'GET', url: '/media-image/assets/%2e%2e%2fpackage.json', headers: { host: 'localhost', origin: 'http://localhost', authorization: 'Bearer secret-token' } });
  assert.equal(invalid.status, 404);
});

test('packaged wrapper binds the editor to the image relay only', async () => {
  const { ctx, routes } = makeContext();
  apply(ctx, {});
  const call = caller(routes[0].handler);

  const page = await call({ url: '/media-image/image/host.html' });
  assert.equal(page.status, 200);
  assert.match(page.body, /src="index.html"/);
  // 三个面板是这页面的对外契约，id 变了就是面板没了。
  for (const id of ['panel-generate', 'panel-asset', 'panel-font']) {
    assert.match(page.body, new RegExp(`id="${id}"`), `缺少面板 ${id}`);
  }

  const script = await call({ url: '/media-image/image/host.js' });
  assert.equal(script.status, 200);
  assert.match(script.body, /baseUrl: '\/media-image\/relay'/);
  assert.match(script.body, /editorKind: 'image'/);
  // 桌面端（Electron）不带 Sec-Fetch-*：取令牌必须自己带同源自定义头，
  // 并且 403 时把服务端观测字段显示出来，否则用户只能看到一个状态码。
  assert.match(script.body, /'x-dsh-media-boot': '1'/, '取令牌需要带同源自定义头');
  assert.match(script.body, /body\.reason/, '403 正文的 reason 要显示');
  assert.match(script.body, /body\.observed/, '403 正文的观测字段要显示');
  assert.match(script.body, /BOOT_FAILED/);
  // 面板只走已有路由：不动协议的约束靠这条钉住。
  assert.match(script.body, /\/media-image\/boot/, '取令牌走 /media-image/boot');
  for (const route of ['/media-image/generate', '/media-image/assets/import', '/media-image/fonts']) {
    assert.ok(script.body.includes(route), `面板应只调用已有路由：${route}`);
  }
  // The page must not pretend it can call the model tool surface.
  assert.equal(/\/media\/(?:image-)?tools/.test(script.body), false);
});

test('每个可点面板控件都真的绑了处理器（防"面板空壳"）', () => {
  const html = readFileSync(join(publicImage, 'host.html'), 'utf8');
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const interactive = ['connect', 'reconnect', 'read', 'gen-refresh', 'gen-submit', 'gen-insert', 'gen-stop', 'batch-submit', 'batch-refresh', 'batch-stop', 'asset-upload', 'asset-import', 'font-register', 'font-refresh'];
  const lines = script.split('\n');
  for (const id of interactive) {
    assert.match(html, new RegExp(`id="${id}"`), `host.html 缺少控件 ${id}`);
    // 两种注册形态都要认：逐个 $('id')?.addEventListener，或循环元组里的 ['id', action]。
    const wired = lines.some(line => line.includes(`'${id}'`) && (line.includes('addEventListener') || line.includes('for (const [id, action] of')));
    assert.ok(wired, `host.js 没有给 ${id} 绑定处理器`);
  }
  // 面板要能显示三态与结果，否则点了没反馈。
  for (const id of ['gen-pill', 'gen-status', 'gen-result', 'asset-status', 'asset-list', 'font-status', 'font-list']) {
    assert.match(html, new RegExp(`id="${id}"`), `host.html 缺少输出位 ${id}`);
  }
});

test('面板插入图层走真实编辑器命令，且未知结果只查不重发', () => {
  const html = readFileSync(join(publicImage, 'host.html'), 'utf8');
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  // 确认对话框必须是页面内的显式确认：点击者即用户本人，这是"人工确认"的落点。
  for (const id of ['confirm-modal', 'confirm-body', 'confirm-mask', 'confirm-ok', 'confirm-cancel']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少确认对话框元素 ${id}`);
  }
  assert.match(script, /modal\.addEventListener\('close'/, '对话框结果要靠 close 事件回收');
  // 走的是编辑器既有契约，不是新协议。
  assert.match(script, /type: 'editor\.apply_command'/);
  assert.match(script, /type: 'layer\.add_image'/);
  assert.match(script, /expectedRevision: state\.revision/, '写入必须带读到的 revision');
  assert.match(script, /maskRef = 'selection:'/, '选作蒙版时用 selection: 引用');
  // 冲突与未知结果的处理：冲突让用户重点一次，未知只提示查询、不得重发。
  assert.match(script, /REVISION_CONFLICT/);
  assert.match(script, /EDITOR_TIMEOUT_OUTCOME_UNKNOWN/);
  assert.match(script, /不要重发/);
  assert.equal(/for\s*\(.*retry/i.test(script), false, '插入路径不得含自动重试循环');
});

test('面板列按用户要求隐藏，能力全部收进助手（取代旧的"面板必须可见"契约）', () => {
  const html = readFileSync(join(publicImage, 'host.html'), 'utf8');
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const raw = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  // 用户明确要求：下方版块直接隐藏，这些功能助手就能解决
  assert.match(css, /aside\s*\{\s*display:\s*none/, 'aside 必须隐藏');
  assert.match(css, /main\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/, '主区应只剩一列');
  // 助手自己持有后端与尺寸，不能依赖已隐藏的控件
  for (const id of ['assist-provider', 'assist-refresh', 'assist-width', 'assist-height', 'assist-file']) {
    assert.match(html, new RegExp(`id="${id}"`), `助手缺少控件 ${id}`);
  }
  for (const id of ['assist-provider', 'assist-refresh', 'assist-file']) {
    assert.ok(script.includes(`'${id}'`), `${id} 必须在脚本里被使用`);
  }
  // 面板隐藏后助手必须覆盖原先把能力
  for (const capability of ['生成[:：]', '批量[:：]', '导入[:：]', '字体[:：]', '字体列表', '状态', '插入图层']) {
    assert.ok(script.includes(capability), `助手缺少能力：${capability}`);
  }
  // 本地文件上传入口不能在隐藏面板里断掉
  assert.match(script, /assist-file'\)\?\.addEventListener\('change'/, '助手要接管本地文件上传');
});
// 2026-11-06：用户要求隐藏下方版块并把能力收进助手，旧断言"面板必须可见"随之作废。

test('悬浮助手：浮层齐全、只走已有路由、且明确标注当前是本地指令', () => {
  const html = readFileSync(join(publicImage, 'host.html'), 'utf8');
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  for (const id of ['assist-open', 'assist-card', 'assist-log', 'assist-chips', 'assist-text', 'assist-send', 'assist-close', 'assist-reset']) {
    assert.match(html, new RegExp(`id="${id}"`), `浮层缺少 ${id}`);
  }
  assert.match(html, /想改什么，直接说/, '输入框占位与工作台一致');
  // 交互控件都要有处理器（发送既认点击也认回车）
  for (const id of ['assist-open', 'assist-send', 'assist-close', 'assist-reset']) {
    assert.ok(script.split('\n').some(line => line.includes(`'${id}'`) && line.includes('addEventListener')), `${id} 没有绑定处理器`);
  }
  assert.ok(/keydown/.test(script) && /Enter/.test(script), '回车要能发送');
  // 这一版是本地指令，不许打着模型对话的旗号（注释里提到 ctx.llm 不算，先剥注释）
  assert.match(script, /本地指令/, '必须如实标注实现方式');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/ctx\.llm|prepareCall/.test(code), false, '页面侧不应直接调模型（模型通路在 Host）');
  // 助手只能复用已有路由
  for (const route of ['/media-image/generate', '/media-image/assets/import', '/media-image/fonts']) {
    assert.ok(script.includes(route), `助手应复用已有路由：${route}`);
  }
  // 0.7.0 起走真实模型通路：Host 侧 /media-image/assist（模型只提议，页面执行 ops）
  assert.ok(script.includes('/media-image/assist'), '助手必须走宿主模型通路');
  assert.match(script, /modelTurn/, '必须走真实模型那一轮');
  assert.match(script, /execOps/, '模型提议的 ops 由页面执行');
  assert.match(script, /ASSIST_UNAVAILABLE/, '模型不可用要能识别并降级');
  assert.match(script, /本地指令·模型未连接/, '降级必须如实标注');
  // 人机协作闸门：模型提议的 command 必须先弹确认，确认后才 apply_command
  const commandIdx = script.indexOf("op.type === 'command'");
  assert.ok(commandIdx > 0, 'execOps 必须处理 command 提议');
  const branch = script.slice(commandIdx, commandIdx + 2600);
  assert.match(branch, /askConfirm/, '模型提议的命令必须经人确认');
  assert.match(branch, /已取消，没有发送任何命令/, '取消要明确说零命令');
  assert.match(branch, /editor\.apply_command/, '确认后才走编辑器命令');
  assert.match(branch, /expectedRevision: state\.revision/, '写入必须带读到的 revision');
  assert.match(branch, /REVISION_CONFLICT/, '冲突要提示重来而不是静默失败');
});

test('性能与状态契约：rAF 到终态停帧、列表增量更新、逐项重试、可解释状态、减动效降级', () => {
  const html = readFileSync(join(publicImage, 'host.html'), 'utf8');
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

  // ① 帧循环：只由 rAF 驱动，且到达目标后不再排队
  assert.match(code, /requestAnimationFrame\(tick\)/, '进度应由 rAF 推进');
  assert.match(code, /frame = null;[\s\S]{0,80}?return/, '到目标必须停帧（不让循环空转）');
  assert.match(code, /cancelAnimationFrame/, '终态与重置都要能取消帧');
  // 只动合成友好属性
  const animating = [...code.matchAll(/style\.(\w+)\s*=/g)].map(m => m[1]);
  assert.deepEqual([...new Set(animating)].filter(p => ['top', 'left', 'width', 'height'].includes(p)), [], '不得用几何属性做动画');
  assert.match(code, /scaleX\(/, '进度条用 transform:scaleX');

  // ② 减动效：CSS 兜底 + JS 分支
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/, 'CSS 必须有减动效兜底');
  assert.match(code, /prefers-reduced-motion: reduce/, 'JS 必须读减动效偏好');
  assert.match(code, /REDUCE_MOTION/, '减动效要走瞬时分支');

  // ③ 列表增量更新：按 key 复用行，不整表重建
  assert.match(code, /function keyedRow/, '列表必须按 key 复用行');
  assert.match(code, /data-key/, '行要有稳定 key');
  assert.equal(/list\.textContent = ''/.test(code), false, '不得整表清空重建（会打掉焦点）');

  // ④ 逐项失败可局部重试：走已有批量路由，1 条
  assert.match(code, /retryBatchItem/, '失败项要有单条重试');
  assert.match(code, /prompts: \[prompt\]/, '重试提交 1 条（新作业），不复用旧作业');
  assert.match(code, /重试=新作业|new/i, '必须说明重试是新作业');

  // ⑤ 状态要可解释：阶段 + 原因 + 恢复方式
  assert.match(code, /已查询 \$\{genPolls\} 次/, '进行中要说明阶段');
  assert.match(code, /不要重放同一作业/, '失败要给恢复方式');
  assert.match(code, /已停止查询/, '停止要说明停的是什么');

  // ⑥ 空态给下一步，且不冒充错误
  for (const id of ['gen-result-empty', 'batch-empty', 'asset-empty']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少空态 ${id}`);
  }
  // ⑦ 焦点可见
  assert.match(css, /:focus-visible/, '必须有可见焦点环');
});

test('上传的图也能插入：最近可插入素材由生成/上传/导入共同更新（真 bug 回归）', () => {
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /function rememberAsset\(asset\)[\s\S]{0,180}?lastAssetRef = `asset:\$\{asset\.id\}`/, 'rememberAsset 必须更新最近可插入素材');
  // aside 默认隐藏时 asset-list 不存在，renderAssets 只能跳过 UI，不能抛错/吞状态。
  assert.match(code, /function renderAssets\(\)[\s\S]{0,160}?if \(!list\) return/, '无列表 DOM 时只跳过渲染');
  assert.match(code, /uploadImageAsset\(file\)[\s\S]{0,220}?rememberAsset\(asset\)/, '助手上传后必须登记为最近可插入素材');
  assert.match(code, /const value = await api\('\/media-image\/assets\/import'[\s\S]{0,240}?rememberAsset\(value\.asset\)/, '助手远程导入后必须登记素材');
  assert.match(code, /const result = await insertAssetAsLayer\([\s\S]{0,180}?if \(result\?\.applied\)/, '必须等 apply_command 成功再报告已插入');
  assert.match(code, /result\?\.cancelled \? '已取消，没有发送任何命令。'/, '取消不能误报已插入');
  // insert op 支持点名 assetRef
  assert.match(code, /op\.assetRef/, 'insert op 要支持指定素材');
  // 插入时用真实文件名，而不是写死一句"助手插入的图片"
  assert.match(code, /nearestAssetName/, '插入名应取素材名');
});

test('历史条：逐步 undo/redo 跳到目标位置，限制单次距离，失败如实报告走到第几步', () => {
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const page = readFileSync(join(publicImage, 'host.html'), 'utf8');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = code.indexOf('const historyBar = ');
  assert.ok(start > 0, '必须有历史条实现');
  const block = code.slice(start);

  // 页面元素
  assert.match(page, /id="history-bar"/);
  assert.match(page, /id="history-steps"/);

  // 只读 state 里已有的结构，不在页面里另算历史
  assert.match(block, /history\.entries/, '必须用 read_state 给的历史条目');
  assert.match(block, /entry\.applied/, '要区分已应用/未应用');
  // 单步走：只能发 history.undo / history.redo，不得伪造一次跳多步的命令
  assert.match(block, /'history\.undo' : 'history\.redo'/, '必须逐步 undo/redo');
  assert.equal(/type: 'history\.jump'/.test(code), false, '不得发明不存在的 history.jump 命令');
  // 距离上限与失败如实报告
  assert.match(block, /const MAX_JUMP = \d+/, '必须有单次跳转上限');
  assert.match(block, /最多跳 \$\{MAX_JUMP\} 步/, '超限要明确告诉人');
  assert.match(block, /中途停下/, '失败必须说清走到第几步');
  assert.match(block, /只走到第 \$\{finalHistory\.index\} 步/, '没走到目标要如实报告');
  // 每步都要用当前 revision（否则会被 REVISION_CONFLICT 拒绝）
  assert.match(block, /expectedRevision: state\.revision/, '每一步都要带当前 revision');
});

test('命令面板：吃同一份命令目录、快捷键可用、执行走 Agent 同一条 apply_command 路径', () => {
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const page = readFileSync(join(publicImage, 'host.html'), 'utf8');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // 目录必须来自插件路由（与 media_image_list_commands 同一个 lib/commands.js），
  // 而不是页面里再造一份命令表 —— 否则"能不能用"会出现两套说法。
  assert.match(code, /\/media-image\/commands/, '命令目录必须走插件路由');
  assert.equal(/const COMMAND_NEEDS|const COMMANDS = new Set/.test(code), false, '页面不得自带命令表');

  // 快捷键与元素
  assert.match(code, /ctrlKey \|\| event\.metaKey/, '必须支持 Ctrl/⌘');
  assert.match(code, /toLowerCase\(\) === 'k'/, '快捷键是 K');
  assert.match(page, /id="palette-list"/);
  assert.match(page, /id="palette-q"/);
  assert.match(page, /id="palette-run"/);

  // 不可用的命令点不动（把"为什么不能用"摆出来，而不是让人试一次失败）
  assert.match(code, /item\.disabled = command\.enabled === false/);
  assert.match(code, /disabledReason/, '必须把不可用原因显示出来');

  // 执行路径：与 Agent 完全相同的单命令提交，不是页面私开一条写通道。
  // 断言只针对面板自己那段代码：面板里不该出现任何 editor.apply_command 直调。
  const paletteStart = code.indexOf('const palette = ');
  assert.ok(paletteStart > 0, '必须能找到命令面板实现');
  const paletteBlock = code.slice(paletteStart);
  assert.match(paletteBlock, /runPlanOnEditor\(\[\{ operation: selected\.id, params: payload \}\]\)/, '面板必须走 runPlanOnEditor');
  assert.equal(paletteBlock.includes('editor.apply_command'), false, '面板不得自己调 editor.apply_command');
  assert.equal(paletteBlock.includes("command: { type:"), false, '面板不得自己拼 command 对象');
  // 执行前必须过一次确认，且执行后自检
  assert.match(code, /askConfirm\(\{[\s\S]{0,400}执行命令/, '执行前要确认');
  assert.match(code, /reportSelfCheck\(selected\.id\)/, '执行后要自检');
});

test('命令面板：默认参数字骨架只填必填字段名，不猜坐标与尺寸', () => {
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const start = script.indexOf('const defaultParams = command =>');
  assert.ok(start > 0, '必须有 defaultParams');
  const block = script.slice(start, script.indexOf('const filter = () =>', start));
  // 从参数契约里挑出"不带 ?"的字段名当骨架，值一律留空字符串
  assert.match(block, /match\[2\] !== '\?'/, '只取必填字段');
  assert.match(block, /skeleton\[name\] = ''/, '值必须留空由人填，不能编一个默认坐标');
});

test('批量套版：一次确认、逐份导出入库、每份撤销回原状，失败即停', () => {
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /\^批量套版\$/, '必须支持「批量套版」指令');
  const start = code.indexOf('async function runTemplateBatch');
  assert.ok(start > 0, '必须有批量套版执行函数');
  const batch = code.slice(start, code.indexOf('async function routeAssist', start));
  assert.equal((batch.match(/askConfirm\(/g) || []).length, 1, '批量只确认一次，符合用户已同意整批');
  assert.match(batch, /\/media-image\/template\/batch/, '必须走批量规划接口');
  assert.match(batch, /exportCanvasAsAsset/, '每份都要导出成品');
  assert.match(batch, /undoApplied\(applied, startState\.contentDigest\)/, '每份完成后撤销并核对摘要');
  assert.match(batch, /已撤销 \$\{undo\.undone\} 步/, '失败要如实报告撤销了几步');
  assert.match(batch, /restored === false/, '摘要不一致必须报告，不能假装恢复');
  assert.match(batch, /批量停止/, '失败即停，不继续写画布');
  const exporter = code.slice(code.indexOf('async function exportCanvasAsAsset'), code.indexOf('async function undoApplied'));
  assert.match(exporter, /editor\.export_start/, '导出走编辑器导出命令');
  assert.match(exporter, /uploadImageAsset/, '导出的 PNG 要入库成素材');
  const undo = code.slice(code.indexOf('async function undoApplied'), code.indexOf('async function fetchEditorState'));
  assert.match(undo, /targetCommandId/, '撤销必须带精确凭据');
  assert.match(undo, /afterDigest/, '撤销必须带摘要凭据');
});

test('套版先给预览（候选槽/文字/装饰），支持「套版：N」选槽', () => {
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /function templatePreview\(/, '必须有套版预览函数');
  const preview = code.slice(code.indexOf('function templatePreview('), code.indexOf('async function applyTemplateFlow'));
  assert.match(preview, /可选商品槽/, '预览要列出可选商品槽');
  assert.match(preview, /#\$\{index \+ 1\}/, '候选槽要带序号，用户才能回「套版：2」');
  assert.match(preview, /合成进底图/, '预览要说清装饰层会合成进底图');
  assert.match(preview, /合成失败才退化/, '预览要说明失败时的降级');
  assert.match(preview, /文字沿用 PSD/, '预览要显示将沿用的 PSD 文案');
  const flow = code.slice(code.indexOf('async function applyTemplateFlow'), code.indexOf('async function routeAssist'));
  assert.match(flow, /slotIndex/, 'applyTemplateFlow 必须接受槽位选择');
  assert.match(flow, /x-psd-slot/, '选槽后要作为请求头传给套版接口');
  assert.match(flow, /\/media-image\/template\/apply/, '执行必须走一次上传即合成底图的接口');
  assert.match(flow, /psdFile/, '要保留 PSD 字节以支持换槽重规划');
  assert.match(flow, /templatePreview\(template\)/, '解析后必须先展示预览');
  assert.match(code.slice(code.indexOf('async function routeAssist')), /\^套版\(\?::\\s\*\(\\d\+\)\)\?\$/, '必须支持「套版」与「套版：N」');
});

test('局部重绘按真实选区/绑定蒙版导出源图，能力不匹配时不提交，结果确认后独立落层', () => {
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sendStart = code.indexOf('async function sendAssist');
  const send = code.slice(sendStart, sendStart + 2400);
  assert.match(code.slice(code.indexOf('async function routeAssist'), code.indexOf('async function sendAssist')), /\^局部重绘/, '自然语言显式局部重绘要走确定性入口');
  const helperStart = code.indexOf('async function sendInpaint');
  const helperEnd = code.indexOf('async function applyInpaintToCanvas', helperStart);
  const helper = code.slice(helperStart, helperEnd);
  assert.match(helper, /editor\.export_inpaint_inputs/, '必须从当前编辑器导出源图与蒙版');
  assert.match(helper, /\/media-image\/inpaint/, '必须走局部重绘路由');
  assert.match(helper, /idempotencyKey/, '提交需带幂等键');
  assert.match(helper, /unknown/, '作业结果未知时不得重提');
  const applyStart = helperEnd;
  const applyEnd = code.indexOf('async function composeMaskLayer', applyStart);
  const apply = code.slice(applyStart, applyEnd);
  assert.match(apply, /await askConfirm\(/, '结果落画布前必须确认');
  assert.match(apply, /maskRef: `layer:\$\{mask\.id\}`/, '结果图层应继承当前绑定蒙版');
  assert.match(apply, /expectedRevision/, '落层必须使用新读状态的 revision');
  const routeStart = code.indexOf('async function routeAssist');
  const inpaintRoute = code.slice(code.indexOf('if (/^局部重绘', routeStart), code.indexOf('if (/^(抠图|去背景)', routeStart));
  assert.match(inpaintRoute, /capabilities\?\.inpaint === true/, '必须由 provider capability 门控');
  assert.match(inpaintRoute, /没有提交生成作业/, '不支持时必须拒绝提交');
});

test('用户输入抠图时直达本地去背景，不先让模型拒答；纯色底失败时如实提示需要 AI 服务', () => {
  const script = readFileSync(join(publicImage, 'host.js'), 'utf8');
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sendStart = code.indexOf('async function sendAssist');
  const send = code.slice(sendStart, sendStart + 1700);
  assert.ok(send.includes('^抠图'), '用户说抠图要走确定性分支');
  assert.match(send, /await routeAssist\(text\);[\s\S]{0,60}?return;/, '抠图分支不得先调用模型');
  // 本地自动去背景：无坐标、无外部服务，失败要有可执行提示
  const cutoutStart = code.indexOf('async function localCutout');
  assert.ok(cutoutStart > 0, '必须存在本地去背景执行函数');
  const cutout = code.slice(cutoutStart, cutoutStart + 8000);
  assert.match(cutout, /layer\.add_mask_layer/, '必须走"先加蒙版图层"的人类式流程');
  const compose = code.slice(code.indexOf('async function composeMaskLayer'), cutoutStart);
  assert.match(compose, /maskRef: 'layer:' \+ mask\.id/, '必须使用绑定蒙版的真实 ID');
  assert.match(compose, /mask\.mask\.sourceLayerId/, '源图必须来自蒙版绑定，不能猜最后一层');
  assert.match(compose, /state\.revision !== before\.revision/, '确认期间修改画布应停止');
  assert.match(send, /合成蒙版/, '修蒙版后必须有确定性重合成入口');
  assert.match(cutout, /原图(未改动|一个像素都不改|保留)/, '要明确原图不动');
  assert.match(cutout, /画笔/, '告诉用户蒙版层还能继续用手修');
  assert.match(cutout, /AI 抠图服务/, '告诉用户下一步该配置什么');
  assert.ok((cutout.match(/askConfirm\(/g) || []).length >= 1 && compose.includes('askConfirm('), '建蒙版与合成各自都要确认');
  const routeStart = code.indexOf('const remove = /^抠图');
  assert.ok(routeStart > 0);
  assert.match(code.slice(routeStart, routeStart + 900), /localCutout\(\)/, '默认走本地去背景而不是先要外部服务');
});

test('packaged wrapper stays byte-identical to its source (no stale copy)', () => {
  // 这个坑真踩过：源码改了 highlight 转发，包内 public/image/host.js 还是旧副本，
  // 部署后页面行为与仓库对不上。两边必须逐字节相同。
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/image-page/host.js'));
  const packaged = readFileSync(join(publicImage, 'host.js'));
  assert.deepEqual(packaged, source, 'public/image/host.js 必须与 scripts/image-page/host.js 一致（跑 pack:image 或同步复制）');
});

test('packaged wrapper is valid ESM (node --check on .js would miss it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'image-host-'));
  try {
    const target = join(dir, 'host.mjs');
    writeFileSync(target, readFileSync(join(publicImage, 'host.js')));
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('packaged image route keeps traversal and source files out', async () => {
  const { ctx, routes } = makeContext();
  apply(ctx, {});
  const call = caller(routes[0].handler);

  for (const url of ['/media-image/image/../lib/index.js', '/media-image/image/BUILD.json.map', '/media-image/image/%2e%2e/host/relay.js']) {
    const response = await call({ url });
    assert.notEqual(response.status, 200, `${url} 不应可读`);
  }
});
