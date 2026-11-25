import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import type { BrandedModel, ProviderId } from '../src/shared/types';

let db: Database.Database;
let app: Express;
let tempDbPath = '';
let streamModelResponse: typeof import('./providers/index').streamModelResponse;
let testProviderConnection: typeof import('./providers/index').testProviderConnection;

const envBackup: Record<string, string | undefined> = {};
const managedEnvVars = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'MISTRAL_API_KEY', 'MISTRAL_BASE_URL',
  'COHERE_API_KEY', 'COHERE_BASE_URL',
  'XAI_API_KEY', 'XAI_BASE_URL',
  'AI21_API_KEY', 'AI21_BASE_URL',
  'GROQ_API_KEY', 'GROQ_BASE_URL',
  'CEREBRAS_API_KEY', 'CEREBRAS_BASE_URL',
  'SAMBANOVA_API_KEY', 'SAMBANOVA_BASE_URL',
  'TOGETHER_API_KEY', 'TOGETHER_BASE_URL',
  'FIREWORKS_API_KEY', 'FIREWORKS_BASE_URL',
  'GITHUB_TOKEN',
  'HUGGINGFACE_API_KEY', 'HUGGINGFACE_BASE_URL',
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_BASE_URL',
  'NVIDIA_API_KEY', 'NVIDIA_BASE_URL',
  'DEEPINFRA_API_KEY', 'DEEPINFRA_BASE_URL',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL',
  'GEMINI_API_KEY',
];

function clearProviderEnvs() {
  for (const key of managedEnvVars) {
    delete process.env[key];
  }
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

function makeModel(overrides: Partial<BrandedModel> = {}): BrandedModel {
  return {
    id: 'sonic-3',
    displayName: 'Sonic 3',
    tier: 'free',
    requiredPlan: 'free',
    provider: 'groq',
    upstreamModelId: 'openai/gpt-oss-20b',
    description: 'Test model',
    speedClass: 'Ultra-Fast',
    reasoningLevel: 'Standard',
    contextLimit: 128_000,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsStreaming: true,
    pricingSummary: 'Test',
    availability: 'connected',
    availabilityReason: 'Test',
    lastTestedAt: null,
    ...overrides,
  };
}

before(async () => {
  for (const key of managedEnvVars) {
    envBackup[key] = process.env[key];
  }
  clearProviderEnvs();

  tempDbPath = path.join(os.tmpdir(), `loody-multiprovider-${process.pid}-${Date.now()}.db`);
  process.env.LOODY_DB_PATH = tempDbPath;

  const dbMod = await import('./db');
  db = dbMod.db;
  const provMod = await import('./providers/index');
  streamModelResponse = provMod.streamModelResponse;
  testProviderConnection = provMod.testProviderConnection;
  const appMod = await import('./app');
  app = appMod.createApiApp();
});

after(() => {
  for (const key of managedEnvVars) {
    const val = envBackup[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(`${tempDbPath}${ext}`, { force: true });
  }
});

test('All OpenAI-compatible new providers stream SSE, send expected auth headers, and handle vision payloads', async () => {
  const providerCases: Array<{
    provider: ProviderId;
    keyEnv: string;
    baseEnv: string;
    upstream: string;
    supportsVision: boolean;
  }> = [
    { provider: 'mistral', keyEnv: 'MISTRAL_API_KEY', baseEnv: 'MISTRAL_BASE_URL', upstream: 'pixtral-large-latest', supportsVision: true },
    { provider: 'xai', keyEnv: 'XAI_API_KEY', baseEnv: 'XAI_BASE_URL', upstream: 'grok-2-vision', supportsVision: true },
    { provider: 'ai21', keyEnv: 'AI21_API_KEY', baseEnv: 'AI21_BASE_URL', upstream: 'jamba-mini', supportsVision: false },
    { provider: 'groq', keyEnv: 'GROQ_API_KEY', baseEnv: 'GROQ_BASE_URL', upstream: 'openai/gpt-oss-120b', supportsVision: false },
    { provider: 'cerebras', keyEnv: 'CEREBRAS_API_KEY', baseEnv: 'CEREBRAS_BASE_URL', upstream: 'llama3.1-8b', supportsVision: false },
    { provider: 'sambanova', keyEnv: 'SAMBANOVA_API_KEY', baseEnv: 'SAMBANOVA_BASE_URL', upstream: 'Meta-Llama-3.3-70B-Instruct', supportsVision: false },
    { provider: 'together', keyEnv: 'TOGETHER_API_KEY', baseEnv: 'TOGETHER_BASE_URL', upstream: 'Qwen/Qwen3.5-9B', supportsVision: true },
    { provider: 'fireworks', keyEnv: 'FIREWORKS_API_KEY', baseEnv: 'FIREWORKS_BASE_URL', upstream: 'accounts/fireworks/models/deepseek-v3', supportsVision: false },
    { provider: 'huggingface', keyEnv: 'HUGGINGFACE_API_KEY', baseEnv: 'HUGGINGFACE_BASE_URL', upstream: 'meta-llama/Llama-3.1-8B-Instruct', supportsVision: false },
    { provider: 'nvidia', keyEnv: 'NVIDIA_API_KEY', baseEnv: 'NVIDIA_BASE_URL', upstream: 'meta/llama-3.2-11b-vision-instruct', supportsVision: true },
    { provider: 'deepinfra', keyEnv: 'DEEPINFRA_API_KEY', baseEnv: 'DEEPINFRA_BASE_URL', upstream: 'meta-llama/Llama-3.3-70B-Instruct', supportsVision: false },
    { provider: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', baseEnv: 'OPENROUTER_BASE_URL', upstream: 'meta-llama/llama-3.3-70b-instruct', supportsVision: true },
  ];

  for (const tc of providerCases) {
    let seenAuth = '';
    let seenBody: Record<string, any> | null = null;
    let seenOpenRouterTitle = '';

    await withLoopbackServer((req, res) => {
      seenAuth = String(req.headers.authorization ?? '');
      seenOpenRouterTitle = String(req.headers['x-openrouter-title'] ?? '');
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seenBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: {"choices":[{"delta":{"content":"Ack ${tc.provider}"}}]}\n\n`);
        res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n');
        res.end('data: [DONE]\n\n');
      });
    }, async (baseUrl) => {
      process.env[tc.keyEnv] = `key-${tc.provider}`;
      process.env[tc.baseEnv] = baseUrl;
      try {
        let output = '';
        await streamModelResponse({
          model: makeModel({
            id: tc.supportsVision ? 'loody-vision-1' : 'sonic-3',
            provider: tc.provider,
            upstreamModelId: tc.upstream,
            inputModalities: tc.supportsVision ? ['text', 'image'] : ['text'],
          }),
          systemInstruction: 'System prompt',
          messages: [
            {
              role: 'user',
              content: 'Analyze',
              attachments: tc.supportsVision
                ? [{ mimeType: 'image/png', dataBase64: 'AAAA', name: 'img.png', sizeBytes: 4 }]
                : undefined,
            },
          ],
          callbacks: {
            onChunk: (t) => {
              output += t;
            },
          },
        });
        assert.equal(output, `Ack ${tc.provider}`);
        assert.equal(seenAuth, `Bearer key-${tc.provider}`);
        assert.equal(seenBody?.model, tc.upstream);
        if (tc.supportsVision) {
          const userMsg = seenBody?.messages?.find((m: any) => m.role === 'user');
          assert.ok(Array.isArray(userMsg?.content));
          assert.equal(userMsg.content[1]?.image_url?.url, 'data:image/png;base64,AAAA');
        }
        if (tc.provider === 'openrouter') {
          assert.equal(seenOpenRouterTitle, 'LOODY AI Workspace');
        }
      } finally {
        delete process.env[tc.keyEnv];
        delete process.env[tc.baseEnv];
      }
    });
  }
});

test('Cohere v2 native SSE streaming, Cloudflare dual-credential check, Anthropic prompt caching, and retired GitHub Models work accurately', async () => {
  // 1. Cohere /v2/chat SSE
  await withLoopbackServer((req, res) => {
    assert.equal(req.url, '/v2/chat');
    assert.equal(req.headers.authorization, 'Bearer test-cohere-key');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: content-delta\ndata: {"type":"content-delta","delta":{"message":{"content":{"text":"مرحبا "}}}}\n\n');
    res.write('event: content-delta\ndata: {"type":"content-delta","delta":{"message":{"content":{"text":"Cohere"}}}}\n\n');
    res.write('event: message-end\ndata: {"type":"message-end","delta":{"usage":{"tokens":{"input_tokens":18,"output_tokens":7}}}}\n\n');
    res.end();
  }, async (baseUrl) => {
    process.env.COHERE_API_KEY = 'test-cohere-key';
    process.env.COHERE_BASE_URL = baseUrl;
    try {
      let text = '';
      let usage: any;
      await streamModelResponse({
        model: makeModel({ id: 'fables-5.3', provider: 'cohere', upstreamModelId: 'command-a' }),
        systemInstruction: 'Be helpful in Arabic',
        messages: [{ role: 'user', content: 'مرحبا' }],
        callbacks: {
          onChunk: (c) => (text += c),
          onUsage: (u) => (usage = u),
        },
      });
      assert.equal(text, 'مرحبا Cohere');
      assert.deepEqual(usage, { inputTokens: 18, outputTokens: 7, cachedTokens: 0 });
    } finally {
      delete process.env.COHERE_API_KEY;
      delete process.env.COHERE_BASE_URL;
    }
  });

  // 2. Cloudflare Workers AI requires BOTH CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
  process.env.CLOUDFLARE_API_TOKEN = 'cf-only-token';
  const cfMissingAcc = await testProviderConnection(
    makeModel({ id: 'sonic-3', provider: 'cloudflare', upstreamModelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' })
  );
  assert.equal(cfMissingAcc.ok, false);
  assert.equal(cfMissingAcc.healthStatus, 'awaiting_config');
  assert.match(cfMissingAcc.message, /CLOUDFLARE_ACCOUNT_ID/);
  delete process.env.CLOUDFLARE_API_TOKEN;

  await withLoopbackServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer cf-tok');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"CF-OK"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  }, async (baseUrl) => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_12345678';
    process.env.CLOUDFLARE_API_TOKEN = 'cf-tok';
    process.env.CLOUDFLARE_BASE_URL = baseUrl;
    try {
      let text = '';
      await streamModelResponse({
        model: makeModel({ id: 'sonic-3', provider: 'cloudflare', upstreamModelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
        messages: [{ role: 'user', content: 'Hi' }],
        callbacks: { onChunk: (c) => (text += c) },
      });
      assert.equal(text, 'CF-OK');
    } finally {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      delete process.env.CLOUDFLARE_API_TOKEN;
      delete process.env.CLOUDFLARE_BASE_URL;
    }
  });

  // 3. Anthropic ephemeral cache_control for long system prompt
  let capturedAnthropicBody: Record<string, any> | null = null;
  await withLoopbackServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      capturedAnthropicBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"CachedOK"}}\n\n');
      res.end();
    });
  }, async (baseUrl) => {
    process.env.ANTHROPIC_API_KEY = 'anth-key';
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    try {
      let text = '';
      await streamModelResponse({
        model: makeModel({ id: 'lodie-5.5', provider: 'anthropic-compatible', upstreamModelId: 'claude-sonnet-4-5' }),
        systemInstruction: 'X'.repeat(1200),
        messages: [{ role: 'user', content: 'Hi' }],
        callbacks: { onChunk: (c) => (text += c) },
      });
      assert.equal(text, 'CachedOK');
      assert.ok(Array.isArray(capturedAnthropicBody?.system));
      assert.deepEqual(capturedAnthropicBody?.system?.[0]?.cache_control, { type: 'ephemeral' });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });

  // 4. GitHub Models retired July 30, 2026
  process.env.GITHUB_TOKEN = 'ghp_dummy';
  const ghProbe = await testProviderConnection(
    makeModel({ id: 'sonic-3', provider: 'github-models', upstreamModelId: 'gpt-4.1-mini' })
  );
  assert.equal(ghProbe.ok, false);
  assert.equal(ghProbe.errorClass, 'configuration_error');
  assert.match(ghProbe.message, /retired/i);
  delete process.env.GITHUB_TOKEN;
});

test('End-to-end /chat/stream failover preserves LOODY branded model, supports Arabic RTL, concurrency, cancellation, and blocks secret leaks', async () => {
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  const apiUrl = `http://127.0.0.1:${port}`;

  // Loopback primary (Groq returns 429 rate limit) and backup (Mistral responds cleanly in Arabic & English)
  let groqHits = 0;
  let mistralHits = 0;

  try {
    await withLoopbackServer((_req, res) => {
      groqHits++;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
    }, async (groqBase) => {
      await withLoopbackServer((req, res) => {
        mistralHits++;
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const parsed = JSON.parse(raw);
          const lastUser = String(parsed.messages?.[parsed.messages.length - 1]?.content ?? '');
          if (lastUser.includes('Slow cancel test')) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"Partial "}}]}\n\n');
            const timer = setTimeout(() => {
              if (!res.writableEnded) {
                res.write('data: {"choices":[{"delta":{"content":"End"}}]}\n\n');
                res.end('data: [DONE]\n\n');
              }
            }, 350);
            req.on('close', () => clearTimeout(timer));
            return;
          }
          const reply = /[\u0600-\u06FF]/.test(lastUser)
            ? 'مرحباً! تم التنفيذ بنجاح.'
            : 'Hello from fallback provider!';
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: {"choices":[{"delta":{"content":${JSON.stringify(reply)}}}]}\n\n`);
          res.end('data: [DONE]\n\n');
        });
      }, async (mistralBase) => {
        // Configure sonic-3 primary in registry to groq, plus MISTRAL_API_KEY as fallback
        db.prepare("UPDATE model_registry SET provider = 'groq', upstream_model_id = 'openai/gpt-oss-20b', availability = 'operational' WHERE id = 'sonic-3'").run();
        process.env.GROQ_API_KEY = 'secret-groq-do-not-leak';
        process.env.GROQ_BASE_URL = groqBase;
        process.env.MISTRAL_API_KEY = 'secret-mistral-do-not-leak';
        process.env.MISTRAL_BASE_URL = mistralBase;

        try {
          // 1. Register user
          const regRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: `multi-${Date.now()}@loody.test`,
              password: 'TestPassword123!',
              displayName: 'Multi Tester',
            }),
          });
          assert.equal(regRes.status, 201);
          const cookie = regRes.headers.get('set-cookie')?.split(';')[0] ?? '';
          assert.ok(cookie);

          // 2. Check /models/matrix never leaks secrets & unauthorized blocks /providers/:id/test
          const matrixRes = await fetch(`${apiUrl}/api/v1/models/matrix`, {
            headers: { Cookie: cookie },
          });
          assert.equal(matrixRes.status, 200);
          const matrixText = await matrixRes.text();
          assert.equal(matrixText.includes('secret-groq-do-not-leak'), false);
          assert.equal(matrixText.includes('secret-mistral-do-not-leak'), false);

          const devBlocked = await fetch(`${apiUrl}/api/v1/models/providers/groq/test`, {
            method: 'POST',
            headers: { Cookie: cookie },
          });
          assert.equal(devBlocked.status, 403);

          // 3. Streaming chat triggers automatic failover groq (429) -> mistral (200) while preserving sonic-3!
          const chatRes = await fetch(`${apiUrl}/api/v1/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({
              modelId: 'sonic-3',
              prompt: 'اكتب لي ملخصاً سريعاً بالعربية',
              orchestrationMode: 'fast',
            }),
          });
          assert.equal(chatRes.status, 200);
          const sseText = await chatRes.text();
          assert.ok(groqHits >= 1);
          assert.ok(mistralHits >= 1);
          assert.match(sseText, /مرحباً! تم التنفيذ بنجاح\./);
          assert.match(sseText, /"modelId":"sonic-3"/);
          assert.match(sseText, /event: done/);

          // 4. Concurrent follow-up English & coding requests succeed cleanly
          const [r1, r2] = await Promise.all([
            fetch(`${apiUrl}/api/v1/chat/stream`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Cookie: cookie },
              body: JSON.stringify({ modelId: 'sonic-3', prompt: 'Explain binary search in TypeScript', orchestrationMode: 'coding' }),
            }),
            fetch(`${apiUrl}/api/v1/chat/stream`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Cookie: cookie },
              body: JSON.stringify({ modelId: 'sonic-3', prompt: 'Hello test', orchestrationMode: 'fast' }),
            }),
          ]);
          assert.equal(r1.status, 200);
          assert.equal(r2.status, 200);
          const t1 = await r1.text();
          const t2 = await r2.text();
          assert.match(t1, /Hello from fallback provider!/);
          assert.match(t2, /Hello from fallback provider!/);

          // 5. Mid-stream AbortController cancellation terminates cleanly without crashing server
          const ac = new AbortController();
          const cancelResp = await fetch(`${apiUrl}/api/v1/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            signal: ac.signal,
            body: JSON.stringify({ modelId: 'sonic-3', prompt: 'Slow cancel test', orchestrationMode: 'fast' }),
          });
          assert.equal(cancelResp.status, 200);
          setTimeout(() => ac.abort(), 30);
          await assert.rejects(
            cancelResp.text(),
            (e: unknown) => (e as { name?: string })?.name === 'AbortError'
          );
        } finally {
          clearProviderEnvs();
        }
      });
    });
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('Strict model identity preservation blocks cross-identity switching, forwards Retry-After, injects dynamic LOODY identity directive, and logs upstream_model_id', async () => {
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  const apiUrl = `http://127.0.0.1:${port}`;
  const orchMod = await import('./orchestratorRuntime');

  let capturedMistralSystem = '';
  try {
    await withLoopbackServer((_req, res) => {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '2',
      });
      res.end(JSON.stringify({ error: { message: 'Groq rate limit exceeded' } }));
    }, async (groqBase) => {
      await withLoopbackServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const parsed = JSON.parse(raw);
          capturedMistralSystem = String(parsed.messages?.find((m: any) => m.role === 'system')?.content ?? '');
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"Backup Sonic 3 response"}}]}\n\n');
          res.write('data: {"choices":[],"usage":{"prompt_tokens":32,"completion_tokens":14}}\n\n');
          res.end('data: [DONE]\n\n');
        });
      }, async (mistralBase) => {
        clearProviderEnvs();
        orchMod.resetProviderCircuit('groq');
        orchMod.resetProviderCircuit('mistral');
        db.prepare("UPDATE model_registry SET provider = 'groq', upstream_model_id = 'openai/gpt-oss-120b', availability = 'operational' WHERE id = 'fables-5.3'").run();
        db.prepare("UPDATE model_registry SET provider = 'groq', upstream_model_id = 'openai/gpt-oss-20b', availability = 'operational' WHERE id = 'sonic-3'").run();
        db.prepare("UPDATE model_registry SET availability = 'operational' WHERE id = 'sonic-3.5'").run();

        process.env.GROQ_API_KEY = 'secret-groq-key';
        process.env.GROQ_BASE_URL = groqBase;

        try {
          // Register developer user so we can also assert Retry-After parsing on /providers/groq/test
          const email = `strict-${Date.now()}@loody.test`;
          const regRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: 'TestPassword123!', displayName: 'Strict Tester' }),
          });
          assert.equal(regRes.status, 201);
          const cookie = regRes.headers.get('set-cookie')?.split(';')[0] ?? '';
          db.prepare("UPDATE users SET role = 'developer', plan = 'enterprise' WHERE email = ?").run(email);

          // 1. Verify /providers/groq/test captures Retry-After header accurately
          const probeRes = await fetch(`${apiUrl}/api/v1/models/providers/groq/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ upstreamModelId: 'openai/gpt-oss-20b' }),
          });
          assert.equal(probeRes.status, 200);
          const probeData = (await probeRes.json()) as { testResult: { ok: boolean; httpStatus: number; retryAfterMs: number; errorClass: string } };
          assert.equal(probeData.testResult.ok, false);
          assert.equal(probeData.testResult.httpStatus, 429);
          assert.equal(probeData.testResult.retryAfterMs, 2000);
          assert.equal(probeData.testResult.errorClass, 'rate_limit');

          // Reset groq circuit so fables-5.3 actually attempts groq
          orchMod.resetProviderCircuit('groq');

          // 2. When ALL eligible routes for fables-5.3 fail, never fall back to sonic-3 or another LOODY identity
          const fablesFailRes = await fetch(`${apiUrl}/api/v1/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({
              modelId: 'fables-5.3',
              prompt: 'Write a short fable',
              orchestrationMode: 'creative',
              allowFallback: true,
            }),
          });
          assert.equal(fablesFailRes.status, 200);
          const fablesSse = await fablesFailRes.text();
          assert.match(fablesSse, /"modelId":"fables-5\.3"/);
          assert.equal(fablesSse.includes('"modelId":"sonic-3"'), false);
          assert.equal(fablesSse.includes('"modelId":"sonic-3.5"'), false);
          assert.match(fablesSse, /event: error/);

          // 3. When groq fails (429) on sonic-3 with mistral configured, intra-model failover updates upstream_model_id,
          // sends LOODY identity directive for Sonic 3 + mistral/mistral-small-latest, and keeps sonic-3 identity intact
          orchMod.resetProviderCircuit('groq');
          process.env.MISTRAL_API_KEY = 'secret-mistral-key';
          process.env.MISTRAL_BASE_URL = mistralBase;

          const sonicRes = await fetch(`${apiUrl}/api/v1/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({
              modelId: 'sonic-3',
              prompt: 'Who are you?',
              orchestrationMode: 'fast',
              allowFallback: true,
            }),
          });
          assert.equal(sonicRes.status, 200);
          const sonicSse = await sonicRes.text();
          assert.match(sonicSse, /"modelId":"sonic-3"/);
          assert.match(sonicSse, /"fallbackNotice":/);
          assert.match(sonicSse, /Backup Sonic 3 response/);
          assert.match(sonicSse, /event: done/);
          // Raw provider/upstream model name must not leak into normal meta event
          const metaLines = sonicSse.split('\n').filter((l) => l.startsWith('data: ') && l.includes('"resolvedMode"'));
          for (const line of metaLines) {
            assert.equal(line.includes('mistral-small-latest'), false);
          }

          // System prompt sent to Mistral explicitly names LOODY model & runtime upstream provider/model
          assert.match(capturedMistralSystem, /operating through Sonic 3/);
          assert.match(capturedMistralSystem, /mistral/);
          assert.match(capturedMistralSystem, /mistral-small-latest/);

          // SQLite messages & token_usage record exact backup provider & upstream_model_id
          const msgRow = db
            .prepare("SELECT model_id, provider, upstream_model_id FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1")
            .get() as { model_id: string; provider: string; upstream_model_id: string } | undefined;
          assert.equal(msgRow?.model_id, 'sonic-3');
          assert.equal(msgRow?.provider, 'mistral');
          assert.equal(msgRow?.upstream_model_id, 'mistral-small-latest');

          const usageRow = db
            .prepare('SELECT model_id, provider, upstream_model_id FROM token_usage ORDER BY created_at DESC LIMIT 1')
            .get() as { model_id: string; provider: string; upstream_model_id: string } | undefined;
          assert.equal(usageRow?.model_id, 'sonic-3');
          assert.equal(usageRow?.provider, 'mistral');
          assert.equal(usageRow?.upstream_model_id, 'mistral-small-latest');
        } finally {
          clearProviderEnvs();
          orchMod.resetProviderCircuit('groq');
          orchMod.resetProviderCircuit('mistral');
        }
      });
    });
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

test('Controlled mocked /chat/stream concurrency benchmark (1, 2, 5)', async () => {
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  const apiUrl = `http://127.0.0.1:${port}`;
  const orchMod = await import('./orchestratorRuntime');

  try {
    await withLoopbackServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"Bench OK"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\n');
        res.end('data: [DONE]\n\n');
      }, 15);
    }, async (groqBase) => {
      clearProviderEnvs();
      orchMod.resetProviderCircuit('groq');
      db.prepare("UPDATE model_registry SET provider = 'groq', upstream_model_id = 'openai/gpt-oss-20b', availability = 'operational' WHERE id = 'sonic-3'").run();
      process.env.GROQ_API_KEY = 'bench-groq-key';
      process.env.GROQ_BASE_URL = groqBase;

      try {
        const regRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: `bench-${Date.now()}@loody.test`,
            password: 'TestPassword123!',
            displayName: 'Bench User',
          }),
        });
        assert.equal(regRes.status, 201);
        const cookie = regRes.headers.get('set-cookie')?.split(';')[0] ?? '';

        const levels = [
          { concurrency: 1, total: 4 },
          { concurrency: 2, total: 6 },
          { concurrency: 5, total: 10 },
        ];

        for (const lvl of levels) {
          const latencies: number[] = [];
          const ttfts: number[] = [];
          let okCount = 0;
          let errCount = 0;
          let inputTokens = 0;
          let outputTokens = 0;

          const runOne = async (idx: number) => {
            const start = Date.now();
            let firstChunkAt = 0;
            const resp = await fetch(`${apiUrl}/api/v1/chat/stream`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Cookie: cookie },
              body: JSON.stringify({
                modelId: 'sonic-3',
                prompt: `Benchmark request ${lvl.concurrency}-${idx}`,
                orchestrationMode: 'fast',
              }),
            });
            const reader = resp.body!.getReader();
            const dec = new TextDecoder();
            let body = '';
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              const text = dec.decode(value, { stream: true });
              body += text;
              if (!firstChunkAt && text.includes('event: chunk')) {
                firstChunkAt = Date.now();
              }
            }
            const end = Date.now();
            if (!firstChunkAt) firstChunkAt = end;
            latencies.push(end - start);
            ttfts.push(firstChunkAt - start);
            if (resp.status === 200 && body.includes('event: done') && body.includes('Bench OK')) {
              okCount++;
              inputTokens += 20;
              outputTokens += 10;
            } else {
              errCount++;
            }
          };

          for (let offset = 0; offset < lvl.total; offset += lvl.concurrency) {
            const batch: Array<Promise<void>> = [];
            for (let j = 0; j < lvl.concurrency && offset + j < lvl.total; j++) {
              batch.push(runOne(offset + j));
            }
            await Promise.all(batch);
          }

          latencies.sort((a, b) => a - b);
          ttfts.sort((a, b) => a - b);
          console.log(
            `MOCK_LOAD_BENCH concurrency=${lvl.concurrency} total=${lvl.total} ok=${okCount} err=${errCount} medianMs=${percentile(latencies, 50)} p95Ms=${percentile(latencies, 95)} medianTtftMs=${percentile(ttfts, 50)} tokensIn=${inputTokens} tokensOut=${outputTokens}`
          );
          assert.equal(okCount, lvl.total);
          assert.equal(errCount, 0);
        }
      } finally {
        clearProviderEnvs();
        orchMod.resetProviderCircuit('groq');
      }
    });
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test('OpenRouter & DeepInfra: attribution headers, genuine upstream attribution/cost persistence, VLM vision, bounded retry, and unconfigured handling', async () => {
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  const apiUrl = `http://127.0.0.1:${port}`;
  const orchMod = await import('./orchestratorRuntime');

  try {
    // 1. Unconfigured OpenRouter & DeepInfra return awaiting_config cleanly without crashing
    clearProviderEnvs();
    const orUnconf = await testProviderConnection(
      makeModel({ id: 'sonic-3', provider: 'openrouter', upstreamModelId: 'nvidia/nemotron-3.5-lightning:free' })
    );
    assert.equal(orUnconf.ok, false);
    assert.equal(orUnconf.healthStatus, 'awaiting_config');
    assert.equal(orUnconf.errorClass, 'configuration_error');

    const diUnconf = await testProviderConnection(
      makeModel({ id: 'sonic-3', provider: 'deepinfra', upstreamModelId: 'Qwen/Qwen3.8-Flash' })
    );
    assert.equal(diUnconf.ok, false);
    assert.equal(diUnconf.healthStatus, 'awaiting_config');

    // 2. DeepInfra VLM image attachment succeeds while text-only DeepInfra rejects images (HTTP 400 validation_error)
    await assert.rejects(
      streamModelResponse({
        model: makeModel({
          id: 'sonic-3',
          provider: 'deepinfra',
          upstreamModelId: 'Qwen/Qwen3.8-Flash',
          inputModalities: ['text'],
        }),
        messages: [
          {
            role: 'user',
            content: 'Inspect',
            attachments: [{ mimeType: 'image/png', dataBase64: 'AAAA', name: 'img.png', sizeBytes: 4 }],
          },
        ],
        callbacks: { onChunk: () => {} },
      }),
      (err: any) => err?.errorClass === 'validation_error' && err?.httpStatus === 400
    );

    // 3. OpenAI-compatible bounded retry recovers cleanly from a transient 503 before emitting chunks, and never leaks attribution when absent
    let diHits = 0;
    await withLoopbackServer((req, res) => {
      diHits++;
      if (diHits === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Temporary DeepInfra capacity overload' } }));
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"DeepInfra VLM OK"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      });
    }, async (diBase) => {
      process.env.DEEPINFRA_API_KEY = 'secret-deepinfra-test-key';
      process.env.DEEPINFRA_BASE_URL = diBase;
      try {
        let diText = '';
        let diAttrib: string | undefined;
        await streamModelResponse({
          model: makeModel({
            id: 'loody-vision-1',
            provider: 'deepinfra',
            upstreamModelId: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL',
            inputModalities: ['text', 'image'],
          }),
          maxAttempts: 2,
          messages: [
            {
              role: 'user',
              content: 'Analyze pixel',
              attachments: [{ mimeType: 'image/png', dataBase64: 'AAAA', name: 'img.png', sizeBytes: 4 }],
            },
          ],
          callbacks: {
            onChunk: (c) => (diText += c),
            onProviderMeta: (m) => {
              diAttrib = m.upstreamAttribution;
            },
          },
        });
        assert.equal(diHits, 2);
        assert.equal(diText, 'DeepInfra VLM OK');
        assert.equal(diAttrib, undefined);
      } finally {
        clearProviderEnvs();
      }
    });

    // 4. OpenRouter sends HTTP-Referer + X-OpenRouter-Title, captures genuine upstream provider & usage.cost into messages + token_usage, and blocks secret leaks
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    await withLoopbackServer((req, res) => {
      seenHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: {"id":"gen-or-123","provider":"DeepInfra","choices":[{"delta":{"content":"OpenRouter Real Route OK"}}]}\n\n'
      );
      res.write(
        'data: {"id":"gen-or-123","provider":"DeepInfra","choices":[],"usage":{"prompt_tokens":22,"completion_tokens":8,"cost":0.000125}}\n\n'
      );
      res.end('data: [DONE]\n\n');
    }, async (orBase) => {
      clearProviderEnvs();
      orchMod.resetProviderCircuit('openrouter');
      process.env.APP_URL = 'https://loody.example.com';
      process.env.OPENROUTER_API_KEY = 'secret-openrouter-do-not-leak';
      process.env.OPENROUTER_BASE_URL = orBase;
      db.prepare(
        "UPDATE model_registry SET provider = 'openrouter', upstream_model_id = 'qwen/qwen3.8-flash', availability = 'operational' WHERE id = 'fables-5.3'"
      ).run();

      try {
        const email = `or-di-${Date.now()}@loody.test`;
        const regRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'TestPassword123!', displayName: 'OR Tester' }),
        });
        assert.equal(regRes.status, 201);
        const cookie = regRes.headers.get('set-cookie')?.split(';')[0] ?? '';

        const chatRes = await fetch(`${apiUrl}/api/v1/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            modelId: 'fables-5.3',
            prompt: 'Hello OpenRouter',
            orchestrationMode: 'creative',
          }),
        });
        assert.equal(chatRes.status, 200);
        const sse = await chatRes.text();
        assert.equal(seenHeaders.authorization, 'Bearer secret-openrouter-do-not-leak');
        assert.equal(seenHeaders['http-referer'], 'https://loody.example.com');
        assert.equal(seenHeaders['x-openrouter-title'], 'LOODY AI Workspace');
        assert.equal(sse.includes('secret-openrouter-do-not-leak'), false);
        assert.match(sse, /OpenRouter Real Route OK/);
        assert.match(sse, /"upstreamAttribution":"DeepInfra"/);
        assert.match(sse, /"estimatedCostUsd":0\.000125/);

        const msgRow = db
          .prepare(
            "SELECT model_id, provider, upstream_model_id, upstream_attribution FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1"
          )
          .get() as {
          model_id: string;
          provider: string;
          upstream_model_id: string;
          upstream_attribution: string | null;
        };
        assert.equal(msgRow.model_id, 'fables-5.3');
        assert.equal(msgRow.provider, 'openrouter');
        assert.equal(msgRow.upstream_model_id, 'qwen/qwen3.8-flash');
        assert.equal(msgRow.upstream_attribution, 'DeepInfra');

        const usageRow = db
          .prepare(
            'SELECT model_id, provider, upstream_model_id, upstream_attribution, latency_ms, fallback_attempts, estimated_cost_usd FROM token_usage ORDER BY created_at DESC LIMIT 1'
          )
          .get() as {
          model_id: string;
          provider: string;
          upstream_model_id: string;
          upstream_attribution: string | null;
          latency_ms: number | null;
          fallback_attempts: number;
          estimated_cost_usd: number;
        };
        assert.equal(usageRow.model_id, 'fables-5.3');
        assert.equal(usageRow.provider, 'openrouter');
        assert.equal(usageRow.upstream_model_id, 'qwen/qwen3.8-flash');
        assert.equal(usageRow.upstream_attribution, 'DeepInfra');
        assert.ok((usageRow.latency_ms ?? 0) >= 1);
        assert.equal(usageRow.fallback_attempts, 1);
        assert.equal(usageRow.estimated_cost_usd, 0.000125);
      } finally {
        delete process.env.APP_URL;
        clearProviderEnvs();
        orchMod.resetProviderCircuit('openrouter');
      }
    });
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});
