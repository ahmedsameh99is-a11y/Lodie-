import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type Database from 'better-sqlite3';
import type { BrandedModel } from '../src/shared/types';

let db: Database.Database;
let tempDbPath = '';
let streamModelResponse: typeof import('./providers/index').streamModelResponse;
let testProviderConnection: typeof import('./providers/index').testProviderConnection;

const savedOpenAiKey = process.env.OPENAI_API_KEY;
const savedOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

function makeFablesModel(overrides: Partial<BrandedModel> = {}): BrandedModel {
  return {
    id: 'fables-5.3',
    displayName: 'Fables 5.3',
    tier: 'premium',
    requiredPlan: 'premium',
    provider: 'openai-compatible',
    upstreamModelId: 'gpt-4.1',
    description: 'Editorial narrative engine',
    speedClass: 'Balanced',
    reasoningLevel: 'High',
    contextLimit: 200000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsStreaming: true,
    pricingSummary: 'Premium Plan & Developer Role',
    availability: 'connected',
    availabilityReason: 'Test fixture',
    thinkingPreset: 'HIGH',
    lastTestedAt: null,
    ...overrides,
  };
}

async function withLoopbackServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const srv = http.createServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(url);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

before(async () => {
  tempDbPath = path.join(os.tmpdir(), `loody-fables-providers-${process.pid}-${Date.now()}.db`);
  process.env.LOODY_DB_PATH = tempDbPath;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;

  const dbMod = await import('./db');
  db = dbMod.db;
  const provMod = await import('./providers/index');
  streamModelResponse = provMod.streamModelResponse;
  testProviderConnection = provMod.testProviderConnection;
});

after(() => {
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAiKey;
  if (savedOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = savedOpenAiBaseUrl;
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;

  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(`${tempDbPath}${ext}`, { force: true });
  }
});

test('Fables 5.3 reports awaiting_config / configuration_error when OpenAI and Anthropic keys are absent', async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  const openAiRes = await testProviderConnection(makeFablesModel({ provider: 'openai-compatible' }));
  assert.equal(openAiRes.ok, false);
  assert.equal(openAiRes.healthStatus, 'awaiting_config');
  assert.equal(openAiRes.errorClass, 'configuration_error');
  assert.match(openAiRes.message, /OPENAI_API_KEY/);

  const anthropicRes = await testProviderConnection(
    makeFablesModel({ provider: 'anthropic-compatible', upstreamModelId: 'claude-sonnet-4-5' })
  );
  assert.equal(anthropicRes.ok, false);
  assert.equal(anthropicRes.healthStatus, 'awaiting_config');
  assert.equal(anthropicRes.errorClass, 'configuration_error');
  assert.match(anthropicRes.message, /ANTHROPIC_API_KEY/);
});

test('openai-compatible adapter streams chunks, records usage, and omits reasoning_effort for gpt-4.1', async () => {
  let capturedBody: Record<string, unknown> | null = null;
  let capturedAuth = '';

  await withLoopbackServer((req, res) => {
    capturedAuth = String(req.headers.authorization ?? '');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      capturedBody = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
      res.write(
        'data: {"choices":[],"usage":{"prompt_tokens":14,"completion_tokens":6,"prompt_tokens_details":{"cached_tokens":3}}}\n\n'
      );
      res.end('data: [DONE]\n\n');
    });
  }, async (baseUrl) => {
    process.env.OPENAI_API_KEY = 'test-openai-loopback-key';
    process.env.OPENAI_BASE_URL = baseUrl;

    try {
      let text = '';
      let usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | undefined;
      await streamModelResponse({
        model: makeFablesModel({ provider: 'openai-compatible', upstreamModelId: 'gpt-4.1', thinkingPreset: 'HIGH' }),
        systemInstruction: 'Be concise',
        messages: [{ role: 'user', content: 'Say hi' }],
        callbacks: {
          onChunk: (chunk) => {
            text += chunk;
          },
          onUsage: (u) => {
            usage = u;
          },
        },
      });

      assert.equal(text, 'Hello world');
      assert.deepEqual(usage, { inputTokens: 14, outputTokens: 6, cachedTokens: 3 });
      assert.equal(capturedAuth, 'Bearer test-openai-loopback-key');
      assert.equal((capturedBody as { model?: string } | null)?.model, 'gpt-4.1');
      assert.equal('reasoning_effort' in (capturedBody ?? {}), false);
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });
});

test('openai-compatible adapter classifies 401 auth error, 429 quota_exceeded, 429 rate_limit, and timeout accurately', async () => {
  await withLoopbackServer((_req, res) => {
    // Hang slightly beyond 1000ms timeout
    setTimeout(() => {
      if (!res.destroyed) res.end();
    }, 1500);
  }, async (baseUrl) => {
    process.env.OPENAI_API_KEY = 'test-openai-loopback-key';
    process.env.OPENAI_BASE_URL = baseUrl;

    try {
      let aborted = false;
      try {
        await streamModelResponse({
          model: makeFablesModel(),
          timeoutMs: 1_000,
          messages: [{ role: 'user', content: 'timeout check' }],
          callbacks: { onChunk: () => {} },
        });
      } catch (err) {
        aborted = true;
        assert.equal((err as { errorClass?: string }).errorClass, 'latency');
        assert.equal((err as { healthStatus?: string }).healthStatus, 'temporarily_unavailable');
      }
      assert.equal(aborted, true);
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  // Explicit status classification checks against HTTP responses
  for (const tc of [
    {
      status: 401,
      body: { error: { message: 'Incorrect API key provided (invalid_api_key)' } },
      expectedHealth: 'authentication_error',
      expectedClass: 'auth_error',
    },
    {
      status: 429,
      body: { error: { message: 'You exceeded your current quota (insufficient_quota)' } },
      expectedHealth: 'temporarily_unavailable',
      expectedClass: 'quota_exceeded',
    },
    {
      status: 429,
      body: { error: { message: 'Rate limit reached for requests per minute' } },
      expectedHealth: 'temporarily_unavailable',
      expectedClass: 'rate_limit',
    },
  ]) {
    await withLoopbackServer((_req, res) => {
      res.writeHead(tc.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tc.body));
    }, async (baseUrl) => {
      process.env.OPENAI_API_KEY = 'test-openai-loopback-key';
      process.env.OPENAI_BASE_URL = baseUrl;
      try {
        const result = await testProviderConnection(makeFablesModel());
        assert.equal(result.ok, false);
        assert.equal(result.healthStatus, tc.expectedHealth);
        assert.equal(result.errorClass, tc.expectedClass);
      } finally {
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_BASE_URL;
      }
    });
  }
});

test('anthropic-compatible adapter parses SSE message_start, content_block_delta, message_delta usage, and 401 errors', async () => {
  await withLoopbackServer((req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey === 'bad-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":21,"cache_read_input_tokens":5}}}\n\n'
    );
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n'
    );
    res.write(
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n'
    );
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  }, async (baseUrl) => {
    db.prepare(
      "UPDATE model_registry SET provider = 'anthropic-compatible', upstream_model_id = 'claude-sonnet-4-5', custom_base_url = ? WHERE id = 'fables-5.3'"
    ).run(baseUrl);
    process.env.ANTHROPIC_API_KEY = 'good-key';

    try {
      let text = '';
      let usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | undefined;
      const model = makeFablesModel({
        provider: 'anthropic-compatible',
        upstreamModelId: 'claude-sonnet-4-5',
      });
      await streamModelResponse({
        model,
        messages: [{ role: 'user', content: 'Respond OK' }],
        callbacks: {
          onChunk: (chunk) => {
            text += chunk;
          },
          onUsage: (u) => {
            usage = u;
          },
        },
      });
      assert.equal(text, 'OK');
      assert.deepEqual(usage, { inputTokens: 21, outputTokens: 4, cachedTokens: 5 });

      process.env.ANTHROPIC_API_KEY = 'bad-key';
      const failed = await testProviderConnection(model);
      assert.equal(failed.ok, false);
      assert.equal(failed.healthStatus, 'authentication_error');
      assert.equal(failed.errorClass, 'auth_error');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
