// DSH Host plugin entry: shared image editing tools and the packaged image page.
// Tools are the only model-facing write surface; relay is an internal transport.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEditorRelay } from './relay.js';
import { createMediaBridge } from './bridge.js';
import { createGuard, createApprovalStore } from './gate.js';
import { registerMediaTools } from './tools.js';
import { createMediaRouter } from './http.js';

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
  const approvals = createApprovalStore();

  ctx.effect(() => () => { relay.close(); }, 'dsh-media-image: relay dispose');

  ctx.tools.guard(createGuard());

  const router = createMediaRouter({
    relay,
    editorKind: 'image',
    prefix: '/media-image',
    token,
    publicDir,
    editorRoot: config.imageRoot ? resolve(config.imageRoot)
      : existsSync(join(packagedRoot, 'index.html')) ? packagedRoot : null,
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/media-image', handler: router }), 'dsh-media-image: routes');

  registerMediaTools(ctx, { bridge, approvals });
  return { dispose() { relay.close(); } };
}
