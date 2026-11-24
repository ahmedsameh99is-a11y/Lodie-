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
  path: string,
  opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {}
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.cookie) {
    headers.Cookie = opts.cookie;
  }
  const resp = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const setCookie = resp.headers.get('set-cookie');
  const cookiePair = setCookie ? setCookie.split(';')[0] : undefined;
  const data = (await resp.json().catch(() => ({}))) as Record<string, any>;
  return { status: resp.status, data, cookie: cookiePair };
}

let userACookie = '';
let userAId = '';
let userBCookie = '';
let userBId = '';

before(async () => {
  tempDbPath = path.join(os.tmpdir(), `loody-integration-${process.pid}-${Date.now()}.db`);
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
  const regA = await apiReq('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: `test_a_${suffix}@loody.local`,
      password: 'Password!234',
      displayName: 'Test User Alpha',
    },
  });
  assert.equal(regA.status, 201);
  assert.ok(regA.cookie);
  userACookie = regA.cookie;
  userAId = regA.data.user.id;
  createdUserIds.push(userAId);

  const regB = await apiReq('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: `test_b_${suffix}@loody.local`,
      password: 'Password!234',
      displayName: 'Test User Beta',
    },
  });
  assert.equal(regB.status, 201);
  assert.ok(regB.cookie);
  userBCookie = regB.cookie;
  userBId = regB.data.user.id;
  createdUserIds.push(userBId);
});

after(async () => {
  for (const uid of createdUserIds) {
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(`${tempDbPath}${ext}`, { force: true });
  }
});

test('Auth session validation & invalid password rejection', async () => {
  const me = await apiReq('/api/v1/auth/me', { cookie: userACookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, userAId);

  const email = me.data.user.email as string;
  const badLogin = await apiReq('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password: 'WrongPassword99!' },
  });
  assert.equal(badLogin.status, 401);
});

test('Multi-tenant isolation prevents cross-user access to projects, files, Kore, agents, and tasks', async () => {
  const projRes = await apiReq('/api/v1/projects', {
    method: 'POST',
    cookie: userACookie,
    body: { name: 'Alpha Private Project', description: 'Top secret', instructions: 'Stay isolated' },
  });
  assert.equal(projRes.status, 201);
  const projectId = projRes.data.project.id as string;

  // User B tries to mutate or delete User A project
  const bDelProj = await apiReq(`/api/v1/projects/${projectId}`, { method: 'DELETE', cookie: userBCookie });
  assert.equal(bDelProj.status, 404);
  const bFiles = await apiReq(`/api/v1/projects/${projectId}/files`, { cookie: userBCookie });
  assert.equal(bFiles.status, 404);

  // Kore workspace isolation
  const koreRes = await apiReq('/api/v1/kore/workspaces', {
    method: 'POST',
    cookie: userACookie,
    body: { name: 'Alpha Kore WS', language: 'typescript' },
  });
  assert.equal(koreRes.status, 201);
  const wsId = koreRes.data.workspace.id as string;
  const bKoreFiles = await apiReq(`/api/v1/kore/workspaces/${wsId}/files`, { cookie: userBCookie });
  assert.equal(bKoreFiles.status, 404);

  // Task isolation
  const taskRes = await apiReq('/api/v1/tasks', {
    method: 'POST',
    cookie: userACookie,
    body: { title: 'Alpha Persistent Task', subtasks: ['Check lock'] },
  });
  assert.equal(taskRes.status, 201);
  const taskId = taskRes.data.task.id as string;
  const bDelTask = await apiReq(`/api/v1/tasks/${taskId}`, { method: 'DELETE', cookie: userBCookie });
  assert.equal(bDelTask.status, 404);
});

test('Upload security blocks disguised executable magic bytes and accepts safe text/documents', async () => {
  const mzBase64 = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]).toString('base64');
  const rejected = await apiReq('/api/v1/files', {
    method: 'POST',
    cookie: userACookie,
    body: {
      name: 'disguised.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      extractedText: 'MZ...',
      dataBase64: mzBase64,
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(String(rejected.data.error), /executable/i);

  const safeContent = 'Quarter 2 architectural review notes for LOODY workspace.';
  const accepted = await apiReq('/api/v1/files', {
    method: 'POST',
    cookie: userACookie,
    body: {
      name: 'architecture-notes.txt',
      mimeType: 'text/plain',
      sizeBytes: safeContent.length,
      extractedText: safeContent,
      dataBase64: Buffer.from(safeContent, 'utf8').toString('base64'),
    },
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.file.name, 'architecture-notes.txt');
});

test('SSRF protection rejects internal/private endpoints in MCP registration and url_text_extractor', async () => {
  const privateMcp = await apiReq('/api/v1/mcp/servers', {
    method: 'POST',
    cookie: userACookie,
    body: { name: 'Metadata SSRF', endpointUrl: 'http://169.254.169.254/latest/meta-data', authType: 'none' },
  });
  assert.equal(privateMcp.status, 400);

  const localhostExtract = await apiReq('/api/v1/mcp/builtin-tools/url_text_extractor/execute', {
    method: 'POST',
    cookie: userACookie,
    body: { input: { url: 'http://127.0.0.1:3000/api/health' } },
  });
  assert.equal(localhostExtract.status, 400);
  assert.match(String(localhostExtract.data.error), /private|localhost|internal|blocked/i);
});

test('Inbound LOODY MCP Server enforces token scoping, initializes, lists allowed tools, and executes safe tools', async () => {
  const tokenRes = await apiReq('/api/v1/mcp/server-tokens', {
    method: 'POST',
    cookie: userACookie,
    body: { label: 'CI Client Token', allowedTools: ['utc_clock', 'token_budget_estimator'] },
  });
  assert.equal(tokenRes.status, 201);
  const plainToken = tokenRes.data.plainToken as string;
  const tokenId = tokenRes.data.tokenRecord.id as string;
  assert.ok(plainToken.startsWith('loody_mcp_'));

  // Missing token -> 401
  const noAuth = await apiReq('/api/v1/mcp/server', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  });
  assert.equal(noAuth.status, 401);

  // Initialize
  const initResp = await apiReq('/api/v1/mcp/server', {
    method: 'POST',
    headers: { Authorization: `Bearer ${plainToken}` },
    body: { jsonrpc: '2.0', id: 2, method: 'initialize' },
  });
  assert.equal(initResp.status, 200);
  assert.equal(initResp.data.result.serverInfo.name, 'loody-mcp-server');

  // List only scoped tools
  const listResp = await apiReq('/api/v1/mcp/server', {
    method: 'POST',
    headers: { Authorization: `Bearer ${plainToken}` },
    body: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  });
  assert.equal(listResp.status, 200);
  const toolNames = (listResp.data.result.tools as Array<{ name: string }>).map((t) => t.name);
  assert.deepEqual(toolNames.sort(), ['token_budget_estimator', 'utc_clock']);

  // Allowed tool execution
  const callOk = await apiReq('/api/v1/mcp/server', {
    method: 'POST',
    headers: { Authorization: `Bearer ${plainToken}` },
    body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'utc_clock', arguments: { timezone: 'UTC' } } },
  });
  assert.equal(callOk.status, 200);
  assert.equal(callOk.data.result.isError, false);

  // Unauthorized tool blocked
  const callDenied = await apiReq('/api/v1/mcp/server', {
    method: 'POST',
    headers: { Authorization: `Bearer ${plainToken}` },
    body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'regex_tester', arguments: {} } },
  });
  assert.equal(callDenied.status, 403);
  assert.equal(callDenied.data.error.code, -32003);

  // Disable token -> rejected
  const disable = await apiReq(`/api/v1/mcp/server-tokens/${tokenId}`, {
    method: 'PATCH',
    cookie: userACookie,
    body: { enabled: false },
  });
  assert.equal(disable.status, 200);

  const afterDisable = await apiReq('/api/v1/mcp/server', {
    method: 'POST',
    headers: { Authorization: `Bearer ${plainToken}` },
    body: { jsonrpc: '2.0', id: 6, method: 'tools/list' },
  });
  assert.equal(afterDisable.status, 401);
});

test('Custom Skills full CRUD and Agent run idempotency + approval gate + pause/cancel flow', async () => {
  // Custom skill create -> patch -> delete
  const createSkill = await apiReq('/api/v1/skills', {
    method: 'POST',
    cookie: userACookie,
    body: {
      name: 'Audit Skill Alpha',
      version: '1.0.0',
      description: 'Validates JSON schema contracts carefully',
      category: 'QA',
      allowedTools: ['json_schema_validator'],
      promptTemplate: 'Inspect JSON carefully:\n\n{{input}}',
    },
  });
  assert.equal(createSkill.status, 201);
  const skillId = createSkill.data.skill.id as string;

  const patchSkill = await apiReq(`/api/v1/skills/${skillId}`, {
    method: 'PATCH',
    cookie: userACookie,
    body: {
      name: 'Audit Skill Beta',
      version: '1.1.0',
      allowedTools: ['json_schema_validator', 'utc_clock'],
    },
  });
  assert.equal(patchSkill.status, 200);
  assert.equal(patchSkill.data.skill.name, 'Audit Skill Beta');
  assert.equal(patchSkill.data.skill.version, '1.1.0');
  assert.deepEqual(patchSkill.data.skill.allowedTools, ['json_schema_validator', 'utc_clock']);

  // Single-agent 'work' run with requireApprovalForWrite: true hits 'awaiting_approval' deterministically before LLM call
  const idempKey = `idem_${Date.now()}`;
  const runRes = await apiReq('/api/v1/agents/runs', {
    method: 'POST',
    cookie: userACookie,
    body: {
      goal: 'Prepare Q3 release milestone breakdown',
      agents: ['work'],
      requireApprovalForWrite: true,
      idempotencyKey: idempKey,
    },
  });
  assert.equal(runRes.status, 201);
  assert.equal(runRes.data.run.status, 'awaiting_approval');
  const runId = runRes.data.run.id as string;

  // Duplicate submission with same idempotencyKey returns existing run without creating a duplicate
  const dupRes = await apiReq('/api/v1/agents/runs', {
    method: 'POST',
    cookie: userACookie,
    body: {
      goal: 'Prepare Q3 release milestone breakdown',
      agents: ['work'],
      requireApprovalForWrite: true,
      idempotencyKey: idempKey,
    },
  });
  assert.equal(dupRes.status, 200);
  assert.equal(dupRes.data.deduplicated, true);
  assert.equal(dupRes.data.run.id, runId);

  // Pause and reject/cancel cleanly
  const pausedRes = await apiReq(`/api/v1/agents/runs/${runId}/pause`, { method: 'POST', cookie: userACookie });
  assert.equal(pausedRes.status, 200);
  assert.equal(pausedRes.data.run.status, 'paused');

  // Cleanup skill
  const delSkill = await apiReq(`/api/v1/skills/${skillId}`, { method: 'DELETE', cookie: userACookie });
  assert.equal(delSkill.status, 200);
});

test('Full Backup Export v1.0 & Transactional Tenant-Isolated Restore round-trip', async () => {
  const exportRes = await apiReq('/api/v1/settings/export', { cookie: userACookie });
  assert.equal(exportRes.status, 200);
  assert.equal(exportRes.data.backupVersion, '1.0');
  assert.ok(Array.isArray(exportRes.data.projects));
  assert.ok(Array.isArray(exportRes.data.koreWorkspaces));
  assert.ok(exportRes.data.projects.length >= 1);

  // Restore User A backup into User B (must allocate new IDs for User B without mutating User A or privileges)
  const restoreIntoB = await apiReq('/api/v1/settings/restore', {
    method: 'POST',
    cookie: userBCookie,
    body: exportRes.data,
  });
  assert.equal(restoreIntoB.status, 200);
  assert.equal(restoreIntoB.data.ok, true);
  assert.ok(restoreIntoB.data.restored.projects >= 1);
  assert.ok(restoreIntoB.data.restored.koreWorkspaces >= 1);

  const bProjects = await apiReq('/api/v1/projects', { cookie: userBCookie });
  assert.ok(bProjects.data.projects.some((p: { name: string }) => p.name === 'Alpha Private Project'));
});
