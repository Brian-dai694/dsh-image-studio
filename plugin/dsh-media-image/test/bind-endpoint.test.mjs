// 面板授权入口（project-grant-v1 §6）：只有同源页面能签发票据；面板只发 {instanceId}，
// 会话身份不进 HTTP；状态按实例维度读；解绑同样由本人点击。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaRouter } from '../lib/http.js';
import { createBindTickets } from '../lib/tickets.js';
import { createSessionBindings } from '../lib/gate.js';

const TOKEN = 'token-for-tests';
const PREFIX = '/media-image';
const SESSION = 'session-http';
const INSTANCE = 'instance-1';
const PAGE = 'page-1';
const PROJECT = 'project-1';

function harness() {
  const tickets = createBindTickets();
  const page = { pageId: PAGE, editorInstanceId: INSTANCE, kind: 'image' };
  const relay = {
    getPage: id => (id === INSTANCE ? page : null),
    request: async () => ({ documentId: PROJECT, revision: 0, stateDigest: 'digest-0', history: {} }),
  };
  const bindings = createSessionBindings({ resolvePage: () => page, tickets });
  const router = createMediaRouter({ relay, editorKind: 'image', prefix: PREFIX, token: TOKEN, publicDir: '.', tickets, bindings });
  const respond = () => {
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = chunk === undefined ? '' : String(chunk); } };
    return { res, out };
  };
  const call = async ({ method = 'POST', url, headers = {}, body }) => {
    const { res, out } = respond();
    const req = {
      method, url, headers,
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    };
    await router(req, res);
    let value = null;
    try { value = JSON.parse(out.body); } catch { value = null; }
    return { ...out, value };
  };
  const auth = { host: '127.0.0.1:1', 'x-dsh-media-relay': '1', 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
  return { tickets, bindings, call, auth };
}

test('没有令牌或不是同源时，授权入口一律拒绝', async () => {
  const { call } = harness();
  const noToken = await call({ url: `${PREFIX}/grant/ticket`, headers: { host: '127.0.0.1:1', 'x-dsh-media-relay': '1', 'content-type': 'application/json' }, body: { instanceId: INSTANCE } });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.value.reason, 'relay-auth-failed');
  const noHeader = await call({ url: `${PREFIX}/grant/ticket`, headers: { host: '127.0.0.1:1', 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: { instanceId: INSTANCE } });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.value.reason, 'missing-relay-header');
});

test('POST /grant/ticket 只发 instanceId 就能签票，票据里没有 sessionId', async () => {
  const { call, auth } = harness();
  const res = await call({ url: `${PREFIX}/grant/ticket`, headers: auth, body: { instanceId: INSTANCE } });
  assert.equal(res.status, 200);
  assert.equal(res.value.ok, true);
  assert.equal(res.value.ticket.projectId, PROJECT);
  assert.equal(res.value.ticket.pageId, PAGE);
  assert.equal(res.value.ticket.ttlMs, 5 * 60_000);
  assert.equal('sessionId' in res.value.ticket, false, '票据不得携带 sessionId');
});

test('页面未连接时 409 EDITOR_NOT_READY，不签空票据', async () => {
  const { call, auth } = harness();
  const res = await call({ url: `${PREFIX}/grant/ticket`, headers: auth, body: { instanceId: 'missing' } });
  assert.equal(res.status, 409);
  assert.equal(res.value.code, 'EDITOR_NOT_READY');
});

test('GET bind-status?instanceId 给面板四态数据：待激活 → 已授权', async () => {
  const { call, auth, bindings } = harness();
  await call({ url: `${PREFIX}/grant/ticket`, headers: auth, body: { instanceId: INSTANCE } });
  const before = await call({ method: 'GET', url: `${PREFIX}/bind-status?instanceId=${INSTANCE}`, headers: auth });
  assert.equal(before.status, 200);
  assert.ok(before.value.ticket, '签发后应看到待激活票据');
  assert.equal(before.value.grant, null);
  assert.equal(before.value.projectId, PROJECT);

  await bindings.bind({ agent: { id: SESSION, session: { id: SESSION } } }, {
    editorKind: 'image', instanceId: INSTANCE, projectId: PROJECT,
    readState: async () => ({ documentId: PROJECT, revision: 0, stateDigest: 'digest-0', history: {} }),
  });
  const after = await call({ method: 'GET', url: `${PREFIX}/bind-status?instanceId=${INSTANCE}&sessionId=${SESSION}`, headers: auth });
  assert.equal(after.value.ticket, null);
  assert.equal(after.value.grant.source, 'panel');
  assert.ok(after.value.grant.expiresInMs > 0);
});

test('POST /grant/unbind 清掉票据与授权', async () => {
  const { call, auth, bindings, tickets } = harness();
  await call({ url: `${PREFIX}/grant/ticket`, headers: auth, body: { instanceId: INSTANCE } });
  await bindings.bind({ agent: { id: SESSION, session: { id: SESSION } } }, {
    editorKind: 'image', instanceId: INSTANCE, projectId: PROJECT,
    readState: async () => ({ documentId: PROJECT, revision: 0, stateDigest: 'digest-0', history: {} }),
  });
  await call({ url: `${PREFIX}/grant/ticket`, headers: auth, body: { instanceId: INSTANCE } });
  const res = await call({ url: `${PREFIX}/grant/unbind`, headers: auth, body: { instanceId: INSTANCE } });
  assert.equal(res.status, 200);
  assert.equal(res.value.revoked, true);
  assert.equal(bindings.bindingOf(SESSION), null);
  assert.equal(tickets.pendingFor({ pageId: PAGE, projectId: PROJECT }), null);
});
