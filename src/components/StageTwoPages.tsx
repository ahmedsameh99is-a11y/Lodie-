import React from 'react';
import { Code2, Briefcase, Sparkles, GitBranch, Terminal, ShieldCheck, CheckCircle2, Clock } from 'lucide-react';
import type { FeatureFlag } from '../shared/types';

interface StageTwoPageProps {
  page: 'code' | 'work' | 'skills';
  flags: FeatureFlag[];
  onOpenChat: () => void;
}

export const StageTwoPages: React.FC<StageTwoPageProps> = ({ page, flags, onOpenChat }) => {
  const flagKey =
    page === 'code' ? 'stage2_loody_code' : page === 'work' ? 'stage2_loody_work' : 'stage2_skills';
  const flag = flags.find((f) => f.key === flagKey);

  const meta = {
    code: {
      icon: Code2,
      title: 'LOODY Code Workspace',
      subtitle: 'Sandboxed repository explorer, structured patch diff viewer, and integrated test verification.',
      statusText: flag?.enabled ? 'Active' : 'Coming Soon · Stage Two Execution Environment',
      capabilities: [
        {
          icon: GitBranch,
          title: 'Multi-File Repository Context',
          desc: 'Index project trees with explicit path boundaries and read-only inspection scopes.',
        },
        {
          icon: Terminal,
          title: 'Controlled Diff & Test Sandbox',
          desc: 'Review unified diffs line by line and approve test commands before workspace execution.',
        },
        {
          icon: ShieldCheck,
          title: 'Secret Redaction & Audit Trail',
          desc: 'Automatic environment variable masking prior to outbound model context serialization.',
        },
      ],
    },
    work: {
      icon: Briefcase,
      title: 'LOODY Work Autonomous Agent',
      subtitle: 'Long-horizon task planner with deterministic checkpoints, pause/resume controls, and human approval gates.',
      statusText: flag?.enabled ? 'Active' : 'Coming Soon · Stage Two Agent Runtime',
      capabilities: [
        {
          icon: Clock,
          title: 'Multi-Step Plan Execution',
          desc: 'Break complex objectives into inspectable milestones with progress state persistence.',
        },
        {
          icon: ShieldCheck,
          title: 'Human-in-the-Loop Checkpoints',
          desc: 'Sensitive writes, external communications, and billing actions pause for explicit user confirmation.',
        },
        {
          icon: CheckCircle2,
          title: 'Verified Deliverable Outputs',
          desc: 'Produce structured reports, files, and audit logs tied to exact tool invocations.',
        },
      ],
    },
    skills: {
      icon: Sparkles,
      title: 'LOODY Skills Registry',
      subtitle: 'Versioned capability packages combining prompt templates, schemas, and declared tool permissions.',
      statusText: flag?.enabled ? 'Active' : 'Coming Soon · Stage Two Skill Marketplace',
      capabilities: [
        {
          icon: Sparkles,
          title: 'Composable Domain Workflows',
          desc: 'Attach reusable engineering, legal review, or data analysis skills directly to Projects.',
        },
        {
          icon: ShieldCheck,
          title: 'Declared Permission Manifests',
          desc: 'Every skill declares exact read/compute/external-network permissions before activation.',
        },
        {
          icon: CheckCircle2,
          title: 'Team & Personal Versioning',
          desc: 'Pin reproducible skill revisions across shared workspace environments.',
        },
      ],
    },
  }[page];

  const Icon = meta.icon;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-8">
      <div className="rounded-2xl border border-emerald-500/25 bg-white dark:bg-[#0D110F] p-6 sm:p-8 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <Icon className="w-6 h-6" />
          </div>
          <span className="rounded-lg border border-amber-500/35 bg-amber-50 dark:bg-amber-950/30 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            {meta.statusText}
          </span>
        </div>

        <h2 className="font-display text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-white">
          {meta.title}
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-300 max-w-2xl leading-relaxed">
          {meta.subtitle}
        </p>

        <div className="pt-2 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onOpenChat}
            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
          >
            Return to Active Workspace Chat
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {meta.capabilities.map((cap) => {
          const CapIcon = cap.icon;
          return (
            <div
              key={cap.title}
              className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-2.5"
            >
              <CapIcon className="w-5 h-5 text-emerald-500" />
              <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">{cap.title}</h3>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">{cap.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
