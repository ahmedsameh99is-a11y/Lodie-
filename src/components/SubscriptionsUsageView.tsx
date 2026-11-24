import React, { useEffect, useState } from 'react';
import { CreditCard, Activity, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import type { PublicUser, TokenUsageSummary } from '../shared/types';

interface SubscriptionsUsageViewProps {
  user: PublicUser | null;
  onOpenAuth: () => void;
  onPlanChanged: () => void;
}

export const SubscriptionsUsageView: React.FC<SubscriptionsUsageViewProps> = ({
  user,
  onOpenAuth,
  onPlanChanged,
}) => {
  const [summary, setSummary] = useState<{
    plan: string;
    role: string;
    subscriptionStatus: string;
    renewalStatus: string;
    paymentProviderConfigured: boolean;
    paymentProviderLabel: string;
    commercialCatalog?: Array<{
      id: string;
      name: string;
      priceUsdMonthly?: number;
      priceDisplay?: string;
      audience?: string;
      dailyTokens: number;
      monthlyTokens: number;
      highlights?: string[];
      checkoutEnabled?: boolean;
    }>;
    plans: Array<{
      id: string;
      name: string;
      audience: string;
      priceDisplay: string;
      dailyLimit: number;
      monthlyLimit: number;
      models: string[];
    }>;
    usage: TokenUsageSummary;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSummary = () => {
    if (!user) return;
    api.getBillingSummary().then(setSummary).catch(() => null);
  };

  useEffect(() => {
    loadSummary();
  }, [user?.id]);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <CreditCard className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">
          Subscriptions & Token Usage
        </h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to inspect your daily/monthly token accounting, plan entitlements, and quota thresholds.
        </p>
        <button
          type="button"
          onClick={onOpenAuth}
          className="mt-6 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
        >
          Sign In
        </button>
      </div>
    );
  }

  const dailyPct = summary
    ? Math.min(100, Math.round((summary.usage.dailyUsed / Math.max(1, summary.usage.dailyLimit)) * 100))
    : 0;
  const monthlyPct = summary
    ? Math.min(100, Math.round((summary.usage.monthlyUsed / Math.max(1, summary.usage.monthlyLimit)) * 100))
    : 0;
  const dailyRemaining = summary
    ? summary.usage.dailyRemaining ?? Math.max(0, summary.usage.dailyLimit - summary.usage.dailyUsed)
    : 0;
  const monthlyRemaining = summary
    ? summary.usage.monthlyRemaining ?? Math.max(0, summary.usage.monthlyLimit - summary.usage.monthlyUsed)
    : 0;
  const MODEL_LABELS: Record<string, string> = {
    'sonic-3': 'Sonic 3',
    'sonic-3.5': 'Sonic 3.5',
    'lodie-5.5': 'LOODY 5.5',
    'fables-5.3': 'Fables 5.3',
    'loody-vision-1': 'LOODY Vision 1',
  };

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-8">
      <div className="border-b border-zinc-200 dark:border-white/10 pb-5">
        <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">
          Plans, Quotas & Token Ledger
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Provider-reported token usage is recorded separately from heuristic estimates. Quotas and per-model budgets reset automatically at 00:00 UTC.
        </p>
      </div>

      {notice && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-50 dark:bg-amber-950/30 p-4 text-xs text-amber-800 dark:text-amber-200">
          <AlertCircle className="w-4 h-4 shrink-0 text-amber-500 dark:text-amber-400 mt-0.5" />
          <span>{notice}</span>
        </div>
      )}

      {summary && (
        <>
          <section className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">Daily Token Allowance</div>
              <div dir="ltr" className="mt-2 font-mono tabular-nums text-2xl font-bold text-zinc-900 dark:text-white inline-block">
                {summary.usage.dailyUsed.toLocaleString()}{' '}
                <span className="text-sm font-normal text-zinc-400">/ {summary.usage.dailyLimit.toLocaleString()}</span>
              </div>
              <div className="mt-3 h-2 w-full rounded-full bg-zinc-100 dark:bg-[#050706] overflow-hidden">
                <div
                  className={`h-full transition-all ${dailyPct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  style={{ width: `${dailyPct}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                <span>{dailyPct}% used · {dailyRemaining.toLocaleString()} left</span>
                {summary.usage.dailyResetAtUtc && (
                  <span className="font-mono">Resets {summary.usage.dailyResetAtUtc.slice(11, 16)} UTC</span>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">Monthly Token Allowance</div>
              <div dir="ltr" className="mt-2 font-mono tabular-nums text-2xl font-bold text-zinc-900 dark:text-white inline-block">
                {summary.usage.monthlyUsed.toLocaleString()}{' '}
                <span className="text-sm font-normal text-zinc-400">/ {summary.usage.monthlyLimit.toLocaleString()}</span>
              </div>
              <div className="mt-3 h-2 w-full rounded-full bg-zinc-100 dark:bg-[#050706] overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${monthlyPct}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                <span>{monthlyPct}% used · {monthlyRemaining.toLocaleString()} left</span>
                {summary.usage.monthlyResetAtUtc && (
                  <span className="font-mono">Resets {summary.usage.monthlyResetAtUtc.slice(0, 10)}</span>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">Accounting Integrity & Cost</div>
              <div dir="ltr" className="mt-2 font-mono tabular-nums text-2xl font-bold text-emerald-600 dark:text-emerald-400 inline-block">
                ${summary.usage.estimatedCostUsd.toFixed(4)}
              </div>
              <div className="mt-2 text-xs text-zinc-700 dark:text-zinc-300 font-mono tabular-nums">
                Provider-reported: {summary.usage.providerReportedTotal.toLocaleString()}
              </div>
              <div className="text-xs text-zinc-500 font-mono tabular-nums">
                Estimated fallback: {summary.usage.estimatedTotal.toLocaleString()}
              </div>
            </div>
          </section>

          {summary.usage.perModelDaily && summary.usage.perModelDaily.length > 0 && (
            <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  Per-Model Daily Budgets
                </div>
                {summary.usage.dailyResetAtUtc && (
                  <div className="text-[11px] font-mono text-zinc-500">
                    Daily Reset: {summary.usage.dailyResetAtUtc.slice(0, 16).replace('T', ' ')} UTC
                  </div>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {summary.usage.perModelDaily.map((entry) => {
                  const pct = Math.min(100, Math.round((entry.used / Math.max(1, entry.limit)) * 100));
                  return (
                    <div
                      key={entry.modelId}
                      className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3.5 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-semibold text-zinc-900 dark:text-white truncate">
                          {MODEL_LABELS[entry.modelId] ?? entry.modelId}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-500 tabular-nums">{pct}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-zinc-200 dark:bg-white/10 overflow-hidden">
                        <div
                          className={`h-full transition-all ${pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div dir="ltr" className="text-[11px] font-mono tabular-nums text-zinc-600 dark:text-zinc-300">
                        {entry.used.toLocaleString()} / {entry.limit.toLocaleString()}
                      </div>
                      <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono tabular-nums">
                        {entry.remaining.toLocaleString()} remaining
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {summary.usage.byTaskType && Object.keys(summary.usage.byTaskType).length > 0 && (
            <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Usage by Task Type
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {Object.entries(summary.usage.byTaskType).map(([taskType, stats]) => (
                  <div
                    key={taskType}
                    className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3.5 flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase">
                        {taskType.replace(/_/g, ' ')}
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">
                        {stats.count} request{stats.count === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="text-end font-mono tabular-nums">
                      <div className="text-xs font-bold text-zinc-900 dark:text-white">
                        {stats.tokens.toLocaleString()} tok
                      </div>
                      <div className="text-[11px] text-zinc-500">${stats.costUsd.toFixed(5)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-lg font-semibold text-zinc-900 dark:text-white">Subscription Architecture</h3>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Payment Gateway: {summary.paymentProviderLabel} · Current Plan:{' '}
                <strong className="text-emerald-600 dark:text-emerald-400 uppercase">{summary.plan}</strong> ({summary.role})
              </span>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {summary.plans.map((p) => {
                const isCurrent = summary.plan === p.id;
                return (
                  <div
                    key={p.id}
                    className={`rounded-2xl border p-5 flex flex-col justify-between gap-4 bg-white dark:bg-[#0D110F] ${
                      isCurrent ? 'border-emerald-500/60' : 'border-zinc-200 dark:border-white/10'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <h4 className="font-display text-lg font-bold text-zinc-900 dark:text-white">{p.name}</h4>
                        {isCurrent && <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Current</span>}
                      </div>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{p.audience}</p>
                      <div dir="ltr" className="mt-4 font-display text-xl font-bold text-zinc-900 dark:text-white inline-block">
                        {p.priceDisplay}
                      </div>
                      <dl className="mt-4 space-y-2 border-t border-zinc-100 dark:border-white/5 pt-3 text-xs">
                        <div className="flex justify-between">
                          <dt className="text-zinc-500">Daily Limit</dt>
                          <dd className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">{p.dailyLimit.toLocaleString()} tokens</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-zinc-500">Monthly Limit</dt>
                          <dd className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">{p.monthlyLimit.toLocaleString()} tokens</dd>
                        </div>
                        <div>
                          <dt className="text-zinc-500 mb-1">Entitled Models</dt>
                          <dd className="text-zinc-800 dark:text-zinc-200">{p.models.join(' · ')}</dd>
                        </div>
                      </dl>
                    </div>

                    {p.id === 'premium' && !isCurrent && summary.role !== 'developer' && (
                      <button
                        type="button"
                        onClick={async () => {
                          setNotice(null);
                          try {
                            await api.attemptUpgrade();
                          } catch (err) {
                            setNotice(err instanceof Error ? err.message : 'Payment provider not configured.');
                          }
                        }}
                        className="w-full rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
                      >
                        Upgrade to Premium
                      </button>
                    )}

                    {p.id === 'premium' && isCurrent && (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.cancelSubscription();
                          loadSummary();
                          onPlanChanged();
                        }}
                        className="w-full rounded-xl border border-red-500/30 py-2.5 text-xs font-medium text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 min-h-[44px] cursor-pointer"
                      >
                        Cancel Subscription
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {summary.commercialCatalog && summary.commercialCatalog.length > 0 && (
              <div className="pt-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-display text-sm font-bold text-zinc-900 dark:text-white">
                    Commercial Packaging Catalog (Architecture Ready · Checkout Disabled)
                  </h4>
                  <span className="text-[11px] font-mono text-amber-600 dark:text-amber-400">
                    {summary.paymentProviderConfigured ? 'Live Gateway Configured' : 'Zero-Budget Rule: No Active Payments'}
                  </span>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  {summary.commercialCatalog.map((tier) => (
                    <div
                      key={tier.id}
                      className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4 space-y-2.5 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-display text-base font-bold text-zinc-900 dark:text-white">{tier.name}</span>
                        <span dir="ltr" className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                          {tier.priceDisplay ?? `$${tier.priceUsdMonthly ?? 0} / mo`}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-zinc-500">
                        {tier.dailyTokens.toLocaleString()} / day · {tier.monthlyTokens.toLocaleString()} / mo
                      </div>
                      {tier.audience && (
                        <p className="text-zinc-600 dark:text-zinc-300 leading-relaxed">{tier.audience}</p>
                      )}
                      {Array.isArray(tier.highlights) && tier.highlights.length > 0 && (
                        <ul className="space-y-1 text-zinc-600 dark:text-zinc-300">
                          {tier.highlights.map((h, i) => (
                            <li key={i}>• {h}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-500" />
              <h3 className="font-display text-lg font-semibold text-zinc-900 dark:text-white">Recent Usage Ledger</h3>
            </div>
            <div className="overflow-x-auto rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F]">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Timestamp</th>
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Task</th>
                    <th className="px-4 py-3 font-medium">Provider</th>
                    <th className="px-4 py-3 font-medium text-right">Input</th>
                    <th className="px-4 py-3 font-medium text-right">Output</th>
                    <th className="px-4 py-3 font-medium">Accounting</th>
                    <th className="px-4 py-3 font-medium text-right">Est. Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-white/5 text-zinc-800 dark:text-zinc-200">
                  {summary.usage.recentEntries.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-6 text-center text-zinc-500">
                        No model requests recorded yet.
                      </td>
                    </tr>
                  ) : (
                    summary.usage.recentEntries.map((entry) => (
                      <tr key={entry.id} className="hover:bg-zinc-50 dark:hover:bg-white/[0.02]">
                        <td className="px-4 py-2.5 font-mono tabular-nums text-zinc-500 whitespace-nowrap">
                          {entry.createdAt.slice(0, 19).replace('T', ' ')}
                        </td>
                        <td className="px-4 py-2.5 font-medium">{entry.modelId}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                          {entry.taskType ?? 'chat'}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-500">{entry.provider}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">{entry.inputTokens.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">{entry.outputTokens.toLocaleString()}</td>
                        <td className="px-4 py-2.5">
                          <span className={entry.accountingType === 'provider_reported' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                            {entry.accountingType === 'provider_reported' ? 'Provider-Reported' : 'Estimated'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                          ${entry.estimatedCostUsd.toFixed(5)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
