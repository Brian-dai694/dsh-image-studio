import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorRelay } from '../lib/relay.js';

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
