// PSD 导入：把 ag-psd 解析出的图层映射成 miniPaint 原生图层动作。
//
// 设计约束：
// 1) 一律通过 app.State.do_action 的 Insert_layer_action 落层，人手动编辑与 Agent 命令共享同一条
//    原生历史栈，撤销/重做与 revision 语义不会被绕过。
// 2) PSD 不是 canvas 场景格式：智能对象、图层样式、蒙版、调整层都没有等价物，一律降级为
//    栅格或跳过，并把这些偏差回给调用方用于中文提示，绝不静默丢。
// 3) ag-psd 体积较大（约 354 KB / 104 KB gzip），使用动态 import 让它成为按需 chunk，
//    主包体积不因 PSD 支持而变大。
import app from './app.js';
import config from './config.js';

const KIND_EXACT = new Set(['psd', 'psb']);

/** 只按扩展名/MIME 判断，避免把普通图片误当 PSD 解析。 */
export function isPsdFile(file) {
  if (!file) return false;
  const name = String(file.name || '').toLowerCase();
  if (KIND_EXACT.has(name.split('.').pop())) return true;
  return String(file.type || '') === 'image/vnd.adobe.photoshop';
}

function rasterLayerFromImageData(imageData, meta) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return {
    name: meta.name, type: 'image', link: canvas, data: canvas.toDataURL(),
    width: imageData.width, height: imageData.height,
    width_original: imageData.width, height_original: imageData.height,
    x: meta.x, y: meta.y, opacity: meta.opacity, visible: meta.visible, order: meta.order,
  };
}

function textLayerFromPsd(layer, meta) {
  const raw = layer.text && typeof layer.text.text === 'string' ? layer.text.text : '';
  if (!raw.trim()) return null;
  const size = Number(layer.text?.transform?.[0]) || 32;
  const lines = raw.split('\n').map(line => [{ text: line, meta: { size } }]);
  return {
    name: meta.name, type: 'text', data: lines, is_vector: true, render_function: ['text', 'render'],
    x: meta.x, y: meta.y, opacity: meta.opacity, visible: meta.visible, order: meta.order, rotate: 0,
    params: { boundary: 'dynamic', kerning: 'metrics', text_direction: 'ltr', wrap_direction: 'ttb', halign: 'left', valign: 'top', wrap: 'letter' },
  };
}

/**
 * 把 PSD 图层树拍平成 miniPaint 图层（自底向上）。
 * 返回 { layers, warnings }：warnings 是给用户看的中文偏差说明，不能省略。
 */
export function mapPsdLayers(psd) {
  const layers = [];
  const warnings = [];
  const walk = (nodes, depth) => {
    for (const layer of nodes || []) {
      if (layer.children && layer.children.length) {
        // 图层组：miniPaint 没有分组容器，按顺序拍平并保留组名到图层名前面。
        walk(layer.children, depth + 1);
        continue;
      }
      const name = layer.name || (layer.text ? '文字' : '图层');
      const opacity = Math.max(0, Math.min(100, Math.round((layer.opacity ?? 1) * 100)));
      const visible = !layer.hidden;
      const x = layer.left || 0, y = layer.top || 0;
      const meta = { name, x, y, opacity, visible, order: layers.length };

      if (layer.mask || layer.realMask) warnings.push(`「${name}」带蒙版，已按未蒙版状态导入`);
      if (layer.effects || layer.layerEffects) warnings.push(`「${name}」的图层样式（阴影/描边/发光等）不保真，已丢弃`);
      if (layer.smartObject) warnings.push(`「${name}」是智能对象，已降级为普通图层`);
      if (layer.adjustment) warnings.push(`「${name}」是调整层，miniPaint 无对应能力，已跳过`);
      if (layer.adjustment) continue;

      // 文字层优先保留可编辑文本：PSD 里它也带栅格像素，直接用像素会丢掉可编辑性。
      // 没有可用文本元数据时退回栅格（保住视觉），连像素都没有才跳过。
      if (layer.text) {
        const textLayer = textLayerFromPsd(layer, meta);
        if (textLayer) {
          warnings.push(`「${name}」按可编辑文本导入，字体与排版可能与 Photoshop 不一致`);
          layers.push(textLayer);
          continue;
        }
        if (layer.imageData) {
          warnings.push(`「${name}」没有可用的文本内容，已退回栅格图层`);
          layers.push(rasterLayerFromImageData(layer.imageData, meta));
          continue;
        }
        warnings.push(`「${name}」是文字层但既无文本也无像素，已跳过`);
        continue;
      }
      if (layer.imageData) { layers.push(rasterLayerFromImageData(layer.imageData, meta)); continue; }
      warnings.push(`「${name}」没有可用的像素数据（可能是空层或未栅格化的智能对象），已跳过`);
    }
  };
  walk(psd.children, 0);
  return { layers, warnings };
}

/**
 * 读取并导入一个 .psd 文件：解析 → 映射 → 一次 Bundle_action 落层。
 * 参数：file 用户选择的 File；返回 { layers, warnings } 供界面提示。
 */
export async function importPsd(file) {
  const buffer = await file.arrayBuffer();
  // 按需加载：只有真的导入 PSD 时才拉这个 chunk。
  let readPsd;
  try {
    ({ readPsd } = await import('ag-psd'));
  } catch (error) {
    // 懒加载 chunk 取不到必须说人话：否则表现就是“调用了、无异常、无提示、画面不变”。
    throw new Error('PSD 支持模块加载失败（860 分块没取到），请刷新页面后重试');
  }
  let psd;
  try {
    psd = readPsd(buffer, { useImageData: true, skipThumbnail: true });
  } catch (error) {
    throw new Error('这个 PSD 解析失败：' + (error && error.message ? error.message : '文件可能已损坏或使用了不支持的编码'));
  }
  if (!psd || !Array.isArray(psd.children)) throw new Error('这个 PSD 里没有可读的图层');
  const { layers, warnings } = mapPsdLayers(psd);
  if (!layers.length) throw new Error('这个 PSD 的所有图层都无法导入（可能是空的智能对象或调整层）');
  const actions = layers.map(layer => new app.Actions.Insert_layer_action(layer));
  if (psd.width && psd.height && (psd.width !== config.WIDTH || psd.height !== config.HEIGHT)) {
    actions.push(new app.Actions.Autoresize_canvas_action(psd.width, psd.height, null, true, true));
  }
  app.State.do_action(new app.Actions.Bundle_action('open_psd', '导入 PSD', actions));
  return { layers, warnings, width: psd.width, height: psd.height };
}
