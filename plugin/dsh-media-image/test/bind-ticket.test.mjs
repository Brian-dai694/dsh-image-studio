// 面板授权票据（project-grant-v1）：票据不带 sessionId，按 (kind, projectId, instanceId, pageId) 索引；
// 会话身份在消费时由 trustedSessionId(exec) 补上；一次性、5 分钟；授权 8 小时软上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBindTickets } from '../lib/tickets.js';
import { createSessionBindings } from '../lib/gate.js';

const SESSION = 'session-a';
const PROJECT = 'project-1';
const INSTANCE = 'instance-1';
const PAGE = 'page-1';
const TARGET = { editorKind: 'image', projectId: PROJECT, editorInstanceId: INSTANCE, pageId: PAGE };

const execOf = () => ({ agent: { id: SESSION, session: { id: SESSION } } });
const stateOf = () => ({ documentId: PROJECT, revision: 3, stateDigest: 'digest-3', history: {} });

function harness({ ttlMs } = {}) {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const tickets = createBindTickets({ ...(ttlMs ? { ttlMs } : {}), now });
  const bindings = createSessionBindings({ resolvePage: () => ({ pageId: PAGE, editorInstanceId: INSTANCE, kind: 'image' }), tickets, now });
  return { tickets, bindings, advance: ms => { clock += ms; } };
}

test('票据一次性：认领成功后第二次必然 CONSUMED', () => {
  const tickets = createBindTickets();
  tickets.issue(TARGET);
  assert.equal(tickets.redeem(TARGET).ok, true);
  const second = tickets.redeem(TARGET);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'BIND_TICKET_CONSUMED');
});

test('票据 5 分钟过期', () => {
  const { tickets, advance } = harness();
  tickets.issue(TARGET);
  advance(5 * 60_000 + 1);
  const verdict = tickets.redeem(TARGET);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'BIND_TICKET_EXPIRED');
});

test('没有票据时认领失败（人没点就永远没有票据）', () => {
  const tickets = createBindTickets();
  const verdict = tickets.redeem(TARGET);
  assert.equal(verdict.code, 'BIND_TICKET_REQUIRED');
});

test('工程 / 页面 / 实例不符时不能认领', () => {
  const cases = [
    { ...TARGET, projectId: 'other-project' },
    { ...TARGET, pageId: 'other-page' },
    { ...TARGET, editorInstanceId: 'other-instance' },
    { ...TARGET, editorKind: 'video' },
  ];
  for (const bad of cases) {
    const tickets = createBindTickets();
    tickets.issue(TARGET);
    const verdict = tickets.redeem(bad);
    assert.equal(verdict.ok, false, JSON.stringify(bad));
  }
});

test('bind：有票据即登记 source=panel，不调用原生审批，grant 带 grantId/issuedAt/expiresAt', async () => {
  const { tickets, bindings } = harness();
  const ticket = tickets.issue(TARGET);
  let approveCalls = 0;
  const binding = await bindings.bind(execOf(), {
    editorKind: 'image', instanceId: INSTANCE, projectId: PROJECT,
    readState: async () => stateOf(),
    approve: async () => { approveCalls += 1; return { allowed: true }; },
  });
  assert.equal(approveCalls, 0, '面板票据路径不得再走原生审批');
  assert.equal(binding.source, 'panel');
  assert.equal(binding.sessionId, SESSION, '会话身份由 exec 补上，不由面板指定');
  assert.equal(binding.ticketId, ticket.ticketId);
  assert.equal(binding.issuedAt, ticket.issuedAt);
  assert.ok(binding.expiresAt > binding.issuedAt);
  const grant = bindings.auditLog().filter(entry => entry.action === 'grant');
  assert.equal(grant.length, 1);
  assert.equal(grant[0].source, 'panel');
});

test('bind：无票据且宿主审批被禁用 → SESSION_APPROVAL_UNAVAILABLE（不是用户拒绝）', async () => {
  const { bindings } = harness();
  for (const code of ['APPROVAL_DENIED', 'APPROVAL_UNAVAILABLE']) {
    await assert.rejects(
      bindings.bind(execOf(), {
        editorKind: 'image', instanceId: INSTANCE, projectId: PROJECT,
        readState: async () => stateOf(),
        approve: async () => ({ allowed: false, code, message: 'policy never' }),
      }),
      error => error.code === 'SESSION_APPROVAL_UNAVAILABLE' && /面板/.test(error.message),
      code,
    );
  }
  assert.equal(bindings.bindingOf(SESSION), null);
});

test('bind：原生审批允许时走 native，来源如实记录', async () => {
  const { bindings } = harness();
  const binding = await bindings.bind(execOf(), {
    editorKind: 'image', instanceId: INSTANCE, projectId: PROJECT,
    readState: async () => stateOf(),
    approve: async () => ({ allowed: true }),
  });
  assert.equal(binding.source, 'native');
});

test('grant 8 小时软上限：过期后 assert 明确回 SESSION_BINDING_EXPIRED', async () => {
  const { tickets, bindings, advance } = harness();
  tickets.issue(TARGET);
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: INSTANCE, projectId: PROJECT, readState: async () => stateOf() });
  advance(8 * 60 * 60_000 + 1);
  assert.throws(() => bindings.assert(execOf(), 'image', { instanceId: INSTANCE, projectId: PROJECT }), error => error.code === 'SESSION_BINDING_EXPIRED');
});

test('revokeByTarget：面板撤销后绑定清空', async () => {
  const { tickets, bindings } = harness();
  tickets.issue(TARGET);
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: INSTANCE, projectId: PROJECT, readState: async () => stateOf() });
  assert.equal(bindings.revokeByTarget({ editorKind: 'image', projectId: PROJECT, pageId: PAGE }), 1);
  assert.equal(bindings.bindingOf(SESSION), null);
});
