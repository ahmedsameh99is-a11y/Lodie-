import React from 'react';
import {
  MessageSquare,
  FolderKanban,
  FileText,
  Brain,
  Cpu,
  Plus,
  ArrowRight,
  Zap,
  ShieldCheck,
  HelpCircle,
  Code2,
  Bot,
  Globe,
  Film,
} from 'lucide-react';
import type { BrandedModel, Conversation, Project, PublicUser } from '../shared/types';
import type { WorkspaceViewId } from './AppSidebar';
import { LoodyLogo } from './LoodyLogo';

interface HomeViewProps {
  user: PublicUser | null;
  usage: { dailyUsed: number; monthlyUsed: number; dailyRemaining?: number; dailyResetAtUtc?: string };
  models: BrandedModel[];
  activeModelId: string;
  conversations: Conversation[];
  projects: Project[];
  onNewChat: () => void;
  onSelectConversation: (conv: Conversation) => void;
  onOpenProjectChat: (project: Project) => void;
  onNavigate: (view: WorkspaceViewId) => void;
  onOpenAuth: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  user,
  usage,
  models,
  activeModelId,
  conversations,
  projects,
  onNewChat,
  onSelectConversation,
  onOpenProjectChat,
  onNavigate,
  onOpenAuth,
}) => {
  const activeModel = models.find((m) => m.id === activeModelId) ?? models[0];
  const operationalCount = models.filter((m) => m.availability === 'operational').length;
  const recentChats = conversations.slice(0, 4);
  const recentProjects = projects.slice(0, 4);

  const dailyLimit = user?.dailyTokenLimit ?? 150_000;
  const dailyPct = Math.min(100, Math.round((usage.dailyUsed / Math.max(1, dailyLimit)) * 100));
  const dailyRemaining = usage.dailyRemaining ?? Math.max(0, dailyLimit - usage.dailyUsed);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-8 space-y-8">
      {/* Hero Banner */}
      <section className="rounded-3xl border border-emerald-500/25 bg-white dark:bg-[#0A0E0C] p-6 sm:p-8 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-2.5 max-w-xl">
          <div className="inline-flex items-center gap-2.5">
            <LoodyLogo variant="primary-3d" size={34} />
            <span className="text-xs font-mono uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              LOODY Super Workspace
            </span>
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">
            {user ? `Welcome back, ${user.displayName}` : 'Your AI. Your Workspace.'}
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
            Multi-model reasoning, isolated project scopes, semantic document retrieval (RAG), and verified tool execution in one black-and-emerald environment.
          </p>
          <div className="pt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onNewChat}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Start New Chat</span>
            </button>
            {!user && (
              <button
                type="button"
                onClick={onOpenAuth}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/35 px-4 py-2.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 min-h-[44px] cursor-pointer"
              >
                <span>Sign In to Sync Workspace</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate('help')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:border-emerald-500/40 min-h-[44px] cursor-pointer"
            >
              <HelpCircle className="w-4 h-4 text-emerald-500" />
              <span>Help Guide</span>
            </button>
          </div>
        </div>

        {/* Workspace Snapshot Cards */}
        <div className="grid grid-cols-2 gap-3 sm:w-80 shrink-0">
          <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <Cpu className="w-3.5 h-3.5 text-emerald-500" />
              <span>Active Model</span>
            </div>
            <div className="mt-1.5 font-display text-sm font-bold text-zinc-900 dark:text-white truncate">
              {activeModel?.displayName ?? 'Sonic 3'}
            </div>
            <div className="mt-0.5 text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
              {operationalCount}/{models.length} live
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4">
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <Zap className="w-3.5 h-3.5 text-emerald-500" />
              <span>Daily Quota</span>
            </div>
            <div dir="ltr" className="mt-1.5 font-mono text-sm font-bold text-zinc-900 dark:text-white tabular-nums">
              {dailyPct}% used
            </div>
            <div className="mt-1.5 h-1.5 w-full rounded-full bg-zinc-200 dark:bg-white/10 overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${dailyPct}%` }} />
            </div>
            <div className="mt-1 text-[10px] font-mono text-zinc-500 tabular-nums">
              {dailyRemaining.toLocaleString()} left
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Conversations</div>
            <div className="mt-1 font-mono text-lg font-bold text-zinc-900 dark:text-white tabular-nums">
              {conversations.length}
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Projects</div>
            <div className="mt-1 font-mono text-lg font-bold text-zinc-900 dark:text-white tabular-nums">
              {projects.length}
            </div>
          </div>
        </div>
      </section>

      {/* Quick Launch Actions */}
      <section className="space-y-3">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Workspace Launchpad
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              title: 'Projects & Scopes',
              desc: 'Bind system instructions, preferred models, and scoped knowledge.',
              icon: FolderKanban,
              view: 'projects' as WorkspaceViewId,
            },
            {
              title: 'Files & Documents',
              desc: 'Upload PDF, DOCX, XLSX, CSV, or code files for AI synthesis & comparison.',
              icon: FileText,
              view: 'files' as WorkspaceViewId,
            },
            {
              title: 'Memory & RAG Search',
              desc: 'Approve long-term instructions and query semantic knowledge chunks.',
              icon: Brain,
              view: 'memory' as WorkspaceViewId,
            },
            {
              title: 'Model Hub',
              desc: 'Inspect model routing, thinking levels, quotas, and live provider status.',
              icon: ShieldCheck,
              view: 'models' as WorkspaceViewId,
            },
            {
              title: 'LOODY Kore',
              desc: 'Multi-file coding workspaces, AST/security validation, and AI code review.',
              icon: Code2,
              view: 'code' as WorkspaceViewId,
            },
            {
              title: 'Agents & Work',
              desc: 'Orchestrate multi-agent DAG workflows with approval gates and project tasks.',
              icon: Bot,
              view: 'work' as WorkspaceViewId,
            },
            {
              title: 'Deep Research',
              desc: 'Grounded web search synthesis, URL inspection, and cited intelligence reports.',
              icon: Globe,
              view: 'research' as WorkspaceViewId,
            },
            {
              title: 'Creative Studio',
              desc: 'Sync images to voiceover, add music & SFX, preview, and render real MP4 videos.',
              icon: Film,
              view: 'creative' as WorkspaceViewId,
            },
          ].map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.view}
                type="button"
                onClick={() => onNavigate(card.view)}
                className="group rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 text-start hover:border-emerald-500/45 transition-colors flex flex-col justify-between gap-4 cursor-pointer"
              >
                <div>
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                    <Icon className="w-5 h-5" />
                  </div>
                  <h3 className="mt-3 font-display text-base font-bold text-zinc-900 dark:text-white">
                    {card.title}
                  </h3>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    {card.desc}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <span>Open</span>
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Recent Activity Split */}
      <section className="grid gap-6 lg:grid-cols-2">
        {/* Recent Conversations */}
        <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-emerald-500" />
              <h2 className="font-display text-base font-bold text-zinc-900 dark:text-white">
                Recent Conversations
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('chat')}
              className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer"
            >
              Open Workspace
            </button>
          </div>

          {!user ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-4">
              Sign in to access synced conversation threads across sessions.
            </p>
          ) : recentChats.length === 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-4">
              No conversations recorded yet. Click Start New Chat above to begin.
            </p>
          ) : (
            <div className="space-y-2">
              {recentChats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelectConversation(c)}
                  className="w-full flex items-center justify-between gap-3 rounded-xl border border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-[#050706] px-3.5 py-2.5 text-start hover:border-emerald-500/40 min-h-[44px] cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-900 dark:text-white truncate">{c.title}</div>
                    <div className="text-[11px] text-zinc-500 font-mono">
                      {models.find((m) => m.id === c.modelId)?.displayName ?? c.modelId}
                    </div>
                  </div>
                  <span className="text-[11px] text-zinc-400 shrink-0 font-mono">
                    {c.updatedAt.slice(0, 10)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Active Projects */}
        <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderKanban className="w-4 h-4 text-emerald-500" />
              <h2 className="font-display text-base font-bold text-zinc-900 dark:text-white">
                Active Projects
              </h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('projects')}
              className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer"
            >
              Manage Projects
            </button>
          </div>

          {!user ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-4">
              Sign in to organize project instructions, files, and isolated memories.
            </p>
          ) : recentProjects.length === 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-4">
              No projects created yet. Create a project to scope instructions and knowledge retrieval.
            </p>
          ) : (
            <div className="space-y-2">
              {recentProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpenProjectChat(p)}
                  className="w-full flex items-center justify-between gap-3 rounded-xl border border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-[#050706] px-3.5 py-2.5 text-start hover:border-emerald-500/40 min-h-[44px] cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-900 dark:text-white truncate">{p.name}</div>
                    <div className="text-[11px] text-zinc-500 truncate">
                      {p.description || 'Scoped project instructions & knowledge'}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 shrink-0">
                    {p.fileCount ?? 0} files · {p.memoryCount ?? 0} mem
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
