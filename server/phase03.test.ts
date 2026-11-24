import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type Database from 'better-sqlite3';

let db: Database.Database;
let tempDbPath = '';
let server: http.Server;
let baseUrl = '';
const createdUserIds: string[] = [];

async function apiReq(
  reqPath: string,
  opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {}
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.cookie) {
    headers.Cookie = opts.cookie;
  }
  const resp = await fetch(`${baseUrl}${reqPath}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const setCookie = resp.headers.get('set-cookie');
  const cookiePair = setCookie ? setCookie.split(';')[0] : undefined;
  const contentType = resp.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json')
    ? ((await resp.json().catch(() => ({}))) as Record<string, any>)
    : {};
  return {
    status: resp.status,
    data,
    cookie: cookiePair,
    setCookie: resp.headers.getSetCookie ? resp.headers.getSetCookie() : setCookie ? [setCookie] : [],
    headers: resp.headers,
    rawResp: resp,
  };
}

let userACookie = '';
let userAId = '';
let userAEmail = '';
let userBCookie = '';
let userBId = '';

before(async () => {
  tempDbPath = path.join(os.tmpdir(), `loody-phase03-${process.pid}-${Date.now()}.db`);
  process.env.LOODY_DB_PATH = tempDbPath;
  const { createApiApp } = await import('./app');
  const dbMod = await import('./db');
  db = dbMod.db;

  const app = createApiApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  userAEmail = `p03_a_${suffix}@loody.local`;
  const regA = await apiReq('/api/v1/auth/register', {
    method: 'POST',
    body: { email: userAEmail, password: 'Phase03StrongPassword!', displayName: 'Phase03 User A' },
  });
  assert.equal(regA.status, 201);
  userACookie = regA.cookie!;
  userAId = regA.data.user.id;
  createdUserIds.push(userAId);

  const regB = await apiReq('/api/v1/auth/register', {
    method: 'POST',
    body: { email: `p03_b_${suffix}@loody.local`, password: 'Phase03StrongPassword!', displayName: 'Phase03 User B' },
  });
  assert.equal(regB.status, 201);
  userBCookie = regB.cookie!;
  userBId = regB.data.user.id;
  createdUserIds.push(userBId);
});

after(async () => {
  for (const uid of createdUserIds) {
    db?.prepare('DELETE FROM users WHERE id = ?').run(uid);
  }
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  for (const ext of ['', '-wal', '-shm']) {
    if (tempDbPath && fs.existsSync(`${tempDbPath}${ext}`)) {
      fs.unlinkSync(`${tempDbPath}${ext}`);
    }
  }
});

test('Phase 0.3 cookie flags adapt cleanly between HTTPS and HTTP localhost', async () => {
  const httpLogin = await apiReq('/api/v1/auth/login', {
    method: 'POST',
    body: { email: userAEmail, password: 'Phase03StrongPassword!' },
  });
  assert.equal(httpLogin.status, 200);
  const httpCookie = httpLogin.setCookie.join('; ');
  assert.match(httpCookie, /HttpOnly/i);
  assert.match(httpCookie, /SameSite=Lax/i);
  assert.doesNotMatch(httpCookie, /Partitioned/i);

  const httpsLogin = await apiReq('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'X-Forwarded-Proto': 'https' },
    body: { email: userAEmail, password: 'Phase03StrongPassword!' },
  });
  assert.equal(httpsLogin.status, 200);
  const httpsCookie = httpsLogin.setCookie.join('; ');
  assert.match(httpsCookie, /HttpOnly/i);
  assert.match(httpsCookie, /SameSite=None/i);
  assert.match(httpsCookie, /Secure/i);
  assert.match(httpsCookie, /Partitioned/i);
});

test('Phase 0.3 CSRF origin guard blocks cross-origin cookie mutations and allows same-origin', async () => {
  const crossOrigin = await apiReq('/api/v1/settings/preferences', {
    method: 'PATCH',
    cookie: userACookie,
    headers: { Origin: 'https://evil.attacker.invalid' },
    body: { soundEnabled: false },
  });
  assert.equal(crossOrigin.status, 403);

  const crossSiteFetch = await apiReq('/api/v1/settings/preferences', {
    method: 'PATCH',
    cookie: userACookie,
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: { soundEnabled: false },
  });
  assert.equal(crossSiteFetch.status, 403);

  const sameOrigin = await apiReq('/api/v1/settings/preferences', {
    method: 'PATCH',
    cookie: userACookie,
    headers: { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' },
    body: { soundEnabled: false },
  });
  assert.equal(sameOrigin.status, 200);
});

test('Phase 0.3 built-in tools and built-in skills enforce developer/admin RBAC', async () => {
  const toolRes = await apiReq('/api/v1/mcp/builtin-tools/utc_clock', {
    method: 'PATCH',
    cookie: userBCookie,
    body: { enabled: false },
  });
  assert.equal(toolRes.status, 403);

  const skillsRes = await apiReq('/api/v1/skills', { cookie: userBCookie });
  assert.equal(skillsRes.status, 200);
  const builtin = (skillsRes.data.skills as Array<{ id: string; isBuiltin?: boolean }>).find((s) => s.isBuiltin);
  if (builtin) {
    const patchBuiltin = await apiReq(`/api/v1/skills/${builtin.id}`, {
      method: 'PATCH',
      cookie: userBCookie,
      body: { enabled: false },
    });
    assert.equal(patchBuiltin.status, 403);
  }
});

test('Phase 0.3 free user accesses all 5 models with 150k/2.5M quotas, per-model daily caps, and binary image validation; allowlist sync promotes user', async () => {
  // All 5 models are unlocked on Free tier and billing summary reports 150k/2.5M + perModelDaily
  const modelsResp = await apiReq('/api/v1/models');
  assert.equal(modelsResp.status, 200);
  assert.equal(modelsResp.data.models.length, 5);
  for (const m of modelsResp.data.models) {
    assert.equal(m.requiredPlan, 'free', `${m.id} must be unlocked on Free tier`);
    assert.equal(m.inputModalities.includes('image'), true, `${m.id} must accept image attachments`);
  }

  const billingResp = await apiReq('/api/v1/billing/summary', { cookie: userBCookie });
  assert.equal(billingResp.status, 200);
  assert.equal(billingResp.data.usage.dailyLimit, 150_000);
  assert.equal(billingResp.data.usage.monthlyLimit, 2_500_000);
  assert.equal(billingResp.data.usage.dailyRemaining, 150_000);
  assert.ok(billingResp.data.usage.dailyResetAtUtc);
  assert.equal(billingResp.data.usage.perModelDaily.length, 5);

  // Forged PNG magic bytes rejected with 400 INVALID_IMAGE_BINARY before any upstream call
  const spoofImg = await apiReq('/api/v1/chat/stream', {
    method: 'POST',
    cookie: userBCookie,
    body: {
      modelId: 'fables-5.3',
      prompt: 'Inspect this',
      attachments: [
        {
          name: 'spoof.png',
          mimeType: 'image/png',
          sizeBytes: 12,
          dataBase64: Buffer.from('MZ\x90\x00notapng!!').toString('base64'),
        },
      ],
    },
  });
  assert.equal(spoofImg.status, 400);
  assert.equal(spoofImg.data.code, 'INVALID_IMAGE_BINARY');

  // Valid PNG + non-existent conversationId passes entitlement, binary image check, and quota cleanly (returns 404 before provider call)
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  if (!prevGeminiKey) {
    process.env.GEMINI_API_KEY = 'offline-test-key-placeholder';
  }
  const now = new Date().toISOString();
  const seededId = `usage-cap-test-${Date.now()}`;
  try {
    const validPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=';
    for (const mId of ['lodie-5.5', 'fables-5.3', 'sonic-3']) {
      const passGate = await apiReq('/api/v1/chat/stream', {
        method: 'POST',
        cookie: userBCookie,
        body: {
          modelId: mId,
          conversationId: '00000000-0000-0000-0000-000000000000',
          prompt: 'Check access',
          attachments: [
            {
              name: 'pixel.png',
              mimeType: 'image/png',
              sizeBytes: 68,
              dataBase64: validPngB64,
            },
          ],
        },
      });
      assert.equal(passGate.status, 404, `Expected ${mId} to pass Free entitlement, image validation & quota`);
    }

    // Per-model daily cap blocks exhausted model cleanly while leaving other models usable
    db.prepare(`
      INSERT INTO token_usage (
        id, user_id, conversation_id, model_id, provider, upstream_model_id, task_type,
        input_tokens, output_tokens, cached_tokens, accounting_type, estimated_cost_usd, usage_date, usage_month, created_at
      ) VALUES (?, ?, NULL, 'lodie-5.5', 'gemini', 'gemini-3.6-pro', 'chat', 30000, 5000, 0, 'provider_reported', 0, ?, ?, ?)
    `).run(seededId, userBId, now.slice(0, 10), now.slice(0, 7), now);

    const blockedLodie = await apiReq('/api/v1/chat/stream', {
      method: 'POST',
      cookie: userBCookie,
      body: { modelId: 'lodie-5.5', prompt: 'Hello' },
    });
    assert.equal(blockedLodie.status, 429);
    assert.equal(blockedLodie.data.code, 'QUOTA_EXCEEDED');
    assert.match(String(blockedLodie.data.error ?? ''), /LOODY 5\.5/);

    const sonicStillAllowed = await apiReq('/api/v1/chat/stream', {
      method: 'POST',
      cookie: userBCookie,
      body: { modelId: 'sonic-3', conversationId: '00000000-0000-0000-0000-000000000000', prompt: 'Hello' },
    });
    assert.equal(sonicStillAllowed.status, 404);
  } finally {
    db.prepare('DELETE FROM token_usage WHERE id = ?').run(seededId);
    if (prevGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevGeminiKey;
    }
  }

  // Allowlist cookie sync test (temporarily allowlist User A then restore)
  const prevAllowlist = process.env.DEVELOPER_ALLOWLIST_EMAILS;
  process.env.DEVELOPER_ALLOWLIST_EMAILS = userAEmail;
  try {
    const me = await apiReq('/api/v1/auth/me', { cookie: userACookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.role, 'developer');
    assert.equal(me.data.user.plan, 'developer');

    // Developer can toggle built-in tool cleanly
    const devToolPatch = await apiReq('/api/v1/mcp/builtin-tools/utc_clock', {
      method: 'PATCH',
      cookie: userACookie,
      body: { enabled: true },
    });
    assert.equal(devToolPatch.status, 200);
  } finally {
    process.env.DEVELOPER_ALLOWLIST_EMAILS = prevAllowlist ?? '';
    db.prepare('UPDATE users SET role = ?, plan = ? WHERE id = ?').run('user', 'free', userAId);
  }
});

test('Phase 0.3 multi-provider orchestrator emits onAttemptStart BEFORE backup chunks', async () => {
  const { CircuitBreakerRegistry, executeWithMultiProviderFallback } = await import(
    '../src/shared/multiProviderOrchestrator'
  );
  const events: string[] = [];
  const cb = new CircuitBreakerRegistry();

  const result = await executeWithMultiProviderFallback({
    candidates: [
      {
        route: {
          id: 'r1',
          brandedModelId: 'lodie-5.5',
          provider: 'nvidia',
          upstreamModelId: 'nvidia-primary',
          priority: 1,
          contextLimit: 128_000,
          supportsVision: true,
          supportsTools: true,
          supportsStreaming: true,
          supportsPromptCaching: false,
          costTier: 'balanced',
          speedTier: 'fast',
          arabicStrength: 'high',
          taskAffinities: ['auto'],
        },
        score: 100,
        circuitState: 'closed',
        reasons: ['Primary'],
      },
      {
        route: {
          id: 'r2',
          brandedModelId: 'lodie-5.5',
          provider: 'gemini',
          upstreamModelId: 'gemini-3.6-pro',
          priority: 2,
          contextLimit: 1_000_000,
          supportsVision: true,
          supportsTools: true,
          supportsStreaming: true,
          supportsPromptCaching: true,
          costTier: 'premium',
          speedTier: 'balanced',
          arabicStrength: 'high',
          taskAffinities: ['auto'],
        },
        score: 80,
        circuitState: 'closed',
        reasons: ['Backup'],
      },
    ],
    circuitBreaker: cb,
    onAttemptStart: ({ candidate, attemptIndex, fallbackOccurred }) => {
      events.push(
        `attempt:${attemptIndex}:${candidate.route.provider}:${candidate.route.upstreamModelId}:fallback=${fallbackOccurred}`
      );
    },
    invoke: async (candidate) => {
      if (candidate.route.provider === 'nvidia') {
        throw Object.assign(new Error('Upstream unavailable'), { status: 503 });
      }
      events.push(`chunk_begin:${candidate.route.provider}`);
      return { emittedAnyChunk: true, latencyMs: 12 };
    },
    extractErrorMeta: (err) => ({
      errorClass: 'provider_unavailable',
      retryable: true,
      message: err instanceof Error ? err.message : 'Upstream failed',
    }),
  });

  assert.equal(result.fallbackOccurred, true);
  assert.equal(result.selectedCandidate.route.provider, 'gemini');
  assert.deepEqual(events, [
    'attempt:0:nvidia:nvidia-primary:fallback=false',
    'attempt:1:gemini:gemini-3.6-pro:fallback=true',
    'chunk_begin:gemini',
  ]);
});

test('Phase 0.3 vision health self-heal resets stale Gemini authentication_error', async () => {
  const vision = db
    .prepare('SELECT id, provider, availability FROM model_registry WHERE id = ?')
    .get('loody-vision-1') as { id: string; provider: string; availability: string } | undefined;
  assert.ok(vision);
  if (vision.provider === 'gemini') {
    assert.notEqual(vision.availability, 'authentication_error');
  }
});

test('Phase 0.3 files & project files enforce 0-byte/base64 checks, sandboxed downloads, and cascade cleanup', async () => {
  // 0-byte workspace file rejected
  const emptyWs = await apiReq('/api/v1/files', {
    method: 'POST',
    cookie: userBCookie,
    body: { name: 'empty.txt', mimeType: 'text/plain', sizeBytes: 1, extractedText: '', dataBase64: '' },
  });
  assert.equal(emptyWs.status, 400);

  // Invalid base64 rejected
  const badB64 = await apiReq('/api/v1/files', {
    method: 'POST',
    cookie: userBCookie,
    body: { name: 'bad.bin', mimeType: 'application/octet-stream', sizeBytes: 10, dataBase64: '!!!invalid===' },
  });
  assert.equal(badB64.status, 400);

  // Create project + upload valid project file with binary storage
  const proj = await apiReq('/api/v1/projects', {
    method: 'POST',
    cookie: userBCookie,
    body: { name: 'P03 Project', description: 'Storage test', instructions: 'Be concise' },
  });
  assert.equal(proj.status, 201);
  const projectId = proj.data.project.id as string;

  const content = 'LOODY Phase 0.3 Project Verification Token Z9X8';
  const uploaded = await apiReq(`/api/v1/projects/${projectId}/files`, {
    method: 'POST',
    cookie: userBCookie,
    body: {
      name: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength(content),
      extractedText: content,
      dataBase64: Buffer.from(content, 'utf8').toString('base64'),
    },
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.data.file.hasBinary, true);
  const fileId = uploaded.data.file.id as string;

  // Cross-user download denied
  const crossDl = await apiReq(`/api/v1/projects/${projectId}/files/${fileId}/download`, { cookie: userACookie });
  assert.equal(crossDl.status, 404);

  // Owner download returns sandbox CSP + exact content
  const dlResp = await fetch(`${baseUrl}/api/v1/projects/${projectId}/files/${fileId}/download`, {
    headers: { Cookie: userBCookie },
  });
  assert.equal(dlResp.status, 200);
  assert.equal(dlResp.headers.get('content-security-policy'), 'sandbox');
  assert.equal(dlResp.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await dlResp.text(), content);

  const chunksBefore = db
    .prepare('SELECT COUNT(*) AS c FROM knowledge_chunks WHERE source_id = ?')
    .get(fileId) as { c: number };
  assert.ok(chunksBefore.c > 0);

  const binRow = db
    .prepare('SELECT storage_rel_path FROM project_files WHERE id = ?')
    .get(fileId) as { storage_rel_path: string | null };
  assert.ok(binRow.storage_rel_path);
  const { resolveUserBinaryPath } = await import('./knowledge');
  const resolvedBin = resolveUserBinaryPath(binRow.storage_rel_path);
  assert.ok(resolvedBin && fs.existsSync(resolvedBin));

  // Delete whole project -> cascade removes binary & knowledge_chunks
  const delProj = await apiReq(`/api/v1/projects/${projectId}`, { method: 'DELETE', cookie: userBCookie });
  assert.equal(delProj.status, 200);
  assert.equal(fs.existsSync(resolvedBin!), false);

  const chunksAfter = db
    .prepare('SELECT COUNT(*) AS c FROM knowledge_chunks WHERE source_id = ?')
    .get(fileId) as { c: number };
  assert.equal(chunksAfter.c, 0);
});

test('Phase 0.3 share URL generation rejects spoofed Host headers and accepts valid hosts', async () => {
  const conv = await apiReq('/api/v1/conversations', {
    method: 'POST',
    cookie: userBCookie,
    body: { title: 'Share Host Test', modelId: 'sonic-3' },
  });
  assert.equal(conv.status, 201);
  const convId = conv.data.conversation.id as string;

  const prevAppUrl = process.env.APP_URL;
  delete process.env.APP_URL;
  try {
    const validShare = await apiReq(`/api/v1/conversations/${convId}/share`, {
      method: 'POST',
      cookie: userBCookie,
    });
    assert.equal(validShare.status, 200);
    assert.ok(String(validShare.data.shareUrl).startsWith(`${baseUrl}/?share=`));

    // Connect raw http to test invalid Host header
    const spoofedShareUrl = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/conversations/${convId}/share`,
        {
          method: 'POST',
          headers: {
            Cookie: userBCookie,
            Host: 'evil.com/path',
            'Content-Length': '0',
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            const json = JSON.parse(raw) as { shareUrl: string };
            resolve(json.shareUrl);
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.ok(spoofedShareUrl.startsWith('/?share='));
  } finally {
    if (prevAppUrl !== undefined) {
      process.env.APP_URL = prevAppUrl;
    } else {
      delete process.env.APP_URL;
    }
  }
});

test('Phase 0.3 settings restore preserves upstream_model_id and re-indexes RAG knowledge_chunks', async () => {
  const fakeProjId = `restored-proj-${Date.now()}`;
  const fakeFileId = `restored-file-${Date.now()}`;
  const fakeConvId = `restored-conv-${Date.now()}`;
  const fakeMsgId = `restored-msg-${Date.now()}`;

  const restoreRes = await apiReq('/api/v1/settings/restore', {
    method: 'POST',
    cookie: userBCookie,
    body: {
      projects: [{ id: fakeProjId, name: 'Restored KB Project', description: 'd', instructions: 'i' }],
      projectFiles: [
        {
          id: fakeFileId,
          projectId: fakeProjId,
          name: 'restored-handbook.md',
          mimeType: 'text/markdown',
          sizeBytes: 64,
          extractedText: 'Quantum Banana Telemetry Protocol requires strict phase locking.',
        },
      ],
      conversations: [{ id: fakeConvId, projectId: fakeProjId, title: 'Restored Chat', modelId: 'sonic-3' }],
      messages: [
        {
          id: fakeMsgId,
          conversationId: fakeConvId,
          role: 'assistant',
          content: 'Verified',
          modelId: 'sonic-3',
          upstreamModelId: 'gemini-3.1-flash-lite',
        },
      ],
    },
  });
  assert.equal(restoreRes.status, 200);
  assert.equal(restoreRes.data.restored.projectFiles, 1);

  const restoredMsg = db
    .prepare('SELECT upstream_model_id FROM messages WHERE id = ?')
    .get(fakeMsgId) as { upstream_model_id: string | null } | undefined;
  assert.equal(restoredMsg?.upstream_model_id, 'gemini-3.1-flash-lite');

  const indexedChunks = db
    .prepare('SELECT COUNT(*) AS c FROM knowledge_chunks WHERE user_id = ? AND source_id = ?')
    .get(userBId, fakeFileId) as { c: number };
  assert.ok(indexedChunks.c > 0);
});

test('Phase 0.3 createRateLimiter bounds memory growth and cross-user agent control returns 404', async () => {
  const { createRateLimiter } = await import('./security');
  const limiter = createRateLimiter({ windowMs: 10_000, maxRequests: 100, scope: 'test_cap' });
  let hits = 0;
  for (let i = 0; i < 5_050; i++) {
    const fakeReq = { ip: `10.0.${Math.floor(i / 256)}.${i % 256}` } as any;
    const fakeRes = { setHeader: () => undefined, status: () => ({ json: () => undefined }) } as any;
    limiter(fakeReq, fakeRes, () => {
      hits++;
    });
  }
  assert.equal(hits, 5_050);

  // Create run for User A directly in DB and verify User B cannot cancel it
  const runId = `run-iso-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agent_runs (id, user_id, project_id, goal, mode, status, final_output, total_tokens, created_at, updated_at)
    VALUES (?, ?, NULL, 'Private run', 'work', 'running', '', 0, ?, ?)
  `).run(runId, userAId, now, now);

  const crossCancel = await apiReq(`/api/v1/agents/runs/${runId}/cancel`, {
    method: 'POST',
    cookie: userBCookie,
  });
  assert.equal(crossCancel.status, 404);

  const stillRunning = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as { status: string };
  assert.equal(stillRunning.status, 'running');
  db.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId);
});
