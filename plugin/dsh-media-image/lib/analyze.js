// 把测量值变成可执行的清单（纯函数）：每条 finding 都指名一个真实存在的命令。
//
// 原则：只根据测量事实判断，不评价"好不好看"；阈值写在这里，便于以后按场景调。
// suggestedCommand 必须属于白名单——测试会逐条核对，防止提示一个做不到的动作。

import { ALLOWED_COMMANDS } from './bridge.js';

export const THRESHOLDS = {
  darkMeanLuma: 0.18,
  brightMeanLuma: 0.82,
  clippingWarn: 0.02,
  clippingHigh: 0.08,
  colorSpreadWarn: 12,
  sharpnessWarn: 80,
  opaqueRatioWarn: 0.02,
  // 分区量：图层至少要占画布这么大才值得提示"它看不见"，避免为一个小图标刷噪声。
  regionShareWarn: 0.02,
  regionOpaqueWarn: 0.02,
};

const severityOf = (value, warn, high) => (value >= high ? 'high' : value >= warn ? 'warn' : 'info');

/**
 * @param measurement editor.analyze 的返回
 * @returns findings[] · 每条 {code, severity, message, suggestedCommand|null, evidence}
 */
export function reviewMeasurements(measurement) {
  const m = measurement && typeof measurement === 'object' ? measurement : null;
  if (!m) return [];
  const findings = [];
  const allowed = ALLOWED_COMMANDS.image;
  const suggest = id => (allowed.has(id) ? id : null);

  const luminance = Number(m.luminance?.mean);
  if (Number.isFinite(luminance)) {
    if (luminance < THRESHOLDS.darkMeanLuma) {
      findings.push({ code: 'TOO_DARK', severity: 'warn', message: `整体偏暗（平均亮度 ${luminance}）`, suggestedCommand: suggest('layer.color_match'), evidence: { meanLuma: luminance } });
    } else if (luminance > THRESHOLDS.brightMeanLuma) {
      findings.push({ code: 'TOO_BRIGHT', severity: 'warn', message: `整体偏亮（平均亮度 ${luminance}）`, suggestedCommand: suggest('layer.color_match'), evidence: { meanLuma: luminance } });
    }
  }

  for (const [key, label] of [['shadows', '暗部'], ['highlights', '高光']]) {
    const ratio = Number(m.clipping?.[key]);
    if (!Number.isFinite(ratio)) continue;
    if (ratio >= THRESHOLDS.clippingWarn) {
      findings.push({
        code: key === 'highlights' ? 'HIGHLIGHT_CLIPPING' : 'SHADOW_CLIPPING',
        severity: severityOf(ratio, THRESHOLDS.clippingWarn, THRESHOLDS.clippingHigh),
        message: `${label}裁切 ${(ratio * 100).toFixed(1)}% 像素`,
        suggestedCommand: suggest('layer.color_match'),
        evidence: { ratio },
      });
    }
  }

  const spread = Number(m.colorCast?.spread);
  if (Number.isFinite(spread) && spread >= THRESHOLDS.colorSpreadWarn) {
    findings.push({
      code: 'COLOR_CAST', severity: 'warn',
      message: `有明显偏色（R/G/B 均值差 ${spread}）`,
      suggestedCommand: suggest('layer.color_match'),
      evidence: { ...m.colorCast },
    });
  }

  const sharp = Number(m.sharpness?.laplacianVariance);
  if (Number.isFinite(sharp) && sharp < THRESHOLDS.sharpnessWarn) {
    findings.push({ code: 'LOW_DETAIL', severity: 'info', message: `边缘能量偏低（Laplacian 方差 ${sharp}），可能糊或被缩放`, suggestedCommand: null, evidence: { laplacianVariance: sharp } });
  }

  const opaque = Number(m.opaqueRatio);
  if (Number.isFinite(opaque) && opaque < THRESHOLDS.opaqueRatioWarn) {
    findings.push({ code: 'ALMOST_EMPTY', severity: 'warn', message: `画布几乎全透明（可见像素 ${(opaque * 100).toFixed(1)}%）`, suggestedCommand: null, evidence: { opaqueRatio: opaque } });
  }

  for (const id of m.layers?.offCanvas || []) {
    findings.push({ code: 'OFF_CANVAS', severity: 'warn', message: `图层 ${id} 超出画布`, suggestedCommand: suggest('layer.set_frame'), evidence: { layerId: id } });
  }
  for (const id of m.layers?.zeroSize || []) {
    findings.push({ code: 'EMPTY_LAYER', severity: 'info', message: `图层 ${id} 尺寸为 0`, suggestedCommand: null, evidence: { layerId: id } });
  }
  for (const item of m.layers?.textOverflow || []) {
    findings.push({ code: 'TEXT_OVERFLOW', severity: 'warn', message: `文字层 ${item.id} 估计宽 ${item.width}px，超出所在框或画布`, suggestedCommand: suggest('layer.set_frame'), evidence: { layerId: item.id, width: item.width } });
  }
  for (const item of m.layers?.textContrast || []) {
    // 唯一能自动修的路径是换颜色；对比度本身就摆在这里，不评价"好不好看"。
    findings.push({
      code: 'TEXT_LOW_CONTRAST', severity: 'warn',
      message: `文字层 ${item.id} 与背景对比 ${item.contrast}（文字亮度 ${item.textLuma} / 背景亮度 ${item.backgroundLuma}）`,
      suggestedCommand: suggest('layer.update_text'),
      evidence: { layerId: item.id, ...item },
    });
  }
  for (const item of m.layers?.upscaled || []) {
    findings.push({ code: 'UPSCALED_IMAGE', severity: 'info', message: `图层 ${item.id} 被放大到 ${item.scaled}px（原图 ${item.natural}px），会发虚`, suggestedCommand: null, evidence: { layerId: item.id, ...item } });
  }

  // 分区量：按每个可见图层的外框量它那一块。只挑一种真正可操作的结论 ——
  // "这层明明可见、也占了不小面积，但那块几乎没有内容"。多半是被上面不透明的层压住了，
  // 或者它本身就是透明的；两种都能靠 reorder / preview 一步查清，所以给 reorder 建议。
  const regions = Array.isArray(m.regions) ? m.regions : [];
  for (const region of regions) {
    if (region?.inCanvas !== true) continue;
    const share = Number(region.canvasShare);
    const opaque = Number(region.opaqueRatio);
    if (!Number.isFinite(share) || !Number.isFinite(opaque)) continue;
    if (share < THRESHOLDS.regionShareWarn) continue;
    if (opaque >= THRESHOLDS.regionOpaqueWarn) continue;
    findings.push({
      code: 'REGION_NOT_VISIBLE', severity: 'warn',
      message: `图层 ${region.layerId} 占画布 ${(share * 100).toFixed(1)}%，但那一块几乎没有内容（可见像素 ${(opaque * 100).toFixed(1)}%）—— 可能被上层压住了`,
      suggestedCommand: suggest('layer.reorder'),
      evidence: { layerId: region.layerId, name: region.name, canvasShare: share, opaqueRatio: opaque, meanLuma: region.meanLuma },
    });
  }

  return findings;
}

/** 供工具层直接回给人看的一句话（不含主观评价）。 */
export function summarizeMeasurements(measurement) {
  const m = measurement || {};
  const luma = Number(m.luminance?.mean);
  const hi = Number(m.clipping?.highlights);
  const lo = Number(m.clipping?.shadows);
  const parts = [];
  if (Number.isFinite(luma)) parts.push(`平均亮度 ${luma}`);
  if (Number.isFinite(hi)) parts.push(`高光裁切 ${(hi * 100).toFixed(1)}%`);
  if (Number.isFinite(lo)) parts.push(`暗部裁切 ${(lo * 100).toFixed(1)}%`);
  const regions = Array.isArray(m.regions) ? m.regions : [];
  if (regions.length) parts.push(`分区 ${regions.length} 个${Number(m.regionsTruncated) > 0 ? `（另有 ${m.regionsTruncated} 个未量）` : ''}`);
  return parts.join(' · ');
}
