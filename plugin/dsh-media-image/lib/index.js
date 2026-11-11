// DSH Host plugin entry: shared image editing tools and the packaged image page.
// Tools are the only model-facing write surface; relay is an internal transport.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditorRelay } from './relay.js';
import { createMediaBridge } from './bridge.js';
import { createGuard, createApprovalStore, createSessionBindings } from './gate.js';
import { createBindTickets } from './tickets.js';
import { registerMediaTools } from './tools.js';
import { createMediaRouter } from './http.js';
import { createAssetStore } from './assets.js';
import { createRecipeStore } from './recipes.js';
import { createGenerationService } from './generation.js';
import { createBatchQueue } from './batch.js';
import { createFontStore } from './fonts.js';
import { chatTurn, modelInfo } from './assist.js';
import { createBackgroundRemovalService } from './background-removal.js';
import { createPhotoshopService } from './photoshop-com.js';
import { ensureHeadlessEditor, closeAllHeadlessEditors } from './headless-registry.js';

// 生成后端配置来源优先级：插件 config.generation.providers > 环境变量 DSH_MEDIA_IMAGE_PROVIDERS(JSON 数组)。
// 两者都没有就不注册任何 provider —— /generate 会如实返回 PROVIDER_UNAVAILABLE，而不是假装能生成。
function resolveProviders(config) {
  const fromConfig = config?.generation?.providers;
  if (Array.isArray(fromConfig)) return fromConfig;
  const raw = process.env.DSH_MEDIA_IMAGE_PROVIDERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const name = 'dsh-media-image';
// llm / agentDefaultModel 用 ctx.get(...) 懒解析（与 dsh-media-desk 同一做法）：
// 不写进 inject，避免服务晚就绪时把整个插件卡住；缺服务时路由如实返回 503。
export const inject = ['tools', 'webServer', 'approval'];

const hostRoot = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(hostRoot, '../public');
const packagedRoot = resolve(publicDir, 'image');

// 中继允许的编辑器请求类型。漏一个就会在运行时被 relay 直接拒成 INVALID_REQUEST，
// 所以这份清单单独导出，由测试逐项核对（0.20.0 就是靠它发现 export_inpaint_inputs 漏登记的）。
export const EDITOR_REQUEST_TYPES = ['editor.read_state', 'editor.apply_command', 'editor.get_command_result', 'editor.export_start', 'editor.export_status', 'editor.export_inpaint_inputs', 'editor.measure_text', 'editor.highlight', 'editor.analyze', 'editor.preview_png'];

export function apply(ctx, config = {}) {
  const token = randomBytes(32).toString('hex');
  const relay = createEditorRelay({
    editorKind: 'image',
    allowedTypes: EDITOR_REQUEST_TYPES,
  });
  const bridge = createMediaBridge({ relay, editorKind: 'image' });
  // 配置了 dataDir 就把素材落盘：重启后素材还在；没配置则保持纯内存（临时语义）。
  const assets = createAssetStore({ dir: config.dataDir ? join(resolve(config.dataDir), 'assets') : null });
  // 预录流程（.atn 思路）：和素材同一套目录，重启后仍在。
  const recipes = createRecipeStore({ dir: config.dataDir ? join(resolve(config.dataDir), 'recipes') : null });
  const fonts = createFontStore();
  // 配置错误不能让整个插件起不来：坏 provider 被跳过并记一行警告，其余功能照常。
  let generation = null;
  const providerDefs = resolveProviders(config);
  if (providerDefs.length) {
    try {
      generation = createGenerationService({ providers: providerDefs, assets });
    } catch (error) {
      console.warn(`[dsh-media-image] 生成后端配置无效，已禁用生成能力：${error.message}`);
    }
  }
  // 批量队列只在有生成后端时才有意义：没有后端就没有可排的作业。
  let batchQueue = null;
  if (generation) {
    batchQueue = createBatchQueue({ generation, maxConcurrency: config?.generation?.maxConcurrency });
  }
  const approvals = createApprovalStore();
  // 面板授权票据：桌面端 approval=never 时的授权路径（本人点一次，票据一次性、5 分钟）。
  const tickets = createBindTickets();
  const bindings = createSessionBindings({
    resolvePage: (_kind, instanceId) => bridge.getPage(instanceId) ?? null,
    tickets,
  });

  const photoshop = createPhotoshopService({
    enabled: config.photoshop?.enabled === true,
    timeoutMs: config.photoshop?.timeoutMs,
    progId: config.photoshop?.progId,
  });
  if (config.photoshop?.enabled !== true) console.warn('[dsh-media-image] Photoshop COM/任意 JSX 工具默认关闭；需本人显式配置 photoshop.enabled=true 才注册');

  ctx.effect(() => () => { relay.close(); assets.clear(); fonts.clear(); }, 'dsh-media-image: relay and assets dispose');

  ctx.tools.guard(createGuard());

  // 助手：走宿主模型服务（与 dsh-media-desk 同一契约，不自建密钥）。
  // 服务在**每次请求时**才解析 —— 插件先于 llm 就绪也不会永久降级。
  const assistant = {
    status: () => {
      const info = modelInfo(ctx);
      return info
        ? { ready: true, model: info.label, provider: info.provider }
        : { ready: false, model: null, reason: 'NO_DEFAULT_MODEL' };
    },
    chat: turn => chatTurn(ctx, turn),
  };

  const backgroundRemoval = config.backgroundRemoval?.endpoint
    ? createBackgroundRemovalService({
      ...config.backgroundRemoval,
      assets,
      fetchImpl: config.backgroundRemoval.fetchImpl || globalThis.fetch,
      timeoutMs: config.backgroundRemoval.timeoutMs,
    })
    : null;
  if (!backgroundRemoval) console.warn('[dsh-media-image] 未配置 backgroundRemoval.endpoint，抠图能力不可用（助手会说明并提供配置提示）');

  const router = createMediaRouter({
    relay,
    editorKind: 'image',
    prefix: '/media-image',
    token,
    publicDir,
    tickets,
    bindings,
    assets,
    generation,
    fonts,
    batchQueue,
    assist: assistant,
    backgroundRemoval,
    photoshop,
    ctx,
    editorRoot: config.imageRoot ? resolve(config.imageRoot)
      : existsSync(join(packagedRoot, 'index.html')) ? packagedRoot : null,
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/media-image', handler: router }), 'dsh-media-image: routes');

  registerMediaTools(ctx, {
    bridge, approvals, bindings, assets, generation, recipes, photoshop,
    // 无头编辑器只在显式工具调用时使用；未启用时对象为空，工具根本不注册。
    headless: config.headless?.enabled === true
      ? {
        enabled: true,
        origin: typeof config.headless.origin === 'string' ? config.headless.origin : '',
        ensure: options => ensureHeadlessEditor(options),
      }
      : null,
  });
  return {
    dispose() {
      relay.close();
      assets.clear();
      fonts.clear();
      // 无头实例由本插件拉起，卸载时必须自己收尾，否则会留下孤儿浏览器进程。
      void closeAllHeadlessEditors();
    },
  };
}
