// P0-1 回归：一个会话可以同时授权多条链路（人打开的面板页 + Host 拉起的无头页）。
// 之前绑定只按 sessionId 做键，第二条链路直接 SESSION_BINDING_MISMATCH，
// 任一条断开还会把整个会话打成 stale。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBindTickets } from '../lib/tickets.js';
import { createSessionBindings } from '../lib/gate.js';

const SESSION = 'session-a';
const execOf = () => ({ agent: { id: SESSION, session: { id: SESSION } } });

const PAGE_A = { pageId: 'page-human', editorInstanceId: 'inst-human', kind: 'image' };
const PAGE_B = { pageId: 'page-headless', editorInstanceId: 'inst-headless', kind: 'image' };
const HUMAN = { editorKind: 'image', projectId: 'project-human', editorInstanceId: 'inst-human', pageId: 'page-human' };
const HEADLESS = { editorKind: 'image', projectId: 'project-headless', editorInstanceId: 'inst-headless', pageId: 'page-headless' };

function harness() {
  const pages = new Map([[PAGE_A.editorInstanceId, PAGE_A], [PAGE_B.editorInstanceId, PAGE_B]]);
  const tickets = createBindTickets();
  const bindings = createSessionBindings({
    resolvePage: (_kind, instanceId) => pages.get(instanceId) ?? null,
    tickets,
  });
  return { tickets, bindings, pages };
}

const stateOf = projectId => () => ({ documentId: projectId, revision: 1, stateDigest: 'd-' + projectId });

test('同一会话可同时授权人页与无头页两条链路', async () => {
  const { tickets, bindings } = harness();
  tickets.issue(HUMAN);
  tickets.issue(HEADLESS);
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: 'inst-human', projectId: 'project-human', readState: stateOf('project-human') });
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: 'inst-headless', projectId: 'project-headless', readState: stateOf('project-headless') });

  assert.equal(bindings.assert(execOf(), 'image', { instanceId: 'inst-human', projectId: 'project-human' }).projectId, 'project-human');
  assert.equal(bindings.assert(execOf(), 'image', { instanceId: 'inst-headless', projectId: 'project-headless' }).projectId, 'project-headless');
  assert.equal(bindings.linksOf(SESSION).length, 2, '两条链路都要在册');
  assert.equal(bindings.bindingOf(SESSION, 'inst-headless').projectId, 'project-headless');
});

test('一条链路断开只作废自己，不牵连另一条', async () => {
  const { tickets, bindings, pages } = harness();
  tickets.issue(HUMAN);
  tickets.issue(HEADLESS);
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: 'inst-human', projectId: 'project-human', readState: stateOf('project-human') });
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: 'inst-headless', projectId: 'project-headless', readState: stateOf('project-headless') });

  pages.delete('inst-headless'); // 无头页被关掉
  assert.throws(
    () => bindings.assert(execOf(), 'image', { instanceId: 'inst-headless', projectId: 'project-headless' }),
    error => error.code === 'SESSION_BINDING_STALE',
  );
  // 人页必须还能用
  assert.equal(bindings.assert(execOf(), 'image', { instanceId: 'inst-human', projectId: 'project-human' }).pageId, 'page-human');
});

test('未授权的实例给出可区分的错误，而不是"整个会话没连上"', async () => {
  const { tickets, bindings } = harness();
  tickets.issue(HUMAN);
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: 'inst-human', projectId: 'project-human', readState: stateOf('project-human') });
  assert.throws(
    () => bindings.assert(execOf(), 'image', { instanceId: 'inst-headless', projectId: 'project-headless' }),
    error => error.code === 'SESSION_BINDING_MISMATCH' && /inst-human/.test(error.message),
  );
});

test('撤销按页面生效：只撤掉目标页面那条链路', async () => {
  const { tickets, bindings } = harness();
  tickets.issue(HUMAN);
  tickets.issue(HEADLESS);
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: 'inst-human', projectId: 'project-human', readState: stateOf('project-human') });
  await bindings.bind(execOf(), { editorKind: 'image', instanceId: 'inst-headless', projectId: 'project-headless', readState: stateOf('project-headless') });

  assert.equal(bindings.revokeByTarget({ editorKind: 'image', projectId: 'project-headless', pageId: 'page-headless' }), 1);
  assert.equal(bindings.bindingOf(SESSION, 'inst-headless'), null);
  assert.equal(bindings.assert(execOf(), 'image', { instanceId: 'inst-human', projectId: 'project-human' }).pageId, 'page-human');
});
