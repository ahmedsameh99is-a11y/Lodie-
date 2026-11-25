import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeSseReadableStream,
  createSseStreamProcessor,
  parseSharedTranscriptSafely,
  reconcileStreamMessages,
} from './chatStream';
import type { ChatMessage } from './types';

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

test('createSseStreamProcessor parses split chunks, CRLF lines, and trailing buffered data without final newline', () => {
  const events: Array<{ type: string; payload: unknown }> = [];
  const proc = createSseStreamProcessor({
    onMeta: (m) => events.push({ type: 'meta', payload: m }),
    onChunk: (t) => events.push({ type: 'chunk', payload: t }),
    onDone: (d) => events.push({ type: 'done', payload: d }),
    onError: (e) => events.push({ type: 'error', payload: e }),
  });

  proc.feed('event: meta\r\ndata: {"conversationId":"c1"');
  proc.feed(',"userMessageId":"u1"}\r\n\r\n');
  proc.feed('event: chunk\ndata: {"te');
  proc.feed('xt":"Hello "}\n\nevent: chunk\ndata: {"text":"LOODY"}\n\n');
  proc.feed('event: done\ndata: {"conversationId":"c1","messageId":"a1"}'); // intentionally no trailing newline

  const summary = proc.finalize();
  assert.equal(summary.receivedMeta, true);
  assert.equal(summary.receivedDone, true);
  assert.equal(summary.receivedError, false);
  assert.equal(summary.chunkCount, 2);
  assert.deepEqual(events, [
    { type: 'meta', payload: { conversationId: 'c1', userMessageId: 'u1' } },
    { type: 'chunk', payload: 'Hello ' },
    { type: 'chunk', payload: 'LOODY' },
    { type: 'done', payload: { conversationId: 'c1', messageId: 'a1' } },
  ]);
});

test('consumeSseReadableStream detects unexpected EOF without done/error and preserves partial chunks', async () => {
  const chunks: string[] = [];
  const errors: Array<{ msg: string; unexpectedEof?: boolean }> = [];
  const stream = makeStream([
    'event: meta\ndata: {"conversationId":"c2","userMessageId":"u2"}\n\n',
    'event: chunk\ndata: {"text":"Partial answer "}\n\n',
    'event: chunk\ndata: {"text":"before drop"}\n\n',
  ]);

  const summary = await consumeSseReadableStream(stream, {
    onMeta: () => {},
    onChunk: (t) => chunks.push(t),
    onDone: () => assert.fail('onDone should not be called on unexpected EOF'),
    onError: (msg, meta) => errors.push({ msg, unexpectedEof: meta?.unexpectedEof }),
  });

  assert.equal(chunks.join(''), 'Partial answer before drop');
  assert.equal(summary.receivedDone, false);
  assert.equal(summary.receivedError, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].unexpectedEof, true);
  assert.match(errors[0].msg, /Partial response was preserved/i);
});

test('consumeSseReadableStream handles explicit provider error without firing duplicate EOF error', async () => {
  const errors: Array<{ msg: string; partialSaved?: boolean; unexpectedEof?: boolean }> = [];
  const stream = makeStream([
    'event: meta\ndata: {"conversationId":"c3","userMessageId":"u3"}\n\n',
    'event: error\ndata: {"error":"Provider timeout","conversationId":"c3","partialSaved":false}\n\n',
  ]);

  const summary = await consumeSseReadableStream(stream, {
    onMeta: () => {},
    onChunk: () => {},
    onDone: () => {},
    onError: (msg, meta) =>
      errors.push({ msg, partialSaved: meta?.partialSaved, unexpectedEof: meta?.unexpectedEof }),
  });

  assert.equal(summary.receivedError, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].msg, 'Provider timeout');
  assert.equal(errors[0].unexpectedEof, undefined);
});

test('consumeSseReadableStream handles malformed JSON on terminal event cleanly', async () => {
  const errors: string[] = [];
  const stream = makeStream(['event: error\ndata: {broken_json\n\n']);

  const summary = await consumeSseReadableStream(stream, {
    onMeta: () => {},
    onChunk: () => {},
    onDone: () => {},
    onError: (msg) => errors.push(msg),
  });

  assert.equal(summary.receivedError, true);
  assert.equal(summary.parseErrorCount, 1);
  assert.equal(errors.length, 1);
});

test('consumeSseReadableStream rejects with AbortError on AbortController cancellation', async () => {
  const ac = new AbortController();
  ac.abort();
  const stream = makeStream(['event: meta\ndata: {"conversationId":"c4"}\n\n']);

  await assert.rejects(
    () =>
      consumeSseReadableStream(
        stream,
        {
          onMeta: () => {},
          onChunk: () => {},
          onDone: () => {},
          onError: () => assert.fail('onError should not run on user AbortError'),
        },
        ac.signal
      ),
    (err: Error) => err.name === 'AbortError'
  );
});

test('reconcileStreamMessages preserves unsaved partial output and never duplicates DB-persisted replies', () => {
  const userMsg: ChatMessage = {
    id: 'u10',
    conversationId: 'c10',
    role: 'user',
    content: 'Hello',
    createdAt: '2026-11-21T00:00:00Z',
  };
  const dbSavedAssistant: ChatMessage = {
    id: 'a10',
    conversationId: 'c10',
    role: 'assistant',
    content: 'Partial saved by server',
    modelId: 'sonic-3',
    createdAt: '2026-11-21T00:00:01Z',
  };

  // Case A: Server did not save yet -> append local partial
  const mergedLocal = reconcileStreamMessages({
    dbMessages: [userMsg],
    fallbackMessages: [userMsg],
    streamedText: 'Local buffered text',
    conversationId: 'c10',
    modelId: 'sonic-3',
    localPartialId: 'partial-1',
    userMessageIdFromServer: 'u10',
  });
  assert.equal(mergedLocal.length, 2);
  assert.equal(mergedLocal[1].id, 'partial-1');
  assert.equal(mergedLocal[1].content, 'Local buffered text');

  // Case B: Server already saved assistant reply -> no duplicate added
  const mergedDb = reconcileStreamMessages({
    dbMessages: [userMsg, dbSavedAssistant],
    fallbackMessages: [userMsg],
    streamedText: 'Partial saved by server',
    conversationId: 'c10',
    modelId: 'sonic-3',
    localPartialId: 'partial-1',
    userMessageIdFromServer: 'u10',
    serverAssistantMessageId: 'a10',
  });
  assert.equal(mergedDb.length, 2);
  assert.equal(mergedDb[1].id, 'a10');
});

test('parseSharedTranscriptSafely handles valid, invalid type, and corrupted JSON safely', () => {
  const valid = parseSharedTranscriptSafely(JSON.stringify([{ role: 'user', content: 'Hi' }]));
  assert.equal(valid.ok, true);
  assert.equal(valid.messages.length, 1);
  assert.equal(valid.messages[0].content, 'Hi');

  const nonArray = parseSharedTranscriptSafely(JSON.stringify({ wrong: true }));
  assert.equal(nonArray.ok, false);
  assert.equal(nonArray.messages.length, 0);
  assert.ok(nonArray.error);

  const malformed = parseSharedTranscriptSafely('{not-valid-json');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.messages.length, 0);
  assert.ok(malformed.error);
});

test('createSseStreamProcessor dispatches real status events without breaking chunk/done flow', () => {
  const stages: Array<{ stage: string; detail?: string }> = [];
  const chunks: string[] = [];
  const proc = createSseStreamProcessor({
    onMeta: () => {},
    onStatus: (s) => stages.push(s),
    onChunk: (c) => chunks.push(c),
    onDone: () => {},
    onError: () => assert.fail('unexpected error'),
  });

  proc.feed('event: status\ndata: {"stage":"searching"}\n\n');
  proc.feed('event: status\ndata: {"stage":"reading_');
  proc.feed('sources","detail":"2 citations"}\n\n');
  proc.feed('event: status\ndata: {"stage":"generating"}\n\n');
  proc.feed('event: chunk\ndata: {"text":"Done"}\n\n');
  proc.feed('event: done\ndata: {"conversationId":"c1"}\n\n');
  const summary = proc.finalize();

  assert.equal(summary.receivedDone, true);
  assert.deepEqual(stages, [
    { stage: 'searching', detail: undefined },
    { stage: 'reading_sources', detail: '2 citations' },
    { stage: 'generating', detail: undefined },
  ]);
  assert.deepEqual(chunks, ['Done']);
});

