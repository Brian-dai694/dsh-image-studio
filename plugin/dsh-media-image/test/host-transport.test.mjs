// 宿主页 transport 契约：白名单只放行 editor.highlight（结果走回包），selection_changed 走推送。
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

function makeTransport({ onEvent } = {}) {
  let editorPort = null;
  const iframe = {
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener() {},
    contentWindow: {
      postMessage(message, origin, transfer) {
        if (message.type === 'dsh.editor.connect') {
          editorPort = transfer[0];
          // 编辑器侧：收请求 → 回包（回包走同一个 port，方向反过来）
          editorPort.onmessage = ({ data }) => {
            if (data.type === 'editor.highlight') {
              editorPort.postMessage({ requestId: data.requestId, ok: true, result: { ok: true, matched: data.objectIds, missing: [] } });
            }
          };
          editorPort.postMessage({ requestId: message.requestId, ok: true, result: { editorInstanceId: 'ed-1', contractVersion: 1, ready: true } });
          return;
        }
        throw new Error('未知消息类型：' + message.type);
      },
    },
  };
  const transport = createIframeTransport({ iframe, origin: 'http://127.0.0.1:59302', MessageChannelClass: FakeChannel, makeId: () => 'req-' + Math.random().toString(16).slice(2), onEvent });
  return { transport, push: message => editorPort.postMessage(message) };
}

test('transport 只放行 editor.highlight，其结果走回包', async () => {
  const { transport } = makeTransport();
  const hello = await transport.connect();
  assert.equal(hello.editorInstanceId, 'ed-1');
  const result = await transport.request({ type: 'editor.highlight', requestId: 'r-1', editorInstanceId: 'ed-1', objectIds: ['layer-1'], ttlMs: 2000 });
  assert.deepEqual(result, { ok: true, matched: ['layer-1'], missing: [] });
  // 编造一个 highlight_result 请求类型必须被拒绝（它不是请求，只有回包）
  await assert.rejects(() => transport.request({ type: 'editor.highlight_result', requestId: 'r-2', editorInstanceId: 'ed-1' }), /不支持此消息类型/);
  transport.dispose();
});

test('selection_changed 是推送帧：不进 pending，直接交给 onEvent', async () => {
  const events = [];
  const { transport, push } = makeTransport({ onEvent: frame => events.push(frame) });
  await transport.connect();
  push({ type: 'editor.selection_changed', editorInstanceId: 'ed-1', revision: 3, selectedObjectIds: ['layer-1'], objectKind: 'layer', at: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'editor.selection_changed');
  assert.equal(events[0].revision, 3);
  assert.deepEqual(events[0].selectedObjectIds, ['layer-1']);
  // 不带 requestId 也不会被当成请求应答而丢在 pending 里
  assert.equal(events[0].requestId, undefined);
  transport.dispose();
});
