import { Router } from 'express';
import { COMMERCIAL_PLANS, DEFAULT_PLAN_LIMITS, MAX_CONFIGURABLE_DAILY_TOKENS } from '../../src/shared/quotas';
import { db, recordAuditLog } from '../db';
import { type AuthenticatedRequest, getUserQuotaUsage, requireAuth } from '../middleware';

export const billingRouter = Router();

billingRouter.use(requireAuth);

billingRouter.get('/summary', (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const quota = getUserQuotaUsage(user.id);

  const agg = db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN accounting_type = 'provider_reported' THEN input_tokens + output_tokens ELSE 0 END), 0) AS provider_reported_total,
        COALESCE(SUM(CASE WHEN accounting_type = 'estimated' THEN input_tokens + output_tokens ELSE 0 END), 0) AS estimated_total,
        COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd
      FROM token_usage
      WHERE user_id = ?
    `)
    .get(user.id) as {
    provider_reported_total: number;
    estimated_total: number;
    total_cost_usd: number;
  };

  const recentRows = db
    .prepare('SELECT * FROM token_usage WHERE user_id = ? ORDER BY created_at DESC LIMIT 25')
    .all(user.id) as Array<Record<string, unknown>>;

  const taskAggRows = db
    .prepare(`
      SELECT COALESCE(task_type, 'chat') AS task_type,
        COUNT(*) AS req_count,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
        COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
      FROM token_usage
      WHERE user_id = ?
      GROUP BY COALESCE(task_type, 'chat')
    `)
    .all(user.id) as Array<{ task_type: string; req_count: number; total_tokens: number; total_cost: number }>;

  const byTaskType: Record<string, { tokens: number; costUsd: number; count: number }> = {};
  for (const row of taskAggRows) {
    byTaskType[row.task_type] = {
      tokens: Number(row.total_tokens ?? 0),
      costUsd: Number(Number(row.total_cost ?? 0).toFixed(6)),
      count: Number(row.req_count ?? 0),
    };
  }

  const paymentProviderConfigured = Boolean(process.env.STRIPE_SECRET_KEY);

  res.json({
    plan: user.plan,
    role: user.role,
    subscriptionStatus: user.role === 'developer' ? 'developer_privilege' : 'active',
    renewalStatus: user.plan === 'free' || user.role === 'developer' ? 'not_applicable' : 'active',
    paymentProviderConfigured,
    paymentProviderLabel: paymentProviderConfigured ? 'Stripe Billing' : 'Awaiting Payment Provider Configuration',
    commercialCatalog: COMMERCIAL_PLANS,
    plans: [
      {
        id: 'free',
        name: 'Free',
        audience: 'For personal exploration and fast everyday chat',
        priceDisplay: '$0 / month',
        dailyLimit: DEFAULT_PLAN_LIMITS.free.daily,
        monthlyLimit: DEFAULT_PLAN_LIMITS.free.monthly,
        models: ['Sonic 3', 'Sonic 3.5', 'LOODY Vision 1 (Preview)'],
      },
      {
        id: 'premium',
        name: 'Pro / Max Ready',
        audience: 'Pro ($15/mo) & Max ($40/mo) tiers when payment gateway is enabled',
        priceDisplay: '$15 - $40 / month (billing disabled)',
        dailyLimit: DEFAULT_PLAN_LIMITS.premium.daily,
        monthlyLimit: DEFAULT_PLAN_LIMITS.premium.monthly,
        models: ['All Free Models', 'Lodie 5.5', 'Fables 5.3'],
      },
      {
        id: 'developer',
        name: 'Developer',
        audience: 'Server-assigned internal testing & administration allowlist',
        priceDisplay: 'Internal Allowlist',
        dailyLimit: MAX_CONFIGURABLE_DAILY_TOKENS,
        monthlyLimit: DEFAULT_PLAN_LIMITS.developer.monthly,
        models: ['All Configured Models', 'Admin Model Registry', 'Audit Logs'],
      },
    ],
    billingHistory: [],
    usage: {
      dailyUsed: quota.dailyUsed,
      dailyLimit: user.dailyTokenLimit,
      monthlyUsed: quota.monthlyUsed,
      monthlyLimit: user.monthlyTokenLimit,
      providerReportedTotal: Number(agg.provider_reported_total ?? 0),
      estimatedTotal: Number(agg.estimated_total ?? 0),
      estimatedCostUsd: Number((agg.total_cost_usd ?? 0).toFixed(6)),
      byTaskType,
      recentEntries: recentRows.map((r) => ({
        id: String(r.id),
        modelId: String(r.model_id),
        provider: r.provider,
        taskType: r.task_type ? String(r.task_type) : 'chat',
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cachedTokens: Number(r.cached_tokens),
        accountingType: r.accounting_type,
        estimatedCostUsd: Number(r.estimated_cost_usd),
        createdAt: String(r.created_at),
      })),
    },
  });
});

// Never simulate successful payments — require real configured payment provider
billingRouter.post('/upgrade', (req: AuthenticatedRequest, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    recordAuditLog({
      actorUserId: req.authUser!.id,
      actorEmail: req.authUser!.email,
      action: 'subscription_upgrade_blocked',
      targetType: 'billing',
      targetId: req.authUser!.id,
      outcome: 'denied',
      detail: 'Blocked checkout attempt: payment provider credentials not configured',
    });
    res.status(501).json({
      error:
        'Live upgrades are disabled because no payment provider (STRIPE_SECRET_KEY) is configured on this server. Paid entitlements are never simulated.',
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
    });
    return;
  }
  res.status(501).json({
    error: 'Connect Stripe webhook handler before activating live checkout sessions.',
  });
});

billingRouter.post('/cancel', (req: AuthenticatedRequest, res) => {
  if (req.authUser!.plan !== 'premium') {
    res.status(400).json({ error: 'No active paid subscription to cancel.' });
    return;
  }
  db.prepare('UPDATE users SET plan = ?, daily_token_limit = ?, monthly_token_limit = ?, updated_at = ? WHERE id = ?').run(
    'free',
    DEFAULT_PLAN_LIMITS.free.daily,
    DEFAULT_PLAN_LIMITS.free.monthly,
    new Date().toISOString(),
    req.authUser!.id
  );
  recordAuditLog({
    actorUserId: req.authUser!.id,
    actorEmail: req.authUser!.email,
    action: 'subscription_cancelled',
    targetType: 'billing',
    targetId: req.authUser!.id,
    outcome: 'success',
    detail: 'Downgraded subscription to Free tier',
  });
  res.json({ ok: true, plan: 'free' });
});
