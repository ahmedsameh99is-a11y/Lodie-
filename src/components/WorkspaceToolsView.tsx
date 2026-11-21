import React, { useEffect, useState } from 'react';
import {
  Server,
  Wrench,
  Plug,
  Layers,
  ShieldAlert,
  Play,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Key,
  Copy,
} from 'lucide-react';
import { api } from '../lib/api';
import type {
  BuiltinTool,
  FeatureFlag,
  IntegrationConnector,
  McpApprovalRequest,
  McpServerRecord,
  McpServerTokenRecord,
  PublicUser,
  ToolExecutionLogEntry,
} from '../shared/types';

interface WorkspaceToolsViewProps {
  user: PublicUser | null;
  initialTab?: 'mcp' | 'tools' | 'integrations' | 'stage2';
  onOpenAuth: () => void;
}

export const WorkspaceToolsView: React.FC<WorkspaceToolsViewProps> = ({
  user,
  initialTab = 'tools',
  onOpenAuth,
}) => {
  const [tab, setTab] = useState<'mcp' | 'tools' | 'integrations' | 'stage2'>(initialTab);
  const [toolCategoryFilter, setToolCategoryFilter] = useState<string>('All');

  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [approvals, setApprovals] = useState<McpApprovalRequest[]>([]);
  const [builtinTools, setBuiltinTools] = useState<BuiltinTool[]>([]);
  const [toolLogs, setToolLogs] = useState<ToolExecutionLogEntry[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConnector[]>([]);
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [pendingBuiltinTool, setPendingBuiltinTool] = useState<{ tool: BuiltinTool; reason: string } | null>(null);

  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpAuthType, setMcpAuthType] = useState<'none' | 'bearer' | 'header'>('none');
  const [mcpToken, setMcpToken] = useState('');
  const [confirmDeleteServerId, setConfirmDeleteServerId] = useState<string | null>(null);
  const [serverTokens, setServerTokens] = useState<McpServerTokenRecord[]>([]);
  const [newTokenLabel, setNewTokenLabel] = useState('');
  const [newTokenTools, setNewTokenTools] = useState<string[]>(['utc_clock', 'json_schema_validator']);
  const [createdPlainToken, setCreatedPlainToken] = useState<string | null>(null);
  const [mcpTestOutput, setMcpTestOutput] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [toolOutput, setToolOutput] = useState<string | null>(null);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const loadAll = async () => {
    const flagRes = await api.getFeatureFlags().catch(() => ({ flags: [] }));
    setFlags(flagRes.flags);
    if (!user) return;
    const [s, a, bt, tl, integ, st] = await Promise.all([
      api.getMcpServers().catch(() => ({ servers: [] })),
      api.getMcpApprovals().catch(() => ({ approvals: [] })),
      api.getBuiltinTools().catch(() => ({ tools: [] })),
      api.getToolLogs().catch(() => ({ logs: [] })),
      api.getIntegrations().catch(() => ({ connectors: [] })),
      api.getMcpServerTokens().catch(() => ({ tokens: [] })),
    ]);
    setServers(s.servers);
    setApprovals(a.approvals);
    setBuiltinTools(bt.tools);
    setToolLogs(tl.logs);
    setIntegrations(integ.connectors);
    setServerTokens(st.tokens);
  };

  useEffect(() => {
    loadAll();
  }, [user?.id]);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Server className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">
          Tools, Integrations & MCP Hub
        </h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to configure built-in workspace tools, register MCP JSON-RPC servers, and inspect OAuth connectors.
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

  const handleRegisterMcp = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      await api.createMcpServer({
        name: mcpName,
        endpointUrl: mcpUrl,
        authType: mcpAuthType,
        authToken: mcpToken || undefined,
      });
      setMcpName('');
      setMcpUrl('');
      setMcpToken('');
      setFeedback('MCP server registered. Run Discover Tools to verify connectivity and inspect schemas.');
      loadAll();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to register MCP server.');
    }
  };

  const handleDiscover = async (id: string) => {
    setFeedback(null);
    try {
      const res = await api.discoverMcpTools(id);
      setFeedback(`Discovered ${res.tools.length} tool(s) via JSON-RPC tools/list.`);
      loadAll();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Discovery failed.');
      loadAll();
    }
  };

  const handleRunMcpTool = async (serverId: string, toolName: string, approvalId?: string) => {
    setFeedback(null);
    setToolOutput(null);
    try {
      const res = await api.executeMcpTool({ serverId, toolName, arguments: {}, approvalId });
      if (res.requiresApproval) {
        setFeedback(`Approval required for "${toolName}": ${res.reason}`);
        loadAll();
      } else {
        setToolOutput(JSON.stringify(res, null, 2));
        loadAll();
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Execution error.');
    }
  };

  const handleRunBuiltin = async (tool: BuiltinTool, approvedByUser = false) => {
    setFeedback(null);
    setToolOutput(null);
    setPendingBuiltinTool(null);
    try {
      const res = await api.executeBuiltinTool(tool.id, tool.inputExample, approvedByUser);
      if (res.requiresApproval) {
        setPendingBuiltinTool({
          tool,
          reason: res.reason ?? 'Restricted tool requires explicit user approval.',
        });
        return;
      }
      setToolOutput(JSON.stringify(res.output, null, 2));
      loadAll();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Tool error.');
    }
  };

  const categories = ['All', ...Array.from(new Set(builtinTools.map((t) => t.category ?? 'Data & Parsing')))];
  const visibleTools =
    toolCategoryFilter === 'All'
      ? builtinTools
      : builtinTools.filter((t) => (t.category ?? 'Data & Parsing') === toolCategoryFilter);
  const stage2Flags = flags.filter((f) => f.stage === 'stage_2');

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">
            Tools, Integrations & MCP Hub
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Permission-checked execution boundary treating all external tool outputs as untrusted data.
          </p>
        </div>
      </div>

      {/* Segmented Navigation */}
      <div className="flex flex-wrap gap-1 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-100 dark:bg-[#0A0E0C] p-1 w-fit">
        {[
          { id: 'tools', label: 'Tools Center', icon: Wrench },
          { id: 'integrations', label: 'Integrations', icon: Plug },
          { id: 'mcp', label: 'MCP Hub', icon: Server },
          { id: 'stage2', label: 'Stage Two Roadmap', icon: Layers },
        ].map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id as typeof tab)}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-medium transition-colors min-h-[40px] whitespace-nowrap cursor-pointer ${
                active
                  ? 'bg-emerald-600 text-white'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {feedback && (
        <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs text-emerald-800 dark:text-emerald-200">
          {feedback}
        </div>
      )}

      {toolOutput && (
        <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#050706] p-4">
          <div className="mb-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            Execution Result (Isolated Output)
          </div>
          <pre className="overflow-x-auto text-xs font-mono text-zinc-800 dark:text-zinc-200">{toolOutput}</pre>
        </div>
      )}

      {tab === 'tools' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setToolCategoryFilter(cat)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium cursor-pointer ${
                  toolCategoryFilter === cat
                    ? 'border-emerald-500 bg-emerald-600 text-white'
                    : 'border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] text-zinc-600 dark:text-zinc-300'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {pendingBuiltinTool && (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-50 dark:bg-[#141006] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div>
                <div className="font-semibold text-amber-800 dark:text-amber-200">
                  Approval Required: {pendingBuiltinTool.tool.name}
                </div>
                <div className="text-amber-700 dark:text-amber-300 mt-0.5">{pendingBuiltinTool.reason}</div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleRunBuiltin(pendingBuiltinTool.tool, true)}
                  className="rounded-lg bg-emerald-600 px-3.5 py-2 font-semibold text-white cursor-pointer"
                >
                  Approve & Execute
                </button>
                <button
                  type="button"
                  onClick={() => setPendingBuiltinTool(null)}
                  className="rounded-lg border border-zinc-300 dark:border-white/15 px-3 py-2 text-zinc-600 dark:text-zinc-300 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {visibleTools.map((tool) => (
              <div key={tool.id} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">{tool.name}</h3>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                      {tool.category ?? 'Data & Parsing'} · Permission: {tool.permissionLevel}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await api.toggleBuiltinTool(tool.id, !tool.enabled);
                      setBuiltinTools(res.tools);
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium cursor-pointer ${
                      tool.enabled
                        ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                        : 'bg-zinc-100 dark:bg-white/5 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-white/10'
                    }`}
                  >
                    {tool.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">{tool.description}</p>
                {tool.availabilityDetail && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">{tool.availabilityDetail}</p>
                )}
                <button
                  type="button"
                  disabled={!tool.enabled}
                  onClick={() => handleRunBuiltin(tool)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 min-h-[40px] cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Run Sample Test</span>
                </button>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-bold text-zinc-900 dark:text-white">Tool Execution Audit Logs</h3>
              <span className="font-mono text-[11px] text-zinc-500">
                {toolLogs.length > 0 ? `Latest ${toolLogs.length} runs` : '0 runs recorded'}
              </span>
            </div>
            {toolLogs.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                No tool runs recorded yet. Click &ldquo;Run Sample Test&rdquo; on any built-in tool above to record an audited trace.
              </p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto text-xs">
                {toolLogs.map((log) => (
                  <div key={log.id} className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono font-semibold text-zinc-900 dark:text-white">{log.toolId}</span>
                      <span className="ms-2 text-[11px] text-zinc-500">({log.category})</span>
                    </div>
                    <div className="font-mono text-[11px] flex items-center gap-3">
                      <span className={log.status === 'success' ? 'text-emerald-500' : 'text-red-500'}>{log.status}</span>
                      <span className="text-zinc-500">{log.durationMs}ms</span>
                      <span className="text-zinc-400">{log.createdAt.slice(11, 19)} UTC</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'integrations' && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {integrations.map((conn) => (
            <div key={conn.id} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 flex flex-col justify-between gap-3">
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">{conn.name}</h3>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{conn.category}</div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap ${
                      conn.status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {conn.status === 'connected' ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5" />
                    )}
                    <span>{conn.status === 'connected' ? 'Connected' : 'Awaiting Config'}</span>
                  </span>
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">{conn.description}</p>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400 break-words">
                  Scopes: {conn.permissions.join(' · ')}
                </div>
                <p className="text-[11px] text-zinc-500">{conn.statusDetail}</p>
              </div>

              {conn.status === 'connected' ? (
                <button
                  type="button"
                  onClick={async () => {
                    await api.disconnectIntegration(conn.id);
                    loadAll();
                  }}
                  className="rounded-xl border border-red-500/30 px-4 py-2 text-xs text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 min-h-[40px] cursor-pointer"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await api.connectIntegration(conn.id);
                      if (res.redirectUrl) window.location.href = res.redirectUrl;
                    } catch (err) {
                      setFeedback(err instanceof Error ? err.message : 'OAuth awaiting configuration.');
                    }
                  }}
                  className="rounded-xl border border-emerald-500/35 px-4 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 min-h-[40px] cursor-pointer"
                >
                  Check Connection
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'mcp' && (
        <div className="space-y-6">
          <form onSubmit={handleRegisterMcp} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
            <h3 className="font-display text-base font-semibold text-zinc-900 dark:text-white">Register MCP Server</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="mcp-name" className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">Server Name</label>
                <input
                  id="mcp-name"
                  type="text"
                  required
                  value={mcpName}
                  onChange={(e) => setMcpName(e.target.value)}
                  placeholder="Internal Docs MCP"
                  className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-sm text-zinc-900 dark:text-white min-h-[44px]"
                />
              </div>
              <div>
                <label htmlFor="mcp-url" className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">JSON-RPC Endpoint URL</label>
                <input
                  id="mcp-url"
                  type="url"
                  required
                  value={mcpUrl}
                  onChange={(e) => setMcpUrl(e.target.value)}
                  placeholder="https://mcp.example.com/rpc"
                  className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-sm text-zinc-900 dark:text-white min-h-[44px]"
                />
              </div>
              <div>
                <label htmlFor="mcp-auth" className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">Authentication</label>
                <select
                  id="mcp-auth"
                  value={mcpAuthType}
                  onChange={(e) => setMcpAuthType(e.target.value as 'none' | 'bearer' | 'header')}
                  className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-sm text-zinc-900 dark:text-white min-h-[44px]"
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer Token (Encrypted)</option>
                  <option value="header">X-MCP-Token Header (Encrypted)</option>
                </select>
              </div>
            </div>
            {mcpAuthType !== 'none' && (
              <div>
                <label htmlFor="mcp-token" className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">Auth Token</label>
                <input
                  id="mcp-token"
                  type="password"
                  value={mcpToken}
                  onChange={(e) => setMcpToken(e.target.value)}
                  placeholder="Encrypted via AES-256-GCM at rest"
                  className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-sm text-zinc-900 dark:text-white min-h-[44px]"
                />
              </div>
            )}
            <button
              type="submit"
              className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
            >
              Register Server
            </button>
          </form>

          {approvals.filter((a) => a.status === 'pending').length > 0 && (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-50 dark:bg-[#141006] p-5 space-y-3">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-semibold text-sm">
                <ShieldAlert className="w-4 h-4" />
                <span>Sensitive Tool Approvals Required</span>
              </div>
              {approvals
                .filter((a) => a.status === 'pending')
                .map((a) => (
                  <div key={a.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#050706] p-3 text-xs">
                    <div>
                      <div className="font-mono text-zinc-900 dark:text-white">{a.toolName}</div>
                      <div className="text-zinc-500 dark:text-zinc-400 mt-0.5">{a.reason}</div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          await api.decideMcpApproval(a.id, 'approved');
                          await handleRunMcpTool(a.serverId, a.toolName, a.id);
                        }}
                        className="rounded-lg bg-emerald-600 px-3 py-2 font-medium text-white cursor-pointer"
                      >
                        Approve & Run
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.decideMcpApproval(a.id, 'rejected');
                          loadAll();
                        }}
                        className="rounded-lg border border-zinc-200 dark:border-white/10 px-3 py-2 text-zinc-600 dark:text-zinc-300 cursor-pointer"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )}

          <div className="space-y-4">
            {servers.length === 0 ? (
              <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0A0E0C] p-6 text-sm text-zinc-500 dark:text-zinc-400">
                No MCP servers registered yet. Add an HTTPS JSON-RPC MCP endpoint above to discover schemas.
              </div>
            ) : (
              servers.map((srv) => (
                <div key={srv.id} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="font-display text-base font-bold text-zinc-900 dark:text-white">{srv.name}</h4>
                      <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                        {srv.endpointUrl} · Status: {srv.status}
                      </div>
                      {srv.lastError && <p className="mt-1 text-xs text-red-500">{srv.lastError}</p>}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleDiscover(srv.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Discover Tools</span>
                      </button>
                      {srv.status === 'connected' && (
                        <button
                          type="button"
                          onClick={async () => {
                            await api.disconnectMcpServer(srv.id);
                            setFeedback(`Disconnected "${srv.name}" and cleared session tool permissions.`);
                            loadAll();
                          }}
                          className="rounded-lg border border-amber-500/30 px-3 py-2 text-xs text-amber-600 dark:text-amber-300 hover:bg-amber-500/10 cursor-pointer"
                        >
                          Disconnect
                        </button>
                      )}
                      {confirmDeleteServerId === srv.id ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={async () => {
                              await api.deleteMcpServer(srv.id);
                              setConfirmDeleteServerId(null);
                              loadAll();
                            }}
                            className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-500 cursor-pointer"
                          >
                            Confirm Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteServerId(null)}
                            className="rounded-lg border border-zinc-200 dark:border-white/10 px-2.5 py-2 text-xs text-zinc-500 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteServerId(srv.id)}
                          aria-label={`Remove ${srv.name}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-white/10 px-3 py-2 text-xs text-zinc-500 hover:text-red-500 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Inbound LOODY MCP Server Endpoint & Scoped Access Tokens */}
          <div className="rounded-2xl border border-emerald-500/25 bg-white dark:bg-[#0D110F] p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                  <Key className="w-4 h-4 text-emerald-500" />
                  <span>LOODY Inbound MCP Server (Expose Permitted Tools)</span>
                </h3>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Allow trusted external MCP clients to connect via JSON-RPC 2.0 at{' '}
                  <code className="font-mono text-emerald-600 dark:text-emerald-400">/api/v1/mcp/server</code> using scoped bearer tokens. State-mutating restricted tools are excluded by policy.
                </p>
              </div>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setFeedback(null);
                setCreatedPlainToken(null);
                try {
                  const res = await api.createMcpServerToken({
                    label: newTokenLabel,
                    allowedTools: newTokenTools,
                  });
                  setCreatedPlainToken(res.plainToken);
                  setNewTokenLabel('');
                  setFeedback('Scoped LOODY MCP Server token created. Copy it now — it will not be shown in full again.');
                  loadAll();
                } catch (err) {
                  setFeedback(err instanceof Error ? err.message : 'Unable to create MCP token.');
                }
              }}
              className="space-y-3 border-t border-zinc-200 dark:border-white/10 pt-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="inbound-token-label" className="block text-xs text-zinc-600 dark:text-zinc-400 mb-1">
                    Client Label
                  </label>
                  <input
                    id="inbound-token-label"
                    type="text"
                    required
                    value={newTokenLabel}
                    onChange={(e) => setNewTokenLabel(e.target.value)}
                    placeholder="External IDE Client"
                    className="w-full rounded-xl border border-zinc-300 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-sm text-zinc-900 dark:text-white min-h-[44px]"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="submit"
                    className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
                  >
                    Issue Scoped Token
                  </button>
                </div>
              </div>

              <div>
                <div className="text-xs text-zinc-600 dark:text-zinc-400 mb-2">Permitted Read-Only / Compute Tools:</div>
                <div className="flex flex-wrap gap-2">
                  {builtinTools
                    .filter((t) => t.permissionLevel !== 'restricted')
                    .map((t) => {
                      const checked = newTokenTools.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() =>
                            setNewTokenTools((prev) =>
                              prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]
                            )
                          }
                          className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-mono cursor-pointer ${
                            checked
                              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              : 'border-zinc-200 dark:border-white/10 text-zinc-500'
                          }`}
                        >
                          {t.id}
                        </button>
                      );
                    })}
                </div>
              </div>
            </form>

            {createdPlainToken && (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/20 p-3 space-y-2 text-xs">
                <div className="font-semibold text-emerald-400">New MCP Bearer Token (Copy once now):</div>
                <div className="flex items-center justify-between gap-2 font-mono text-zinc-200 break-all bg-black/40 rounded-lg px-3 py-2">
                  <span>{createdPlainToken}</span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(createdPlainToken)}
                    className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-emerald-300 cursor-pointer shrink-0"
                  >
                    <Copy className="w-3 h-3" />
                    <span>Copy</span>
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const resp = await fetch('/api/v1/mcp/server', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${createdPlainToken}`,
                        },
                        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
                      });
                      const json = await resp.json();
                      setMcpTestOutput(JSON.stringify(json, null, 2));
                    }}
                    className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-[11px] font-semibold text-emerald-300 cursor-pointer"
                  >
                    Verify JSON-RPC tools/list
                  </button>
                </div>
              </div>
            )}

            {mcpTestOutput && (
              <pre className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 text-[11px] font-mono text-zinc-700 dark:text-emerald-300">
                {mcpTestOutput}
              </pre>
            )}

            {serverTokens.length > 0 && (
              <div className="space-y-2 pt-2">
                {serverTokens.map((tk) => (
                  <div
                    key={tk.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 text-xs"
                  >
                    <div>
                      <div className="font-semibold text-zinc-900 dark:text-white">
                        {tk.label}{' '}
                        <span className="font-mono text-[11px] text-zinc-500">({tk.tokenPrefix})</span>
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5">
                        Tools: {tk.allowedTools.join(', ')} · Last used:{' '}
                        {tk.lastUsedAt ? tk.lastUsedAt.slice(0, 19).replace('T', ' ') : 'Never'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          await api.toggleMcpServerToken(tk.id, !tk.enabled);
                          loadAll();
                        }}
                        className={`rounded-lg border px-2.5 py-1.5 text-[11px] cursor-pointer ${
                          tk.enabled
                            ? 'border-emerald-500/30 text-emerald-500'
                            : 'border-zinc-400/30 text-zinc-500'
                        }`}
                      >
                        {tk.enabled ? 'Active' : 'Disabled'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.deleteMcpServerToken(tk.id);
                          loadAll();
                        }}
                        className="rounded-lg border border-red-500/30 px-2.5 py-1.5 text-[11px] text-red-500 cursor-pointer"
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'stage2' && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-emerald-500/20 bg-white dark:bg-[#0D110F] p-5">
            <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Stage Two Architectural Preparation</h3>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              Stage Two agentic execution modules below are registered in the server feature-flag architecture and intentionally disabled until Stage Two rollout.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {stage2Flags.map((flag) => (
              <div key={flag.key} className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0A0E0C] p-5">
                <div className="flex items-center justify-between">
                  <h4 className="font-display text-base font-semibold text-zinc-900 dark:text-white">{flag.label}</h4>
                  <span className="text-xs font-mono text-zinc-500">
                    {flag.enabled ? 'Enabled' : 'Stage Two Planned'}
                  </span>
                </div>
                <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">{flag.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
