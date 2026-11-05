import app from './app.js';
import config from './config.js';
import zoomView from './libs/zoomView.js';

const COMMANDS = new Set(['layer.add_text', 'layer.update_text', 'layer.set_transform', 'layer.set_visibility', 'layer.reorder', 'layer.set_frame', 'layer.feather', 'layer.color_match', 'history.undo', 'history.redo', 'canvas.resize', 'canvas.crop', 'layer.remove']);
const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const textOf = layer => Array.isArray(layer.data) ? layer.data.map(line => line.map(span => span.text || '').join('')).join('\n') : '';
const keysOnly = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const stableStringify = value => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digestOf = value => {  const input = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64-${hash.toString(16).padStart(16, '0')}`;
};

export class DshEditorBridge {
  /** 纯像素算法按需加载：生产走动态 import，测试可注入 globalThis.__dshPixelOps。 */
  async pixelOps() {
    if (globalThis.__dshPixelOps) return globalThis.__dshPixelOps;
    return import('./dsh-pixel-ops.js');
  }
  /** 把图层栅格化成 ImageData；没有可绘制像素时明确报错，不猜。 */
  rasterizeLayer(layer) {
    const width = Math.max(1, Math.round(layer.width || layer.width_original || 1));
    const height = Math.max(1, Math.round(layer.height || layer.height_original || 1));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') throw this.error('LAYER_NOT_RASTERIZED', '这个图层还不能按像素处理');
    if (!layer.link) throw this.error('LAYER_NOT_RASTERIZED', '图层像素尚未加载为图像，请先导入或栅格化');
    ctx.drawImage(layer.link, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }
  /** 把处理后的像素封装成原生动作：一步撤销、一个 revision。 */
  imageAction(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    canvas.getContext('2d').putImageData(image, 0, 0);
    return new app.Actions.Update_layer_image_action(canvas, image.layerId);
  }
  /** 取（或建立）该图层处理前的首帧快照；之后每次都从它重算，保证幂等。 */
  baseSnapshot(layerId, image, pixelDigest) {
    const key = String(layerId);
    const existing = this.pixelBases.get(key);
    if (existing) return existing;
    const snapshot = { base: image, digest: pixelDigest(image) };
    this.pixelBases.set(key, snapshot);
    return snapshot;
  }
  constructor() {
    this.editorInstanceId = randomId();
    this.documentId = randomId();
    this.revision = 0;
    this.port = null;
    this.pending = [];
    this.running = false;
    this.pointerDown = false;
    this.composing = false;
    this.commandResults = new Map();
    this.exports = new Map();
    // 羽化/色彩匹配的首帧快照与已应用参数：只活在编辑器内，不进图层字段、不进 read_state。
    this.pixelBases = new Map();
    this.pixelApplied = new Map();
    // 图层像素摘要缓存：link + 尺寸 + 像素变更计数都没变就复用，避免重复全量扫描。
    this.pixelDigestCache = new Map();
    // 每次原生像素动作（含撤销/重做）自增，用于让全分辨率像素摘要失效。
    this.pixelMutation = 0;
    this.lastFingerprint = this.fingerprint();
    this.forcedFingerprint = null;
    this.observeMutations();
    window.addEventListener('message', this.onConnect.bind(this));
  }

  /**
   * 内容摘要：只含会改变画面的字段，**不含选中层/视图**。像素层额外带一个 64×64 采样摘要，
   * 否则羽化、调色这类纯像素修改前后摘要完全相同，"写后回读校验"等于没校验。
   */
  documentState() {
    return {
      width: config.WIDTH, height: config.HEIGHT,
      layers: config.layers.map(layer => ({
        id: layer.id, name: layer.name, type: layer.type,
        x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotate: layer.rotate,
        visible: layer.visible, order: layer.order, opacity: layer.opacity, color: layer.color,
        params: layer.params, filters: layer.filters,
        data: Array.isArray(layer.data) ? layer.data : null,
        pixels: this.layerPixelDigest(layer),
      })),
    };
  }

  /** UI 瞬时态：选中层、缩放、滚动位置。不参与内容摘要，也不该让 revision 增长。 */
  viewState() {
    const position = zoomView.getPosition();
    return { selectedLayerId: config.layer ? String(config.layer.id) : null, scale: zoomView.getScale(), position: { x: position.x, y: position.y } };
  }

  /**
   * 单层像素摘要：按**全分辨率**逐字节算 FNV-1a，缩略图会抹掉小改动，不能用于审计。
   * 性能靠缓存：键 = 图层像素对象身份 + 显示尺寸 + 像素变更计数，三者都没变就复用。
   * 像素变更计数由每个原生像素动作（羽化/调色，含其撤销重做）自增。
   */
  layerPixelDigest(layer) {
    const key = String(layer.id);
    const link = layer.link || null;
    const cache = this.pixelDigestCache.get(key);
    const size = `${layer.width || 0}x${layer.height || 0}`;
    if (cache && cache.link === link && cache.size === size && cache.mutation === this.pixelMutation) return cache.digest;
    let digest = 'pixels:none';
    if (link && typeof document !== 'undefined' && document.createElement) {
      try {
        const width = Math.max(1, Math.round(layer.width || layer.width_original || 1));
        const height = Math.max(1, Math.round(layer.height || layer.height_original || 1));
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx && typeof ctx.drawImage === 'function' && typeof ctx.getImageData === 'function') {
          ctx.clearRect?.(0, 0, width, height);
          ctx.drawImage(link, 0, 0, width, height);
          const image = ctx.getImageData(0, 0, width, height);
          let hash = 0xcbf29ce484222325n;
          for (let index = 0; index < image.data.length; index += 1) {
            hash ^= BigInt(image.data[index]);
            hash = BigInt.asUintN(64, hash * 0x100000001b3n);
          }
          digest = `pixels:${hash.toString(16).padStart(16, '0')}`;
        }
      } catch (_) { digest = 'pixels:unreadable'; }
    }
    this.pixelDigestCache.set(key, { link, size, mutation: this.pixelMutation, digest });
    return digest;
  }

  fingerprint() {
    return stableStringify(this.documentState());
  }

  // Revision counts distinct document states, so it advances at most once per observed
  // change. A forced bump on an unchanged fingerprint (redo used to double count) is a
  // no-op instead of a second increment.
  refreshRevision(force = false) {
    const fingerprint = this.fingerprint();
    const changed = fingerprint !== this.lastFingerprint;
    if (!changed && (!force || this.forcedFingerprint === fingerprint)) return;
    this.lastFingerprint = fingerprint;
    this.forcedFingerprint = changed ? null : fingerprint;
    this.revision++;
  }

  // Start idle human actions synchronously: miniPaint callers sometimes inspect config.layer
  // immediately after do_action(). All asynchronous history work shares this one scheduler.
  enqueue(operation) {
    return new Promise((resolve, reject) => {
      this.pending.push({ operation, resolve, reject });
      this.drain();
    });
  }

  drain() {
    if (this.running || !this.pending.length) return;
    const next = this.pending.shift();
    this.running = true;
    let result;
    try { result = next.operation(); } catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(next.resolve, next.reject).finally(() => {
      this.running = false;
      this.drain();
    });
  }

  observeMutations() {
    const state = app.State;
    this.nativeDo = state.do_action.bind(state);
    this.nativeUndo = state.undo_action.bind(state);
    this.nativeRedo = state.redo_action.bind(state);
    state.do_action = (action, options) => this.enqueue(async () => {
      const result = await this.nativeDo(action, options);
      if (result?.status === 'completed' && ['new_file', 'open_json_file'].includes(action.action_id)) this.documentId = randomId();
      this.refreshRevision(result?.status === 'completed');
      return result;
    });
    for (const [method, native] of [['undo_action', this.nativeUndo], ['redo_action', this.nativeRedo]]) {
      state[method] = () => this.enqueue(async () => {
        const before = state.action_history_index;
        await native();
        this.refreshRevision(before !== state.action_history_index);
      });
    }
    state.scrap_last_action = () => this.enqueue(async () => {
      if (!state.can_undo()) return;
      await this.nativeUndo();
      state.action_history.pop();
      this.refreshRevision(true);
    });
    // Direct previews (dragging, typing, sliders) are native miniPaint behavior. Do not
    // allow an agent transaction to interrupt an uncommitted gesture or text session.
    document.addEventListener('pointerdown', () => { this.pointerDown = true; }, true);
    window.addEventListener('pointerup', () => { this.pointerDown = false; }, true);
    window.addEventListener('pointercancel', () => { this.pointerDown = false; }, true);
    window.addEventListener('blur', () => { this.pointerDown = false; }, true);
    document.addEventListener('compositionstart', () => { this.composing = true; }, true);
    document.addEventListener('compositionend', () => { this.composing = false; }, true);
    // Native actions may await images/storage. Prevent fresh UI mutations until the
    // current history transaction settles, rather than allowing direct previews to race.
    for (const type of ['pointerdown', 'pointermove', 'mousedown', 'mousemove', 'touchstart', 'touchmove', 'keydown', 'beforeinput', 'input', 'change', 'click', 'drop', 'paste']) {
      document.addEventListener(type, event => {
        if (!this.running || !event.isTrusted) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { capture: true, passive: false });
    }
  }

  isHumanEditing() {
    const target = document.activeElement;
    return this.pointerDown || this.composing || !!target?.matches('input,textarea,[contenteditable="true"]');
  }

  onConnect(event) {
    if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin) return;
    if (event.data?.type !== 'dsh.editor.connect' || typeof event.data.requestId !== 'string' || !event.ports?.[0]) return;
    const port = event.ports[0];
    this.port?.close();
    this.port = port;
    port.onmessage = ({ data }) => void this.handleRequest(data, port);
    port.start?.();
    port.postMessage({ requestId: event.data.requestId, ok: true, result: { editorInstanceId: this.editorInstanceId, contractVersion: 1, ready: true } });
  }

  async handleRequest(request, port = this.port) {
    if (!plain(request) || typeof request.requestId !== 'string') return;
    try {
      const result = await this.enqueue(async () => {
        this.refreshRevision();
        if (request.editorInstanceId !== this.editorInstanceId) throw this.error('EDITOR_INSTANCE_MISMATCH');
        if (request.type === 'editor.read_state') return this.readState();
        if (request.type === 'editor.get_command_result') return this.getCommandResult(request);
        if (request.type === 'editor.apply_command') return this.applyCommand(request);
        if (request.type === 'editor.export_start') return this.exportStart(request);
        if (request.type === 'editor.export_status') {
          const item = this.exports.get(request.exportId);
          if (!item || item.documentId !== this.documentId) throw this.error('DOCUMENT_MISMATCH');
          return item;
        }
        throw this.error('INVALID_REQUEST');
      });
      port?.postMessage({ requestId: request.requestId, ok: true, result });
    } catch (error) {
      port?.postMessage({ requestId: request.requestId, ok: false, error: { code: error.code || 'EDITOR_ERROR', message: error.message || '编辑器执行失败', revision: error.revision ?? this.revision } });
    }
  }

  readState() {
    const layers = app.Layers.get_sorted_layers().map(layer => {
      const applied = this.pixelApplied.get(String(layer.id)) || {};
      return { id: String(layer.id), name: String(layer.name || ''), type: String(layer.type || 'empty'),
        visible: layer.visible !== false, x: layer.x, y: layer.y, width: layer.width, height: layer.height,
        rotationDeg: layer.rotate || 0,
        // 只在真的应用过时出现；快照本身留在编辑器内部，模型看不到原始像素。
        ...(applied.feather ? { feather: applied.feather } : {}),
        ...(applied.colorMatch ? { colorMatch: applied.colorMatch } : {}),
        ...(layer.type === 'text' ? { text: textOf(layer) } : {}) };
    });
    const selectedLayerId = config.layer ? String(config.layer.id) : null;
    const selectedLayer = layers.find(layer => layer.id === selectedLayerId) || null;
    const historyIndex = app.State.action_history_index;
    const historyLength = app.State.action_history.length;
    const top = this.lastAgentCommit;
    const currentDigest = digestOf(this.documentState());
    const validTop = top && top.revision === this.revision && top.afterDigest === currentDigest && top.historyIndex === historyIndex && top.action === app.State.action_history[historyIndex - 1];
    const position = zoomView.getPosition();
    // A canvas that has not been laid out yet can still report a non-positive config size;
    // never publish a negative dimension to the Host state validator.
    const canvasWidth = Number.isFinite(config.WIDTH) ? Math.max(1, config.WIDTH) : 1;
    const canvasHeight = Number.isFinite(config.HEIGHT) ? Math.max(1, config.HEIGHT) : 1;
    const contentDigest = currentDigest;
    return { editorKind: 'image', editorInstanceId: this.editorInstanceId, documentId: this.documentId, revision: this.revision,
      // 内容摘要与视图态分开：选中/缩放不再算内容变化。
      contentDigest,
      viewState: this.viewState(),
      // deprecated：保留一版以稳住旧契约，值与 contentDigest 相同。
      stateDigest: contentDigest,
      canvas: { width: canvasWidth, height: canvasHeight },
      view: { scale: zoomView.getScale(), position: { x: position.x, y: position.y } },
      history: { ...(validTop ? { lastCommandId: top.commandId, appliedRevision: top.revision, afterDigest: top.afterDigest } : {}), canUndo: app.State.can_undo(), canRedo: app.State.can_redo(),
        undoDepth: historyIndex, redoDepth: historyLength - historyIndex, lastActionId: historyIndex > 0 ? app.State.action_history[historyIndex - 1]?.action_id ?? 'unknown' : 'unknown' },
      selectedLayerId, selectedObjects: selectedLayer ? [{ id: selectedLayer.id, kind: selectedLayer.type,
        textSummary: selectedLayer.type === 'text' ? selectedLayer.text : null,
        propsSummary: selectedLayer.type === 'text' ? null : { name: selectedLayer.name },
        transform: { x: selectedLayer.x, y: selectedLayer.y, width: selectedLayer.width, height: selectedLayer.height, rotationDeg: selectedLayer.rotationDeg },
        visible: selectedLayer.visible, zIndex: app.Layers.get_sorted_layers().findIndex(layer => String(layer.id) === selectedLayer.id) }] : [],
      layers };
  }

  getCommandResult(request) {
    if (typeof request.commandId !== 'string' || !request.commandId || request.commandId.length > 256) throw this.error('INVALID_REQUEST');
    const cached = this.commandResults.get(request.commandId);
    return cached ? { status: cached.status, originalResult: cached.originalResult } : { status: 'unknown', originalResult: null };
  }

  async applyCommand(request) {
    if (request.documentId !== this.documentId) throw this.error('DOCUMENT_MISMATCH');
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || typeof request.commandId !== 'string' || !request.commandId || request.commandId.length > 256) throw this.error('INVALID_REQUEST');
    const previous = this.commandResults.get(request.commandId);
    if (previous?.status === 'applied') return previous.originalResult;
    if (previous?.status === 'rejected') throw this.error(previous.code);
    if (previous) throw this.error('EDITOR_TIMEOUT_OUTCOME_UNKNOWN');
    // Never evict outcomes while an editor lives: dropping a key would permit replay.
    if (this.commandResults.size >= 10000) throw this.error('EDITOR_NOT_READY');
    let started = false;
    try {
      if (this.isHumanEditing()) throw this.error('EDITOR_NOT_READY', '人工编辑尚未提交，请结束拖拽或文字输入后重试');
      this.refreshRevision();
      if (request.expectedRevision !== this.revision) throw this.error('REVISION_CONFLICT');
      const prepared = await this.prepare(request.command);
      // Validation and action construction are synchronous inside the shared scheduler.
      // Mutation uses the original native history entrypoint, avoiding queue re-entry.
      this.commandResults.set(request.commandId, { status: 'unknown', originalResult: null });
      started = true;
      if (prepared.history) {
        const can = prepared.history === 'undo' ? app.State.can_undo() : app.State.can_redo();
        if (!can) { started = false; throw this.error('HISTORY_EMPTY', '没有可撤销或重做的修改'); }
        await (prepared.history === 'undo' ? this.nativeUndo() : this.nativeRedo());
        config.need_render = true;
        app.Layers.render(true);
        this.refreshRevision(true);
      }
      if (prepared.action) {
        const outcome = await this.nativeDo(prepared.action);
        if (outcome?.status !== 'completed') throw this.error('EDITOR_ERROR');
        // Text layout writes dynamic width/height during render. Settle native layout
        // before fingerprinting, so the next read cannot count that layout as an edit.
        config.need_render = true;
        app.Layers.render(true);
        this.refreshRevision(true);
      }
      const afterDigest = digestOf(this.documentState());
      this.lastAgentCommit = prepared.action ? { commandId: request.commandId, revision: this.revision, afterDigest, historyIndex: app.State.action_history_index, action: app.State.action_history[app.State.action_history_index - 1] } : null;
      const result = { editorKind: 'image', documentId: this.documentId, revision: this.revision, afterDigest, commandId: request.commandId,
        changedObjectIds: prepared.ids(), stateSummary: { selectedLayerId: config.layer ? String(config.layer.id) : null } };
      this.commandResults.set(request.commandId, { status: 'applied', originalResult: result });
      return result;
    } catch (error) {
      this.refreshRevision();
      // Native aborted actions can have partial effects. Do not call these rejected
      // or replayable without proof of rollback; keep their outcome explicitly unknown.
      if (!started) this.commandResults.set(request.commandId, { status: 'rejected', originalResult: null, code: error.code || 'EDITOR_ERROR' });
      else throw this.error('EDITOR_TIMEOUT_OUTCOME_UNKNOWN', '原生动作未能确认完整提交，结果未知，请查询原命令');
      throw error;
    }
  }

  async exportStart(request) {
    if (request.documentId !== this.documentId) throw this.error('DOCUMENT_MISMATCH');
    if (request.expectedRevision !== this.revision) throw this.error('REVISION_CONFLICT');
    if (!['png', 'jpeg'].includes(request.format) || typeof request.commandId !== 'string' || !request.commandId) throw this.error('INVALID_REQUEST');
    const existing = Array.from(this.exports.values()).find(item => item.commandId === request.commandId);
    if (existing) return existing;
    const canvas = document.createElement('canvas');
    canvas.width = config.WIDTH; canvas.height = config.HEIGHT;
    const ctx = canvas.getContext('2d');
    if (request.format === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    app.Layers.convert_layers_to_canvas(ctx, null, false);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(this.error('EDITOR_ERROR', '无法生成图片')), 'image/' + request.format, 0.92));
    const artifactRef = URL.createObjectURL(blob);
    const exportId = randomId();
    const item = { editorKind: 'image', exportId, commandId: request.commandId, documentId: this.documentId, revision: this.revision, status: 'completed', artifactRef, mimeType: blob.type, bytes: blob.size };
    this.exports.set(exportId, item);
    return item;
  }

  /** 取色彩匹配的参考像素：同画布其他图层（canvas）或该图层下方图层（below），可裁成矩形。 */
  referencePixels(layer, reference) {
    const width = Math.max(1, Math.round(config.WIDTH || 1));
    const height = Math.max(1, Math.round(config.HEIGHT || 1));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') throw this.error('LAYER_NOT_RASTERIZED', '画布还不支持像素读取');
    const sorted = app.Layers.get_sorted_layers();
    const index = sorted.findIndex(item => String(item.id) === String(layer.id));
    const sources = reference === 'below' ? sorted.slice(index + 1) : sorted.filter(item => String(item.id) !== String(layer.id));
    for (const item of sources) {
      if (item.visible === false || !item.link) continue;
      ctx.globalAlpha = (item.opacity ?? 100) / 100;
      try { ctx.drawImage(item.link, item.x || 0, item.y || 0, item.width || item.width_original || 1, item.height || item.height_original || 1); } catch (_) { /* 不可绘制图层跳过 */ }
    }
    ctx.globalAlpha = 1;
    const rect = reference !== 'canvas' && reference !== 'below' ? reference.rect : [0, 0, width, height];
    const [x, y, w, h] = rect;
    return ctx.getImageData(x, y, Math.max(1, Math.min(w, width - x)), Math.max(1, Math.min(h, height - y)));
  }

  async prepare(command) {
    if (!keysOnly(command, ['type', 'payload']) || !COMMANDS.has(command.type)) throw this.error('UNSUPPORTED_COMMAND');
    const p = command.payload;
    if (command.type === 'history.undo' || command.type === 'history.redo') {
      if (!keysOnly(p, command.type === 'history.undo' ? ['targetCommandId', 'afterDigest'] : [])) throw this.error('INVALID_REQUEST');
      if ((p.targetCommandId === undefined) !== (p.afterDigest === undefined)) throw this.error('INVALID_REQUEST');
      if (p.targetCommandId !== undefined) {
        const top = this.lastAgentCommit;
        if (!top || p.targetCommandId !== top.commandId || p.afterDigest !== top.afterDigest || top.revision !== this.revision || top.historyIndex !== app.State.action_history_index || top.action !== app.State.action_history[app.State.action_history_index - 1] || digestOf(this.documentState()) !== top.afterDigest) throw this.error('HISTORY_CONFLICT', '已有后续修改，不能单独撤销这一步');
      }
      return { history: command.type.split('.')[1], ids: () => [] };
    }
    if (command.type === 'canvas.resize' || command.type === 'canvas.crop') {
      const crop = command.type === 'canvas.crop';
      if (!keysOnly(p, crop ? ['x', 'y', 'width', 'height'] : ['width', 'height']) || !Number.isSafeInteger(p.width) || !Number.isSafeInteger(p.height) || p.width < 1 || p.height < 1 || p.width > 16384 || p.height > 16384) throw this.error('INVALID_REQUEST');
      const actions = [];
      if (crop) {
        if (!Number.isSafeInteger(p.x) || !Number.isSafeInteger(p.y) || p.x < 0 || p.y < 0 || p.x + p.width > config.WIDTH || p.y + p.height > config.HEIGHT) throw this.error('INVALID_REQUEST');
        for (const layer of config.layers) actions.push(new app.Actions.Update_layer_action(layer.id, { x: (layer.x || 0) - p.x, y: (layer.y || 0) - p.y }));
      }
      actions.push(new app.Actions.Update_config_action({ WIDTH: p.width, HEIGHT: p.height }));
      return { action: new app.Actions.Bundle_action('dsh_canvas', crop ? '裁剪画布' : '调整画布尺寸', actions), ids: () => config.layers.map(layer => String(layer.id)) };
    }
    if (command.type === 'layer.feather' || command.type === 'layer.color_match') {
      const isFeather = command.type === 'layer.feather';
      const allowed = isFeather ? ['layerId', 'radiusPx'] : ['layerId', 'method', 'strength', 'reference'];
      if (!keysOnly(p, allowed)) throw this.error('INVALID_REQUEST');
      const layer = config.layers.find(item => String(item.id) === p.layerId);
      if (!layer) throw this.error('LAYER_NOT_FOUND');
      const ops = await this.pixelOps();
      const key = String(layer.id);
      const current = this.rasterizeLayer(layer);
      const snapshot = this.baseSnapshot(layer.id, current, ops.pixelDigest);
      let output;
      let applied;
      if (isFeather) {
        if (!Number.isSafeInteger(p.radiusPx) || p.radiusPx < 1 || p.radiusPx > 64) throw this.error('INVALID_REQUEST');
        // 每次都用首帧快照重算：调半径是覆盖，不是叠加。
        output = ops.blurAlpha(snapshot.base, p.radiusPx);
        applied = { feather: { radiusPx: p.radiusPx, fromDigest: snapshot.digest } };
      } else {
        if (p.method !== 'reinhard') throw this.error('INVALID_REQUEST');
        const strength = p.strength === undefined ? 1 : p.strength;
        if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1) throw this.error('INVALID_REQUEST');
        const reference = p.reference === undefined ? 'below' : p.reference;
        if (reference !== 'canvas' && reference !== 'below') {
          if (!plain(reference) || !keysOnly(reference, ['rect']) || !Array.isArray(reference.rect) || reference.rect.length !== 4
            || !reference.rect.every(value => Number.isSafeInteger(value) && value >= 0)) throw this.error('INVALID_REQUEST');
        }
        const referenceImage = this.referencePixels(layer, reference);
        output = ops.reinhardTransfer(snapshot.base, referenceImage, strength);
        applied = { colorMatch: { method: 'reinhard', strength, fromDigest: snapshot.digest } };
      }
      output.layerId = layer.id;
      // 「已应用」必须跟着历史走：把参数挂到该动作的 do/undo 上，撤销时回退、重做时恢复，
      // 否则撤销后 read_state 还会说 feather/colorMatch 在生效，等于骗人。
      const previous = { ...(this.pixelApplied.get(key) || {}) };
      const action = this.imageAction(output);
      const nativeDo = action.do.bind(action);
      const nativeUndo = action.undo.bind(action);
      const appliedState = this.pixelApplied;
      const owner = this;
      action.do = async () => {
        await nativeDo();
        owner.pixelMutation += 1;
        appliedState.set(key, { ...previous, ...applied });
      };
      action.undo = async () => {
        await nativeUndo();
        owner.pixelMutation += 1;
        if (Object.keys(previous).length) appliedState.set(key, previous);
        else appliedState.delete(key);
      };
      return { action, ids: () => [key] };
    }
    if (command.type === 'layer.remove') {
      if (!keysOnly(p, ['layerId']) || typeof p.layerId !== 'string' || !config.layers.some(layer => String(layer.id) === p.layerId)) throw this.error('LAYER_NOT_FOUND');
      return { action: new app.Actions.Delete_layer_action(p.layerId), ids: () => [p.layerId] };
    }
    if (command.type === 'layer.set_frame') {
      // 像素框定位：模型给的是坐标/尺寸而不是缩放比，set_transform 表达不了。
      // 只给一边时按 fit 保持比例推算另一边；两边都给就是这一帧的最终尺寸。
      if (!keysOnly(p, ['layerId', 'x', 'y', 'width', 'height', 'fit', 'anchor'])) throw this.error('INVALID_REQUEST');
      const layer = config.layers.find(item => String(item.id) === p.layerId);
      if (!layer) throw this.error('LAYER_NOT_FOUND');
      const fit = p.fit === undefined ? 'contain' : p.fit;
      if (!['stretch', 'contain', 'cover'].includes(fit)) throw this.error('INVALID_REQUEST');
      for (const key of ['x', 'y']) if (p[key] !== undefined && !Number.isSafeInteger(p[key])) throw this.error('INVALID_REQUEST');
      for (const key of ['width', 'height']) if (p[key] !== undefined && (!Number.isSafeInteger(p[key]) || p[key] < 1 || p[key] > 16384)) throw this.error('INVALID_REQUEST');
      if (p.width === undefined && p.height === undefined) throw this.error('INVALID_REQUEST');
      const current = { width: layer.width || layer.width_original || 1, height: layer.height || layer.height_original || 1 };
      const ratio = current.width / current.height;
      let width = p.width, height = p.height;
      if (width === undefined) width = Math.max(1, Math.round(height * ratio));
      if (height === undefined) height = Math.max(1, Math.round(width / ratio));
      let x = p.x, y = p.y;
      if (x === undefined) x = layer.x || 0;
      if (y === undefined) y = layer.y || 0;
      if (p.anchor === 'center') { x = Math.round(x - width / 2); y = Math.round(y - height / 2); }
      else if (p.anchor !== undefined && p.anchor !== 'top-left') throw this.error('INVALID_REQUEST');
      return { action: new app.Actions.Update_layer_action(layer.id, { x, y, width, height }), ids: () => [String(layer.id)] };
    }
    const fields = {
      'layer.add_text': ['text', 'x', 'y', 'style'], 'layer.update_text': ['layerId', 'text'],
      'layer.set_transform': ['layerId', 'x', 'y', 'scaleX', 'scaleY', 'rotationDeg'],
      'layer.set_visibility': ['layerId', 'visible'], 'layer.reorder': ['layerId', 'toIndex']
    };
    if (!keysOnly(p, fields[command.type])) throw this.error('INVALID_REQUEST');
    const validText = text => typeof text === 'string' && text.length <= 4000;
    const lines = (text, meta) => text.split('\n').map(line => [{ text: line, meta: { ...meta } }]);
    if (command.type === 'layer.add_text') {
      if (!validText(p.text)) throw this.error('INVALID_REQUEST');
      // x/y are optional: an agent that only supplies text should land on the canvas
      // centre instead of failing late with INVALID_REQUEST.
      const x = p.x === undefined ? Math.round((config.WIDTH || 800) / 2) : p.x;
      const y = p.y === undefined ? Math.round((config.HEIGHT || 600) / 2) : p.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw this.error('INVALID_REQUEST');
      const style = p.style ?? {};
      if (!keysOnly(style, ['size', 'family', 'fill_color', 'bold', 'italic'])) throw this.error('INVALID_REQUEST');
      if (style.size !== undefined && (!Number.isFinite(style.size) || style.size < 1 || style.size > 1000)) throw this.error('INVALID_REQUEST');
      if (style.family !== undefined && (typeof style.family !== 'string' || !/^[\p{L}\p{N} _-]{1,100}$/u.test(style.family))) throw this.error('INVALID_REQUEST');
      if (style.fill_color !== undefined && !/^#[0-9a-f]{6}$/i.test(style.fill_color)) throw this.error('INVALID_REQUEST');
      for (const key of ['bold', 'italic']) if (style[key] !== undefined && typeof style[key] !== 'boolean') throw this.error('INVALID_REQUEST');
      const action = new app.Actions.Insert_layer_action({ name: p.text.slice(0, 80) || '文本', type: 'text', x, y, rotate: 0, is_vector: true,
        render_function: ['text', 'render'], data: lines(p.text, style),
        params: { boundary: 'dynamic', kerning: 'metrics', text_direction: 'ltr', wrap_direction: 'ttb', halign: 'left', valign: 'top', wrap: 'letter' } }, false);
      return { action, ids: () => [String(action.inserted_layer_id)] };
    }
    if (typeof p.layerId !== 'string' || !p.layerId) throw this.error('INVALID_REQUEST');
    const layer = config.layers.find(item => String(item.id) === p.layerId);
    if (!layer) throw this.error('LAYER_NOT_FOUND');
    const ids = () => [String(layer.id)];
    if (command.type === 'layer.update_text') {
      if (layer.type !== 'text' || !validText(p.text)) throw this.error('INVALID_REQUEST');
      return { action: new app.Actions.Update_layer_action(layer.id, { data: lines(p.text, layer.data?.[0]?.[0]?.meta || {}) }), ids };
    }
    if (command.type === 'layer.set_transform') {
      const settings = {};
      for (const key of ['x', 'y', 'rotationDeg', 'scaleX', 'scaleY']) if (p[key] !== undefined && !Number.isFinite(p[key])) throw this.error('INVALID_REQUEST');
      if (p.x !== undefined) settings.x = p.x;
      if (p.y !== undefined) settings.y = p.y;
      if (p.rotationDeg !== undefined) settings.rotate = p.rotationDeg;
      for (const [scale, size] of [['scaleX', 'width'], ['scaleY', 'height']]) if (p[scale] !== undefined) {
        const original = layer[`${size}_original`] ?? layer[size];
        if (p[scale] <= 0 || !Number.isFinite(original) || original <= 0 || !Number.isFinite(original * p[scale])) throw this.error('INVALID_REQUEST');
        settings[size] = Math.max(1, Math.round(original * p[scale]));
        if (layer[`${size}_original`] == null) settings[`${size}_original`] = original;
      }
      if (!Object.keys(settings).length) throw this.error('INVALID_REQUEST');
      return { action: new app.Actions.Update_layer_action(layer.id, settings), ids };
    }
    if (command.type === 'layer.set_visibility') {
      if (typeof p.visible !== 'boolean') throw this.error('INVALID_REQUEST');
      return { action: (layer.visible !== false) === p.visible ? null : new app.Actions.Toggle_layer_visibility_action(layer.id), ids };
    }
    const sorted = app.Layers.get_sorted_layers();
    if (!Number.isSafeInteger(p.toIndex) || p.toIndex < 0 || p.toIndex >= sorted.length) throw this.error('INVALID_REQUEST');
    const current = sorted.findIndex(item => item.id === layer.id);
    const direction = p.toIndex < current ? 1 : -1;
    const actions = [];
    for (let index = current; index !== p.toIndex; index += p.toIndex < current ? -1 : 1) actions.push(new app.Actions.Reorder_layer_action(layer.id, direction));
    return { action: actions.length ? new app.Actions.Bundle_action('dsh_reorder', 'Agent 调整图层顺序', actions) : null, ids };
  }

  error(code, message) {
    const messages = { INVALID_REQUEST: '请求格式无效', UNSUPPORTED_COMMAND: '不支持此编辑命令', LAYER_NOT_FOUND: '未找到目标图层',
      REVISION_CONFLICT: '工程已被修改，请重新读取后再操作', DOCUMENT_MISMATCH: '当前工程与请求不一致', EDITOR_INSTANCE_MISMATCH: '编辑器实例已变化',
      EDITOR_NOT_READY: '编辑器忙碌，请结束人工操作后重试', EDITOR_TIMEOUT_OUTCOME_UNKNOWN: '执行结果未知，请查询原命令结果', EDITOR_ERROR: '编辑器执行失败' };
    return Object.assign(new Error(message || messages[code] || messages.EDITOR_ERROR), { code, revision: this.revision });
  }
}

export default DshEditorBridge;
