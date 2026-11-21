import React from 'react';
import {
  HelpCircle,
  MessageSquare,
  Cpu,
  Brain,
  FileText,
  Keyboard,
  ShieldAlert,
  ArrowRight,
} from 'lucide-react';
import type { BrandedModel } from '../shared/types';
import type { WorkspaceViewId } from './AppSidebar';

interface HelpViewProps {
  models: BrandedModel[];
  onNavigate: (view: WorkspaceViewId) => void;
}

export const HelpView: React.FC<HelpViewProps> = ({ models, onNavigate }) => {
  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 space-y-8">
      <div className="border-b border-zinc-200 dark:border-white/10 pb-5">
        <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-xs font-mono uppercase">
          <HelpCircle className="w-4 h-4" />
          <span>LOODY Documentation</span>
        </div>
        <h2 className="mt-1 font-display text-2xl font-bold text-zinc-900 dark:text-white">
          Workspace Guide & Reference
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          How to work effectively across multi-model chat, projects, document retrieval, voice controls, and quota rules.
        </p>
      </div>

      {/* Getting Started Steps */}
      <section className="grid gap-4 md:grid-cols-3">
        {[
          {
            icon: MessageSquare,
            title: '1. Multi-Model Chat',
            body: 'Choose Sonic 3 for ultra-fast tasks, Sonic 3.5 for balanced coding, or LOODY Vision 1 for image analysis. Edit & resend, regenerate, export Markdown/JSON, or listen aloud.',
            action: 'Open Workspace',
            view: 'chat' as WorkspaceViewId,
          },
          {
            icon: Brain,
            title: '2. Scoped Memory & RAG',
            body: 'Create global User memories or strict Project-scoped instructions. Uploaded documents are automatically chunked and indexed for citation-backed chat responses.',
            action: 'Manage Memory',
            view: 'memory' as WorkspaceViewId,
          },
          {
            icon: FileText,
            title: '3. Document Intelligence',
            body: 'Upload PDF, DOCX, XLSX, CSV, Markdown, code, images, audio, or video. Preview files safely, generate summaries, ask targeted questions, or compare two files.',
            action: 'Open Files',
            view: 'files' as WorkspaceViewId,
          },
        ].map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 flex flex-col justify-between gap-4"
            >
              <div>
                <Icon className="w-5 h-5 text-emerald-500" />
                <h3 className="mt-3 font-display text-base font-bold text-zinc-900 dark:text-white">
                  {card.title}
                </h3>
                <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {card.body}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate(card.view)}
                className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 cursor-pointer"
              >
                <span>{card.action}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </section>

      {/* Model Availability Matrix */}
      <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-emerald-500" />
          <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">
            Model Lineup & Routing Status
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-zinc-200 dark:border-white/10 text-zinc-500">
              <tr>
                <th className="py-2.5 pe-4 font-medium">Model</th>
                <th className="py-2.5 pe-4 font-medium">Tier</th>
                <th className="py-2.5 pe-4 font-medium">Provider Route</th>
                <th className="py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-white/5 text-zinc-800 dark:text-zinc-200">
              {models.map((m) => (
                <tr key={m.id}>
                  <td className="py-2.5 pe-4 font-semibold">{m.displayName}</td>
                  <td className="py-2.5 pe-4 uppercase font-mono text-[11px]">{m.requiredPlan}</td>
                  <td className="py-2.5 pe-4 font-mono text-[11px] text-zinc-500">
                    {m.provider} ({m.upstreamModelId})
                  </td>
                  <td className="py-2.5">
                    <span
                      className={
                        m.availability === 'operational'
                          ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                          : 'text-amber-600 dark:text-amber-400'
                      }
                    >
                      {m.availability === 'operational' ? 'Operational' : 'Awaiting Provider Key'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Keyboard Shortcuts & Troubleshooting */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-emerald-500" />
            <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">
              Composer & Workflow Shortcuts
            </h3>
          </div>
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-2 border-b border-zinc-100 dark:border-white/5 pb-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Send Message</dt>
              <dd className="font-mono text-zinc-900 dark:text-white">Enter</dd>
            </div>
            <div className="flex justify-between gap-2 border-b border-zinc-100 dark:border-white/5 pb-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Insert New Line</dt>
              <dd className="font-mono text-zinc-900 dark:text-white">Shift + Enter</dd>
            </div>
            <div className="flex justify-between gap-2 border-b border-zinc-100 dark:border-white/5 pb-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Attach Files</dt>
              <dd className="font-mono text-zinc-900 dark:text-white">Drag & Drop onto Chat</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Voice Input / Output</dt>
              <dd className="font-mono text-zinc-900 dark:text-white">Mic Icon / Listen Button</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-emerald-500" />
            <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">
              Troubleshooting & Security
            </h3>
          </div>
          <ul className="space-y-2 text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed list-disc ps-4">
            <li>
              <strong className="text-zinc-900 dark:text-white">Model Awaiting Config:</strong> Lodie 5.5 or Fables 5.3 require server-side OpenAI or Anthropic credentials. Enable Automatic Model Fallback in Settings to route safely.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-white">Private Data Isolation:</strong> Every conversation, project, file, and memory record is filtered server-side by your authenticated session ID.
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-white">Executable Policy:</strong> Binary executables (.exe, .apk, .bat, .dll) are blocked at upload validation.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
};
