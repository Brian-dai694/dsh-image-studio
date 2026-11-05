// boot 令牌同源判据（图片包，与视频包同形）：自定义头为主，Sec-Fetch-Site 只做否定判断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootAllowed } from '../lib/http.js';

const H = { 'x-dsh-media-boot': '1' };

test('缺自定义头即拒绝', () => {
  const verdict = bootAllowed({ headers: {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'missing-boot-header');
  assert.deepEqual(verdict.observed, { site: null, dest: null, mode: null, origin: null });
});

test('跨站 / 同站异源一律拒绝', () => {
  for (const site of ['cross-site', 'same-site']) {
    const verdict = bootAllowed({ headers: { ...H, 'sec-fetch-site': site } });
    assert.equal(verdict.ok, false, site);
    assert.equal(verdict.reason, 'sec-fetch-site');
    assert.equal(verdict.observed.site, site);
  }
});

test('带自定义头且非跨站放行（含桌面端不带 Sec-Fetch-* 的情况）', () => {
  assert.equal(bootAllowed({ headers: { ...H } }).ok, true);
  assert.equal(bootAllowed({ headers: { ...H, 'sec-fetch-site': 'same-origin' } }).ok, true);
  assert.equal(bootAllowed({ headers: { ...H, 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' } }).ok, true);
});

test('403 观测值带 site/dest/mode/origin', () => {
  const verdict = bootAllowed({ headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', origin: 'https://evil.example' } });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.observed, { site: 'cross-site', dest: 'empty', mode: 'cors', origin: 'https://evil.example' });
});
