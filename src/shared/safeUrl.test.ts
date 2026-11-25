import test from 'node:test';
import assert from 'node:assert/strict';
import { toSafeHref, toSafeMarkdownUrl } from './safeUrl';

test('toSafeHref allows http, https, mailto, hash, and root-relative paths while blocking unsafe protocols', () => {
  assert.equal(toSafeHref('https://example.com/path?a=1'), 'https://example.com/path?a=1');
  assert.equal(toSafeHref('http://localhost:3000/?share=abc'), 'http://localhost:3000/?share=abc');
  assert.equal(toSafeHref('mailto:support@loody.ai'), 'mailto:support@loody.ai');
  assert.equal(toSafeHref('/api/v1/files/123'), '/api/v1/files/123');
  assert.equal(toSafeHref('#section-1'), '#section-1');

  assert.equal(toSafeHref('javascript:alert(1)'), null);
  assert.equal(toSafeHref('  java\tscript:alert(1)'), null);
  assert.equal(toSafeHref('JaVaScRiPt:alert(document.cookie)'), null);
  assert.equal(toSafeHref('vbscript:msgbox(1)'), null);
  assert.equal(toSafeHref('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(toSafeHref('//evil.attacker.invalid/phish'), null);
  assert.equal(toSafeHref('file:///etc/passwd'), null);
});

test('toSafeMarkdownUrl allows raster data URIs only on img src and blocks active payloads', () => {
  const pngData = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(toSafeMarkdownUrl(pngData, 'src'), pngData);
  assert.equal(toSafeMarkdownUrl(pngData, 'href'), '');
  assert.equal(toSafeMarkdownUrl('data:image/svg+xml;base64,PHN2Zz4=', 'src'), '');
  assert.equal(toSafeMarkdownUrl('javascript:alert(1)', 'href'), '');
  assert.equal(toSafeMarkdownUrl('https://docs.example.org', 'href'), 'https://docs.example.org');
});
