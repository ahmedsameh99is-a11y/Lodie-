import React, { useState } from 'react';
import { Check, Cpu, Lock, Settings2, Zap, Eye, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { canAccessModel } from '../shared/quotas';
import type { BrandedModel, ProviderId, PublicUser } from '../shared/types';

interface ModelHubProps {
  user: PublicUser | null;
  models: BrandedModel[];
  activeModelId: string;
  onSelectModel: (id: string) => void;
  onModelsUpdated: () => void;
}

export const ModelHub: React.FC<ModelHubProps> = ({
  user,
  models,
  activeModelId,
  onSelectModel,
  onModelsUpdated,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editProvider, setEditProvider] = useState<ProviderId>('gemini');
  const [editUpstream, setEditUpstream] = useState('');
  const [editPlan, setEditPlan] = useState<'free' | 'premium'>('free');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  const isDeveloper = user?.role === 'developer' || user?.role === 'admin';

  const startEdit = (m: BrandedModel) => {
    setEditingId(m.id);
    setEditProvider(m.provider);
    setEditUpstream(m.upstreamModelId);
    setEditPlan(m.requiredPlan);
    setEditBaseUrl('');
    setEditApiKey('');
    setStatusMsg(null);
  };

  const saveEdit = async (id: string) => {
    try {
      await api.updateAdminModel(id, {
        provider: editProvider,
        upstreamModelId: editUpstream,
        requiredPlan: editPlan,
        ...(editBaseUrl ? { customBaseUrl: editBaseUrl } : {}),
        ...(editApiKey ? { customApiKey: editApiKey } : {}),
      });
      setEditingId(null);
      setStatusMsg(`Updated routing for ${id}. Run Test Connection to verify live status.`);
      onModelsUpdated();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Failed to update model.');
    }
  };

  const runTest = async (id: string) => {
    setTestingId(id);
    setStatusMsg(null);
    try {
      const res = await api.testAdminModel(id);
      setStatusMsg(`${id}: ${res.testResult.message} (${res.testResult.latencyMs}ms)`);
      onModelsUpdated();
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Connection test failed.');
    } finally {
      setTestingId(null);
    }
  };

  const tiers: Array<{ key: BrandedModel['tier']; title: string; subtitle: string }> = [
    { key: 'free', title: 'Free Tier Models', subtitle: 'Fast everyday execution included on all accounts' },
    { key: 'premium', title: 'Premium Tier Models', subtitle: 'Deep reasoning and editorial intelligence for Premium & Developer accounts' },
    { key: 'multimodal', title: 'Multimodal Tier', subtitle: 'Visual and document understanding across images and text' },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Model Hub</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Transparent commercial model lineup mapped to real configured backend inference providers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {user && (
            <button
              type="button"
              disabled={checkingAll}
              onClick={async () => {
                setCheckingAll(true);
                setStatusMsg(null);
                try {
                  const res = await api.checkModelsHealth();
                  const okCount = res.results.filter((r) => r.ok).length;
                  setStatusMsg(`Health check finished: ${okCount}/${res.results.length} models operational.`);
                  onModelsUpdated();
                } catch (err) {
                  setStatusMsg(err instanceof Error ? err.message : 'Health check failed.');
                } finally {
                  setCheckingAll(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 min-h-[40px] cursor-pointer"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>{checkingAll ? 'Checking Models...' : 'Run Health Check'}</span>
            </button>
          )}
          {statusMsg && (
            <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-2 text-xs text-emerald-800 dark:text-emerald-200">
              {statusMsg}
            </div>
          )}
        </div>
      </div>

      {tiers.map((tierGroup) => {
        const items = models.filter((m) => m.tier === tierGroup.key);
        if (items.length === 0) return null;
        return (
          <section key={tierGroup.key} className="space-y-4">
            <div>
              <h3 className="font-display text-lg font-semibold text-zinc-900 dark:text-white">{tierGroup.title}</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{tierGroup.subtitle}</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {items.map((m) => {
                const isSelected = activeModelId === m.id;
                const access = canAccessModel(
                  { role: user?.role ?? 'user', plan: user?.plan ?? 'free' },
                  m
                );
                const isOperational =
                  m.availability === 'operational' || m.availability === 'connected' || m.availability === 'slow';
                const statusLabel: Record<string, string> = {
                  operational: 'Operational',
                  connected: 'Connected',
                  slow: 'Slow',
                  temporarily_unavailable: 'Temporarily Unavailable',
                  configuration_error: 'Config Error',
                  authentication_error: 'Auth Error',
                  awaiting_config: 'Awaiting Config',
                  disabled: 'Disabled',
                  error: 'Error',
                };

                return (
                  <div
                    key={m.id}
                    className={`rounded-2xl border p-5 transition-colors bg-white dark:bg-[#0D110F] ${
                      isSelected ? 'border-emerald-500/60' : 'border-zinc-200 dark:border-white/10'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          {m.tier === 'multimodal' ? (
                            <Eye className="w-4 h-4 text-emerald-500" />
                          ) : m.tier === 'premium' ? (
                            <Sparkles className="w-4 h-4 text-emerald-500" />
                          ) : (
                            <Zap className="w-4 h-4 text-emerald-500" />
                          )}
                          <h4 className="font-display text-base font-bold text-zinc-900 dark:text-white">{m.displayName}</h4>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                          <span className="font-mono text-zinc-700 dark:text-zinc-300">{m.id}</span>
                          <span aria-hidden="true">·</span>
                          <span>{m.provider}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{m.upstreamModelId}</span>
                        </div>
                      </div>

                      <div className="text-end">
                        <span
                          className={`text-xs font-medium whitespace-nowrap ${
                            m.availability === 'operational' || m.availability === 'connected'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : m.availability === 'slow' || m.availability === 'awaiting_config'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-500'
                          }`}
                        >
                          {statusLabel[m.availability] ?? m.availability}
                        </span>
                        {typeof m.avgLatencyMs === 'number' && m.avgLatencyMs > 0 && (
                          <div className="text-[10px] font-mono text-zinc-500">{m.avgLatencyMs}ms</div>
                        )}
                        {m.errorClass && (
                          <div className="text-[10px] font-mono text-red-500">{m.errorClass}</div>
                        )}
                      </div>
                    </div>

                    <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">{m.description}</p>

                    <dl className="mt-4 grid grid-cols-2 gap-y-2 gap-x-4 border-t border-zinc-100 dark:border-white/5 pt-3 text-xs">
                      <div>
                        <dt className="text-zinc-500">Speed & Reasoning</dt>
                        <dd className="text-zinc-800 dark:text-zinc-200 font-medium">
                          {m.speedClass} · {m.reasoningLevel}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Context Window</dt>
                        <dd className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
                          {m.contextLimit ? `${m.contextLimit.toLocaleString()} tokens` : 'Provider-defined'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Modalities</dt>
                        <dd className="text-zinc-800 dark:text-zinc-200">
                          In: {m.inputModalities.join(', ')} · Out: {m.outputModalities.join(', ')}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Entitlement</dt>
                        <dd className="text-zinc-800 dark:text-zinc-200">{m.pricingSummary}</dd>
                      </div>
                    </dl>

                    <p className="mt-3 text-[11px] text-zinc-500 dark:text-zinc-400">{m.availabilityReason}</p>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={!isOperational || !access.allowed}
                        onClick={() => onSelectModel(m.id)}
                        className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold min-h-[40px] cursor-pointer ${
                          isSelected
                            ? 'bg-emerald-600 text-white'
                            : !isOperational || !access.allowed
                            ? 'bg-zinc-100 dark:bg-white/5 text-zinc-400 dark:text-zinc-500 cursor-not-allowed'
                            : 'border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10'
                        }`}
                      >
                        {!access.allowed ? (
                          <>
                            <Lock className="w-3.5 h-3.5" />
                            <span>Requires Premium</span>
                          </>
                        ) : isSelected ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>Selected</span>
                          </>
                        ) : (
                          <span>Use {m.displayName}</span>
                        )}
                      </button>

                      {isDeveloper && (
                        <>
                          <button
                            type="button"
                            onClick={() => startEdit(m)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/10 px-3 py-2 text-xs text-zinc-700 dark:text-zinc-300 hover:border-emerald-500/40 min-h-[40px] cursor-pointer"
                          >
                            <Settings2 className="w-3.5 h-3.5" />
                            <span>Configure</span>
                          </button>
                          <button
                            type="button"
                            disabled={testingId === m.id}
                            onClick={() => runTest(m.id)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/10 px-3 py-2 text-xs text-zinc-700 dark:text-zinc-300 hover:border-emerald-500/40 min-h-[40px] cursor-pointer"
                          >
                            <Cpu className="w-3.5 h-3.5" />
                            <span>{testingId === m.id ? 'Testing...' : 'Test Connection'}</span>
                          </button>
                        </>
                      )}
                    </div>

                    {isDeveloper && editingId === m.id && (
                      <div className="mt-4 rounded-xl border border-emerald-500/30 bg-zinc-50 dark:bg-[#050706] p-4 space-y-3 text-xs">
                        <div className="font-semibold text-emerald-600 dark:text-emerald-400">
                          Developer Provider Mapping ({m.displayName})
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <label className="block text-zinc-500 dark:text-zinc-400 mb-1">Provider Adapter</label>
                            <select
                              value={editProvider}
                              onChange={(e) => setEditProvider(e.target.value as ProviderId)}
                              className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2.5 py-2 text-zinc-900 dark:text-white"
                            >
                              <option value="gemini">gemini</option>
                              <option value="openai-compatible">openai-compatible</option>
                              <option value="anthropic-compatible">anthropic-compatible</option>
                              <option value="hosted-oss">hosted-oss</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-zinc-500 dark:text-zinc-400 mb-1">Upstream Model ID</label>
                            <input
                              type="text"
                              value={editUpstream}
                              onChange={(e) => setEditUpstream(e.target.value)}
                              className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2.5 py-2 text-zinc-900 dark:text-white font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-zinc-500 dark:text-zinc-400 mb-1">Required Plan</label>
                            <select
                              value={editPlan}
                              onChange={(e) => setEditPlan(e.target.value as 'free' | 'premium')}
                              className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2.5 py-2 text-zinc-900 dark:text-white"
                            >
                              <option value="free">free</option>
                              <option value="premium">premium</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-zinc-500 dark:text-zinc-400 mb-1">Custom Base URL (Optional)</label>
                            <input
                              type="url"
                              value={editBaseUrl}
                              onChange={(e) => setEditBaseUrl(e.target.value)}
                              placeholder="https://api.example.com/v1"
                              className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2.5 py-2 text-zinc-900 dark:text-white"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-zinc-500 dark:text-zinc-400 mb-1">
                            Provider API Key (Encrypted at rest server-side; optional)
                          </label>
                          <input
                            type="password"
                            value={editApiKey}
                            onChange={(e) => setEditApiKey(e.target.value)}
                            placeholder="Leave blank to keep server env key"
                            className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2.5 py-2 text-zinc-900 dark:text-white"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => saveEdit(m.id)}
                            className="rounded-lg bg-emerald-600 px-3 py-2 font-medium text-white hover:bg-emerald-500 cursor-pointer"
                          >
                            Save Mapping
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded-lg border border-zinc-200 dark:border-white/10 px-3 py-2 text-zinc-600 dark:text-zinc-300 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
};
