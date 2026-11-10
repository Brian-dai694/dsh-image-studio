import app from './app.js';
import config from './config.js';
import zoomView from './libs/zoomView.js';

// 与 modules/layer/composition.js 的清单一致：浏览器 globalCompositeOperation 全集。
// 编辑器的 "-- Default --" 对应这里显式写出的 source-over。
const BLEND_MODES = new Set(['color', 'color-burn', 'color-dodge', 'copy', 'darken', 'darker', 'destination-atop', 'destination-in', 'destination-out', 'destination-over', 'difference', 'exclusion', 'hard-light', 'hue', 'lighten', 'lighter', 'luminosity', 'multiply', 'overlay', 'saturation', 'screen', 'soft-light', 'source-atop', 'source-in', 'source-out', 'source-over', 'xor']);
const COMMANDS = new Set(['layer.add_image', 'layer.add_text', 'layer.update_text', 'layer.set_transform', 'layer.set_visibility', 'layer.set_appearance', 'layer.reorder', 'layer.set_frame', 'layer.feather', 'layer.color_match', 'layer.remove_background', 'layer.magic_erase', 'layer.add_mask_layer', 'history.undo', 'history.redo', 'history.batch', 'canvas.resize', 'canvas.crop', 'layer.remove']);
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
  imageAction(image, layerId) {
    if (layerId === undefined || layerId === null || !config.layers.some(layer => String(layer.id) === String(layerId))) {
      throw this.error('LAYER_NOT_FOUND', '像素动作必须指定真实目标图层');
    }
    // putImageData 只认 ImageData：像素算法返回的是纯 {width,height,data}，必须先转换。
    if (typeof ImageData !== 'function' || !(image instanceof ImageData)) {
      throw this.error('PIXEL_DATA_NOT_IMAGE_DATA', '像素结果必须先经 ensureImageData 转换再写回画布');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    canvas.getContext('2d').putImageData(image, 0, 0);
    return new app.Actions.Update_layer_image_action(canvas, layerId);
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
    this.assets = new Map();
    this.assetToken = '';
    // 羽化/色彩匹配的首帧快照与已应用参数：只活在编辑器内，不进图层字段、不进 read_state。
    this.pixelBases = new Map();
    this.pixelApplied = new Map();
    // 最近一次纯像素动作的事实（如自动去背景的覆盖率），只读回给调用方核对，不进图层字段。
    this.lastPixelOp = null;
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
        composition: layer.composition,
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

  /** 全分辨率逐字节 FNV-1a；同步快路径与分块异步路径共用，保证两者结果完全一致。 */
  hashPixels(data, hash = 0xcbf29ce484222325n) {
    for (let index = 0; index < data.length; index += 1) {
      hash ^= BigInt(data[index]);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash;
  }

  /** 图层像素字节数：决定走同步快路径还是分块异步路径。 */
  layerByteLength(layer) {
    const width = Math.max(1, Math.round(layer.width || layer.width_original || 1));
    const height = Math.max(1, Math.round(layer.height || layer.height_original || 1));
    return width * height * 4;
  }

  /** 计算并缓存一个图层的全分辨率像素摘要；**绝不缩小采样**。 */
  computePixelDigest(layer) {
    const key = String(layer.id);
    const link = layer.link || null;
    const size = `${layer.width || 0}x${layer.height || 0}`;
    const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
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
          digest = `pixels:${this.hashPixels(image.data).toString(16).padStart(16, '0')}`;
        }
      } catch (_) { digest = 'pixels:unreadable'; }
    }
    const timeMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - started);
    this.digestTimeMs = Math.max(this.digestTimeMs || 0, timeMs);
    this.pixelDigestCache.set(key, { link, size, mutation: this.pixelMutation, digest, timeMs });
    return digest;
  }

  /** 分块版：字节顺序与同步版完全一致，只是每若干行让出主线程。 */
  async computePixelDigestChunked(layer) {
    const key = String(layer.id);
    const link = layer.link || null;
    const size = `${layer.width || 0}x${layer.height || 0}`;
    const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
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
          const data = ctx.getImageData(0, 0, width, height).data;
          const stride = width * 4;
          const rowsPerChunk = Math.max(1, Math.min(256, Math.floor(1_000_000 / stride) || 1));
          let hash = 0xcbf29ce484222325n;
          this.digestBusy = true;
          for (let row = 0; row < height; row += rowsPerChunk) {
            hash = this.hashPixels(data.subarray(row * stride, Math.min(data.length, (row + rowsPerChunk) * stride)), hash);
            // 让出主线程；没有 setTimeout 的环境（Node 测试桩）退化为微任务，不改变哈希结果。
            await new Promise(resolve => (typeof setTimeout === 'function' ? setTimeout(resolve, 0) : resolve()));
          }
          this.digestBusy = false;
          digest = `pixels:${hash.toString(16).padStart(16, '0')}`;
        }
      } catch (_) { digest = 'pixels:unreadable'; this.digestBusy = false; }
    }
    const timeMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - started);
    this.digestTimeMs = Math.max(this.digestTimeMs || 0, timeMs);
    this.pixelDigestCache.set(key, { link, size, mutation: this.pixelMutation, digest, timeMs });
    return digest;
  }

  /** 取缓存摘要；小图缺失时现场同步补算，大图未就绪则明确失败（不返回占位值）。 */
  layerPixelDigest(layer) {
    const key = String(layer.id);
    const cache = this.pixelDigestCache.get(key);
    const size = `${layer.width || 0}x${layer.height || 0}`;
    if (cache && cache.link === (layer.link || null) && cache.size === size && cache.mutation === this.pixelMutation) return cache.digest;
    if (this.layerByteLength(layer) > 4_000_000) throw this.error('DIGEST_TIMEOUT', '该图层像素摘要需要异步计算，请稍后重试');
    return this.computePixelDigest(layer);
  }

  /** 写操作/读状态前把摘要算完：小图同步、大图分块，算不出来就抛错。 */
  async prepareDigest() {
    for (const layer of config.layers) {
      const cache = this.pixelDigestCache.get(String(layer.id));
      const size = `${layer.width || 0}x${layer.height || 0}`;
      const fresh = cache && cache.link === (layer.link || null) && cache.size === size && cache.mutation === this.pixelMutation;
      if (fresh) continue;
      if (this.layerByteLength(layer) <= 4_000_000) this.computePixelDigest(layer);
      else await this.computePixelDigestChunked(layer);
    }
  }

  /** 内容摘要（同步字符串）；算不出来就抛 DIGEST_TIMEOUT，绝不返回 Promise 或 {}。 */
  /**
   * 只测量、不绘制：调用方看不见画布，只能靠数字排版。
   * 给 maxWidth 时返回能放进这个宽度的最大字号（fittedSize），不小于 8px。
   */
  /**
   * 只测量、不修改：在**降采样**合成图上算曝光/裁切/偏色/清晰度，外加图层级体检。
   * 目的让看不见画布的调用方能"量一遍再改"，而不是凭感觉宣称改好了。
   * 采样上限 320px（长边），所以大图也不会卡主线程。
   */
  analyzeDocument(request = {}) {
    const maxSide = Number.isSafeInteger(request.maxSide) ? Math.min(640, Math.max(64, request.maxSide)) : 320;
    const W = Math.max(1, Math.round(config.WIDTH || 1));
    const H = Math.max(1, Math.round(config.HEIGHT || 1));
    const scale = Math.min(1, maxSide / Math.max(W, H));
    const sw = Math.max(1, Math.round(W * scale));
    const sh = Math.max(1, Math.round(H * scale));
    const canvas = document.createElement('canvas');
    canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw this.error('EDITOR_ERROR', '当前环境无法合成画布');
    if (typeof ctx.getImageData !== 'function') throw this.error('EDITOR_ERROR', '当前环境无法读取像素');
    // 先把整幅合成画到一张全尺寸临时画布，再缩到采样尺寸：直接缩放转换会比逐层缩放稳。
    const full = this.compositeCanvas();
    ctx.drawImage(full, 0, 0, sw, sh);
    const { data } = ctx.getImageData(0, 0, sw, sh);

    const histogram = new Array(8).fill(0);
    let sum = 0, sumR = 0, sumG = 0, sumB = 0, shadows = 0, highlights = 0;
    const grey = new Float32Array(sw * sh);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3] / 255;
      // 透明区域不计入曝光统计，否则空画布会被算成"全黑"。
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      grey[p] = luma;
      if (a < 0.05) continue;
      sum += luma; sumR += r; sumG += g; sumB += b;
      histogram[Math.min(7, Math.floor(luma / 32))] += 1;
      if (luma <= 4) shadows += 1;
      if (luma >= 251) highlights += 1;
    }
    const counted = histogram.reduce((a, b) => a + b, 0);
    const denom = counted || 1;

    // Laplacian 方差：在灰度采样上算，衡量边缘能量（糊/锐）。
    let lapSum = 0, lapSq = 0, lapCount = 0;
    for (let y = 1; y < sh - 1; y += 1) {
      for (let x = 1; x < sw - 1; x += 1) {
        const p = y * sw + x;
        const lap = 4 * grey[p] - grey[p - 1] - grey[p + 1] - grey[p - sw] - grey[p + sw];
        lapSum += lap; lapSq += lap * lap; lapCount += 1;
      }
    }
    const lapMean = lapCount ? lapSum / lapCount : 0;
    const lapVariance = lapCount ? lapSq / lapCount - lapMean * lapMean : 0;

    const layers = config.layers || [];
    const offCanvas = [];
    const zeroSize = [];
    const textOverflow = [];
    const textContrast = [];
    const upscaled = [];
    const scaleX = sw / W, scaleY = sh / H;
    const lumaAt = (x, y) => {
      const i = (y * sw + x) * 4;
      if (i < 0 || i + 3 >= data.length) return null;
      if (data[i + 3] < 13) return null;   // 透明像素不参与，否则"没背景"会被算成黑
      return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    };
    for (const layer of layers) {
      if (layer.visible === false) continue;
      const w = Number(layer.width) || 0, h = Number(layer.height) || 0;
      if (w < 1 || h < 1) { zeroSize.push(String(layer.id)); continue; }
      const x = Number(layer.x) || 0, y = Number(layer.y) || 0;
      if (x < 0 || y < 0 || x + w > W + 1 || y + h > H + 1) offCanvas.push(String(layer.id));
      // 位图被放大：链接画布的自然尺寸小于版面尺寸，成品会发虚。
      if (layer.link && Number(layer.link.width) > 0 && w > Number(layer.link.width) * 1.05) {
        upscaled.push({ id: String(layer.id), natural: Number(layer.link.width), scaled: Math.round(w) });
      }
      if (layer.type === 'text') {
        const text = textOf(layer);
        if (text) {
          try {
            const measured = this.measureText({ text, style: { size: layer.params?.size ?? 24, family: layer.data?.[0]?.[0]?.meta?.family } });
            if (measured.width > w + 1 || x + measured.width > W + 1) textOverflow.push({ id: String(layer.id), width: Math.round(measured.width) });
          } catch { /* 字体没就绪就不算这一项，不编数字 */ }
        }
        // 文字与背景对比：只取文字框**外圈**的背景像素，和文字声明的颜色比。
        const fill = layer.data?.[0]?.[0]?.meta?.fill_color;
        if (typeof fill === 'string' && /^#[0-9a-f]{6}$/i.test(fill)) {
          const box = {
            x0: Math.max(0, Math.round(x * scaleX)), y0: Math.max(0, Math.round(y * scaleY)),
            x1: Math.min(sw, Math.round((x + w) * scaleX)), y1: Math.min(sh, Math.round((y + h) * scaleY)),
          };
          const pad = 4;
          let sum = 0, count = 0;
          for (let py = Math.max(0, box.y0 - pad); py < Math.min(sh, box.y1 + pad); py += 1) {
            for (let pxx = Math.max(0, box.x0 - pad); pxx < Math.min(sw, box.x1 + pad); pxx += 1) {
              const inside = pxx >= box.x0 && pxx < box.x1 && py >= box.y0 && py < box.y1;
              if (inside) continue;
              const luma = lumaAt(pxx, py);
              if (luma === null) continue;
              sum += luma; count += 1;
            }
          }
          if (count > 0) {
            const bgLuma = sum / count;
            const rr = parseInt(fill.slice(1, 3), 16), gg = parseInt(fill.slice(3, 5), 16), bb = parseInt(fill.slice(5, 7), 16);
            const textLuma = (0.2126 * rr + 0.7152 * gg + 0.0722 * bb) / 255;
            const contrast = Math.abs(bgLuma - textLuma);
            if (contrast < 0.25) textContrast.push({ id: String(layer.id), contrast: Number(contrast.toFixed(3)), textLuma: Number(textLuma.toFixed(3)), backgroundLuma: Number(bgLuma.toFixed(3)) });
          }
        }
      }
    }

    return {
      width: W, height: H, sampledWidth: sw, sampledHeight: sh,
      luminance: { mean: Number((sum / denom / 255).toFixed(4)), histogram: histogram.map(value => Number((value / denom).toFixed(4))) },
      clipping: { shadows: Number((shadows / denom).toFixed(4)), highlights: Number((highlights / denom).toFixed(4)) },
      colorCast: {
        r: Number((sumR / denom).toFixed(1)), g: Number((sumG / denom).toFixed(1)), b: Number((sumB / denom).toFixed(1)),
        spread: Number((Math.max(sumR, sumG, sumB) / denom - Math.min(sumR, sumG, sumB) / denom).toFixed(1)),
      },
      sharpness: { laplacianVariance: Number(lapVariance.toFixed(2)) },
      layers: { total: layers.length, visible: layers.filter(layer => layer.visible !== false).length, offCanvas, zeroSize, textOverflow, textContrast, upscaled },
      opaqueRatio: Number((counted / (sw * sh)).toFixed(4)),
    };
  }

  /**
   * 缩略预览：返回降采样后的 PNG data URL（只读，不改画布、不推进 revision）。
   * 上限 256 KB，超了就明确报错让调用方降低 maxWidth，而不是悄悄截断。
   */
  previewPng(request = {}) {
    const maxWidth = Number.isSafeInteger(request.maxWidth) ? Math.min(1024, Math.max(64, request.maxWidth)) : 640;
    const full = this.compositeCanvas();
    const scale = Math.min(1, maxWidth / Math.max(1, full.width));
    const width = Math.max(1, Math.round(full.width * scale));
    const height = Math.max(1, Math.round(full.height * scale));
    const small = document.createElement('canvas');
    small.width = width; small.height = height;
    const ctx = small.getContext('2d');
    if (!ctx) throw this.error('EDITOR_ERROR', '当前环境无法生成预览');
    ctx.drawImage(full, 0, 0, width, height);
    // 可选蒙版叠加：把"这次会改到哪块"画成半透明色块，避免改完才发现动错了地方。
    const overlayInfo = this.previewOverlay(request.overlay, ctx, scale, width, height);
    // 可选坐标网格：按源图像素每 100 画一条线并标注坐标，方便调用方把"位置"对上数字。
    if (request.grid) {
      const stepSource = 100;
      const stepScaled = Math.max(8, Math.round(stepSource * scale));
      ctx.save();
      ctx.strokeStyle = 'rgba(255,0,0,0.55)';
      ctx.fillStyle = 'rgba(255,0,0,0.85)';
      ctx.lineWidth = 1;
      ctx.font = '9px monospace';
      for (let gx = stepScaled; gx < width; gx += stepScaled) {
        ctx.beginPath(); ctx.moveTo(gx + 0.5, 0); ctx.lineTo(gx + 0.5, height); ctx.stroke();
        ctx.fillText(String(Math.round(gx / scale)), gx + 2, 9);
      }
      for (let gy = stepScaled; gy < height; gy += stepScaled) {
        ctx.beginPath(); ctx.moveTo(0, gy + 0.5); ctx.lineTo(width, gy + 0.5); ctx.stroke();
        ctx.fillText(String(Math.round(gy / scale)), 2, gy - 2);
      }
      ctx.restore();
    }
    const dataUrl = small.toDataURL('image/png');
    const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    if (bytes > 256 * 1024) throw this.error('PREVIEW_TOO_LARGE', `预览 ${Math.round(bytes / 1024)} KB 超过 256 KB，请调低 maxWidth`);
    return { dataUrl, width, height, bytes, ...(overlayInfo ? { overlay: overlayInfo } : {}) };
  }

  /**
   * 预览叠加层：把蒙版（或当前选区）画成半透明色块。
   * 只影响预览图，不改文档、不推进 revision——目的是让"改到哪块"在执行前就看得见。
   */
  previewOverlay(overlay, ctx, scale, width, height) {
    if (!overlay) return null;
    const source = overlay.layerId !== undefined ? this.get_layer_for_preview(overlay.layerId) : null;
    const selection = !source && overlay.selection !== false ? this.readSelectionRect() : null;
    if (!source && !selection) return null;

    const tint = typeof overlay.color === 'string' && /^#[0-9a-f]{6}$/i.test(overlay.color) ? overlay.color : '#ff00ff';
    const alpha = Number.isFinite(Number(overlay.opacity)) ? Math.max(0.05, Math.min(0.85, Number(overlay.opacity))) : 0.35;
    const scratch = document.createElement('canvas');
    scratch.width = width; scratch.height = height;
    const sctx = scratch.getContext('2d');
    if (source && source.link) {
      const sw = Number(source.width) || 1, sh = Number(source.height) || 1;
      sctx.drawImage(source.link_canvas != null ? source.link_canvas : source.link, Math.round((source.x || 0) * scale), Math.round((source.y || 0) * scale), Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
    } else if (selection) {
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(Math.round(selection.x * scale), Math.round(selection.y * scale), Math.max(1, Math.round(selection.width * scale)), Math.max(1, Math.round(selection.height * scale)));
    }
    // 用蒙版的 alpha 当形状：先把形状留下，再整体染成提示色。
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = tint;
    sctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
    const box = source
      ? { x: Math.round(source.x || 0), y: Math.round(source.y || 0), width: Math.round(source.width || 0), height: Math.round(source.height || 0), kind: 'layer', layerId: String(source.id) }
      : { x: Math.round(selection.x), y: Math.round(selection.y), width: Math.round(selection.width), height: Math.round(selection.height), kind: 'selection' };
    return { ...box, color: tint, opacity: alpha, scale: Number(scale.toFixed(4)) };
  }

  /** read_state 之外的内部取层（预览叠加用），不存在返回 null。 */
  get_layer_for_preview(id) {
    const layers = config.layers || [];
    return layers.find(layer => String(layer.id) === String(id)) || null;
  }

  /** 把当前文档合成到一张全尺寸画布（只读，不改任何图层）。 */
  compositeCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(config.WIDTH || 1));
    canvas.height = Math.max(1, Math.round(config.HEIGHT || 1));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw this.error('EDITOR_ERROR', '当前环境无法合成画布');
    app.Layers.convert_layers_to_canvas(ctx, null, false);
    return canvas;
  }

  measureText(request) {
    const text = String(request?.text ?? '');
    if (!text.length || text.length > 4000) throw this.error('INVALID_REQUEST', 'text 必须是 1..4000 字符');
    const style = plain(request?.style) ? request.style : {};
    const size = style.size === undefined ? 24 : Number(style.size);
    if (!Number.isFinite(size) || size < 1 || size > 1000) throw this.error('INVALID_REQUEST', 'style.size 必须是 1..1000');
    const maxWidth = request?.maxWidth === undefined ? null : Number(request.maxWidth);
    if (maxWidth !== null && (!Number.isFinite(maxWidth) || maxWidth < 1)) throw this.error('INVALID_REQUEST', 'maxWidth 必须是正数');
    const family = typeof style.family === 'string' && style.family ? style.family : null;
    const fontFor = value => `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${value}px ${family ? `"${family}", ` : ''}sans-serif`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.measureText !== 'function') throw this.error('EDITOR_ERROR', '当前环境无法测量文字');
    const lines = text.split('\n');
    const widthAt = value => {
      ctx.font = fontFor(value);
      let widest = 0;
      for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width);
      return widest;
    };
    const width = widthAt(size);
    const lineHeight = Math.round(size * 1.2);
    let fittedSize = size;
    if (maxWidth !== null && width > maxWidth + 0.5) {
      // 二分找能放下的最大字号；下界 8px，宁可小也不溢出。
      let lo = 8, hi = size;
      for (let step = 0; step < 20 && hi - lo > 0.5; step += 1) {
        const mid = (lo + hi) / 2;
        if (widthAt(mid) <= maxWidth + 0.5) lo = mid; else hi = mid;
      }
      fittedSize = Math.max(8, Math.floor(lo));
    }
    return { width: Math.round(width * 100) / 100, height: lineHeight * lines.length, lineCount: lines.length,
      lineHeight, size, fittedSize, maxWidth, fits: maxWidth === null ? null : widthAt(fittedSize) <= maxWidth + 0.5 };
  }

  contentDigestValue() {
    const digest = digestOf(this.documentState());
    if (typeof digest !== 'string' || !/^fnv1a64-/.test(digest)) throw this.error('DIGEST_TIMEOUT', '内容摘要不可用，请重试');
    return digest;
  }

  /** 只含元数据的状态（无像素摘要）：用于 revision 追踪，避免摘要异步算完导致版本跳变。 */
  metadataState() {
    return {
      width: config.WIDTH, height: config.HEIGHT,
      layers: config.layers.map(layer => ({
        id: layer.id, name: layer.name, type: layer.type,
        x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotate: layer.rotate,
        visible: layer.visible, order: layer.order, opacity: layer.opacity, color: layer.color,
        composition: layer.composition,
        params: layer.params, filters: layer.filters,
        data: Array.isArray(layer.data) ? layer.data : null,
      })),
    };
  }

  fingerprint() {
    // revision 只追踪元数据：像素摘要依赖异步计算，放进指纹会让版本号随摘要算完而跳变。
    // 像素动作引发的版本推进由原生动作完成后的强制刷新负责。
    return stableStringify(this.metadataState());
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
      this.emitSelectionChanged();
      return result;
    });
    for (const [method, native] of [['undo_action', this.nativeUndo], ['redo_action', this.nativeRedo]]) {
      state[method] = () => this.enqueue(async () => {
        const before = state.action_history_index;
        await native();
        this.refreshRevision(before !== state.action_history_index);
        this.emitSelectionChanged();
      });
    }
    state.scrap_last_action = () => this.enqueue(async () => {
      if (!state.can_undo()) return;
      await this.nativeUndo();
      state.action_history.pop();
      this.refreshRevision(true);
      this.emitSelectionChanged();
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

  requestAssetToken() {
    if (this.assetToken) return Promise.resolve(this.assetToken);
    return new Promise((resolve, reject) => {
      const requestId = randomId();
      // 与高亮 TTL 同样的环境守卫：没有定时器的宿主（测试沙箱）不装超时，其余行为不变。
      const timeout = typeof setTimeout === 'function'
        ? setTimeout(() => { window.removeEventListener('message', onMessage); reject(this.error('ASSET_AUTH_UNAVAILABLE', '素材授权不可用，请重新连接编辑器')); }, 5000)
        : null;
      const onMessage = event => {
        if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== 'dsh.asset.token' || event.data.requestId !== requestId || typeof event.data.token !== 'string') return;
        if (timeout !== null && typeof clearTimeout === 'function') clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        this.assetToken = event.data.token; resolve(this.assetToken);
      };
      window.addEventListener('message', onMessage);
      window.parent.postMessage({ type: 'dsh.asset.token.request', requestId }, window.location.origin);
    });
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

  /**
   * 高亮只画描边：独立 overlay canvas（不进 config.layers、不进历史、不动 selection、不 bump revision）。
   * TTL 到期自动移除；没有可绘制的 DOM 时静默降级为"只记状态不画"，但回执仍如实给 matched/missing。
   */
  ensureHighlightOverlay() {
    if (this.highlightOverlay) return this.highlightOverlay;
    if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') return null;
    const host = document.createElement('div');
    host.setAttribute('data-dsh-highlight', 'overlay');
    host.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483000';
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    document.body.appendChild(host);
    this.highlightOverlay = { host, canvas };
    return this.highlightOverlay;
  }

  /** 按当前缩放/滚动把对象框换算成屏幕矩形（只读 view 状态）。 */
  highlightRects(objectIds) {
    const scale = Number(zoomView.getScale?.() ?? 1) || 1;
    const position = zoomView.getPosition?.() ?? { x: 0, y: 0 };
    const canvasNode = typeof document !== 'undefined' && document.querySelector ? document.querySelector('#canvas_minipaint') : null;
    const bounds = canvasNode && typeof canvasNode.getBoundingClientRect === 'function' ? canvasNode.getBoundingClientRect() : { left: 0, top: 0 };
    const wanted = new Set(objectIds.map(String));
    return config.layers.filter(layer => wanted.has(String(layer.id))).map(layer => ({
      id: String(layer.id),
      x: Math.round((bounds.left || 0) + (position.x || 0) + (Number(layer.x) || 0) * scale),
      y: Math.round((bounds.top || 0) + (position.y || 0) + (Number(layer.y) || 0) * scale),
      width: Math.max(1, Math.round((Number(layer.width) || 0) * scale)),
      height: Math.max(1, Math.round((Number(layer.height) || 0) * scale)),
    }));
  }

  paintHighlight() {
    const overlay = this.ensureHighlightOverlay();
    if (!overlay) return;
    const rects = this.highlightRects(this.highlightState?.objectIds || []);
    const ctx = overlay.canvas.getContext?.('2d');
    if (!ctx) return;
    overlay.canvas.width = Math.max(1, Math.round(overlay.host.ownerDocument?.defaultView?.innerWidth || 1920));
    overlay.canvas.height = Math.max(1, Math.round(overlay.host.ownerDocument?.defaultView?.innerHeight || 1080));
    ctx.clearRect?.(0, 0, overlay.canvas.width, overlay.canvas.height);
    ctx.strokeStyle = '#0071e3';
    ctx.lineWidth = 3;
    for (const rect of rects) ctx.strokeRect?.(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height);
  }

  clearHighlight() {
    if (this.highlightTimer && typeof clearTimeout === 'function') clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    this.highlightState = null;
    const overlay = this.highlightOverlay;
    if (overlay && overlay.host?.parentNode) overlay.host.parentNode.removeChild(overlay.host);
    this.highlightOverlay = null;
  }

  /** editor.highlight：只描边，绝不改文档。 */
  highlightObjects(request) {
    const ids = request && (request.objectIds ?? request.payload?.objectIds);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) {
      throw this.error('INVALID_REQUEST', '高亮需要 objectIds（1–200 个非空字符串）');
    }
    const ttlRaw = request?.ttlMs ?? request?.payload?.ttlMs;
    const ttl = Math.max(200, Math.min(5000, Number.isFinite(ttlRaw) ? ttlRaw : 2000));
    const existing = new Set(config.layers.map(layer => String(layer.id)));
    const matched = ids.map(String).filter(id => existing.has(id));
    const missing = ids.map(String).filter(id => !existing.has(id));
    this.highlightState = { objectIds: matched, ttlMs: ttl, until: Date.now() + ttl };
    this.paintHighlight();
    if (typeof setTimeout === 'function') {
      if (this.highlightTimer) clearTimeout(this.highlightTimer);
      this.highlightTimer = setTimeout(() => this.clearHighlight(), ttl);
    }
    return { ok: true, matched, missing };
  }

  /** selection_changed：只读通知，≥100ms 节流；不改任何状态，也不落盘。 */
  emitSelectionChanged(force = false) {
    const port = this.port;
    if (!port || typeof port.postMessage !== 'function') return;
    const now = Date.now();
    if (!force && this.selectionEmitAt && now - this.selectionEmitAt < 100) return;
    this.selectionEmitAt = now;
    const selected = config.layer ? String(config.layer.id) : null;
    port.postMessage({
      type: 'editor.selection_changed',
      editorInstanceId: this.editorInstanceId,
      revision: this.revision,
      selectedObjectIds: selected ? [selected] : [],
      objectKind: selected ? 'layer' : null,
      at: now,
    });
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
        // highlight 只画描边：不进 revision、不进历史、不改 selection。
        if (request.type === 'editor.highlight') return this.highlightObjects(request);
        if (request.type === 'editor.export_start') return this.exportStart(request);
        if (request.type === 'editor.export_status') {
          const item = this.exports.get(request.exportId);
          if (!item || item.documentId !== this.documentId) throw this.error('DOCUMENT_MISMATCH');
          return item;
        }
        if (request.type === 'editor.export_inpaint_inputs') return this.exportInpaintInputs(request);
        // 只测量不绘制：看不见画布的调用方靠它按数字排版。
        if (request.type === 'editor.measure_text') return this.measureText(request);
        // 只测量不修改：曝光/裁切/偏色/清晰度 + 图层体检。
        if (request.type === 'editor.analyze') return this.analyzeDocument(request);
        if (request.type === 'editor.preview_png') return this.previewPng(request);
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
        ...(layer.params?.dshMask ? { mask: { sourceLayerId: String(layer.params.dshMask.sourceLayerId), editable: true } } : {}),
        // 外观三元组要能被 read_state 看到，否则模型改完无法自我核对。
        opacity: layer.opacity ?? 100, blendMode: layer.composition || 'source-over',
        rotationDeg: layer.rotate || 0,
        // 只在真的应用过时出现；快照本身留在编辑器内部，模型看不到原始像素。
        ...(applied.feather ? { feather: applied.feather } : {}),
        ...(applied.colorMatch ? { colorMatch: applied.colorMatch } : {}),        ...(layer.type === 'text' ? { text: textOf(layer) } : {}) };
    });
    const selectedLayerId = config.layer ? String(config.layer.id) : null;
    const selectedLayer = layers.find(layer => layer.id === selectedLayerId) || null;
    const historyIndex = app.State.action_history_index;
    const historyLength = app.State.action_history.length;
    const top = this.lastAgentCommit;
    const currentDigest = this.contentDigestValue();
    const validTop = top && top.revision === this.revision && top.afterDigest === currentDigest && top.historyIndex === historyIndex && top.action === app.State.action_history[historyIndex - 1];
    const position = zoomView.getPosition();
    // A canvas that has not been laid out yet can still report a non-positive config size;
    // never publish a negative dimension to the Host state validator.
    const canvasWidth = Number.isFinite(config.WIDTH) ? Math.max(1, config.WIDTH) : 1;
    const canvasHeight = Number.isFinite(config.HEIGHT) ? Math.max(1, config.HEIGHT) : 1;
    const contentDigest = currentDigest;
    const selection = this.readSelectionRect();
    return { editorKind: 'image', editorInstanceId: this.editorInstanceId, documentId: this.documentId, revision: this.revision,
      // 只读快照：模型据此判断该用 selection: 还是显式 maskRect，不用盲猜坐标。
      selection: selection ? { x: selection.x, y: selection.y, width: selection.width, height: selection.height } : null,
      // 最近一次纯像素动作的事实（如自动去背景覆盖率），调用方据此核对效果，而不是听信回复。
      ...(this.lastPixelOp ? { lastPixelOp: this.lastPixelOp } : {}),
      // 内容摘要与视图态分开：选中/缩放不再算内容变化。
      contentDigest,
      viewState: this.viewState(),
      // deprecated：保留一版以稳住旧契约，值与 contentDigest 相同。
      stateDigest: contentDigest,
      // 诊断：像素摘要耗时；超过阈值只给非阻塞提示，算法不变、数值仍是精确值。
      digestTimeMs: this.digestTimeMs || 0,
      digestBusy: !!this.digestBusy,
      ...((this.digestTimeMs || 0) > 1500 ? { digestNotice: '该图层像素摘要耗时较长（仅供诊断，摘要仍为全分辨率精确值）' } : {}),
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
      // 写前先把像素摘要算完（大图分块让出主线程）；算不出来就失败，不进入写入。
      await this.prepareDigest();
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
      // 写后审计：像素动作后必须真正重算完，再返回 afterDigest，不能先返回再补。
      await this.prepareDigest();
      const afterDigest = this.contentDigestValue();
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

  async exportInpaintInputs(request) {
    if (request.documentId !== this.documentId) throw this.error('DOCUMENT_MISMATCH');
    const sourceLayerId = String(request.sourceLayerId || '');
    const maskLayerId = request.maskLayerId == null ? null : String(request.maskLayerId);
    const source = config.layers.find(layer => String(layer.id) === sourceLayerId);
    if (!source) throw this.error('LAYER_NOT_FOUND');
    if (source.type !== 'image' || source.is_vector) throw this.error('LAYER_NOT_RASTERIZED', '局部重绘需要栅格图片源图');
    const image = this.rasterizeLayer(source);
    let maskPixels;
    if (maskLayerId) {
      const mask = config.layers.find(layer => String(layer.id) === maskLayerId);
      if (!mask) throw this.error('LAYER_NOT_FOUND', '蒙版层不存在');
      if (mask.type !== 'image' || mask.is_vector) throw this.error('LAYER_NOT_RASTERIZED', '局部重绘蒙版必须是栅格图层');
      if (String(mask.params?.dshMask?.sourceLayerId) !== sourceLayerId) throw this.error('MASK_SOURCE_MISMATCH', '该蒙版没有绑定到所选源图');
      maskPixels = this.rasterizeLayer(mask);
    } else {
      const selection = this.readSelectionRect();
      if (!selection) throw this.error('NO_SELECTION', '请选择一个区域或选择一张绑定蒙版的图层');
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      const sx = image.width / Math.max(1, config.WIDTH), sy = image.height / Math.max(1, config.HEIGHT);
      ctx.fillRect(Math.round(selection.x * sx), Math.round(selection.y * sy), Math.max(1, Math.round(selection.width * sx)), Math.max(1, Math.round(selection.height * sy)));
      maskPixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // 外缘渐隐（选区较长边的 1/8）：模型才知道"边缘要往里收"，接缝才不会硬。
      const ops = await this.pixelOps();
      const radius = Math.max(1, Math.round(Math.max(selection.width, selection.height) / 8));
      maskPixels = ops.ensureImageData(ops.blurAlpha(maskPixels, Math.min(64, radius)));
    }
    if (image.width !== maskPixels.width || image.height !== maskPixels.height) throw this.error('INPAINT_MASK_SIZE_MISMATCH', '蒙版尺寸与源图不一致');
    const toPng = pixels => {
      const canvas = document.createElement('canvas'); canvas.width = pixels.width; canvas.height = pixels.height;
      canvas.getContext('2d').putImageData(pixels, 0, 0);
      return canvas.toDataURL('image/png');
    };
    return { documentId: this.documentId, revision: this.revision, sourceLayerId, maskLayerId, width: image.width, height: image.height,
      imageDataUrl: toPng(image), maskDataUrl: toPng(maskPixels) };
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

  /**
   * 蒙版参数解析：只做形状与取值域校验，像素留给 applyMaskToCanvas。
   *
   * 两种来源互斥：
   * - maskRef：layer:<id> / asset:<48 位 id> / 受限内联图 / "selection:"（当前选框）
   * - maskRect：{x,y,width,height} 的显式矩形（画布坐标），不依赖任何工具状态
   * 没有来源时不允许出现蒙版附属参数 —— 否则调用方会以为生效了，实际被静默忽略。
   */
  readMaskSpec(p) {
    const given = ['maskMode', 'maskInvert', 'featherPx'].filter(key => p[key] !== undefined);
    const hasRef = p.maskRef !== undefined;
    const hasRect = p.maskRect !== undefined;
    if (!hasRef && !hasRect) {
      if (given.length) throw this.error('INVALID_REQUEST', 'maskMode/maskInvert/featherPx 需要同时给 maskRef 或 maskRect');
      return null;
    }
    if (hasRef && hasRect) throw this.error('INVALID_REQUEST', 'maskRef 与 maskRect 只能给一个');
    if (p.maskInvert !== undefined && typeof p.maskInvert !== 'boolean') throw this.error('INVALID_REQUEST');
    const featherPx = p.featherPx === undefined ? 0 : p.featherPx;
    if (!Number.isSafeInteger(featherPx) || featherPx < 0 || featherPx > 64) throw this.error('INVALID_REQUEST', 'featherPx 必须是 0..64 的整数');
    if (hasRect) {
      const rect = p.maskRect;
      if (!plain(rect) || !keysOnly(rect, ['x', 'y', 'width', 'height'])) throw this.error('INVALID_REQUEST', 'maskRect 只接受 x/y/width/height');
      for (const key of ['x', 'y']) if (!Number.isSafeInteger(rect[key]) || rect[key] < -16384 || rect[key] > 16384) throw this.error('INVALID_REQUEST', `maskRect.${key} 必须是整数像素`);
      for (const key of ['width', 'height']) if (!Number.isSafeInteger(rect[key]) || rect[key] < 1 || rect[key] > 16384) throw this.error('INVALID_REQUEST', `maskRect.${key} 必须是 1..16384 的整数`);
      return { rect: { ...rect }, mode: p.maskMode ?? 'alpha', invert: p.maskInvert === true, featherPx };
    }
    if (typeof p.maskRef !== 'string' || !p.maskRef) throw this.error('INVALID_REQUEST');
    const isLayer = p.maskRef.startsWith('layer:');
    const isSelection = p.maskRef === 'selection:';
    if (!isLayer && !isSelection && !/^asset:[a-f0-9]{48}$/.test(p.maskRef) && !/^data:image\/(png|jpeg|webp);base64,/.test(p.maskRef)) {
      throw this.error('INVALID_REQUEST', 'maskRef 只支持 layer:<id>、selection:、asset:<48 位 id> 或受限内联图');
    }
    const mode = p.maskMode === undefined ? (isLayer || isSelection ? 'alpha' : 'luminance') : p.maskMode;
    if (!['luminance', 'alpha'].includes(mode)) throw this.error('INVALID_REQUEST', 'maskMode 只能是 luminance 或 alpha');
    return { ref: p.maskRef, mode, invert: p.maskInvert === true, featherPx };
  }

  /**
   * 当前选框（画布坐标），没有就是 null。
   * 只有「选择工具」激活时才可信：该工具切走时 on_leave 会清空选区（见 config.TOOLS 的 on_leave）。
   * 这里只读全局 Base_selection，不去构造工具单例，避免读状态产生副作用。
   */
  readSelectionRect() {
    try {
      if (config.TOOL?.name !== 'selection') return null;
      const data = app.Layers?.Base_selection?.get_selection?.();
      if (!data) return null;
      const rect = { x: data.x, y: data.y, width: data.width, height: data.height };
      if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
      if (rect.width < 1 || rect.height < 1) return null;
      return rect;
    } catch (_) {
      return null;
    }
  }

  /** 把任意合法 sourceRef 解码成同尺寸画布；来源统一后，蒙版与 fit 只面对一种输入。 */
  async decodeSourceCanvas(sourceRef) {
    if (typeof sourceRef !== 'string' || !sourceRef) throw this.error('INVALID_REQUEST');
    if (sourceRef.startsWith('layer:')) {
      const layer = config.layers.find(item => String(item.id) === sourceRef.slice('layer:'.length));
      if (!layer) throw this.error('LAYER_NOT_FOUND');
      const image = this.rasterizeLayer(layer);
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      canvas.getContext('2d').putImageData(image, 0, 0);
      return { canvas, width: canvas.width, height: canvas.height };
    }
    let dataUrl;
    if (sourceRef.startsWith('asset:')) {
      const assetId = sourceRef.slice('asset:'.length);
      if (!/^[a-f0-9]{48}$/.test(assetId)) throw this.error('INVALID_REQUEST', 'asset id format is invalid');
      const assetToken = await this.requestAssetToken();
      const response = await fetch(`/media-image/assets/${assetId}`, { credentials: 'same-origin', headers: { Authorization: `Bearer ${assetToken}`, 'x-dsh-media-relay': '1', 'x-dsh-media-asset': '1' } });
      if (!response.ok) throw this.error(response.status === 404 ? 'ASSET_NOT_FOUND' : 'ASSET_FETCH_FAILED', response.status === 404 ? '素材不存在或已过期，请重新上传' : '素材读取失败，请重试');
      const blob = await response.blob();
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(this.error('ASSET_FETCH_FAILED', '素材读取失败，请重试'));
        reader.readAsDataURL(blob);
      });
    } else if (/^data:image\/(png|jpeg|webp);base64,/.test(sourceRef)) {
      dataUrl = sourceRef;
    } else {
      throw this.error('INVALID_REQUEST');
    }
    const image = new Image();
    const loaded = await new Promise((resolve, reject) => {
      image.onload = () => resolve(true);
      image.onerror = () => reject(this.error('INVALID_IMAGE_DATA', '图片无法解码'));
      image.src = dataUrl;
    });
    if (!loaded || !image.naturalWidth || !image.naturalHeight) throw this.error('INVALID_IMAGE_DATA');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return { canvas, width: canvas.width, height: canvas.height, dataUrl };
  }

  /** 蒙版来源统一成"一张可缩放的画布"：矩形/选区在画布坐标系里绘制，其余按引用解码。 */
  async maskCanvasFor(spec) {
    const rect = spec.rect ?? (spec.ref === 'selection:' ? this.readSelectionRect() : null);
    if (spec.ref === 'selection:' && !rect) {
      throw this.error('NO_SELECTION', '当前没有选区：请先用选择工具拉一个选框（保持该工具激活），或改用 maskRect 给显式矩形');
    }
    if (rect) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, config.WIDTH || 1);
      canvas.height = Math.max(1, config.HEIGHT || 1);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      return canvas;
    }
    const decoded = await this.decodeSourceCanvas(spec.ref);
    return decoded.canvas;
  }

  /** 按蒙版裁剪 alpha：源图颜色不变，只在蒙版为黑处挖空。返回新画布，不改动输入。 */
  async applyMaskToCanvas(decoded, spec) {
    const maskSource = await this.maskCanvasFor(spec);
    const { width, height } = decoded;
    const scaled = document.createElement('canvas');
    scaled.width = width; scaled.height = height;
    const maskCtx = scaled.getContext('2d');
    maskCtx.drawImage(maskSource, 0, 0, width, height);
    const sourcePixels = decoded.canvas.getContext('2d').getImageData(0, 0, width, height);
    const maskPixels = maskCtx.getImageData(0, 0, width, height);
    const ops = await this.pixelOps();
    const masked = ops.applyMask(sourcePixels, maskPixels, { mode: spec.mode, invert: spec.invert, featherPx: spec.featherPx });
    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    out.getContext('2d').putImageData(ops.ensureImageData(masked), 0, 0);
    return out;
  }

  /**
   * 字体：受控加载已登记的字体文件。
   * 用带令牌的 fetch 取字节再转 blob URL —— CSS 的 @font-face 请求不带自定义头，
   * 直接给 FontFace 一个需要鉴权的 URL 会 403，所以先取字节、再喂给 FontFace。
   */
  readFontSpec(p) {
    if (p.fontUrl === undefined) return null;
    if (typeof p.fontUrl !== 'string' || !/^\/media-image\/fonts\/[a-f0-9]{48}$/.test(p.fontUrl)) {
      throw this.error('INVALID_REQUEST', 'fontUrl 必须是 /media-image/fonts/<48 位 id>');
    }
    return p.fontUrl;
  }

  async ensureFontLoaded(family, fontUrl) {
    const key = `${family}\u0000${fontUrl}`;
    this.loadedFonts ??= new Map();
    if (this.loadedFonts.has(key)) return;
    if (typeof FontFace !== 'function' || !document?.fonts?.add) throw this.error('FONT_UNSUPPORTED', '当前浏览器不支持加载自定义字体');
    const token = await this.requestAssetToken();
    const response = await fetch(fontUrl, { credentials: 'same-origin', headers: { Authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1', 'x-dsh-media-asset': '1' } });
    if (!response.ok) throw this.error(response.status === 404 ? 'FONT_NOT_FOUND' : 'FONT_FETCH_FAILED', '字体文件读取失败，请重新登记');
    const blobUrl = URL.createObjectURL(await response.blob());
    const face = new FontFace(family, `url(${blobUrl})`);
    await face.load();
    document.fonts.add(face);
    this.loadedFonts.set(key, blobUrl);
  }

  async prepare(command) {
    if (!keysOnly(command, ['type', 'payload']) || !COMMANDS.has(command.type)) throw this.error('UNSUPPORTED_COMMAND');
    const p = command.payload;
    if (command.type === 'history.batch') {
      // 批量：一串命令合成**一条**历史记录（Bundle_action 自带"任一步失败就回滚已做的"）。
      // 里面不允许再嵌套批量或历史命令——否则撤销语义会变得没法解释。
      if (!keysOnly(p, ['steps', 'name'])) throw this.error('INVALID_REQUEST');
      const steps = p.steps;
      if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12) throw this.error('INVALID_REQUEST', 'steps 必须是 1..12 条命令');
      const prepared = [];
      for (const [index, step] of steps.entries()) {
        if (!plain(step) || !keysOnly(step, ['type', 'payload']) || typeof step.type !== 'string' || !COMMANDS.has(step.type)) {
          throw this.error('INVALID_REQUEST', `step ${index + 1} 不是有效命令`);
        }
        if (step.type === 'history.batch' || step.type === 'history.undo' || step.type === 'history.redo') {
          throw this.error('INVALID_REQUEST', `step ${index + 1}：批量里不能包含历史命令`);
        }
        // 复用单条命令的校验与动作构造；这一步只构造、不动画布。
        prepared.push(await this.prepare({ type: step.type, payload: step.payload ?? {} }));
      }
      const actions = prepared.map(item => item.action);
      const label = typeof p.name === 'string' && p.name ? p.name.slice(0, 80) : `批量 ${actions.length} 步`;
      return {
        action: new app.Actions.Bundle_action('dsh_batch', label, actions),
        ids: () => prepared.flatMap(item => item.ids()),
      };
    }
    if (command.type === 'history.undo' || command.type === 'history.redo') {
      if (!keysOnly(p, command.type === 'history.undo' ? ['targetCommandId', 'afterDigest'] : [])) throw this.error('INVALID_REQUEST');
      if ((p.targetCommandId === undefined) !== (p.afterDigest === undefined)) throw this.error('INVALID_REQUEST');
      if (p.targetCommandId !== undefined) {
        const top = this.lastAgentCommit;
        if (!top || p.targetCommandId !== top.commandId || p.afterDigest !== top.afterDigest || top.revision !== this.revision || top.historyIndex !== app.State.action_history_index || top.action !== app.State.action_history[app.State.action_history_index - 1] || digestOf(this.documentState()) !== top.afterDigest) throw this.error('HISTORY_CONFLICT', '已有后续修改，不能单独撤销这一步');
      }
      return { history: command.type.split('.')[1], ids: () => [] };
    }
    if (command.type === 'layer.add_image') {
      if (!keysOnly(p, ['sourceRef', 'x', 'y', 'width', 'height', 'fit', 'name', 'maskRef', 'maskRect', 'maskMode', 'maskInvert', 'featherPx'])) throw this.error('INVALID_REQUEST');
      if ((p.width === undefined) !== (p.height === undefined)) throw this.error('INVALID_REQUEST');
      const x = p.x === undefined ? 0 : p.x;
      const y = p.y === undefined ? 0 : p.y;
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw this.error('INVALID_REQUEST');
      const name = p.name === undefined ? 'AI 生成图层' : p.name;
      if (typeof name !== 'string' || name.length > 120) throw this.error('INVALID_REQUEST');
      const fit = p.fit ?? 'contain';
      if (!['stretch', 'contain', 'cover'].includes(fit)) throw this.error('INVALID_REQUEST');
      const maskSpec = this.readMaskSpec(p);
      // 先解码成画布：来源统一化之后，蒙版合成与 fit 计算都只面对同一种输入。
      const decoded = await this.decodeSourceCanvas(p.sourceRef);
      let width = p.width ?? decoded.width;
      let height = p.height ?? decoded.height;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) throw this.error('INVALID_REQUEST');
      // contain/cover 只在显式给了框时改写尺寸；这里用局部变量，不能碰还没构造出来的 layer。
      if (fit !== 'stretch' && p.width !== undefined) {
        const sourceRatio = decoded.width / decoded.height;
        const targetRatio = width / height;
        if (fit === 'contain' && sourceRatio !== targetRatio) {
          const scale = Math.min(width / decoded.width, height / decoded.height);
          width = Math.max(1, Math.round(decoded.width * scale));
          height = Math.max(1, Math.round(decoded.height * scale));
        } else if (fit === 'cover' && sourceRatio !== targetRatio) {
          const scale = Math.max(width / decoded.width, height / decoded.height);
          width = Math.max(width, Math.round(decoded.width * scale));
          height = Math.max(height, Math.round(decoded.height * scale));
        }
      }
      // layer:<id> 绑定成**活蒙版**（params.dshMask）：合成时读蒙版层，之后你改蒙版层结果就跟着变。
      // 其它来源（selection:/asset:/data:/maskRect）没有可编辑对象，只能烤进像素。
      const liveMaskSource = (maskSpec && typeof maskSpec.ref === 'string' && maskSpec.ref.startsWith('layer:'))
        ? maskSpec.ref.slice('layer:'.length).trim() : null;
      const canvas = (maskSpec && !liveMaskSource) ? await this.applyMaskToCanvas(decoded, maskSpec) : null;
      // 无蒙版时透传原始 dataUrl，避免对大图做无谓的二次编解码；只有真改了像素才重编码。
      const data = canvas ? canvas.toDataURL('image/png') : (decoded.dataUrl || decoded.canvas.toDataURL('image/png'));
      const layer = { name, type: 'image', data, x, y, width, height, width_original: width, height_original: height, visible: true, opacity: 100, rotate: 0 };
      if (liveMaskSource) {
        layer.params = { dshMask: { sourceLayerId: liveMaskSource, mode: maskSpec.mode, invert: maskSpec.invert, featherPx: maskSpec.featherPx } };
      }
      const action = new app.Actions.Insert_layer_action(layer, false);
      return { action, ids: () => [String(action.inserted_layer_id)] };
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
      const action = this.imageAction(ops.ensureImageData(output), layer.id);
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
    if (command.type === 'layer.remove_background') {
      // 自动去背景：不需要坐标，也不依赖外部模型。取边界主色后按连通域擦除；
      // 覆盖率过小/过大都中止，避免"什么都没去掉"或"把整张图吃掉"。
      if (!keysOnly(p, ['layerId', 'tolerance', 'featherPx'])) throw this.error('INVALID_REQUEST');
      const layer = config.layers.find(item => String(item.id) === p.layerId);
      if (!layer) throw this.error('LAYER_NOT_FOUND');
      if (layer.type !== 'image' || layer.is_vector) throw this.error('LAYER_NOT_RASTERIZED', '自动去背景需要非矢量的图片图层');
      const tolerance = p.tolerance === undefined ? 8 : p.tolerance;
      const featherPx = p.featherPx === undefined ? 0 : p.featherPx;
      if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw this.error('INVALID_REQUEST');
      if (!Number.isSafeInteger(featherPx) || featherPx < 0 || featherPx > 64) throw this.error('INVALID_REQUEST');
      const ops = await this.pixelOps();
      const current = this.rasterizeLayer(layer);
      const result = ops.removeFlatBackground(current, { tolerance, featherPx });
      if (result.coverage === 0) throw this.error('BACKGROUND_NOT_DETECTED', '边界背景与商品颜色接近或背景不纯，未擦除任何像素；请换一张白底/纯色底图，或配置 AI 抠图服务');
      if (result.coverage >= 0.999) throw this.error('BACKGROUND_REMOVAL_TOO_MUCH', '自动识别会擦掉几乎整张图，已中止；请降低 tolerance 或改用 AI 抠图服务');
      const key = String(layer.id);
      const action = this.imageAction(ops.ensureImageData(result.image), layer.id);
      const nativeDo = action.do.bind(action);
      const nativeUndo = action.undo.bind(action);
      const owner = this;
      const stats = { command: 'layer.remove_background', coverage: Number(result.coverage.toFixed(4)), background: result.background, bbox: result.bbox };
      action.do = async () => { await nativeDo(); owner.pixelMutation += 1; owner.lastPixelOp = stats; };
      action.undo = async () => { await nativeUndo(); owner.pixelMutation += 1; owner.lastPixelOp = null; };
      return { action, ids: () => [key] };
    }
    if (command.type === 'layer.magic_erase') {
      // 人类用魔棒的做法：在某点按下 → 只擦掉与它同色且相连的那一片。
      // 坐标是图层本地像素；每次只影响一个连通区域，因此不会从边缘一路啃进商品。
      if (!keysOnly(p, ['layerId', 'x', 'y', 'tolerance', 'contiguous'])) throw this.error('INVALID_REQUEST');
      const layer = config.layers.find(item => String(item.id) === p.layerId);
      if (!layer) throw this.error('LAYER_NOT_FOUND');
      if (layer.type !== 'image' || layer.is_vector) throw this.error('LAYER_NOT_RASTERIZED', '魔棒擦除需要非矢量的图片图层');
      const tolerance = p.tolerance === undefined ? 10 : p.tolerance;
      const contiguous = p.contiguous === undefined ? true : p.contiguous;
      if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw this.error('INVALID_REQUEST');
      if (typeof contiguous !== 'boolean') throw this.error('INVALID_REQUEST');
      const ops = await this.pixelOps();
      const current = this.rasterizeLayer(layer);
      const x = p.x, y = p.y;
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= current.width || y >= current.height) throw this.error('INVALID_REQUEST', 'x/y 必须落在图层像素范围内');
      const result = ops.magicErase(current, { x, y, tolerance, contiguous });
      if (!result.erased) throw this.error('MAGIC_ERASE_NO_MATCH', `该点颜色 ${JSON.stringify(result.seedColor)} 在容差 ${tolerance} 内没有可擦除的相连区域`);
      const key = String(layer.id);
      const action = this.imageAction(ops.ensureImageData(result.image), layer.id);
      const nativeDo = action.do.bind(action);
      const nativeUndo = action.undo.bind(action);
      const owner = this;
      const stats = { command: 'layer.magic_erase', coverage: Number(result.coverage.toFixed(4)), erased: result.erased, seed: { x, y }, tolerance };
      action.do = async () => { await nativeDo(); owner.pixelMutation += 1; owner.lastPixelOp = stats; };
      action.undo = async () => { await nativeUndo(); owner.pixelMutation += 1; owner.lastPixelOp = null; };
      return { action, ids: () => [key] };
    }
    if (command.type === 'layer.add_mask_layer') {
      // 生成一张"蒙版图层"：白色=保留、透明=挖掉。它是普通图层，人可以继续用画笔修，
      // 原图完全不动，后续用 layer.add_image + maskRef=layer:<蒙版层> 得到抠图结果。
      if (!keysOnly(p, ['sourceLayerId', 'mode', 'tolerance', 'featherPx', 'name'])) throw this.error('INVALID_REQUEST');
      const source = config.layers.find(item => String(item.id) === p.sourceLayerId);
      if (!source) throw this.error('LAYER_NOT_FOUND');
      if (source.type !== 'image' || source.is_vector) throw this.error('LAYER_NOT_RASTERIZED', '生成蒙版需要非矢量的图片图层');
      const mode = p.mode === undefined ? 'subject' : p.mode;
      if (mode !== 'subject' && mode !== 'background') throw this.error('INVALID_REQUEST');
      const tolerance = p.tolerance === undefined ? 12 : p.tolerance;
      const featherPx = p.featherPx === undefined ? 1 : p.featherPx;
      if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw this.error('INVALID_REQUEST');
      if (!Number.isSafeInteger(featherPx) || featherPx < 0 || featherPx > 64) throw this.error('INVALID_REQUEST');
      const ops = await this.pixelOps();
      const current = this.rasterizeLayer(source);
      const mask = ops.backgroundMask(current, { tolerance, featherPx, mode });
      const canvas = document.createElement('canvas');
      canvas.width = mask.image.width; canvas.height = mask.image.height;
      canvas.getContext('2d').putImageData(ops.ensureImageData(mask.image), 0, 0);
      const width = source.width || mask.image.width;
      const height = source.height || mask.image.height;
      const layer = {
        name: (p.name || `蒙版·${source.name || source.id}`).slice(0, 120),
        type: 'image', data: canvas.toDataURL('image/png'),
        x: source.x || 0, y: source.y || 0,
        width, height, width_original: mask.image.width, height_original: mask.image.height,
        visible: true, opacity: 100, rotate: source.rotate || 0,
        params: { dshMask: { sourceLayerId: String(source.id), mode } },
      };
      const action = new app.Actions.Insert_layer_action(layer, false);
      // changedObjectIds 里带上新蒙版层 id，调用方据此拼 layer.add_image 的 maskRef。
      return { action, ids: () => [String(action.inserted_layer_id)] };
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
      'layer.add_text': ['text', 'x', 'y', 'style', 'fontUrl'], 'layer.update_text': ['layerId', 'text', 'fontUrl', 'style'],
      'layer.set_transform': ['layerId', 'x', 'y', 'scaleX', 'scaleY', 'rotationDeg'],
      'layer.set_visibility': ['layerId', 'visible'], 'layer.reorder': ['layerId', 'toIndex'],
      'layer.set_appearance': ['layerId', 'opacity', 'blendMode', 'name']
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
      const fontUrl = this.readFontSpec(p);
      if (fontUrl) {
        // 字体必须绑到一个 family 上才有意义；只给 URL 不给 family 是说明调用方搞错了。
        if (typeof style.family !== 'string' || !style.family) throw this.error('INVALID_REQUEST', 'fontUrl 需要同时用 style.family 指定字体族');
        await this.ensureFontLoaded(style.family, fontUrl);
      }
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
      const existingStyle = layer.data?.[0]?.[0]?.meta || {};
      // 允许只改颜色：自检报"文字与背景对比不足"时，这是唯一能落地的修复动作。
      let nextStyle = existingStyle;
      if (p.style !== undefined) {
        if (!plain(p.style) || !keysOnly(p.style, ['fill_color'])) throw this.error('INVALID_REQUEST');
        if (p.style.fill_color !== undefined && !/^#[0-9a-f]{6}$/i.test(p.style.fill_color)) throw this.error('INVALID_REQUEST');
        nextStyle = { ...existingStyle, ...p.style };
      }
      const fontUrl = this.readFontSpec(p);
      if (fontUrl) {
        const family = existingStyle.family;
        if (typeof family !== 'string' || !family) throw this.error('INVALID_REQUEST', '该文本层没有字体族，无法绑定 fontUrl');
        await this.ensureFontLoaded(family, fontUrl);
      }
      return { action: new app.Actions.Update_layer_action(layer.id, { data: lines(p.text, nextStyle) }), ids };
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
    if (command.type === 'layer.set_appearance') {
      // 外观三元组：只写真正给了的字段；一个都没给就是无意义写入，直接拒绝。
      const settings = {};
      if (p.opacity !== undefined) {
        if (typeof p.opacity !== 'number' || !Number.isFinite(p.opacity) || p.opacity < 0 || p.opacity > 100) throw this.error('INVALID_REQUEST', 'opacity 必须是 0..100 的数字');
        settings.opacity = p.opacity;
      }
      if (p.blendMode !== undefined) {
        if (!BLEND_MODES.has(p.blendMode)) throw this.error('INVALID_REQUEST', 'blendMode 不在支持的合成模式清单里');
        settings.composition = p.blendMode;
      }
      if (p.name !== undefined) {
        if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120) throw this.error('INVALID_REQUEST', 'name 必须是 1..120 字符');
        settings.name = p.name;
      }
      if (!Object.keys(settings).length) throw this.error('INVALID_REQUEST', 'opacity、blendMode、name 至少给一项');
      return { action: new app.Actions.Update_layer_action(layer.id, settings), ids };
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
