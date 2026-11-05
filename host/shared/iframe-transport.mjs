// Browser-parent transport. A Node Host cannot access iframe.contentWindow directly.
export function createIframeTransport({ iframe, origin, timeoutMs = 10000,
  MessageChannelClass = globalThis.MessageChannel, makeId = () => globalThis.crypto.randomUUID() }) {
  const targetOrigin = new URL(origin).origin;
  if (targetOrigin === 'null' || !iframe?.contentWindow || !MessageChannelClass) throw new TypeError('A live iframe, explicit non-opaque origin and MessageChannel are required.');
  let port = null;
  let editorInstanceId = null;
  let connecting = null;
  let disposed = false;
  const pending = new Map();
  const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });

  function reset(error) {
    editorInstanceId = null;
    port?.close();
    port = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function onLoad() {
    reset(failure('EDITOR_INSTANCE_MISMATCH', '编辑页面已重新加载；未完成命令的执行结果未知，请勿重放。', { outcomeUnknown: true }));
  }
  iframe.addEventListener('load', onLoad);

  function receive(event) {
    const message = event.data;
    if (!message || typeof message !== 'object' || typeof message.requestId !== 'string') return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message.result);
    else if (message.ok === false) entry.reject(failure(message.error?.code || 'EDITOR_ERROR', message.error?.message || '编辑器应答错误', { revision: message.error?.revision }));
    else entry.reject(failure('EDITOR_ERROR', '编辑器应答缺少 ok 状态'));
  }

  function waitFor(requestId, type, commandId, ms) {
    if (pending.has(requestId)) throw failure('INVALID_REQUEST', 'requestId 已在等待应答');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        const mutation = type === 'editor.apply_command';
        reject(failure(mutation ? 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' : 'EDITOR_TIMEOUT',
          mutation ? '命令应答超时，执行结果未知；请查询原 commandId。' : '编辑器应答超时。', { commandId }));
      }, ms);
      pending.set(requestId, { resolve, reject, timer });
    });
  }

  async function connect() {
    if (disposed) throw failure('EDITOR_NOT_READY', '通信通道已关闭');
    if (editorInstanceId) return { editorInstanceId, contractVersion: 1, ready: true };
    if (connecting) return connecting;
    const operation = (async () => {
      const channel = new MessageChannelClass();
      port = channel.port1;
      port.onmessage = receive;
      port.onmessageerror = () => reset(failure('EDITOR_ERROR', '无法解析编辑器消息；未完成命令结果未知', { outcomeUnknown: true }));
      port.start?.();
      const requestId = makeId();
      const response = waitFor(requestId, 'connect', null, timeoutMs);
      try {
        // Explicit targetOrigin; only this transferred MessagePort is trusted for replies.
        iframe.contentWindow.postMessage({ type: 'dsh.editor.connect', requestId }, targetOrigin, [channel.port2]);
      } catch (error) { reset(error); }
      const hello = await response;
      if (!hello?.ready || hello.contractVersion !== 1 || typeof hello.editorInstanceId !== 'string' || !hello.editorInstanceId) {
        reset(failure('EDITOR_NOT_READY', '编辑器握手内容无效'));
        throw failure('EDITOR_NOT_READY', '编辑器握手内容无效');
      }
      editorInstanceId = hello.editorInstanceId;
      return hello;
    })();
    connecting = operation;
    try { return await operation; }
    finally { connecting = null; }
  }

  return {
    connect,
    async request(message, options = {}) {
      if (!message || !['editor.read_state', 'editor.apply_command', 'editor.get_command_result', 'editor.export_start', 'editor.export_status'].includes(message.type)) throw failure('INVALID_REQUEST', '不支持此消息类型');
      if (options.allowedOrigin && new URL(options.allowedOrigin).origin !== targetOrigin) throw failure('INVALID_REQUEST', '请求来源配置不匹配');
      const hello = await connect();
      if (message.editorInstanceId !== hello.editorInstanceId) throw failure('EDITOR_INSTANCE_MISMATCH', '编辑器实例不匹配');
      if (typeof message.requestId !== 'string' || !message.requestId) throw failure('INVALID_REQUEST', '缺少 requestId');
      const response = waitFor(message.requestId, message.type, message.commandId, options.timeoutMs ?? timeoutMs);
      try { port.postMessage(message); }
      catch (error) { reset(failure('EDITOR_ERROR', '消息发送失败；命令结果未知', { outcomeUnknown: true, cause: error.message })); }
      return response;
    },
    dispose() {
      disposed = true;
      iframe.removeEventListener('load', onLoad);
      reset(failure('EDITOR_NOT_READY', '通信通道已释放；未完成命令结果未知', { outcomeUnknown: true }));
    },
  };
}
