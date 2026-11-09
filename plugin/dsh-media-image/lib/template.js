// 套版规划器（纯函数，不碰画布、不发命令）：把 PSD 解出的槽位变成一串白名单命令。
//
// 为什么是"重建式"：miniPaint 打不开 PSD，像素级合成要自己实现 PSD 通道解码（RLE/ZIP），
// 成本高。重建式用现有白名单命令（canvas.resize / layer.add_image / layer.add_text）
// 按槽位矩形搭出新版面，能完全撤销，代价是丢掉 PSD 里的渐变、描边、投影等图层效果。
// 这些丢失必须如实返回给调用方（skipped），不能假装还原了。
//
// 边界：只产出"待确认命令"，不判断是否已执行；所有写入仍由页面逐条弹确认。

import { deflateSync } from 'node:zlib';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** 生成 1×1 PNG 的 data URL，用来当纯色背景层（白名单里没有"画矩形"命令）。 */
export function solidColorDataUrl(hex = '#ffffff') {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) throw Object.assign(new Error(`颜色必须是 #RRGGBB：${hex}`), { code: 'TEMPLATE_BAD_COLOR' });
  const value = match[1];
  const r = parseInt(value.slice(0, 2), 16), g = parseInt(value.slice(2, 4), 16), b = parseInt(value.slice(4, 6), 16);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const out = Buffer.alloc(8);
    out.writeUInt32BE(data.length, 0);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 4);
    return Buffer.concat([out.subarray(0, 4), Buffer.from(type, 'ascii'), data, out.subarray(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.from([0, r, g, b, 255]); // filter=0 + RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * 批量套版：同一模板、同一商品槽，换多个商品图，各出一份规划。
 * 只做规划，不执行；调用方逐份确认并导出，避免一次写入无法回退。
 * @param products [{assetRef, name?, texts?, slotId?}]，1..20 个
 */
export function planTemplateBatch(template, { baseAssetRef, background, products = [], texts = {}, textStyle = {} } = {}) {
  if (!template || !template.canvas || !Array.isArray(template.slots)) throw Object.assign(new Error('模板缺少 canvas/slots'), { code: 'TEMPLATE_INVALID' });
  if (!Array.isArray(products) || products.length === 0) throw Object.assign(new Error('批量套版至少需要一个商品素材'), { code: 'TEMPLATE_NO_PRODUCTS' });
  if (products.length > 20) throw Object.assign(new Error('批量套版一次最多 20 个商品'), { code: 'TEMPLATE_TOO_MANY_VARIANTS' });
  const variants = products.map((product, index) => {
    const assetRef = String(product?.assetRef || '');
    if (!/^asset:[a-f0-9]{48}$/.test(assetRef)) throw Object.assign(new Error(`第 ${index + 1} 个商品素材引用无效`), { code: 'TEMPLATE_BAD_ASSET' });
    return {
      index: index + 1,
      name: product?.name || '',
      productAssetRef: assetRef,
      plan: planTemplateApply(template, {
        baseAssetRef,
        background,
        product: { assetRef, ...(product?.name ? { name: product.name } : {}), ...(product?.slotId ? { slotId: product.slotId } : {}) },
        texts: product?.texts || texts,
        textStyle,
      }),
    };
  });
  return {
    variants,
    summary: {
      variants: variants.length,
      base: Boolean(baseAssetRef),
      commandsPerVariant: variants[0]?.plan.commands.length ?? 0,
      productSlot: variants[0]?.plan.summary.productSlot ?? null,
    },
  };
}

/**
 * 规划一次套版：模板槽位 + 填充内容 → 待确认命令列表。
 * @param template psdToTemplate() 的结果
 * @param options.background 背景色 #RRGGBB（可省略，省略则只留 PSD 里最底层图片槽当背景占位）
 * @param options.product {assetRef, slotId?} 商品图放哪个槽（默认挑面积最大且非整幅的图片槽）
 * @param options.texts {slotId: 文案} 覆盖文字槽文案（默认沿用 PSD 原文）
 * @param options.textStyle {size?, fill_color?, family?, bold?}
 */
export function planTemplateApply(template, { background, baseAssetRef, product, texts = {}, textStyle = {} } = {}) {
  if (!template || !template.canvas || !Array.isArray(template.slots)) {
    throw Object.assign(new Error('模板缺少 canvas/slots'), { code: 'TEMPLATE_INVALID' });
  }
  const { width: canvasWidth, height: canvasHeight } = template.canvas;
  if (!(canvasWidth > 0 && canvasHeight > 0)) throw Object.assign(new Error('模板画布尺寸无效'), { code: 'TEMPLATE_INVALID' });

  const commands = [];
  const skipped = [];
  const clampRect = rect => ({
    x: clamp(Math.round(rect.x), 0, Math.max(0, canvasWidth - 1)),
    y: clamp(Math.round(rect.y), 0, Math.max(0, canvasHeight - 1)),
    width: clamp(Math.round(rect.width), 1, canvasWidth),
    height: clamp(Math.round(rect.height), 1, canvasHeight),
  });

  commands.push({ type: 'canvas.resize', payload: { width: canvasWidth, height: canvasHeight }, note: `画布对齐模板 ${canvasWidth}×${canvasHeight}` });

  // 底图优先：PSD 逐层合成出的 PNG 已经把装饰（渐变/描边/投影）画好了，
  // 比纯色背景更接近模板；纯色背景只在没有底图时用来占位。
  if (baseAssetRef) {
    if (!/^asset:[a-f0-9]{48}$/.test(String(baseAssetRef))) throw Object.assign(new Error('baseAssetRef 必须是 asset:<48 位 id>'), { code: 'TEMPLATE_BAD_ASSET' });
    commands.push({
      type: 'layer.add_image',
      payload: { sourceRef: baseAssetRef, x: 0, y: 0, width: canvasWidth, height: canvasHeight, fit: 'stretch', name: '模板底图' },
      note: 'PSD 装饰层合成底图（不含文字与商品槽）',
    });
  } else if (background) {
    commands.push({
      type: 'layer.add_image',
      payload: { sourceRef: solidColorDataUrl(background), x: 0, y: 0, width: canvasWidth, height: canvasHeight, fit: 'stretch', name: '背景' },
      note: `纯色背景 ${background}`,
    });
  }

  const visible = template.slots.filter(slot => slot.visible !== false);
  const imageSlots = visible.filter(slot => slot.type === 'image');
  const textSlots = visible.filter(slot => slot.type === 'text');
  const canvasArea = canvasWidth * canvasHeight;
  const isFullCanvas = slot => slot.rect.width * slot.rect.height >= canvasArea * 0.98;

  // 可放商品图的槽位候选（排除整幅背景槽），按面积从大到小；页面据此让用户挑槽。
  // 下标从 1 开始，方便用户直接回「套版：2」。
  const candidates = imageSlots
    .filter(slot => !isFullCanvas(slot))
    .slice()
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
    .map((slot, index) => ({
      index: index + 1,
      id: String(slot.id),
      name: slot.name || '',
      rect: { x: Math.round(slot.rect.x), y: Math.round(slot.rect.y), width: Math.round(slot.rect.width), height: Math.round(slot.rect.height) },
      areaRatio: Number(((slot.rect.width * slot.rect.height) / canvasArea).toFixed(4)),
    }));

  // 商品图槽：显式指定优先；否则取面积最大的非整幅图槽。
  let productSlot = null;
  if (product) {
    if (!/^asset:[a-f0-9]{48}$/.test(String(product.assetRef || ''))) throw Object.assign(new Error('product.assetRef 必须是 asset:<48 位 id>'), { code: 'TEMPLATE_BAD_ASSET' });
    if (product.slotId) {
      productSlot = imageSlots.find(slot => String(slot.id) === String(product.slotId)) || null;
      if (!productSlot) throw Object.assign(new Error(`模板里没有这个图片槽：${product.slotId}`), { code: 'TEMPLATE_SLOT_NOT_FOUND' });
      if (isFullCanvas(productSlot) && candidates.length) throw Object.assign(new Error('整幅背景槽不能放商品图，请换一个槽位'), { code: 'TEMPLATE_SLOT_NOT_FOUND' });
    } else {
      productSlot = candidates.length
        ? imageSlots.find(slot => String(slot.id) === candidates[0].id)
        : (imageSlots[0] || null);
    }
  }

  const mapping = [];
  for (const slot of imageSlots) {
    if (slot === productSlot) {
      mapping.push({ slotId: String(slot.id), name: slot.name || '', kind: 'product', action: 'place-product', reason: null });
    } else if (baseAssetRef) {
      mapping.push({ slotId: String(slot.id), name: slot.name || '', kind: 'decoration', action: 'preserved-in-base', reason: null });
    } else if (isFullCanvas(slot) && background) {
      mapping.push({ slotId: String(slot.id), name: slot.name || '', kind: 'background', action: 'replaced-by-solid-background', reason: `整幅背景槽由纯色 ${background} 取代，PSD 原背景像素不还原` });
    } else {
      // 除背景/商品之外的图片槽在重建式里是装饰（形状、阴影位图），无法还原：如实登记。
      mapping.push({ slotId: String(slot.id), name: slot.name || '', kind: 'decoration', action: 'skip', reason: '重建式不还原 PSD 的装饰图层（渐变/描边/投影等）' });
      skipped.push({ slotId: slot.id, name: slot.name, kind: 'image', reason: '重建式不还原 PSD 的装饰图层（渐变/描边/投影等）' });
    }
  }
  for (const slot of textSlots) {
    const text = Object.prototype.hasOwnProperty.call(texts, slot.id) ? texts[slot.id] : (slot.text || '');
    const hasText = Boolean(text && String(text).trim());
    mapping.push({ slotId: String(slot.id), name: slot.name || '', kind: 'text', action: hasText ? 'place-text' : 'skip', text: hasText ? String(text) : null,
      reason: hasText ? null : '没有文案（模板里该文字层为空，且未提供替换文案）' });
    if (!hasText) skipped.push({ slotId: slot.id, name: slot.name, kind: 'text', reason: '没有文案（模板里该文字层为空，且未提供替换文案）' });
  }

  if (product) {
    if (!productSlot) {
      skipped.push({ slotId: null, kind: 'product', reason: '模板没有可用的图片槽，商品图未放置' });
    } else {
      const rect = clampRect(productSlot.rect);
      commands.push({
        type: 'layer.add_image',
        payload: { sourceRef: product.assetRef, x: rect.x, y: rect.y, width: rect.width, height: rect.height, fit: 'contain', name: product.name || productSlot.name || '商品图' },
        note: `商品图填入槽位 ${productSlot.id}（${productSlot.name}）`,
      });
    }
  }

  for (const slot of textSlots) {
    const text = Object.prototype.hasOwnProperty.call(texts, slot.id) ? texts[slot.id] : (slot.text || '');
    // 缺文案已在 mapping 阶段登记过 skipped，这里只跳过、不重复登记。
    if (!text || !String(text).trim()) continue;
    const rect = clampRect(slot.rect);
    commands.push({
      type: 'layer.add_text',
      payload: {
        text: String(text),
        x: rect.x,
        y: rect.y,
        style: {
          size: Math.max(8, Math.min(256, Math.round(textStyle.size || slot.fontSize || Math.min(48, canvasHeight / 12)))),
          ...(textStyle.fill_color ? { fill_color: textStyle.fill_color } : {}),
          ...(textStyle.family ? { family: textStyle.family } : {}),
          ...(textStyle.bold ? { bold: true } : {}),
        },
      },
      note: `文案填入槽位 ${slot.id}（${slot.name}）`,
    });
  }

  return {
    canvas: { width: canvasWidth, height: canvasHeight },
    commands,
    skipped,
    // 预览用：哪些槽能放商品图、每个槽最终会被怎么处理。页面先展示这个再执行。
    candidates,
    mapping,
    summary: {
      commands: commands.length,
      images: commands.filter(command => command.type === 'layer.add_image').length,
      texts: commands.filter(command => command.type === 'layer.add_text').length,
      skipped: skipped.length,
      productSlot: productSlot?.id || null,
      productSlotIndex: candidates.find(item => item.id === String(productSlot?.id ?? ''))?.index ?? null,
    },
  };
}
