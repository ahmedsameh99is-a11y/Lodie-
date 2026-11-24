import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { McpToolSchema } from '../../src/shared/types';
import { db, listBuiltinTools, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth, requireDeveloper } from '../middleware';
import {
  assertSafeExternalUrl,
  createRateLimiter,
  decryptSecret,
  encryptSecret,
  hashToken,
  validateExternalHttpUrl,
} from '../security';
import { runBuiltinToolById } from '../tools/engine';

export const mcpRouter = Router();

const inboundMcpLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60, scope: 'mcp_inbound' });

// Inbound LOODY MCP Server endpoint (JSON-RPC 2.0) authenticated via scoped token
mcpRouter.post('/server', inboundMcpLimiter, async (req, res) => {
  const rpcBody = req.body as {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };
  const rpcId = rpcBody?.id ?? null;

  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const altHeaderToken =
    typeof req.headers['x-loody-mcp-token'] === 'string' ? req.headers['x-loody-mcp-token'].trim() : '';
  const rawToken = bearerToken || altHeaderToken;

  if (!rawToken) {
    res.status(401).json({
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32001, message: 'Missing LOODY MCP Bearer or X-LOODY-MCP-Token credential.' },
    });
    return;
  }

  const tokenHash = hashToken(rawToken);
  const tokenRow = db
    .prepare(`
      SELECT t.*, u.email AS user_email
      FROM mcp_server_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.enabled = 1
    `)
    .get(tokenHash) as Record<string, unknown> | undefined;

  if (!tokenRow) {
    res.status(401).json({
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32001, message: 'Invalid or disabled LOODY MCP Server token.' },
    });
    return;
  }

  const userId = String(tokenRow.user_id);
  const userEmail = String(tokenRow.user_email);
  const allowedTools = JSON.parse(String(tokenRow.allowed_tools_json || '[]')) as string[];
  const method = String(rpcBody?.method ?? '');

  db.prepare('UPDATE mcp_server_tokens SET last_used_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    String(tokenRow.id)
  );

  if (method === 'initialize') {
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'loody-mcp-server',
          version: '1.0.0',
        },
        capabilities: {
          tools: { listChanged: false },
        },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    const builtin = listBuiltinTools().filter(
      (t) => t.enabled && t.permissionLevel !== 'restricted' && allowedTools.includes(t.id)
    );
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        tools: builtin.map((t) => ({
          name: t.id,
          description: `${t.name}: ${t.description}`,
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(
              Object.keys(t.inputExample ?? {}).map((k) => [k, { type: 'string' }])
            ),
          },
        })),
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = String(rpcBody?.params?.name ?? '').trim();
    const args =
      rpcBody?.params?.arguments && typeof rpcBody.params.arguments === 'object'
        ? (rpcBody.params.arguments as Record<string, unknown>)
        : {};

    if (!toolName || !allowedTools.includes(toolName)) {
      recordAuditLog({
        actorUserId: userId,
        actorEmail: userEmail,
        action: 'mcp_inbound_tool_denied',
        targetType: 'mcp_server_token',
        targetId: String(tokenRow.id),
        outcome: 'denied',
        detail: `Denied call to unauthorized tool "${toolName || 'empty'}"`,
      });
      res.status(403).json({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32003, message: `Tool "${toolName}" is not permitted by this scoped token.` },
      });
      return;
    }

    const result = await runBuiltinToolById({
      userId,
      userEmail,
      toolId: toolName,
      input: args,
      approvedByUser: false,
    });

    if (result.requiresApproval) {
      res.status(403).json({
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: -32003,
          message: result.approvalReason ?? 'State-mutating restricted tools cannot execute without interactive approval.',
        },
      });
      return;
    }

    recordAuditLog({
      actorUserId: userId,
      actorEmail: userEmail,
      action: 'mcp_inbound_tool_call',
      targetType: 'tool',
      targetId: toolName,
      outcome: result.ok ? 'success' : 'error',
      detail: `Token "${String(tokenRow.label)}" executed ${toolName}`,
    });

    if (!result.ok) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32602, message: result.error ?? 'Tool execution failed.' },
      });
      return;
    }

    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result.output, null, 2) }],
        structuredContent: result.output,
        isError: false,
      },
    });
    return;
  }

  res.status(400).json({
    jsonrpc: '2.0',
    id: rpcId,
    error: { code: -32601, message: `Unsupported MCP JSON-RPC method "${method}".` },
  });
});

mcpRouter.use(requireAuth);

const SENSITIVE_NAME_PATTERN = /(delete|remove|drop|send|email|message|publish|deploy|pay|spend|charge|transfer|setting|password|account)/i;

function classifyToolSensitivity(tool: { name: string; description?: string }): {
  sensitive: boolean;
  reason?: string;
} {
  const combined = `${tool.name} ${tool.description ?? ''}`;
  if (SENSITIVE_NAME_PATTERN.test(combined)) {
    return {
      sensitive: true,
      reason: 'Tool matches sensitive/irreversible operation policy and requires explicit user confirmation.',
    };
  }
  return { sensitive: false };
}

mcpRouter.get('/servers', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;

  res.json({
    servers: rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      name: String(r.name),
      endpointUrl: String(r.endpoint_url),
      authType: r.auth_type,
      status: r.status,
      lastError: r.last_error ? String(r.last_error) : null,
      tools: JSON.parse(String(r.tools_json)),
      createdAt: String(r.created_at),
    })),
  });
});

mcpRouter.post('/servers', (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    name: z.string().trim().min(2).max(80),
    endpointUrl: z.string().trim().url(),
    authType: z.enum(['none', 'bearer', 'header']).default('none'),
    authToken: z.string().trim().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid MCP server config.' });
    return;
  }

  const urlCheck = validateExternalHttpUrl(parsed.data.endpointUrl);
  if (!urlCheck.valid) {
    res.status(400).json({ error: urlCheck.reason ?? 'Invalid endpoint URL.' });
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const encryptedToken = parsed.data.authToken ? encryptSecret(parsed.data.authToken) : null;

  db.prepare(`
    INSERT INTO mcp_servers (
      id, user_id, name, endpoint_url, auth_type, encrypted_auth_token, status, tools_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'awaiting_test', '[]', ?)
  `).run(id, req.authUser!.id, parsed.data.name, parsed.data.endpointUrl, parsed.data.authType, encryptedToken, now);

  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'mcp_server_registered',
    targetType: 'mcp_server',
    targetId: id,
    outcome: 'success',
    detail: `Registered MCP server ${parsed.data.name}`,
  });

  res.status(201).json({
    server: {
      id,
      userId: req.authUser!.id,
      name: parsed.data.name,
      endpointUrl: parsed.data.endpointUrl,
      authType: parsed.data.authType,
      status: 'awaiting_test',
      lastError: null,
      tools: [],
      createdAt: now,
    },
  });
});

mcpRouter.post('/servers/:id/discover', async (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'MCP server not found.' });
    return;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (row.encrypted_auth_token) {
    const token = decryptSecret(String(row.encrypted_auth_token));
    if (row.auth_type === 'bearer') {
      headers.Authorization = `Bearer ${token}`;
    } else if (row.auth_type === 'header') {
      headers['X-MCP-Token'] = token;
    }
  }

  try {
    const safeCheck = await assertSafeExternalUrl(String(row.endpoint_url));
    if (!safeCheck.ok) {
      throw new Error(safeCheck.reason ?? 'Blocked MCP endpoint URL');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(String(row.endpoint_url), {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from MCP endpoint`);
    }
    const json = (await resp.json()) as {
      result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    };
    const rawTools = json.result?.tools ?? [];
    const tools: McpToolSchema[] = rawTools.map((t) => {
      const sens = classifyToolSensitivity(t);
      return {
        name: String(t.name),
        description: String(t.description ?? ''),
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
        sensitive: sens.sensitive,
        sensitivityReason: sens.reason,
      };
    });

    db.prepare('UPDATE mcp_servers SET status = ?, last_error = NULL, tools_json = ? WHERE id = ? AND user_id = ?').run(
      'connected',
      JSON.stringify(tools),
      req.params.id,
      req.authUser!.id
    );

    recordAuditLog({
      actorUserId: req.authUser!.id,
      actorEmail: req.authUser!.email,
      action: 'mcp_tools_discovered',
      targetType: 'mcp_server',
      targetId: String(req.params.id),
      outcome: 'success',
      detail: `Discovered ${tools.length} tools`,
    });

    res.json({ status: 'connected', tools });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Discovery connection failed.';
    db.prepare('UPDATE mcp_servers SET status = ?, last_error = ? WHERE id = ? AND user_id = ?').run(
      'error',
      errMsg,
      req.params.id,
      req.authUser!.id
    );
    res.status(502).json({ error: errMsg, status: 'error' });
  }
});

mcpRouter.post('/servers/:id/disconnect', (req: AuthenticatedRequest, res) => {
  const result = db
    .prepare('UPDATE mcp_servers SET status = ?, last_error = NULL, tools_json = ? WHERE id = ? AND user_id = ?')
    .run('disconnected', '[]', req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'MCP server not found.' });
    return;
  }
  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'mcp_server_disconnected',
    targetType: 'mcp_server',
    targetId: String(req.params.id),
    outcome: 'success',
    detail: 'Disconnected MCP server session and cleared discovered tool permissions',
  });
  res.json({ ok: true, status: 'disconnected' });
});

mcpRouter.delete('/servers/:id', (req: AuthenticatedRequest, res) => {
  const result = db
    .prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'MCP server not found.' });
    return;
  }
  res.json({ ok: true });
});

mcpRouter.get('/approvals', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare('SELECT * FROM mcp_approvals WHERE user_id = ? ORDER BY created_at DESC LIMIT 25')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;
  res.json({
    approvals: rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      serverId: String(r.server_id),
      toolName: String(r.tool_name),
      argumentsJson: String(r.arguments_json),
      reason: String(r.reason),
      status: r.status,
      createdAt: String(r.created_at),
    })),
  });
});

mcpRouter.post('/execute', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    serverId: z.string().trim().min(1),
    toolName: z.string().trim().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    approvalId: z.string().trim().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid MCP tool execution request.' });
    return;
  }

  const server = db
    .prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?')
    .get(parsed.data.serverId, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!server) {
    res.status(404).json({ error: 'MCP server not found.' });
    return;
  }

  const tools = JSON.parse(String(server.tools_json)) as McpToolSchema[];
  const sensFallback = classifyToolSensitivity({ name: parsed.data.toolName });
  const toolMeta: McpToolSchema = tools.find((t) => t.name === parsed.data.toolName) ?? {
    name: parsed.data.toolName,
    description: '',
    inputSchema: {},
    sensitive: sensFallback.sensitive,
    sensitivityReason: sensFallback.reason,
  };

  if (toolMeta.sensitive) {
    if (!parsed.data.approvalId) {
      const approvalId = crypto.randomUUID();
      const reason =
        toolMeta.sensitivityReason ?? 'Sensitive operation requires explicit user approval before execution.';
      db.prepare(`
        INSERT INTO mcp_approvals (id, user_id, server_id, tool_name, arguments_json, reason, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        approvalId,
        req.authUser!.id,
        String(server.id),
        parsed.data.toolName,
        JSON.stringify(parsed.data.arguments),
        reason,
        new Date().toISOString()
      );
      recordAuditLog({
        actorUserId: req.authUser!.id,
        actorEmail: req.authUser!.email,
        action: 'mcp_approval_required',
        targetType: 'mcp_tool',
        targetId: parsed.data.toolName,
        outcome: 'denied',
        detail: reason,
      });
      res.status(202).json({
        requiresApproval: true,
        approvalId,
        reason,
      });
      return;
    }

    const approval = db
      .prepare('SELECT * FROM mcp_approvals WHERE id = ? AND user_id = ? AND status = ?')
      .get(parsed.data.approvalId, req.authUser!.id, 'approved') as Record<string, unknown> | undefined;
    if (!approval) {
      res.status(403).json({ error: 'Valid user approval is required to execute this sensitive tool.' });
      return;
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (server.encrypted_auth_token) {
    const token = decryptSecret(String(server.encrypted_auth_token));
    if (server.auth_type === 'bearer') headers.Authorization = `Bearer ${token}`;
    else if (server.auth_type === 'header') headers['X-MCP-Token'] = token;
  }

  try {
    const safeCheck = await assertSafeExternalUrl(String(server.endpoint_url));
    if (!safeCheck.ok) {
      throw new Error(safeCheck.reason ?? 'Blocked MCP endpoint URL');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(String(server.endpoint_url), {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: parsed.data.toolName, arguments: parsed.data.arguments },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const raw = await resp.text();

    if (parsed.data.approvalId) {
      db.prepare('UPDATE mcp_approvals SET status = ? WHERE id = ? AND user_id = ?').run(
        'executed',
        parsed.data.approvalId,
        req.authUser!.id
      );
    }

    recordAuditLog({
      actorUserId: req.authUser!.id,
      actorEmail: req.authUser!.email,
      action: 'mcp_tool_executed',
      targetType: 'mcp_tool',
      targetId: parsed.data.toolName,
      outcome: resp.ok ? 'success' : 'error',
      detail: `Executed on server ${server.name} with HTTP ${resp.status}`,
    });

    res.json({
      untrustedOutput: true,
      securityNotice: 'Tool output is treated as untrusted external data and isolated from system instructions.',
      status: resp.status,
      output: raw.slice(0, 12000),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'MCP execution failed.';
    res.status(502).json({ error: errMsg });
  }
});

mcpRouter.post('/approvals/:id/decide', (req: AuthenticatedRequest, res) => {
  const decision = z.enum(['approved', 'rejected']).safeParse(req.body?.decision);
  if (!decision.success) {
    res.status(400).json({ error: 'Decision must be approved or rejected.' });
    return;
  }
  const result = db
    .prepare('UPDATE mcp_approvals SET status = ? WHERE id = ? AND user_id = ? AND status = ?')
    .run(decision.data, req.params.id, req.authUser!.id, 'pending');
  if (result.changes === 0) {
    res.status(404).json({ error: 'Pending approval request not found.' });
    return;
  }
  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: `mcp_approval_${decision.data}`,
    targetType: 'mcp_approval',
    targetId: String(req.params.id),
    outcome: 'success',
    detail: `User marked approval ${decision.data}`,
  });
  res.json({ ok: true, status: decision.data });
});

// Built-in safe deterministic tools directory
mcpRouter.get('/builtin-tools', (_req, res) => {
  res.json({ tools: listBuiltinTools() });
});

mcpRouter.patch('/builtin-tools/:id', requireDeveloper, (req: AuthenticatedRequest, res) => {
  const enabled = z.boolean().safeParse(req.body?.enabled);
  if (!enabled.success) {
    res.status(400).json({ error: 'Boolean enabled state required.' });
    return;
  }
  const result = db.prepare('UPDATE builtin_tools SET enabled = ? WHERE id = ?').run(
    enabled.data ? 1 : 0,
    req.params.id
  );
  if (result.changes === 0) {
    res.status(404).json({ error: 'Tool not found.' });
    return;
  }
  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'builtin_tool_toggled',
    targetType: 'tool',
    targetId: String(req.params.id),
    outcome: 'success',
    detail: `Set enabled=${enabled.data}`,
  });
  res.json({ tools: listBuiltinTools() });
});

mcpRouter.get('/tool-logs', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare('SELECT * FROM tool_execution_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 40')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;
  res.json({
    logs: rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      toolId: String(r.tool_id),
      category: String(r.category),
      status: r.status,
      durationMs: Number(r.duration_ms),
      inputJson: String(r.input_json),
      outputJson: String(r.output_json),
      createdAt: String(r.created_at),
    })),
  });
});

mcpRouter.post('/builtin-tools/:id/execute', async (req: AuthenticatedRequest, res) => {
  const input = (req.body?.input ?? {}) as Record<string, unknown>;
  const approvedByUser = Boolean(req.body?.approvedByUser);
  const result = await runBuiltinToolById({
    userId: req.authUser!.id,
    userEmail: req.authUser!.email,
    toolId: String(req.params.id),
    input,
    approvedByUser,
  });

  if (result.requiresApproval) {
    res.status(202).json({
      requiresApproval: true,
      reason: result.approvalReason,
      toolId: result.toolId,
    });
    return;
  }
  if (!result.ok) {
    res.status(400).json({ error: result.error ?? 'Tool execution error.' });
    return;
  }
  res.json({ ok: true, durationMs: result.durationMs, output: result.output });
});

function mapServerTokenRow(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    label: String(r.label),
    tokenPrefix: String(r.token_prefix),
    allowedTools: JSON.parse(String(r.allowed_tools_json || '[]')) as string[],
    enabled: Boolean(r.enabled),
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    createdAt: String(r.created_at),
  };
}

mcpRouter.get('/server-tokens', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare('SELECT * FROM mcp_server_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;
  res.json({ tokens: rows.map(mapServerTokenRow) });
});

mcpRouter.post('/server-tokens', (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    label: z.string().trim().min(2).max(60),
    allowedTools: z.array(z.string().trim().min(1)).min(1).max(12),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Provide a token label and at least one tool.' });
    return;
  }

  const validToolIds = new Set(
    listBuiltinTools()
      .filter((t) => t.permissionLevel !== 'restricted')
      .map((t) => t.id)
  );
  const filteredTools = parsed.data.allowedTools.filter((tid) => validToolIds.has(tid));
  if (filteredTools.length === 0) {
    res.status(400).json({
      error: 'Select at least one non-restricted built-in tool to expose via the inbound MCP server.',
    });
    return;
  }

  const id = crypto.randomUUID();
  const plainToken = `loody_mcp_${crypto.randomBytes(20).toString('hex')}`;
  const tokenPrefix = `${plainToken.slice(0, 16)}...`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO mcp_server_tokens (id, user_id, label, token_prefix, token_hash, allowed_tools_json, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, req.authUser!.id, parsed.data.label, tokenPrefix, hashToken(plainToken), JSON.stringify(filteredTools), now);

  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'mcp_server_token_created',
    targetType: 'mcp_server_token',
    targetId: id,
    outcome: 'success',
    detail: `Issued token "${parsed.data.label}" for tools: ${filteredTools.join(', ')}`,
  });

  const row = db.prepare('SELECT * FROM mcp_server_tokens WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json({
    tokenRecord: mapServerTokenRow(row),
    plainToken,
  });
});

mcpRouter.patch('/server-tokens/:id', (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    enabled: z.boolean().optional(),
    allowedTools: z.array(z.string().trim().min(1)).min(1).max(12).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid token update payload.' });
    return;
  }
  const existing = db
    .prepare('SELECT * FROM mcp_server_tokens WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'MCP token not found.' });
    return;
  }

  const validToolIds = new Set(
    listBuiltinTools()
      .filter((t) => t.permissionLevel !== 'restricted')
      .map((t) => t.id)
  );
  const nextTools = parsed.data.allowedTools
    ? parsed.data.allowedTools.filter((t) => validToolIds.has(t))
    : (JSON.parse(String(existing.allowed_tools_json || '[]')) as string[]);
  const nextEnabled =
    parsed.data.enabled !== undefined ? (parsed.data.enabled ? 1 : 0) : Number(existing.enabled);

  db.prepare('UPDATE mcp_server_tokens SET enabled = ?, allowed_tools_json = ? WHERE id = ? AND user_id = ?').run(
    nextEnabled,
    JSON.stringify(nextTools),
    req.params.id,
    req.authUser!.id
  );
  const updated = db.prepare('SELECT * FROM mcp_server_tokens WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ tokenRecord: mapServerTokenRow(updated) });
});

mcpRouter.delete('/server-tokens/:id', (req: AuthenticatedRequest, res) => {
  const result = db
    .prepare('DELETE FROM mcp_server_tokens WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.authUser!.id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'MCP token not found.' });
    return;
  }
  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'mcp_server_token_revoked',
    targetType: 'mcp_server_token',
    targetId: String(req.params.id),
    outcome: 'success',
    detail: 'Revoked inbound LOODY MCP server token',
  });
  res.json({ ok: true });
});
