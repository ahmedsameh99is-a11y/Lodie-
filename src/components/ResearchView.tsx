import React, { useEffect, useState } from 'react';
import { Globe, Search, Trash2, ExternalLink, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import type { Project, PublicUser, ResearchReport } from '../shared/types';

interface ResearchViewProps {
  user: PublicUser | null;
  projects: Project[];
  onOpenAuth: () => void;
}

export const ResearchView: React.FC<ResearchViewProps> = ({ user, projects, onOpenAuth }) => {
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [urlsText, setUrlsText] = useState('');
  const [projectId, setProjectId] = useState('');
  const [useWebSearch, setUseWebSearch] = useState(true);
  const [running, setRunning] = useState(false);
  const [confirmDeleteReportId, setConfirmDeleteReportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadReports = async () => {
    if (!user) return;
    try {
      const res = await api.getResearchReports();
      setReports(res.reports);
      if (!selectedId && res.reports.length > 0) setSelectedId(res.reports[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load research reports.');
    }
  };

  useEffect(() => {
    loadReports();
  }, [user?.id]);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Globe className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Deep Research Engine</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to run live grounded web search queries, inspect URL evidence safely, and archive cited intelligence reports.
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

  const activeReport = reports.find((r) => r.id === selectedId) ?? null;

  const handleRunResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    const urls = urlsText
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 4);

    try {
      const res = await api.runResearch({
        query: query.trim(),
        projectId: projectId || null,
        urls,
        useWebSearch,
      });
      setQuery('');
      setUrlsText('');
      await loadReports();
      setSelectedId(res.report.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Research synthesis failed.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 space-y-6">
      <div className="border-b border-zinc-200 dark:border-white/10 pb-5">
        <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Research Engine</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Live Search Grounding + SSRF-checked URL text extraction with calibrated confidence ratings and conflict flagging.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* New Research Form */}
      <form onSubmit={handleRunResearch} className="rounded-2xl border border-emerald-500/25 bg-white dark:bg-[#0D110F] p-5 space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label htmlFor="res-query" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Research Question
            </label>
            <input
              id="res-query"
              type="text"
              required
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. Compare SQLite WAL concurrency limits vs PostgreSQL 17 for mid-scale SaaS"
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white min-h-[42px]"
            />
          </div>
          <div>
            <label htmlFor="res-proj" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Project Context (Optional)
            </label>
            <select
              id="res-proj"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[42px]"
            >
              <option value="">Workspace Global</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="res-urls" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">
            Explicit URLs to Inspect Safely (Optional, up to 4 HTTPS URLs)
          </label>
          <input
            id="res-urls"
            type="text"
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            placeholder="https://www.sqlite.org/wal.html, https://nodejs.org/api/test.html"
            className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3.5 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={useWebSearch} onChange={(e) => setUseWebSearch(e.target.checked)} />
            <span>Enable live Google Search Grounding verification</span>
          </label>

          <button
            type="submit"
            disabled={running || !query.trim()}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 min-h-[42px] cursor-pointer"
          >
            <Search className="w-3.5 h-3.5" />
            <span>{running ? 'Researching Sources...' : 'Generate Cited Report'}</span>
          </button>
        </div>
      </form>

      {/* Saved Reports */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-4 space-y-2.5">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Saved Reports ({reports.length})</div>
          {reports.length === 0 ? (
            <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-6 text-xs text-zinc-500">
              No research reports saved yet.
            </div>
          ) : (
            reports.map((rep) => (
              <div
                key={rep.id}
                className={`rounded-xl border p-3.5 text-xs space-y-1 bg-white dark:bg-[#0D110F] ${
                  selectedId === rep.id ? 'border-emerald-500/60' : 'border-zinc-200 dark:border-white/10'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedId(rep.id)}
                    className="text-start font-semibold text-zinc-900 dark:text-white line-clamp-2 cursor-pointer"
                  >
                    {rep.query}
                  </button>
                  {confirmDeleteReportId === rep.id ? (
                    <span className="inline-flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={async () => {
                          await api.deleteResearchReport(rep.id);
                          setConfirmDeleteReportId(null);
                          if (selectedId === rep.id) setSelectedId(null);
                          await loadReports();
                        }}
                        className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white cursor-pointer"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteReportId(null)}
                        className="rounded border border-zinc-300 dark:border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-500 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete report ${rep.query}`}
                      onClick={() => setConfirmDeleteReportId(rep.id)}
                      className="text-zinc-400 hover:text-red-500 p-1 cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-zinc-500 font-mono">
                  {rep.sources.length} sources · {rep.createdAt.slice(0, 10)}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="lg:col-span-8">
          {activeReport ? (
            <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-5 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 dark:border-white/10 pb-3">
                <div>
                  <h3 className="font-display text-lg font-bold text-zinc-900 dark:text-white">{activeReport.query}</h3>
                  <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>
                      {activeReport.groundingsAvailable ? 'Grounded with Verified Sources' : 'Synthesis Only (No External Sources Grounded)'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="font-semibold text-zinc-800 dark:text-zinc-200">Executive Summary</div>
                <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">{activeReport.summary}</p>
              </div>

              {activeReport.findings.length > 0 && (
                <div className="space-y-2">
                  <div className="font-semibold text-zinc-800 dark:text-zinc-200">Structured Findings</div>
                  {activeReport.findings.map((f, i) => (
                    <div key={i} className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-zinc-900 dark:text-white">{f.claim}</span>
                        <span
                          className={`font-mono text-[10px] uppercase font-bold ${
                            f.confidence === 'high'
                              ? 'text-emerald-500'
                              : f.confidence === 'medium'
                              ? 'text-amber-500'
                              : 'text-red-500'
                          }`}
                        >
                          {f.confidence} confidence
                        </span>
                      </div>
                      <p className="text-zinc-600 dark:text-zinc-300">{f.evidence}</p>
                      {f.conflictNote && <p className="text-amber-600 dark:text-amber-400">Conflict Note: {f.conflictNote}</p>}
                    </div>
                  ))}
                </div>
              )}

              {activeReport.sources.length > 0 && (
                <div className="space-y-2">
                  <div className="font-semibold text-zinc-800 dark:text-zinc-200">Verified Citations ({activeReport.sources.length})</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {activeReport.sources.map((src, i) => (
                      <a
                        key={i}
                        href={src.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-xl border border-emerald-500/20 bg-zinc-50 dark:bg-[#050706] p-3 hover:border-emerald-500/50 transition-colors space-y-1 block"
                      >
                        <div className="flex items-center justify-between gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
                          <span className="truncate">{src.title}</span>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </div>
                        <div className="font-mono text-[10px] text-zinc-400 truncate">{src.url}</div>
                        <p className="text-[11px] text-zinc-600 dark:text-zinc-400 line-clamp-2">{src.snippet}</p>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-10 text-center text-xs text-zinc-500">
              Select or generate a research report to inspect verified sources and findings.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
