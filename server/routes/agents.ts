import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { buildDagExecutionBatches } from '../../src/shared/orchestrator';
import { computeEstimatedCostUsd, reconcileTokenRecord } from '../../src/shared/quotas';
import type { AgentProfile, AgentStepRecord, OrchestratorMode, SpecialistAgentId } from '../../src/shared/types';
import { db, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth } from '../middleware';
import { generateModelText } from '../providers';
import { createRateLimiter } from '../security';
import { runBuiltinToolById } from '../tools/engine';

export const agentsRouter = Router();
agentsRouter.use(requireAuth);
const agentRunLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20, scope: 'agent_runs' });

export const SPECIALIST_AGENTS: AgentProfile[] = [
  {
    id: 'kore',
    name: 'LOODY Kore',
    roleTitle: 'Coding & Architecture Agent',
    description: 'Designs clean code modules, audits security boundaries, and produces verified refactoring diffs.',
    allowedTools: ['js_ts_ast_static_check', 'json_schema_validator', 'regex_tester'],
    defaultMode: 'coding',
  },
  {
    id: 'research',
    name: 'LOODY Research',
    roleTitle: 'Evidence & Source Analyst',
    description: 'Cross-checks real web sources, extracts URL evidence, and flags conflicting claims honestly.',
    allowedTools: ['gemini_web_search', 'url_text_extractor'],
    defaultMode: 'research',
  },
  {
    id: 'work',
    name: 'LOODY Work',
    roleTitle: 'Operations & Task Orchestrator',
    description: 'Breaks goals into structured project tasks, milestones, owners, and approval checkpoints.',
    allowedTools: ['utc_clock', 'project_task_creator', 'token_budget_estimator'],
    defaultMode: 'work',
  },
  {
    id: 'creative',
    name: 'LOODY Creative',
    roleTitle: 'Studio & Storyboard Director',
    description: 'Produces scripts, visual scene timelines, SVG layouts, and multi-track production briefs.',
    allowedTools: ['token_budget_estimator'],
    defaultMode: 'creative',
  },
  {
    id: 'data',
    name: 'LOODY Data',
    roleTitle: 'Quantitative & CSV Profiler',
    description: 'Analyzes structured tables, computes KPI statistics, and validates JSON schemas.',
    allowedTools: ['csv_stats_profiler', 'json_schema_validator'],
    defaultMode: 'analysis',
  },
  {
    id: 'education',
    name: 'LOODY Education',
    roleTitle: 'Curriculum & Study Mentor',
    description: 'Builds progressive lessons, exercises, rubrics, and concept explanations tailored to learners.',
    allowedTools: ['utc_clock'],
    defaultMode: 'deep_thinking',
  },
  {
    id: 'business',
    name: 'LOODY Business',
    roleTitle: 'Strategy & Product Planner',
    description: 'Produces go-to-market memos, risk registers, pricing models, and executive summaries.',
    allowedTools: ['utc_clock', 'project_task_creator'],
    defaultMode: 'work',
  },
];

const activeRunControllers = new Map<string, AbortController>();

function mapStepRow(r: Record<string, unknown>): AgentStepRecord {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    agentId: String(r.agent_id) as SpecialistAgentId,
    title: String(r.title),
    dependsOn: JSON.parse(String(r.depends_on_json || '[]')),
    toolIds: JSON.parse(String(r.tool_ids_json || '[]')),
    status: String(r.status) as AgentStepRecord['status'],
    inputSummary: String(r.input_summary || ''),
    outputText: String(r.output_text || ''),
    approvalRequired: Boolean(r.approval_required),
    approvalStatus: String(r.approval_status || 'none') as AgentStepRecord['approvalStatus'],
    durationMs: Number(r.duration_ms ?? 0),
    errorMessage: r.error_message ? String(r.error_message) : null,
    stepOrder: Number(r.step_order ?? 0),
  };
}

function hydrateRun(runRow: Record<string, unknown>) {
  const runId = String(runRow.id);
  const steps = (
    db.prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_order ASC').all(runId) as Array<
      Record<string, unknown>
    >
  ).map(mapStepRow);
  return {
    id: runId,
    userId: String(runRow.user_id),
    projectId: runRow.project_id ? String(runRow.project_id) : null,
    goal: String(runRow.goal),
    mode: String(runRow.mode) as OrchestratorMode,
    status: String(runRow.status),
    finalOutput: String(runRow.final_output || ''),
    totalTokens: Number(runRow.total_tokens ?? 0),
    idempotencyKey: runRow.idempotency_key ? String(runRow.idempotency_key) : null,
    steps,
    createdAt: String(runRow.created_at),
    updatedAt: String(runRow.updated_at),
  };
}

const STEP_TIMEOUT_MS = 45_000;

function buildPlanStepsForGoal(params: {
  goal: string;
  selectedAgents: SpecialistAgentId[];
  includeApprovalGate: boolean;
}) {
  const agents = params.selectedAgents.length > 0 ? params.selectedAgents : (['research', 'work'] as SpecialistAgentId[]);
  const stepSpecs: Array<{
    id: string;
    agentId: SpecialistAgentId;
    title: string;
    dependsOn: string[];
    toolIds: string[];
    approvalRequired: boolean;
  }> = [];

  if (agents.length === 1) {
    const aId = agents[0];
    const profile = SPECIALIST_AGENTS.find((a) => a.id === aId) ?? SPECIALIST_AGENTS[2];
    stepSpecs.push({
      id: 'step-1',
      agentId: aId,
      title: `${profile.name}: Execute Objective`,
      dependsOn: [],
      toolIds: profile.allowedTools.slice(0, 2),
      approvalRequired: params.includeApprovalGate && profile.allowedTools.includes('project_task_creator'),
    });
  } else {
    // Wave 1: independent initial specialist analyses run concurrently
    const firstWaveIds: string[] = [];
    agents.slice(0, 2).forEach((aId, idx) => {
      const profile = SPECIALIST_AGENTS.find((a) => a.id === aId) ?? SPECIALIST_AGENTS[0];
      const stepId = `step-${idx + 1}`;
      firstWaveIds.push(stepId);
      stepSpecs.push({
        id: stepId,
        agentId: aId,
        title: `${profile.name}: Specialist Analysis`,
        dependsOn: [],
        toolIds: profile.allowedTools.filter((t) => t !== 'project_task_creator').slice(0, 1),
        approvalRequired: false,
      });
    });

    // Wave 2: dependent synthesis/delivery step
    const synthesizer = agents[2] ?? 'work';
    const synthProfile = SPECIALIST_AGENTS.find((a) => a.id === synthesizer) ?? SPECIALIST_AGENTS[2];
    stepSpecs.push({
      id: 'step-synth',
      agentId: synthesizer,
      title: `${synthProfile.name}: Final Deliverable Synthesis`,
      dependsOn: firstWaveIds,
      toolIds: params.includeApprovalGate ? ['project_task_creator'] : ['utc_clock'],
      approvalRequired: params.includeApprovalGate,
    });
  }

  // Validate DAG with shared pure scheduler
  buildDagExecutionBatches(stepSpecs);
  return stepSpecs;
}

async function executeRunPipeline(runId: string, userId: string, userEmail: string) {
  const controller = new AbortController();
  activeRunControllers.set(runId, controller);

  try {
    db.prepare("UPDATE agent_runs SET status = 'running', updated_at = ? WHERE id = ? AND user_id = ?").run(
      new Date().toISOString(),
      runId,
      userId
    );

    const runRow = db.prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?').get(runId, userId) as
      | Record<string, unknown>
      | undefined;
    if (!runRow) return;

    const goal = String(runRow.goal);
    const projectId = runRow.project_id ? String(runRow.project_id) : null;
    const stepRows = db
      .prepare('SELECT * FROM agent_steps WHERE run_id = ? AND user_id = ? ORDER BY step_order ASC')
      .all(runId, userId) as Array<Record<string, unknown>>;

    const steps = stepRows.map(mapStepRow);
    const batches = buildDagExecutionBatches(steps);
    let cumulativeTokens = Number(runRow.total_tokens ?? 0);

    for (const batch of batches) {
      const latestRunState = db
        .prepare('SELECT status FROM agent_runs WHERE id = ?')
        .get(runId) as { status: string } | undefined;
      if (latestRunState?.status === 'paused') {
        return;
      }
      if (controller.signal.aborted || latestRunState?.status === 'cancelled') {
        db.prepare("UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          runId
        );
        return;
      }

      await Promise.all(
        batch.map(async (step) => {
          if (step.status === 'completed' || step.status === 'cancelled') return;

          if (step.approvalRequired && step.approvalStatus !== 'approved') {
            db.prepare(
              "UPDATE agent_steps SET status = 'awaiting_approval', approval_status = 'pending' WHERE id = ? AND run_id = ?"
            ).run(step.id, runId);
            return;
          }

          const stepStart = Date.now();
          db.prepare("UPDATE agent_steps SET status = 'running' WHERE id = ? AND run_id = ?").run(step.id, runId);

          // Gather dependency outputs as shared task state
          const depOutputs = steps
            .filter((s) => step.dependsOn.includes(s.id))
            .map((d) => {
              const latest = db.prepare('SELECT output_text FROM agent_steps WHERE id = ?').get(d.id) as
                | { output_text: string }
                | undefined;
              return `--- Prior Step (${d.title}) ---\n${latest?.output_text ?? ''}`;
            })
            .join('\n\n');

          // Execute allowed deterministic/external tools cleanly
          const toolNotes: string[] = [];
          for (const toolId of step.toolIds) {
            const toolInput: Record<string, unknown> =
              toolId === 'gemini_web_search'
                ? { query: goal.slice(0, 240) }
                : toolId === 'project_task_creator'
                ? { title: `Deliverable: ${goal.slice(0, 64)}`, priority: 'high', projectId }
                : { timezone: 'UTC', text: goal };
            const toolRes = await runBuiltinToolById({
              userId,
              userEmail,
              toolId,
              input: toolInput,
              approvedByUser: step.approvalStatus === 'approved',
            });
            toolNotes.push(
              toolRes.ok
                ? `Tool ${toolId} output: ${JSON.stringify(toolRes.output).slice(0, 2500)}`
                : `Tool ${toolId} note: ${toolRes.error ?? 'Approval needed'}`
            );
          }

          const profile = SPECIALIST_AGENTS.find((a) => a.id === step.agentId) ?? SPECIALIST_AGENTS[2];
          const stepAbortController = new AbortController();
          const onRunAbort = () => stepAbortController.abort();
          controller.signal.addEventListener('abort', onRunAbort, { once: true });
          const stepTimer = setTimeout(() => stepAbortController.abort(new Error('Agent step timed out after 45s')), STEP_TIMEOUT_MS);
          try {
            const gen = await generateModelText({
              upstreamModelId: 'gemini-4-hydrogen',
              thinkingPreset: 'MEDIUM',
              signal: stepAbortController.signal,
              systemInstruction: `You are ${profile.name} (${profile.roleTitle}) inside LOODY Multi-Agent Orchestrator. Stay strictly grounded in provided context and tool outputs. Never fabricate executed tests or unverified URLs.`,
              prompt: `Overall Goal:\n${goal}\n\nAssigned Role Step: ${step.title}\n\n${
                toolNotes.length > 0 ? `Tool Execution Results:\n${toolNotes.join('\n')}\n\n` : ''
              }${depOutputs ? `Shared Task State from Dependencies:\n${depOutputs}\n\n` : ''}Produce a structured, concrete output for this step.`,
            });

            const reconciled = reconcileTokenRecord({
              providerReported: {
                inputTokens: gen.inputTokens,
                outputTokens: gen.outputTokens,
                cachedTokens: gen.cachedTokens,
              },
              fallbackInputText: goal,
              fallbackOutputText: gen.text,
            });
            cumulativeTokens += reconciled.inputTokens + reconciled.outputTokens;
            const now = new Date().toISOString();

            db.prepare(`
              INSERT INTO token_usage (
                id, user_id, conversation_id, model_id, provider, task_type,
                input_tokens, output_tokens, cached_tokens, accounting_type,
                estimated_cost_usd, usage_date, usage_month, created_at
              ) VALUES (?, ?, ?, 'sonic-3.5', 'gemini', 'agent', ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              crypto.randomUUID(),
              userId,
              runId,
              reconciled.inputTokens,
              reconciled.outputTokens,
              reconciled.cachedTokens,
              reconciled.accountingType,
              computeEstimatedCostUsd({
                provider: 'gemini',
                inputTokens: reconciled.inputTokens,
                outputTokens: reconciled.outputTokens,
                cachedTokens: reconciled.cachedTokens,
              }),
              now.slice(0, 10),
              now.slice(0, 7),
              now
            );

            db.prepare(
              "UPDATE agent_steps SET status = 'completed', output_text = ?, duration_ms = ? WHERE id = ? AND run_id = ?"
            ).run(gen.text, Date.now() - stepStart, step.id, runId);
          } catch (err) {
            const currentRun = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as
              | { status: string }
              | undefined;
            if (currentRun?.status === 'paused') {
              db.prepare("UPDATE agent_steps SET status = 'pending', duration_ms = ? WHERE id = ? AND run_id = ?").run(
                Date.now() - stepStart,
                step.id,
                runId
              );
            } else {
              const errMsg = err instanceof Error ? err.message : 'Agent step failed.';
              db.prepare(
                "UPDATE agent_steps SET status = 'failed', error_message = ?, duration_ms = ? WHERE id = ? AND run_id = ?"
              ).run(errMsg, Date.now() - stepStart, step.id, runId);
            }
          } finally {
            clearTimeout(stepTimer);
            controller.signal.removeEventListener('abort', onRunAbort);
          }
        })
      );

      const postWaveRun = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId) as
        | { status: string }
        | undefined;
      if (postWaveRun?.status === 'paused') {
        return;
      }

      // Pause outer loop cleanly if any step is awaiting approval or failed
      const freshSteps = (
        db.prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_order ASC').all(runId) as Array<
          Record<string, unknown>
        >
      ).map(mapStepRow);
      if (freshSteps.some((s) => s.status === 'awaiting_approval')) {
        db.prepare("UPDATE agent_runs SET status = 'awaiting_approval', total_tokens = ?, updated_at = ? WHERE id = ?").run(
          cumulativeTokens,
          new Date().toISOString(),
          runId
        );
        return;
      }
      if (freshSteps.some((s) => s.status === 'failed')) {
        db.prepare("UPDATE agent_runs SET status = 'failed', total_tokens = ?, updated_at = ? WHERE id = ?").run(
          cumulativeTokens,
          new Date().toISOString(),
          runId
        );
        return;
      }
    }

    // Aggregate final deliverable cleanly from completed steps and write Task Memory
    const doneSteps = (
      db.prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_order ASC').all(runId) as Array<
        Record<string, unknown>
      >
    ).map(mapStepRow);

    const finalOutput = doneSteps
      .map((s) => `## ${s.title}\n\n${s.outputText}`)
      .join('\n\n---\n\n');
    const finishedAt = new Date().toISOString();

    db.prepare(
      "UPDATE agent_runs SET status = 'completed', final_output = ?, total_tokens = ?, updated_at = ? WHERE id = ?"
    ).run(finalOutput, cumulativeTokens, finishedAt, runId);

    // Save compact task memory entry for ongoing workspace continuity
    db.prepare(`
      INSERT INTO user_memories (id, user_id, project_id, scope, category, content, source_type, approved, created_at, updated_at)
      VALUES (?, ?, ?, 'task', 'fact', ?, 'extracted', 1, ?, ?)
    `).run(
      crypto.randomUUID(),
      userId,
      projectId,
      `Agent goal completed: "${goal.slice(0, 120)}" (${doneSteps.length} steps).`,
      finishedAt,
      finishedAt
    );
  } finally {
    activeRunControllers.delete(runId);
  }
}

agentsRouter.get('/profiles', (_req, res) => {
  res.json({ agents: SPECIALIST_AGENTS });
});

agentsRouter.get('/runs', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare('SELECT * FROM agent_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 25')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;
  res.json({ runs: rows.map(hydrateRun) });
});

agentsRouter.get('/runs/:id', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Agent run not found.' });
    return;
  }
  res.json({ run: hydrateRun(row) });
});

agentsRouter.post('/runs', agentRunLimiter, async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    goal: z.string().trim().min(5).max(4000),
    projectId: z.string().trim().nullable().optional(),
    mode: z
      .enum(['auto', 'fast', 'deep_thinking', 'research', 'coding', 'creative', 'analysis', 'work'])
      .optional()
      .default('work'),
    agents: z
      .array(z.enum(['kore', 'research', 'work', 'creative', 'data', 'education', 'business']))
      .max(4)
      .optional()
      .default(['research', 'work']),
    requireApprovalForWrite: z.boolean().optional().default(true),
    idempotencyKey: z.string().trim().min(4).max(120).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid agent run request.' });
    return;
  }

  const user = req.authUser!;
  if (parsed.data.idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM agent_runs WHERE user_id = ? AND idempotency_key = ?')
      .get(user.id, parsed.data.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      res.status(200).json({ run: hydrateRun(existing), deduplicated: true });
      return;
    }
  }

  const projectId = parsed.data.projectId ?? null;
  if (projectId) {
    const owns = db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, user.id);
    if (!owns) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
  }

  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const planSteps = buildPlanStepsForGoal({
    goal: parsed.data.goal,
    selectedAgents: parsed.data.agents as SpecialistAgentId[],
    includeApprovalGate: parsed.data.requireApprovalForWrite,
  });

  db.prepare(`
    INSERT INTO agent_runs (id, user_id, project_id, goal, mode, status, final_output, total_tokens, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', '', 0, ?, ?, ?)
  `).run(runId, user.id, projectId, parsed.data.goal, parsed.data.mode, parsed.data.idempotencyKey ?? null, now, now);

  const idMap = new Map<string, string>();
  planSteps.forEach((s) => idMap.set(s.id, `${runId.slice(0, 8)}-${s.id}`));

  const insertStep = db.prepare(`
    INSERT INTO agent_steps (
      id, run_id, user_id, agent_id, title, depends_on_json, tool_ids_json,
      status, input_summary, output_text, approval_required, approval_status, duration_ms, step_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, '', ?, 'none', 0, ?)
  `);

  planSteps.forEach((s, idx) => {
    insertStep.run(
      idMap.get(s.id)!,
      runId,
      user.id,
      s.agentId,
      s.title,
      JSON.stringify(s.dependsOn.map((d) => idMap.get(d)!)),
      JSON.stringify(s.toolIds),
      parsed.data.goal.slice(0, 200),
      s.approvalRequired ? 1 : 0,
      idx
    );
  });

  recordAuditLog({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'agent_run_started',
    targetType: 'agent_run',
    targetId: runId,
    outcome: 'success',
    detail: `Started ${planSteps.length}-step multi-agent DAG run`,
  });

  // Execute synchronously for deterministic tests/immediate response OR resumeable on approval
  await executeRunPipeline(runId, user.id, user.email);

  const finalRow = db.prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?').get(runId, user.id) as Record<
    string,
    unknown
  >;
  res.status(201).json({ run: hydrateRun(finalRow) });
});

agentsRouter.post('/runs/:id/approve-step/:stepId', async (req: AuthenticatedRequest, res) => {
  const decision = z.enum(['approved', 'rejected']).safeParse(req.body?.decision);
  if (!decision.success) {
    res.status(400).json({ error: 'Decision must be approved or rejected.' });
    return;
  }

  const runRow = db
    .prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!runRow) {
    res.status(404).json({ error: 'Agent run not found.' });
    return;
  }

  const stepRow = db
    .prepare('SELECT * FROM agent_steps WHERE id = ? AND run_id = ? AND user_id = ?')
    .get(req.params.stepId, req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!stepRow) {
    res.status(404).json({ error: 'Agent step not found.' });
    return;
  }

  if (decision.data === 'rejected') {
    db.prepare("UPDATE agent_steps SET status = 'cancelled', approval_status = 'rejected' WHERE id = ?").run(
      req.params.stepId
    );
    db.prepare("UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      req.params.id
    );
  } else {
    db.prepare("UPDATE agent_steps SET status = 'pending', approval_status = 'approved' WHERE id = ?").run(
      req.params.stepId
    );
    await executeRunPipeline(String(req.params.id), req.authUser!.id, req.authUser!.email);
  }

  const updated = db
    .prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown>;
  res.json({ run: hydrateRun(updated) });
});

agentsRouter.post('/runs/:id/cancel', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Agent run not found.' });
    return;
  }
  activeRunControllers.get(String(req.params.id))?.abort();
  db.prepare("UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    req.params.id
  );
  db.prepare("UPDATE agent_steps SET status = 'cancelled' WHERE run_id = ? AND status IN ('pending', 'running', 'awaiting_approval')").run(
    req.params.id
  );
  const updated = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ run: hydrateRun(updated) });
});

agentsRouter.post('/runs/:id/pause', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Agent run not found.' });
    return;
  }
  const status = String(row.status);
  if (!['running', 'queued', 'awaiting_approval'].includes(status)) {
    res.status(400).json({ error: `Cannot pause an agent run in "${status}" state.` });
    return;
  }
  db.prepare("UPDATE agent_runs SET status = 'paused', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    req.params.id
  );
  db.prepare("UPDATE agent_steps SET status = 'pending' WHERE run_id = ? AND status = 'running'").run(req.params.id);
  activeRunControllers.get(String(req.params.id))?.abort();
  const updated = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(req.params.id) as Record<string, unknown>;
  res.json({ run: hydrateRun(updated) });
});

agentsRouter.post('/runs/:id/resume', async (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Agent run not found.' });
    return;
  }
  const status = String(row.status);
  if (status !== 'paused' && status !== 'failed') {
    res.status(400).json({ error: `Only paused or failed runs can be resumed (current: ${status}).` });
    return;
  }
  db.prepare("UPDATE agent_steps SET status = 'pending', error_message = NULL WHERE run_id = ? AND status = 'failed'").run(
    req.params.id
  );
  await executeRunPipeline(String(req.params.id), req.authUser!.id, req.authUser!.email);
  const updated = db
    .prepare('SELECT * FROM agent_runs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown>;
  res.json({ run: hydrateRun(updated) });
});

