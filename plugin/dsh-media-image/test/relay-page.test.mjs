import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorRelay, createRelayHttpHandler } from '../lib/relay.js';

test('Host getPage returns immutable live routing without credentials or claimed session', () => {
  const relay = createEditorRelay({ editorKind: 'image' });
  try {
    assert.equal(relay.getPage('missing'), null);
    const registration = relay.register({ editorInstanceId: 'image-instance' });
    const page = relay.getPage('image-instance');
    assert.equal(page.pageId, registration.pageId);
    assert.equal(page.editorInstanceId, 'image-instance');
    assert.equal(page.kind, 'image');
    assert.equal(Object.isFrozen(page), true);
    assert.equal('pageToken' in page, false);
    assert.equal('token' in page, false);
    assert.equal('sessionId' in page, false);
    relay.disconnect(registration);
    assert.equal(relay.getPage('image-instance'), null);
  } finally { relay.close(); }
});

test('Host getPage fails closed after lease expiry and relay close', async () => {
  const relay = createEditorRelay({ leaseMs: 5 });
  relay.register({ editorInstanceId: 'expiring' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(relay.getPage('expiring'), null);
  relay.close();
  assert.equal(relay.getPage('expiring'), null);
});

test('HTTP action allowlist never exposes Host getPage', async () => {
  const relay = createEditorRelay();
  const handler = createRelayHttpHandler({ relay, origin: 'http://localhost:59301', accessToken: 'x'.repeat(32) });
  const req = { url: '/editor-relay/getPage', method: 'POST', headers: { host: 'localhost:59301', origin: 'http://localhost:59301', authorization: 'Bearer ' + 'x'.repeat(32), 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
  let status;
  try {
    await handler(req, { writeHead(value) { status = value; }, end() {} });
    assert.equal(status, 404);
  } finally { relay.close(); }
});
