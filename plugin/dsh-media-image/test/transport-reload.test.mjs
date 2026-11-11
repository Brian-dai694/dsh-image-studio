// 回归：首个 iframe load 不能被当成"页面重载"，否则握手会被自己的重载保护打断。
// 真实症状：页面永远注册不上 relay → Agent 侧只有 SESSION_BINDING_REQUIRED。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIframeTransport } from '../public/host/iframe-transport.mjs';

class FakePort {
  constructor() { this.onmessage = null; this.peer = null; this.closed = false; }
  postMessage(message) { const peer = this.peer; if (peer && !peer.closed) queueMicrotask(() => peer.onmessage?.({ data: message })); }
  start() {}
  close() { this.closed = true; }
}
class FakeChannel {
  constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); this.port1.peer = this.port2; this.port2.peer = this.port1; }
}

function harness() {
  let editorPort = null;
  const iframe = {
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener() {},
    contentWindow: {
      postMessage(message, _origin, transfer) {
        if (message.type !== 'dsh.editor.connect') throw new Error('unexpected ' + message.type);
        editorPort = transfer[0];
        editorPort.postMessage({ requestId: message.requestId, ok: true, result: { editorInstanceId: 'ed-1', contractVersion: 1, ready: true } });
      },
    },
  };
  const transport = createIframeTransport({ iframe, origin: 'http://127.0.0.1:59302', MessageChannelClass: FakeChannel, makeId: () => 'req-' + Math.random().toString(16).slice(2) });
  const fireLoad = () => iframe.listeners.load?.({ type: 'load' });
  return { transport, fireLoad };
}

test('首次 load 之后握手仍然成功（不会被当成页面重载）', async () => {
  const { transport, fireLoad } = harness();
  // 页面在 iframe 的 load 回调里发起 connect：这个 load 就是"当前这次加载"。
  fireLoad();
  const hello = await transport.connect();
  assert.equal(hello.editorInstanceId, 'ed-1');
  assert.equal(hello.ready, true);
  transport.dispose();
});

test('第二次 load 才算重载：在途请求以 EDITOR_INSTANCE_MISMATCH 明确失败', async () => {
  const { transport, fireLoad } = harness();
  fireLoad();
  await transport.connect();
  // 在途请求：编辑器不应答，随后页面重载 → 必须明确判为"结果未知"，不能静默超时。
  const inflight = transport.request({ type: 'editor.highlight', requestId: 'r-9', editorInstanceId: 'ed-1', objectIds: ['a'] });
  fireLoad();
  await assert.rejects(
    () => inflight,
    error => /^EDITOR_/.test(error.code) && error.outcomeUnknown === true,
  );
  transport.dispose();
});
