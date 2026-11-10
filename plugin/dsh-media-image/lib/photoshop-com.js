// Windows Photoshop COM bridge using fixed, structured actions only.
// The model cannot supply JSX. PowerShell maps the action enum + validated JSON
// arguments to fixed ExtendScript templates. Writes require DSH native approval.
import { spawnSync } from 'node:child_process';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { GenerationError } from './errors.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BRIDGE = resolve(ROOT, 'scripts', 'photoshop-bridge.ps1');
const MAX_TIMEOUT = 5 * 60_000;
const MAX_OUTPUT = 32_000;
const PROGIDS = ['Photoshop.Application','Photoshop.Application.BETA','Photoshop.Application.BETA.1','Photoshop.Application.2026','Photoshop.Application.2025','Photoshop.Application.2024','Photoshop.Application.2023','Photoshop.Application.Beta'];
const ACTIONS = new Set(['status','open_image','create_document','place_image','add_text_layer','layer_ops','adjust_image','export_active','run_jsx']);
const BLENDS = new Set(['NORMAL','COLOR','HUE','MULTIPLY','SCREEN','OVERLAY','SOFTLIGHT']);
const FILE_EXTS = new Set(['.png','.jpg','.jpeg','.tif','.tiff','.psd']);
const READ_ACTIONS = new Set(['status']);
const WRITE_ACTIONS = new Set(['open_image','create_document','place_image','add_text_layer','layer_ops','adjust_image','export_active','run_jsx']);
// 任意 ExtendScript 的大小上限。它是一次脚本投递，不是可流式传输的产物；
// 超过这个量级通常是模型把二进制/大段数据塞进了脚本，应该走别的通道。
const MAX_JSX_BYTES = 64 * 1024;

function fail(code, message) { throw new GenerationError(code, message); }
function timeoutValue(value, fallback) {
  const timeoutMs = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT) fail('PHOTOSHOP_TIMEOUT_INVALID', `timeoutMs 必须是 1000..${MAX_TIMEOUT} 的整数`);
  return timeoutMs;
}
function progIdValue(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(value)) fail('PHOTOSHOP_PROGID_INVALID', 'progId 格式无效');
  return value;
}
function localImagePath(value, label, mustExist = false) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 2048 || value.startsWith('\\\\') || /^\\\\\?\\/.test(value)) fail('PHOTOSHOP_PATH_INVALID', `${label} 必须是本机绝对路径`);
  if (!FILE_EXTS.has(extname(value).toLowerCase())) fail('PHOTOSHOP_PATH_INVALID', `${label} 文件扩展名不支持`);
  if (mustExist && !existsSync(value)) fail('PHOTOSHOP_FILE_NOT_FOUND', `${label} 文件不存在`);
  return value;
}
function boundedString(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('PHOTOSHOP_ARGUMENTS_INVALID', `${label} 必须是 1..${max} 字符`);
  return value;
}
function numberRange(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) fail('PHOTOSHOP_ARGUMENTS_INVALID', `${label} 超出范围 ${min}..${max}`);
}
function validate(action, a) {
  if (!ACTIONS.has(action)) fail('PHOTOSHOP_ACTION_INVALID', `Photoshop action 不在白名单：${String(action)}`);
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('PHOTOSHOP_ARGUMENTS_INVALID','arguments 必须是对象');
  const fields = {
    status: ['timeoutMs','progId'], open_image: ['path','timeoutMs','progId'],
    create_document: ['widthPx','heightPx','name','resolution','backgroundColor','transparent','timeoutMs','progId'],
    place_image: ['imagePath','layerName','leftPx','topPx','widthPx','heightPx','opacity','blendMode','timeoutMs','progId'],
    add_text_layer: ['text','layerName','xPx','yPx','font','sizePx','color','justification','opacity','timeoutMs','progId'],
    layer_ops: ['operation','layerName','newName','opacity','blendMode','timeoutMs','progId'],
    adjust_image: ['inputPath','outputPath','widthPx','heightPx','brightness','contrast','crop','sharpen','jpegQuality','timeoutMs','progId'],
    export_active: ['outputPath','jpegQuality','timeoutMs','progId'],
    run_jsx: ['jsx','timeoutMs','progId'],
  }[action];
  const extra = Object.keys(a).find(k => !fields.includes(k));
  if (extra) fail('PHOTOSHOP_ARGUMENTS_INVALID', `${action} 不支持参数 ${extra}`);
  if (action === 'open_image') localImagePath(a.path,'path',true);
  if (action === 'place_image') localImagePath(a.imagePath,'imagePath',true);
  if (action === 'adjust_image') {
    if (a.inputPath) localImagePath(a.inputPath,'inputPath',true);
    if (a.outputPath) localImagePath(a.outputPath,'outputPath');
  }
  if (action === 'export_active') localImagePath(a.outputPath,'outputPath');
  if (action === 'create_document') {
    for (const k of ['widthPx','heightPx']) if (!Number.isSafeInteger(a[k]) || a[k] < 1 || a[k] > 30000) fail('PHOTOSHOP_ARGUMENTS_INVALID', `${k} 必须是 1..30000 整数`);
    if (a.name !== undefined) boundedString(a.name,'name',120);
    if (a.resolution !== undefined) numberRange(a.resolution,'resolution',1,9600);
    if (a.backgroundColor !== undefined && !/^#[0-9a-f]{6}$/i.test(a.backgroundColor)) fail('PHOTOSHOP_ARGUMENTS_INVALID','backgroundColor 必须是 #RRGGBB');
  }
  if (action === 'place_image') {
    for (const k of ['leftPx','topPx']) if (a[k] !== undefined) numberRange(a[k],k,-30000,30000);
    for (const k of ['widthPx','heightPx']) if (a[k] !== undefined) numberRange(a[k],k,1,30000);
    if ((a.widthPx === undefined) !== (a.heightPx === undefined)) fail('PHOTOSHOP_ARGUMENTS_INVALID','widthPx/heightPx 必须成对提供');
    if (a.opacity !== undefined) numberRange(a.opacity,'opacity',0,100);
    if (a.blendMode !== undefined && !BLENDS.has(a.blendMode)) fail('PHOTOSHOP_ARGUMENTS_INVALID','blendMode 不在白名单');
  }
  if (action === 'add_text_layer') {
    boundedString(a.text,'text',4000);
    for (const k of ['xPx','yPx']) numberRange(a[k],k,-30000,30000);
    if (a.sizePx !== undefined) numberRange(a.sizePx,'sizePx',1,1000);
    if (a.opacity !== undefined) numberRange(a.opacity,'opacity',0,100);
    if (a.color !== undefined && !/^#[0-9a-f]{6}$/i.test(a.color)) fail('PHOTOSHOP_ARGUMENTS_INVALID','color 必须是 #RRGGBB');
    if (a.justification !== undefined && !['LEFT','CENTER','RIGHT'].includes(a.justification)) fail('PHOTOSHOP_ARGUMENTS_INVALID','justification 不在白名单');
    if (a.font !== undefined) boundedString(a.font,'font',120);
    if (a.layerName !== undefined) boundedString(a.layerName,'layerName',120);
  }
  if (action === 'layer_ops') {
    if (!['list','rename','show','hide','setOpacity','setBlendMode'].includes(a.operation)) fail('PHOTOSHOP_ARGUMENTS_INVALID','layer_ops operation 不在白名单');
    if (a.operation !== 'list') boundedString(a.layerName,'layerName',120);
    if (a.operation === 'rename') boundedString(a.newName,'newName',120);
    if (a.operation === 'setOpacity') numberRange(a.opacity,'opacity',0,100);
    if (a.operation === 'setBlendMode' && !BLENDS.has(a.blendMode)) fail('PHOTOSHOP_ARGUMENTS_INVALID','blendMode 不在白名单');
  }
  if (action === 'adjust_image') {
    if (a.widthPx !== undefined) numberRange(a.widthPx,'widthPx',1,30000);
    if (a.heightPx !== undefined) numberRange(a.heightPx,'heightPx',1,30000);
    if (a.brightness !== undefined) numberRange(a.brightness,'brightness',-150,150);
    if (a.contrast !== undefined) numberRange(a.contrast,'contrast',-50,100);
    if (a.jpegQuality !== undefined && (!Number.isSafeInteger(a.jpegQuality) || a.jpegQuality < 1 || a.jpegQuality > 12)) fail('PHOTOSHOP_ARGUMENTS_INVALID','jpegQuality 必须是 1..12 整数');
  }
  if (action === 'run_jsx') {
    // 任意 ExtendScript：这是本人明确要求暴露给 Agent 的能力。
    // 只做"能传进去、不会撑爆管道"的约束；脚本能做什么由 Photoshop 与这台机器决定，
    // 我们不能也不该声称能安全沙箱它在 Adobe 的 ExtendScript 引擎里。
    if (typeof a.jsx !== 'string' || !a.jsx.trim()) fail('PHOTOSHOP_JSX_INVALID', 'jsx 必须是非空字符串');
    const bytes = Buffer.byteLength(a.jsx, 'utf8');
    if (bytes > MAX_JSX_BYTES) fail('PHOTOSHOP_JSX_TOO_LARGE', `jsx 超过 ${MAX_JSX_BYTES} 字节（实际 ${bytes}）`);
  }
  if (a.timeoutMs !== undefined) timeoutValue(a.timeoutMs, 60_000);
  progIdValue(a.progId);
  return a;
}

export function createPhotoshopService({ enabled = false, timeoutMs = 60_000, progId = null, spawnSyncImpl = spawnSync, command = 'powershell.exe' } = {}) {
  if (enabled !== true) return null;
  const defaultTimeout = timeoutValue(timeoutMs, 60_000);
  const configuredProgId = progIdValue(progId);
  if (typeof command !== 'string' || !command.trim()) fail('PHOTOSHOP_BRIDGE_INVALID','PowerShell command 必须非空');
  return {
    describe() { return { enabled:true, platform:'win32', bridge:'PowerShell → Photoshop COM → fixed action templates', arbitraryJsx:true, requiresHumanApproval:true, actions:[...ACTIONS], readActions:[...READ_ACTIONS], writeActions:[...WRITE_ACTIONS], jsxMaxBytes:MAX_JSX_BYTES }; },
    runAction({ action, arguments: raw = {}, confirm, timeoutMs: requestTimeout, progId: requestProgId } = {}) {
      const args = validate(action, raw);
      if (WRITE_ACTIONS.has(action) && confirm !== true) fail('PHOTOSHOP_CONFIRM_REQUIRED','Photoshop 写操作须逐次 DSH 审批');
      const duration = timeoutValue(requestTimeout, defaultTimeout);
      const selectedProgId = progIdValue(requestProgId) || configuredProgId || '';
      let result;
      try {
        result = spawnSyncImpl(command,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',BRIDGE,'-Action',action,'-ProgId',selectedProgId,'-TimeoutSeconds',String(Math.ceil(duration/1000))],{
          shell:false,windowsHide:true,encoding:'utf8',input:JSON.stringify(args),timeout:duration,maxBuffer:MAX_OUTPUT*4,
        });
      } catch (error) { throw new GenerationError('PHOTOSHOP_BRIDGE_START_FAILED',`PowerShell bridge 启动失败：${error?.message||error}`); }
      if (result.error) {
        if (result.error.code==='ETIMEDOUT') throw new GenerationError('PHOTOSHOP_RESULT_UNKNOWN','Photoshop 调用超时；文档可能已部分修改，先检查，不要盲目重试',{outcomeUnknown:true});
        throw new GenerationError('PHOTOSHOP_BRIDGE_START_FAILED',result.error.message);
      }
      const stdout=String(result.stdout||'').slice(0,MAX_OUTPUT).trim(), stderr=String(result.stderr||'').slice(0,MAX_OUTPUT).trim();
      if (result.status!==0) throw new GenerationError('PHOTOSHOP_BRIDGE_FAILED',`bridge 退出码 ${result.status}: ${(stderr||stdout||'无诊断输出').slice(0,800)}`);
      let payload; try { payload=JSON.parse(stdout); } catch { throw new GenerationError('PHOTOSHOP_BRIDGE_INVALID_RESPONSE',`bridge 返回非 JSON：${stdout.slice(0,400)}`); }
      if (payload?.ok!==true) throw new GenerationError('PHOTOSHOP_EXECUTION_FAILED',String(payload?.error||'Photoshop action failed'));
      return { action, progId:payload.progId||null, attached:payload.attached===true, result:payload.result??null, document:payload.document??null };
    },
  };
}

export const PHOTOSHOP_ACTIONS=Object.freeze([...ACTIONS]);
