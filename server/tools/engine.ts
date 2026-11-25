import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { db, listBuiltinTools, recordAuditLog } from '../db';
import { createGeminiClient } from '../providers';
import { assertSafeExternalUrl } from '../security';

export interface ToolRunParams {
  userId: string;
  userEmail: string;
  toolId: string;
  input: Record<string, unknown>;
  approvedByUser?: boolean;
}

export interface ToolRunResult {
  ok: boolean;
  requiresApproval?: boolean;
  approvalReason?: string;
  toolId: string;
  category: string;
  durationMs: number;
  output?: unknown;
  error?: string;
}

export async function runBuiltinToolById(params: ToolRunParams): Promise<ToolRunResult> {
  const start = Date.now();
  const tools = listBuiltinTools();
  const meta = tools.find((t) => t.id === params.toolId);
  if (!meta) {
    return {
      ok: false,
      toolId: params.toolId,
      category: 'Unknown',
      durationMs: Date.now() - start,
      error: `Unknown tool: ${params.toolId}`,
    };
  }
  if (!meta.enabled) {
    return {
      ok: false,
      toolId: meta.id,
      category: meta.category ?? 'General',
      durationMs: Date.now() - start,
      error: `${meta.name} is currently disabled in Tool Directory.`,
    };
  }
  if (meta.permissionLevel === 'restricted' && !params.approvedByUser) {
    return {
      ok: false,
      requiresApproval: true,
      approvalReason: `${meta.name} modifies persistent workspace state and requires explicit user approval.`,
      toolId: meta.id,
      category: meta.category ?? 'General',
      durationMs: Date.now() - start,
    };
  }

  let output: unknown;
  try {
    switch (meta.id) {
      case 'utc_clock': {
        const tz =
          typeof params.input.timezone === 'string' && params.input.timezone.trim()
            ? params.input.timezone.trim()
            : 'UTC';
        const now = new Date();
        output = {
          isoUtc: now.toISOString(),
          unixEpochSeconds: Math.floor(now.getTime() / 1000),
          formatted: new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            dateStyle: 'full',
            timeStyle: 'long',
          }).format(now),
          timezone: tz,
        };
        break;
      }

      case 'json_schema_validator': {
        const raw =
          typeof params.input.payload === 'string'
            ? params.input.payload
            : JSON.stringify(params.input.payload ?? {});
        const parsed = JSON.parse(raw);
        output = {
          valid: true,
          rootType: Array.isArray(parsed) ? 'array' : typeof parsed,
          keys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [],
        };
        break;
      }

      case 'token_budget_estimator': {
        const text = typeof params.input.text === 'string' ? params.input.text : '';
        output = {
          characters: text.length,
          estimatedTokens: Math.max(0, Math.ceil(text.trim().length / 4)),
          accountingNote: 'Heuristic estimate only — never counted as exact provider-reported usage.',
        };
        break;
      }

      case 'regex_tester': {
        const pattern = typeof params.input.pattern === 'string' ? params.input.pattern.slice(0, 120) : '';
        const sample = typeof params.input.sample === 'string' ? params.input.sample.slice(0, 2000) : '';
        // Reject catastrophic nested quantifier ReDoS patterns before compilation
        if (/(\([^)]*[+*][^)]*\)|\[[^\]]*\][+*]|[+*])\s*[+*{]/.test(pattern) || /\\\d+\s*[+*{]/.test(pattern)) {
          throw new Error('Regex pattern rejected due to nested quantifier complexity risk.');
        }
        const re = new RegExp(pattern);
        const match = re.exec(sample);
        output = {
          matched: Boolean(match),
          matchedText: match ? match[0] : null,
        };
        break;
      }

      case 'csv_stats_profiler': {
        const rawCsv = typeof params.input.csv === 'string' ? params.input.csv.trim() : '';
        if (!rawCsv) throw new Error('Non-empty csv string required.');
        const lines = rawCsv.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length < 2) throw new Error('CSV must include header row and at least 1 data row.');
        const headers = lines[0].split(',').map((h) => h.trim());
        const rows = lines.slice(1, 5000).map((line) => line.split(',').map((c) => c.trim()));
        const columns = headers.map((header, idx) => {
          const values = rows.map((r) => r[idx] ?? '').filter((v) => v !== '');
          const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
          if (nums.length > 0 && nums.length === values.length) {
            const sum = nums.reduce((a, b) => a + b, 0);
            return {
              name: header,
              type: 'numeric',
              nonEmpty: values.length,
              min: Math.min(...nums),
              max: Math.max(...nums),
              mean: Number((sum / nums.length).toFixed(4)),
            };
          }
          return {
            name: header,
            type: 'string',
            nonEmpty: values.length,
            uniqueCount: new Set(values).size,
          };
        });
        output = { rowCount: rows.length, columnCount: headers.length, columns };
        break;
      }

      case 'js_ts_ast_static_check': {
        const code = typeof params.input.code === 'string' ? params.input.code : '';
        if (!code.trim()) throw new Error('Non-empty code string required.');
        const findings: Array<{ severity: 'high' | 'medium' | 'info'; message: string }> = [];
        if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) {
          findings.push({ severity: 'high', message: 'Dynamic code execution (eval/new Function) detected.' });
        }
        if (/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(code)) {
          findings.push({ severity: 'high', message: 'Potential DOM XSS sink (innerHTML / dangerouslySetInnerHTML).' });
        }
        if (/child_process|execSync\s*\(/.test(code)) {
          findings.push({ severity: 'medium', message: 'Shell execution API detected; verify strict input validation.' });
        }
        if (/password\s*=\s*['"][^'"]+['"]|apiKey\s*=\s*['"][^'"]+['"]/i.test(code)) {
          findings.push({ severity: 'high', message: 'Possible hardcoded credential literal detected.' });
        }
        let tsErrors: string[] = [];
        try {
          const esbuild = await import('esbuild');
          await esbuild.transform(code, {
            loader: 'tsx',
            target: 'es2022',
          });
        } catch (parseErr: unknown) {
          const errObj = parseErr as { errors?: Array<{ text: string; location?: { line?: number; column?: number } }>; message?: string };
          if (Array.isArray(errObj?.errors) && errObj.errors.length > 0) {
            tsErrors = errObj.errors.map((e) =>
              e.location ? `Line ${e.location.line ?? '?'}:${e.location.column ?? '?'} — ${e.text}` : e.text
            );
          } else if (errObj?.message) {
            tsErrors = [errObj.message];
          }
        }
        output = {
          lines: code.split('\n').length,
          characters: code.length,
          securityFindings: findings,
          syntaxDiagnostics: tsErrors,
          passed: findings.filter((f) => f.severity === 'high').length === 0 && tsErrors.length === 0,
        };
        break;
      }

      case 'url_text_extractor': {
        const urlStr = typeof params.input.url === 'string' ? params.input.url.trim() : '';
        const check = await assertSafeExternalUrl(urlStr);
        if (!check.ok) throw new Error(check.reason ?? 'Blocked URL');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch(urlStr, {
            method: 'GET',
            headers: { 'User-Agent': 'LOODY-Research-Fetcher/2.0' },
            redirect: 'error',
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!resp.ok) throw new Error(`HTTP ${resp.status} while fetching URL`);
          const MAX_FETCH_BYTES = 512 * 1024;
          const reader = resp.body?.getReader();
          let html = '';
          if (reader) {
            const decoder = new TextDecoder();
            let receivedBytes = 0;
            while (receivedBytes < MAX_FETCH_BYTES) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                receivedBytes += value.byteLength;
                html += decoder.decode(value, { stream: true });
              }
            }
            html += decoder.decode();
            await reader.cancel().catch(() => null);
          } else {
            html = (await resp.text()).slice(0, MAX_FETCH_BYTES);
          }
          const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
          const cleanText = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 6000);
          output = {
            url: urlStr,
            status: resp.status,
            title: titleMatch?.[1]?.trim() || urlStr,
            excerpt: cleanText,
            retrievedAt: new Date().toISOString(),
          };
        } finally {
          clearTimeout(timer);
        }
        break;
      }

      case 'gemini_web_search': {
        const query = typeof params.input.query === 'string' ? params.input.query.trim() : '';
        if (!query) throw new Error('Search query required.');
        const ai = createGeminiClient();
        if (!ai) {
          throw new Error('GEMINI_API_KEY not configured on server for live web search grounding.');
        }
        let resp: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
        let lastSearchErr: unknown = null;
        for (const searchModel of ['gemini-3.1-flash-lite', 'gemini-3.6-flash']) {
          try {
            resp = await ai.models.generateContent({
              model: searchModel,
              contents: `Search the web and summarize verifiable facts for: ${query}`,
              config: {
                tools: [{ googleSearch: {} }],
                abortSignal: AbortSignal.timeout(15_000),
              },
            });
            break;
          } catch (err) {
            lastSearchErr = err;
          }
        }
        if (!resp) {
          throw lastSearchErr instanceof Error ? lastSearchErr : new Error('Live web search failed.');
        }
        const chunks = resp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const sources = chunks
          .map((c: { web?: { uri?: string; title?: string } }) => ({
            url: c.web?.uri ?? '',
            title: c.web?.title ?? 'Web Source',
          }))
          .filter((s) => Boolean(s.url));
        output = {
          query,
          answer: (resp.text ?? '').trim(),
          sources,
          retrievedAt: new Date().toISOString(),
        };
        break;
      }

      case 'project_task_creator': {
        const title =
          typeof params.input.title === 'string' && params.input.title.trim()
            ? params.input.title.trim().slice(0, 120)
            : 'Workspace Task';
        const priority =
          params.input.priority === 'high' || params.input.priority === 'low'
            ? params.input.priority
            : 'medium';
        const rawProjectId =
          typeof params.input.projectId === 'string' && params.input.projectId.trim()
            ? params.input.projectId.trim()
            : null;
        if (rawProjectId) {
          const ownedProject = db
            .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
            .get(rawProjectId, params.userId) as { id: string } | undefined;
          if (!ownedProject) {
            throw new Error('Target project not found or access denied.');
          }
        }
        const taskId = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO project_tasks (id, user_id, project_id, title, description, status, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(
          taskId,
          params.userId,
          rawProjectId,
          title,
          typeof params.input.description === 'string' ? params.input.description.slice(0, 1000) : '',
          priority,
          now,
          now
        );
        output = { createdTaskId: taskId, title, priority, status: 'active' };
        break;
      }

      default:
        throw new Error(`No handler registered for tool ${meta.id}`);
    }

    const durationMs = Date.now() - start;
    db.prepare(`
      INSERT INTO tool_execution_logs (id, user_id, tool_id, category, input_json, output_json, status, duration_ms, approved_by_user, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      params.userId,
      meta.id,
      meta.category ?? 'General',
      JSON.stringify(params.input).slice(0, 4000),
      JSON.stringify(output).slice(0, 8000),
      durationMs,
      params.approvedByUser ? 1 : 0,
      new Date().toISOString()
    );

    recordAuditLog({
      actorUserId: params.userId,
      actorEmail: params.userEmail,
      action: 'builtin_tool_executed',
      targetType: 'tool',
      targetId: meta.id,
      outcome: 'success',
      detail: `Executed in ${durationMs}ms`,
    });

    return {
      ok: true,
      toolId: meta.id,
      category: meta.category ?? 'General',
      durationMs,
      output,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : 'Tool execution error.';
    db.prepare(`
      INSERT INTO tool_execution_logs (id, user_id, tool_id, category, input_json, output_json, status, duration_ms, approved_by_user, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'error', ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      params.userId,
      meta.id,
      meta.category ?? 'General',
      JSON.stringify(params.input).slice(0, 4000),
      JSON.stringify({ error: errMsg }),
      durationMs,
      params.approvedByUser ? 1 : 0,
      new Date().toISOString()
    );
    return {
      ok: false,
      toolId: meta.id,
      category: meta.category ?? 'General',
      durationMs,
      error: errMsg,
    };
  }
}

export const noopMiddleware: RequestHandler = (_req, _res, next) => next();
