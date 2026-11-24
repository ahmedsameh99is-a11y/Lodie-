import React, { useEffect, useState } from 'react';
import { Check, Cpu, Lock, Settings2, Zap, Eye, Sparkles, Activity, RotateCcw, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import { getModelStatusMeta } from '../shared/modelRegistry';
import { canAccessModel } from '../shared/quotas';
import type {
  BrandedModel,
  MatrixRouteDescriptor,
  ProviderId,
  ProviderStatusSummary,
  PublicUser,
} from '../shared/types';

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
  const [providers, setProviders] = useState<ProviderStatusSummary[]>([]);
  const [matrix, setMatrix] = useState<Record<string, MatrixRouteDescriptor[]>>({});
  const [unsupportedNotes, setUnsupportedNotes] = useState<Array<{ provider: string; reason: string }>>([]);
  const [matrixModelTab, setMatrixModelTab] = useState<string>('sonic-3');
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);

  const isDeveloper = user?.role === 'developer' || user?.role === 'admin';

  const loadMatrix = async () => {
    if (!user) return;
    try {
      const data = await api.getModelMatrix();
      setProviders(data.providers);
      setMatrix(data.matrix);
      setUnsupportedNotes(data.unsupportedNotes);
    } catch {
      // Non-fatal if user lacks session or offline
    }
  };

  useEffect(() => {
    void loadMatrix();
  }, [user?.id, models.length]);

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
    { key: 'free', title: 'Fast & Balanced Models', subtitle: 'Everyday speed, coding, and tool execution included on all accounts' },
    { key: 'premium', title: 'Flagship Reasoning & Editorial Models', subtitle: 'Deep reasoning and editorial intelligence included on Free tier (with higher caps on Pro/Max)' },
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
                  setStatusMsg(`Health check finished: ${okCount}/${res.results.length} models verified responding.`);
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
                const statusMeta = getModelStatusMeta(m);
                const isCallable = statusMeta.callable;

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
                            m.availability === 'operational'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : m.availability === 'connected' || m.availability === 'slow' || m.availability === 'awaiting_config'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-500'
                          }`}
                        >
                          {statusMeta.badgeLabel}
                        </span>
                        <div className="text-[10px] font-mono text-zinc-500">
                          {statusMeta.connectivityTested
                            ? typeof m.avgLatencyMs === 'number' && m.avgLatencyMs > 0
                              ? `Tested · ${m.avgLatencyMs}ms`
                              : 'Tested'
                            : statusMeta.configured
                            ? 'Not tested'
                            : 'No credentials'}
                        </div>
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
                        disabled={!isCallable || !access.allowed}
                        onClick={() => onSelectModel(m.id)}
                        className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold min-h-[40px] cursor-pointer ${
                          isSelected
                            ? 'bg-emerald-600 text-white'
                            : !isCallable || !access.allowed
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
                        ) : !isCallable ? (
                          <span>{statusMeta.badgeLabel}</span>
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
                              <option value="mistral">mistral</option>
                              <option value="cohere">cohere</option>
                              <option value="xai">xai</option>
                              <option value="ai21">ai21</option>
                              <option value="groq">groq</option>
                              <option value="cerebras">cerebras</option>
                              <option value="sambanova">sambanova</option>
                              <option value="together">together</option>
                              <option value="fireworks">fireworks</option>
                              <option value="huggingface">huggingface</option>
                              <option value="cloudflare">cloudflare</option>
                              <option value="nvidia">nvidia</option>
                              <option value="deepinfra">deepinfra</option>
                              <option value="openrouter">openrouter</option>
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

      {user && providers.length > 0 && (
        <section className="space-y-5 border-t border-zinc-200 dark:border-white/10 pt-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display text-lg font-semibold text-zinc-900 dark:text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-500" />
                <span>Multi-Provider Infrastructure & Compatibility Matrix</span>
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {providers.filter((p) => p.configured).length}/{providers.length} providers credentialed · Circuit-breaker protected intra-model failover preserves your selected LOODY model.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMatrixModelTab(m.id)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium cursor-pointer transition-colors ${
                    matrixModelTab === m.id
                      ? 'bg-emerald-600 text-white'
                      : 'border border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-300 hover:border-emerald-500/40'
                  }`}
                >
                  {m.displayName}
                </button>
              ))}
            </div>
          </div>

          {/* Selected Branded Model Compatibility Routes */}
          <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-200 dark:border-white/10 flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-900 dark:text-white">
                Compatible Routes for {models.find((m) => m.id === matrixModelTab)?.displayName ?? matrixModelTab}
              </span>
              <span className="font-mono text-zinc-500">
                {(matrix[matrixModelTab] ?? []).length} verified routes
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-100 dark:border-white/5 text-zinc-500">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">#</th>
                    <th className="py-2.5 px-3 font-medium">Provider</th>
                    <th className="py-2.5 px-3 font-medium">Upstream Model</th>
                    <th className="py-2.5 px-3 font-medium">Context</th>
                    <th className="py-2.5 px-3 font-medium">Capabilities</th>
                    <th className="py-2.5 px-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-white/5">
                  {(matrix[matrixModelTab] ?? []).map((route) => {
                    const prov = providers.find((p) => p.id === route.provider);
                    return (
                      <tr key={route.id} className="text-zinc-700 dark:text-zinc-300">
                        <td className="py-2.5 px-4 font-mono text-zinc-500">{route.priority}</td>
                        <td className="py-2.5 px-3 font-medium">{prov?.displayName ?? route.provider}</td>
                        <td className="py-2.5 px-3 font-mono text-[11px]">{route.upstreamModelId}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums">{route.contextLimit.toLocaleString()}</td>
                        <td className="py-2.5 px-3 text-[11px] text-zinc-500">
                          {route.supportsVision ? 'Vision · ' : ''}
                          {route.supportsTools ? 'Tools · ' : ''}
                          {route.supportsPromptCaching ? 'Cache · ' : ''}
                          {route.speedTier}
                        </td>
                        <td className="py-2.5 px-3">
                          {prov?.retired ? (
                            <span className="text-red-500 font-medium">Unsupported</span>
                          ) : prov?.configured ? (
                            <span
                              className={`font-medium ${
                                prov.circuitState === 'open'
                                  ? 'text-red-500'
                                  : prov.circuitState === 'half_open'
                                  ? 'text-amber-500'
                                  : 'text-emerald-600 dark:text-emerald-400'
                              }`}
                            >
                              Configured ({prov.circuitState})
                            </span>
                          ) : (
                            <span className="text-amber-600 dark:text-amber-400">Awaiting credentials</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* All 19 Provider Adapters Readiness & Circuit Status */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {providers.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-3.5 text-xs space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-zinc-900 dark:text-white">{p.displayName}</div>
                    <div className="font-mono text-[11px] text-zinc-500">
                      {p.id} · {p.protocol}
                    </div>
                  </div>
                  <span
                    className={`font-medium whitespace-nowrap ${
                      p.retired
                        ? 'text-red-500'
                        : p.configured && p.circuitState === 'closed'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : p.circuitState === 'open'
                        ? 'text-red-500'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {p.retired
                      ? 'Retired'
                      : p.configured
                      ? `Configured (${p.circuitState})`
                      : 'Awaiting keys'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500 font-mono">
                  <span>Env: {p.envVars.join(', ')}</span>
                  {p.avgLatencyMs !== null && <span>{p.avgLatencyMs}ms</span>}
                  <span>Reqs today: {p.todayRequests}/{p.dailyRequestCap}</span>
                </div>
                {p.retiredNotice && (
                  <p className="text-[11px] text-red-500 flex items-start gap-1">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{p.retiredNotice}</span>
                  </p>
                )}
                {p.lastError && !p.retired && (
                  <p className="text-[11px] text-red-500 truncate" title={p.lastError}>
                    Last error: {p.lastError}
                  </p>
                )}
                {isDeveloper && !p.retired && (
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={testingProviderId === p.id}
                      onClick={async () => {
                        setTestingProviderId(p.id);
                        try {
                          const res = await api.testProviderEndpoint(p.id);
                          setStatusMsg(`${p.displayName}: ${res.testResult.message}`);
                          await loadMatrix();
                        } catch (err) {
                          setStatusMsg(err instanceof Error ? err.message : 'Provider test failed.');
                        } finally {
                          setTestingProviderId(null);
                        }
                      }}
                      className="rounded-lg border border-zinc-200 dark:border-white/10 px-2.5 py-1 text-[11px] text-zinc-700 dark:text-zinc-300 hover:border-emerald-500/40 cursor-pointer"
                    >
                      {testingProviderId === p.id ? 'Probing...' : 'Probe'}
                    </button>
                    {p.circuitState !== 'closed' && (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.resetProviderCircuitBreaker(p.id);
                          setStatusMsg(`Circuit breaker reset for ${p.displayName}.`);
                          await loadMatrix();
                        }}
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 px-2.5 py-1 text-[11px] text-amber-600 dark:text-amber-400 cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Reset Circuit</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {unsupportedNotes.length > 0 && (
            <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#080B0A] p-4 text-xs space-y-1.5">
              <div className="font-semibold text-zinc-800 dark:text-zinc-200">
                Explicitly Excluded / Unsupported Matrix Slots
              </div>
              {unsupportedNotes.map((n) => (
                <div key={n.provider} className="text-zinc-500 dark:text-zinc-400">
                  <span className="font-mono text-zinc-700 dark:text-zinc-300">{n.provider}:</span> {n.reason}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
