import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationJson,
  buildConversationMarkdown,
  extractLanguageExtension,
  formatConversationJson,
  formatConversationMarkdown,
  isSupportedTextDocument,
  sanitizeExtractedText,
} from './chatExport';

test('formatConversationMarkdown renders title, model, and turns cleanly', () => {
  const md = formatConversationMarkdown(
    { title: 'Architecture Review', modelId: 'sonic-3', createdAt: '2026-11-19T00:00:00Z' },
    [
      { role: 'user', content: 'Review my rate limiter', createdAt: '2026-11-19T00:00:01Z' },
      { role: 'assistant', content: 'Use sliding window counters.', modelId: 'sonic-3', createdAt: '2026-11-19T00:00:02Z' },
    ]
  );
  assert.match(md, /^# Architecture Review/);
  assert.match(md, /### User/);
  assert.match(md, /### LOODY \(sonic-3\)/);
  assert.match(md, /Use sliding window counters\./);
});

test('buildConversationMarkdown and buildConversationJson wrap payload cleanly', () => {
  const md = buildConversationMarkdown({
    title: 'Design Notes',
    modelId: 'Sonic 3',
    messages: [{ role: 'user', content: 'Summarize API', createdAt: '2026-11-19T00:00:00Z' }],
  });
  assert.match(md, /# Design Notes/);
  const json = JSON.parse(
    buildConversationJson({
      title: 'Design Notes',
      modelId: 'Sonic 3',
      messages: [],
    })
  );
  assert.equal(json.platform, 'LOODY');
  assert.equal(json.conversation.title, 'Design Notes');
});

test('formatConversationJson outputs valid JSON with LOODY platform metadata', () => {
  const raw = formatConversationJson(
    {
      id: 'c1',
      title: 'Test',
      modelId: 'sonic-3',
      createdAt: '2026-11-19T00:00:00Z',
      updatedAt: '2026-11-19T00:00:05Z',
    },
    []
  );
  const parsed = JSON.parse(raw);
  assert.equal(parsed.platform, 'LOODY');
  assert.equal(parsed.conversation.id, 'c1');
});

test('isSupportedTextDocument identifies text/code files and rejects binary executables', () => {
  assert.equal(isSupportedTextDocument('notes.md', 'text/markdown'), true);
  assert.equal(isSupportedTextDocument('schema.ts', ''), true);
  assert.equal(isSupportedTextDocument('report.pdf', 'application/pdf'), false);
});

test('sanitizeExtractedText strips null bytes and truncates cleanly', () => {
  assert.equal(sanitizeExtractedText('hello\u0000world', 20), 'helloworld');
  const long = 'a'.repeat(50);
  const truncated = sanitizeExtractedText(long, 10);
  assert.equal(truncated.startsWith('aaaaaaaaaa'), true);
  assert.match(truncated, /Truncated/);
});

test('extractLanguageExtension maps common languages cleanly', () => {
  assert.equal(extractLanguageExtension('language-typescript'), 'ts');
  assert.equal(extractLanguageExtension('language-python'), 'py');
  assert.equal(extractLanguageExtension(undefined), 'txt');
});
