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
import { createGenerationService } from './generation.js';
import { createFontStore } from './fonts.js';

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
export const inject = ['tools', 'webServer', 'approval'];

const hostRoot = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(hostRoot, '../public');
const packagedRoot = resolve(publicDir, 'image');

export function apply(ctx, config = {}) {
  const token = randomBytes(32).toString('hex');
  const relay = createEditorRelay({
    editorKind: 'image',
    allowedTypes: ['editor.read_state', 'editor.apply_command', 'editor.get_command_result', 'editor.export_start', 'editor.export_status'],
  });
  const bridge = createMediaBridge({ relay, editorKind: 'image' });
  const assets = createAssetStore();
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
  const approvals = createApprovalStore();
  // 面板授权票据：桌面端 approval=never 时的授权路径（本人点一次，票据一次性、5 分钟）。
  const tickets = createBindTickets();
  const bindings = createSessionBindings({
    resolvePage: (_kind, instanceId) => bridge.getPage(instanceId) ?? null,
    tickets,
  });

  ctx.effect(() => () => { relay.close(); assets.clear(); fonts.clear(); }, 'dsh-media-image: relay and assets dispose');

  ctx.tools.guard(createGuard());

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
    editorRoot: config.imageRoot ? resolve(config.imageRoot)
      : existsSync(join(packagedRoot, 'index.html')) ? packagedRoot : null,
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/media-image', handler: router }), 'dsh-media-image: routes');

  registerMediaTools(ctx, { bridge, approvals, bindings, assets, generation });
  return { dispose() { relay.close(); assets.clear(); fonts.clear(); } };
}
