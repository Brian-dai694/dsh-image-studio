// 预览图落盘：把 editor.preview_png 的 data URL 写成真实 PNG 文件。
//
// 为什么要这个：宿主用图片块把图送进模型，需要 attachments 的写入接口，
// 而那个接口没有公开声明（只有 fileHostPath/imageHostPath 两个读接口）。
// 与其猜一个方法名，不如写出一份**真实文件**：调用方用自己的看图工具打开它，
// 这条路径在今天就可用，而且可核对（路径 + 字节数 + PNG 签名）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 只接受 PNG data URL；解不出字节就报错，不写空文件。 */
export function decodePngDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw Object.assign(new Error('预览数据不是字符串'), { code: 'PREVIEW_INVALID' });
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl.trim());
  if (!match) throw Object.assign(new Error('只支持 data:image/png;base64, 形式的预览数据'), { code: 'PREVIEW_INVALID' });
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length) throw Object.assign(new Error('预览数据为空'), { code: 'PREVIEW_INVALID' });
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw Object.assign(new Error('解出来的字节不是 PNG（签名不符）'), { code: 'PREVIEW_INVALID' });
  return bytes;
}

/**
 * 把预览写成 PNG 文件。
 * @param {object} options
 * @param {string} options.dataUrl PNG data URL
 * @param {string} options.savePath 目标路径（绝对，或以 cwd 为基准的相对路径）
 * @param {string} [options.cwd] 相对路径的基准目录
 * @returns {{path:string, bytes:number}}
 */
export function writePreviewPng({ dataUrl, savePath, cwd = process.cwd() }) {
  const target = String(savePath ?? '').trim();
  if (!target) throw Object.assign(new Error('savePath 必填'), { code: 'PREVIEW_INVALID' });
  if (!/\.png$/i.test(target)) throw Object.assign(new Error('savePath 必须以 .png 结尾（只写 PNG，避免按扩展名骗人）'), { code: 'PREVIEW_INVALID' });
  const bytes = decodePngDataUrl(dataUrl);
  const absolute = isAbsolute(target) ? target : resolve(cwd, target);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  return { path: absolute, bytes: bytes.length };
}

export { PNG_SIGNATURE };
