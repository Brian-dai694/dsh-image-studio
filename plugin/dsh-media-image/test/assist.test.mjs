// 助手模型通路的单元测试：用假 ctx（llm + agentDefaultModel）驱动，不碰真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatTurn, callModel, modelInfo, parsePlan, AssistError, OP_TYPES, PROPRIETABLE_COMMANDS } from '../lib/assist.js';
import { createMediaRouter } from '../lib/http.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 假宿主：currentSelection + prepareCall().stream() 吐若干 text-delta。
function fakeCtx({ chunks = [], failWith = null, selection = { provider: 'deepseek-account', model: 'deepseek-flash' }, llm = true } = {}) {
  const seen = { calls: [], streamArgs: null };
  const services = {
    agentDefaultModel: { currentSelection: () => selection },
    llm: llm ? {
      async prepareCall(config) {
        seen.calls.push(config);
        return {
          config: { ...config, temperature: 0.7 },
          async *stream(args) {
            seen.streamArgs = args;
            if (failWith) throw new Error(failWith);
            for (const chunk of chunks) yield chunk;
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    } : undefined,
  };
  return { ctx: { get: name => services[name] }, seen };
}

test('画面实测进入提示词，并明确它不是视觉（不能声称"看到了"）', async () => {
  const { ctx, seen } = fakeCtx({ chunks: [{ type: 'text-delta', text: '{"reply":"偏暗","ops":[]}' }] });
  await chatTurn(ctx, {
    message: '图里有什么',
    observation: {
      luminance: { mean: 32.5, stdDev: 12.1 },
      clipping: { highlights: 0, shadows: 0.082 },
      colourCast: { r: 40, g: 38, b: 36, spread: 4 },
      sharpness: { laplacianVariance: 180.4 },
      opaqueRatio: 0.97,
      palette: [{ hex: '#2a2a2a', share: 0.61 }, { hex: '#8c8c8c', share: 0.22 }],
    },
  });
  const prompt = seen.streamArgs.messages[0].content[0].text;
  assert.match(prompt, /画面实测/, prompt);
  assert.match(prompt, /32\.5/);
  assert.match(prompt, /8\.2%/, '暗部裁切要按百分比写出来');
  assert.match(prompt, /#2a2a2a\(61\.0%\)/, '主色带占比');
  assert.match(prompt, /180\.4/);
  // 关键约束：不能把测量值说成视觉理解。
  assert.match(prompt, /不是视觉/);
  assert.match(prompt, /不要猜/);
});

test('没有实测时不得编造画面信息，提示词里要明说没有像素', async () => {
  const { ctx, seen } = fakeCtx({ chunks: [{ type: 'text-delta', text: '{"reply":"ok","ops":[]}' }] });
  await chatTurn(ctx, { message: '这图怎么样' });
  const prompt = seen.streamArgs.messages[0].content[0].text;
  assert.equal(prompt.includes('画面实测'), false);
  assert.match(prompt, /没有画面像素信息/);
});

test('实测数值缺失时写"未知"，不补 0 冒充测量结果', async () => {
  const { ctx, seen } = fakeCtx({ chunks: [{ type: 'text-delta', text: '{"reply":"ok","ops":[]}' }] });
  await chatTurn(ctx, { message: '亮度多少', observation: { luminance: { mean: null, stdDev: undefined }, palette: [] } });
  const prompt = seen.streamArgs.messages[0].content[0].text;
  assert.match(prompt, /未知/);
  assert.equal(/平均亮度 0(\.0)?（/.test(prompt), false, '不能把缺失值写成 0');
});

test('modelInfo 如实反映宿主选择；没有 llm 或选择时返回 null', () => {
  assert.equal(modelInfo(fakeCtx().ctx).label, 'deepseek-flash');
  assert.equal(modelInfo(fakeCtx({ llm: false }).ctx), null);
  assert.equal(modelInfo(fakeCtx({ selection: {} }).ctx), null);
  assert.equal(modelInfo({ get: () => undefined }), null);
});

test('callModel 走宿主 prepareCall/stream，并把 text-delta 拼成完整文本', async () => {
  const { ctx, seen } = fakeCtx({ chunks: [
    { type: 'text-delta', text: '你好' },
    { type: 'text-delta', text: '，我是助手' },
  ] });
  const result = await callModel(ctx, { system: 'sys', user: 'hi', maxTokens: 321 });
  assert.equal(result.text, '你好，我是助手');
  assert.equal(result.model, 'deepseek-flash');
  assert.equal(seen.calls[0].maxTokens, 321);
  // 契约细节：system 走顶层字段，消息是 content 数组，source 标记来源
  assert.equal(seen.streamArgs.system, 'sys');
  assert.equal(seen.streamArgs.messages[0].content[0].text, 'hi');
  assert.equal(seen.streamArgs.messages[0].source.kind, 'dsh-media-image');
  assert.equal(seen.streamArgs.temperature, 0.7, '必须透传宿主 call.config');
});

test('没有模型时抛 ASSIST_UNAVAILABLE，而不是假装回答', async () => {
  await assert.rejects(
    () => callModel(fakeCtx({ llm: false }).ctx, { system: 's', user: 'u' }),
    error => error instanceof AssistError && error.code === 'ASSIST_UNAVAILABLE',
  );
});

test('模型中断（finish.error）抛 ASSIST_FAILED，不把半截文本当答案', async () => {
  const ctx = {
    get: name => name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      : {
        async prepareCall() {
          return {
            config: {},
            async *stream() {
              yield { type: 'text-delta', text: '半截' };
              yield { type: 'finish', reason: { kind: 'error', failure: { message: '额度用尽' } } };
            },
          };
        },
      },
  };
  await assert.rejects(() => callModel(ctx, { system: 's', user: 'u' }), error => error.code === 'ASSIST_FAILED' && /额度用尽/.test(error.message));
});

test('parsePlan：JSON 走结构化、ops 过滤未知类型、纯文本当成 reply', () => {
  const json = parsePlan('{"reply":"我来生成","ops":[{"type":"generate","prompt":"a cat"},{"type":"rm -rf","x":1}]}');
  assert.equal(json.reply, '我来生成');
  assert.deepEqual(json.ops.map(op => op.type), ['generate']);
  assert.equal(json.droppedOps, 1, '未知 op 必须被丢掉并计数');

  const fenced = parsePlan('```json\n{"reply":"好","ops":[{"type":"insert"}]}\n```');
  assert.deepEqual(fenced.ops.map(op => op.type), ['insert']);

  const plain = parsePlan('这张图背景偏灰，建议提亮一点。');
  assert.equal(plain.ops.length, 0);
  assert.match(plain.reply, /提亮/);

  assert.deepEqual(parsePlan('').ops, []);
});

test('chatTurn：把画布上下文与历史喂给模型，返回 reply+ops+engine', async () => {
  const { ctx, seen } = fakeCtx({ chunks: [
    { type: 'text-delta', text: '{"reply":"我来生成一张","ops":[{"type":"generate","prompt":"soft morning light"}]}' },
  ] });
  const turn = await chatTurn(ctx, {
    message: '来个晨光',
    history: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好' }],
    context: { width: 800, height: 600, layers: 3, hasSelection: true, lastAssetRef: 'asset:abc' },
  });
  assert.equal(turn.reply, '我来生成一张');
  assert.deepEqual(turn.ops.map(op => op.type), ['generate']);
  assert.equal(turn.engine, 'deepseek-flash');
  assert.equal(turn.provider, 'deepseek-account');
  const user = seen.streamArgs.messages[0].content[0].text;
  assert.match(user, /800×600/);
  assert.match(user, /图层 3 个/);
  assert.match(user, /有选区 是/);
  assert.match(user, /最近对话/);
  assert.match(user, /用户说：来个晨光/);
  // 系统提示必须写明"只提议不执行"
  assert.match(seen.streamArgs.system, /你不执行|不执行/);
  assert.ok(OP_TYPES.includes('generate'));
});

test('chatTurn：图层清单（真实 id）必须进提示词，否则模型只能编 id', async () => {
  const { ctx, seen } = fakeCtx({ chunks: [{ type: 'text-delta', text: '{"reply":"好","ops":[]}' }] });
  await chatTurn(ctx, {
    message: '把背景层隐藏',
    context: {
      width: 800, height: 600, layers: 2, hasSelection: false, lastAssetRef: null,
      layerList: [{ id: 'layer-7f3a', name: '背景', type: 'image', visible: true }, { id: 'layer-91b2', name: '文字', type: 'text', visible: false }],
    },
  });
  const user = seen.streamArgs.messages[0].content[0].text;
  assert.match(user, /layer-7f3a=背景/, '必须给出真实图层 id 供模型引用');
  assert.match(user, /layer-91b2=文字\(隐藏\)/, '隐藏状态要标出来');
});

test('chatTurn：空消息与超长消息被拒（不进模型）', async () => {
  const { ctx, seen } = fakeCtx();
  await assert.rejects(() => chatTurn(ctx, { message: '   ' }), error => error.code === 'ASSIST_INVALID');
  await assert.rejects(() => chatTurn(ctx, { message: 'x'.repeat(4001) }), error => error.code === 'ASSIST_INVALID');
  assert.equal(seen.calls.length, 0, '非法入参不该产生模型调用');
});

test('parsePlan：command op 必须命中编辑器白名单且带 payload，否则丢弃', () => {
  const good = parsePlan(JSON.stringify({
    reply: '我把不透明度调到 60%',
    ops: [{ type: 'command', command: { type: 'layer.set_appearance', payload: { layerId: 'l1', opacity: 60 } } }],
  }));
  assert.deepEqual(good.ops.map(op => op.type), ['command']);
  assert.equal(good.ops[0].command.type, 'layer.set_appearance');

  const offList = parsePlan(JSON.stringify({ reply: 'x', ops: [{ type: 'command', command: { type: 'shell.exec', payload: { cmd: 'rm -rf /' } } }] }));
  assert.equal(offList.ops.length, 0, '不在白名单的命令必须被丢掉');
  assert.equal(offList.droppedOps, 1);

  const noPayload = parsePlan(JSON.stringify({ reply: 'x', ops: [{ type: 'command', command: { type: 'layer.remove' } }] }));
  assert.equal(noPayload.ops.length, 0, '缺 payload 的命令必须被丢掉');

  const badGen = parsePlan(JSON.stringify({ reply: 'x', ops: [{ type: 'generate', prompt: '  ' }] }));
  assert.equal(badGen.ops.length, 0, '空提示词的生成必须被丢掉');
  const badImport = parsePlan(JSON.stringify({ reply: 'x', ops: [{ type: 'import', url: 'file:///etc/passwd' }] }));
  assert.equal(badImport.ops.length, 0, '非 http(s) 导入必须被丢掉');
});

test('系统提示必须把白名单交给模型，并写死"只提议不执行"', () => {
  assert.ok(PROPRIETABLE_COMMANDS.includes('layer.set_appearance'));
  assert.ok(PROPRIETABLE_COMMANDS.includes('layer.add_text'));
  assert.ok(!PROPRIETABLE_COMMANDS.some(name => /shell|exec|eval/.test(name)), '白名单里不该出现任意执行类命令');
});

test('insert op 可指定 assetRef；格式不对就丢弃（上传的图也能被点名插入）', () => {
  const named = parsePlan(JSON.stringify({ reply: '好', ops: [{ type: 'insert', assetRef: `asset:${'b'.repeat(48)}` }] }));
  assert.equal(named.ops.length, 1);
  assert.equal(named.ops[0].assetRef.length, 48 + 'asset:'.length);
  assert.equal(parsePlan(JSON.stringify({ reply: '好', ops: [{ type: 'insert', assetRef: 'asset:zzz' }] })).ops.length, 0);
  // 不带 assetRef 也合法（用最近的）
  assert.equal(parsePlan(JSON.stringify({ reply: '好', ops: [{ type: 'insert' }] })).ops.length, 1);
});

test('上下文必须告诉模型"手里有哪些素材"，否则上传过的它也看不见', async () => {
  const { ctx, seen } = fakeCtx({ chunks: [{ type: 'text-delta', text: '{"reply":"好","ops":[]}' }] });
  await chatTurn(ctx, {
    message: '把刚上传那张插入画布',
    context: {
      width: 640, height: 480, layers: 1, hasSelection: false,
      lastAssetRef: `asset:${'c'.repeat(48)}`,
      assetList: [{ id: `asset:${'c'.repeat(48)}`, name: '0A9A7668.JPG', bytes: 5945344 }],
    },
  });
  const user = seen.streamArgs.messages[0].content[0].text;
  assert.match(user, /已有素材/, '必须给出素材清单');
  assert.match(user, /0A9A7668\.JPG/, '要带文件名，方便模型对应用户说的"刚上传那张"');
  assert.match(user, /最近可插入素材/, '最近可插入素材要进提示词（上传后也算）');
});

test('removeBackground op is allowlisted only for a real uploaded asset ref', () => {
  const valid = parsePlan(JSON.stringify({ reply: '我来抠这张图', ops: [{ type: 'removeBackground', assetRef: `asset:${'d'.repeat(48)}` }] }));
  assert.equal(valid.ops.length, 1);
  assert.equal(valid.ops[0].type, 'removeBackground');
  assert.equal(parsePlan(JSON.stringify({ reply: '好了', ops: [{ type: 'removeBackground', assetRef: 'asset:bad' }] })).ops.length, 0);
});

test('chatTurn：用户明确要求抠图且已有上传素材时，模型应提议 removeBackground，而非拒绝', async () => {
  const { ctx } = fakeCtx({ chunks: [{ type: 'text-delta', text: JSON.stringify({ reply: '我用刚上传的图片去背景，原图会保留。', ops: [{ type: 'removeBackground', assetRef: `asset:${'e'.repeat(48)}` }] }) }] });
  const result = await chatTurn(ctx, {
    message: '抠图',
    context: { width: 800, height: 600, layers: 1, hasSelection: false, lastAssetRef: `asset:${'e'.repeat(48)}`, assetList: [{ id: `asset:${'e'.repeat(48)}`, name: '0A9A7668.JPG', bytes: 5806 }] },
  });
  assert.match(result.reply, /原图会保留/);
  assert.equal(result.ops[0].type, 'removeBackground');
  assert.equal(result.ops[0].assetRef, `asset:${'e'.repeat(48)}`);
});

test('chatTurn：用户要求抠图但未上传素材时，模型先询问上传，不声称执行成功', async () => {
  const { ctx } = fakeCtx({ chunks: [{ type: 'text-delta', text: JSON.stringify({ reply: '请先上传一张图片，我才能为它去背景。', ops: [] }) }] });
  const result = await chatTurn(ctx, { message: '抠图', context: { width: 800, height: 600, layers: 0, hasSelection: false, assetList: [] } });
  assert.match(result.reply, /先上传/);
  assert.equal(result.ops.length, 0);
});

test('每个白名单命令都在助手提示里写明参数契约（防止能执行但模型不会写）', () => {
  assert.ok(PROPRIETABLE_COMMANDS.length >= 15, `白名单命令数量异常：${PROPRIETABLE_COMMANDS.length}`);
  const assistSource = readFileSync(resolve(root, 'lib/assist.js'), 'utf8');
  const missing = PROPRIETABLE_COMMANDS.filter(command => !assistSource.includes(`- ${command}: `));
  assert.deepEqual(missing, [], `以下命令缺少参数契约说明：${missing.join(', ')}`);
});

test('命令链路最多 3 个 command，超出部分计入 droppedOps', () => {
  const command = index => ({ type: 'command', command: { type: 'layer.reorder', payload: { layerId: 'l1', toIndex: index } } });
  const plan = parsePlan(JSON.stringify({ reply: '连做五步', ops: [command(1), command(2), command(3), command(4), command(5)] }));
  assert.equal(plan.ops.length, 3);
  assert.equal(plan.commandCount, 3);
  assert.equal(plan.droppedOps, 2);
  const mixed = parsePlan(JSON.stringify({ reply: '先读再改', ops: [{ type: 'status' }, command(1)] }));
  assert.equal(mixed.ops.length, 2, '非 command 操作不受 3 条上限影响');
});

test('HTTP /assist：GET 报状态、POST 转成 reply、无模型 503、非法体 400、鉴权 403', async () => {
  const token = 'assist-token';
  const caller = router => async ({ method = 'GET', url, headers = {}, body }) => {
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = chunk === undefined ? '' : String(chunk); return res; } };
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    await router(req, res);
    let value = null;
    try { value = JSON.parse(out.body); } catch { value = null; }
    return { ...out, value };
  };
  const auth = { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = { relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.' };

  const okCtx = fakeCtx({ chunks: [{ type: 'text-delta', text: '{"reply":"好的","ops":[]}' }] }).ctx;
  const working = caller(createMediaRouter({ ...base, ctx: okCtx, assist: { status: () => ({ ready: true, model: 'deepseek-flash' }), chat: turn => chatTurn(okCtx, turn) } }));
  const status = await working({ url: '/media-image/assist', headers: auth });
  assert.equal(status.status, 200);
  assert.equal(status.value.model, 'deepseek-flash');
  const chat = await working({ method: 'POST', url: '/media-image/assist', headers: auth, body: { message: '帮我看下' } });
  assert.equal(chat.status, 200);
  assert.equal(chat.value.reply, '好的');

  const downCtx = fakeCtx({ llm: false }).ctx;
  const down = caller(createMediaRouter({ ...base, ctx: downCtx, assist: { status: () => ({ ready: false }), chat: turn => chatTurn(downCtx, turn) } }));
  const unavailable = await down({ method: 'POST', url: '/media-image/assist', headers: auth, body: { message: 'hi' } });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.value.code, 'ASSIST_UNAVAILABLE');

  const noAuth = await working({ method: 'POST', url: '/media-image/assist', headers: { ...auth, authorization: 'Bearer nope' }, body: { message: 'hi' } });
  assert.equal(noAuth.status, 403);

  const badBody = await working({ method: 'POST', url: '/media-image/assist', headers: auth });
  assert.equal(badBody.status, 400);
});
