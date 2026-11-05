// 对话面板共享模型（图片 / 视频两个插件共用一份）。
//
// 目的：两个编辑器只允许有一套消息→界面规则。这里只有纯函数：不碰 DOM、不依赖宿主、
// 不发起任何调用。图片侧 `plugin/dsh-media-image/lib/client.js` 内联实现与本文档语义一致，
// 由 `plugin/dsh-media-image/test/dialog-parity.test.mjs` 逐函数对照，改一边不改另一边会红。
//
// 版本：dialog-model@1（2026-11-05）。视频侧 vendor 本文件后，在 import 处记录 sha256，
// 升级时替换文件并同步 sha256，不做"各改各的"。

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ATTACHMENT_TYPES = { 'image/png': true, 'image/jpeg': true, 'image/webp': true };

/** 把一段文本切成行内片段：普通文本、`代码`、![图](url)、[链接](url)、裸链接。 */
export function parseInlineTokens(text) {
  const source = String(text == null ? '' : text);
  const tokens = [];
  const pattern = /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\s]+\))|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > last) tokens.push({ kind: 'text', text: source.slice(last, match.index) });
    const raw = match[0];
    if (raw.charAt(0) === '`') tokens.push({ kind: 'code', text: raw.slice(1, -1) });
    else if (raw.slice(0, 2) === '![') {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(raw);
      tokens.push(image ? { kind: 'image', alt: image[1], href: image[2] } : { kind: 'text', text: raw });
    } else if (raw.charAt(0) === '[') {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw);
      tokens.push(link ? { kind: 'link', text: link[1], href: link[2] } : { kind: 'text', text: raw });
    } else tokens.push({ kind: 'link', text: raw, href: raw });
    last = match.index + raw.length;
  }
  if (last < source.length) tokens.push({ kind: 'text', text: source.slice(last) });
  return tokens;
}

/** 轻量 Markdown 分块：标题、列表、围栏代码、引用、段落。不认识的一律当段落，不吞内容。 */
export function parseMarkdownBlocks(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    blocks.push({ kind: 'paragraph', text: buffer.join('\n') });
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
      blocks.push({ kind: 'code', lang, text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); continue; }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flush();
      const list = { kind: 'list', ordered: !!ordered, items: [] };
      while (index < lines.length) {
        const next = lines[index];
        const item = /^\s*[-*]\s+(.*)$/.exec(next) || /^\s*\d+[.)]\s+(.*)$/.exec(next);
        if (!item) break;
        list.items.push(item[1]);
        index += 1;
      }
      index -= 1;
      blocks.push(list);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flush(); blocks.push({ kind: 'quote', text: quote[1] }); continue; }
    if (!line.trim()) { flush(); continue; }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/** 工具卡片四态：自由文本收敛成 applied / rejected / unknown / pending。 */
export function normalizeToolStatus(status, failed) {
  const value = String(status || '').toLowerCase();
  if (!value) return failed ? 'rejected' : 'pending';
  if (value === 'applied' || value === 'completed' || value === 'ok' || value === 'ready') return 'applied';
  if (value === 'rejected' || value === 'failed' || value === 'error' || value === 'aborted') return 'rejected';
  if (value === 'unknown' || value === 'pending' || value === 'running' || value === 'queued') return value === 'unknown' ? 'unknown' : 'pending';
  return failed ? 'rejected' : 'pending';
}

/** 一段文本是不是"裸 JSON"：以 { 或 [ 开头、整体是一个结构、且足够长。 */
export function looksLikeRawJson(text) {
  const value = String(text == null ? '' : text);
  if (value.length < 40) return false;
  const trimmed = value.trim();
  if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return false;
  return /^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(trimmed);
}

/** 附件：只接受 PNG/JPEG/WebP，按 base64 大小校验，超限明确拒绝。 */
export function attachmentFromDataUrl(name, dataUrl) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl == null ? '' : dataUrl));
  if (!match) return { ok: false, message: '只能附加 PNG、JPEG 或 WebP 图片' };
  const mediaType = match[1].toLowerCase();
  if (!ATTACHMENT_TYPES[mediaType]) return { ok: false, message: '只支持 PNG、JPEG、WebP 图片（当前是 ' + mediaType + '）' };
  const data = match[2].replace(/\s+/g, '');
  const bytes = Math.floor(data.length * 3 / 4);
  if (bytes > MAX_ATTACHMENT_BYTES) return { ok: false, message: '图片约 ' + Math.round(bytes / 1024 / 1024) + ' MB，超过 4 MB 上限，请先压缩' };
  return { ok: true, name: String(name || '图片'), bytes, part: { type: 'image', mediaType, data } };
}

/** 输入区发送状态：只有已知失败才允许"重试一次"，结果未知必须先核对会话记录。 */
export function retryState(failure) {
  if (!failure || !failure.text) return null;
  if (failure.unknown) return { retryable: false, reason: '上次结果未知，请先核对会话记录，避免重复发送' };
  return { retryable: true, reason: '' };
}

/** 审批结果 → 四态徽标：允许一次=applied，拒绝/取消=rejected，不可用/其他=unknown。 */
export function approvalBadge(row) {
  if (!row || !row.decided) return 'pending';
  if (row.outcome === 'allowed-once') return 'applied';
  if (row.outcome === 'rejected' || row.outcome === 'cancelled') return 'rejected';
  return 'unknown';
}

/**
 * 会话行 → 界面计划。这是两个编辑器唯一的渲染入口约定：
 *   { key, kind: 'user'|'assistant'|'tool'|'approval'|'error', badge, tone,
 *     blocks:[{kind,...}], card?, issue?, diagnostic?, title?, actions:[{kind}] }
 * 规则：裸 JSON 不进 DOM；审批只有 open-native；撤销只有 fill-undo（只填输入框）。
 */
export function buildDialogPlan(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row, index) => {
    const key = row && row.id ? row.id : 'row-' + index;
    if (!row || typeof row !== 'object') return { key, kind: 'assistant', badge: null, blocks: [{ kind: 'paragraph', text: '' }], actions: [] };
    if (row.role === 'approval') {
      const badge = approvalBadge(row);
      return {
        key, kind: 'approval', badge, tone: badge === 'rejected' ? 'error' : badge === 'pending' ? 'warn' : 'muted',
        title: row.title || (row.decided ? '审批结果' : '等待本人在原生会话确认'),
        blocks: [{ kind: 'paragraph', text: row.text || '审批状态来自原生会话，本面板只显示状态，不代为作答。' }],
        actions: [{ kind: 'open-native', label: '打开原生会话 / 审批' }],
      };
    }
    if (row.role === 'tool') {
      const card = row.card || { name: '工具调用', status: '', revision: null, line: '' };
      const badge = normalizeToolStatus(card.status, !!card.error);
      const actions = [];
      if (row.undo) actions.push({ kind: 'fill-undo', label: '填入撤销指令', hint: '仅栈顶可撤；已有后续修改会返回 HISTORY_CONFLICT' });
      if (row.exportRef) actions.push({ kind: 'download-export', label: '在编辑器中另存为文件' });
      const diagnostic = card.line && looksLikeRawJson(card.line) ? card.line : '';
      return {
        key, kind: 'tool', badge,
        tone: badge === 'rejected' ? 'error' : badge === 'unknown' ? 'warn' : badge === 'applied' ? 'good' : 'muted',
        card: { name: card.name || '工具调用', status: badge, revision: card.revision, line: diagnostic ? '' : (card.line || '') },
        issue: row.issue || '', diagnostic, actions,
      };
    }
    if (row.role === 'error') {
      const text = looksLikeRawJson(row.text) ? '操作没有完成（无法解析摘要）' : String(row.text || '操作没有完成');
      return { key, kind: 'error', badge: 'rejected', tone: 'error', blocks: [{ kind: 'paragraph', text }], actions: [] };
    }
    const text = String(row.text == null ? '' : row.text);
    const raw = looksLikeRawJson(text);
    return {
      key, kind: row.role === 'user' ? 'user' : 'assistant', badge: null, tone: 'normal',
      blocks: raw ? [{ kind: 'paragraph', text: '这一步已执行（无法解析摘要）' }] : parseMarkdownBlocks(text),
      diagnostic: raw ? text : '', actions: [],
    };
  });
}

export const DIALOG_MODEL_VERSION = 'dialog-model@1';
