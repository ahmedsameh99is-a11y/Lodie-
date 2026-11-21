import React, { useState } from 'react';
import {
  MessageSquare,
  FolderKanban,
  Code2,
  Briefcase,
  Sparkles,
  FileText,
  Wrench,
  Plug,
  Server,
  Cpu,
  BarChart3,
  Settings,
  Plus,
  Search,
  Pin,
  Archive,
  Pencil,
  Trash2,
  X,
  User as UserIcon,
  Folder,
  Home,
  Brain,
  HelpCircle,
  Globe,
  Film,
} from 'lucide-react';
import { t } from '../shared/i18n';
import type { AppLanguage, Conversation, PublicUser } from '../shared/types';
import { LoodyLogo } from './LoodyLogo';

export type WorkspaceViewId =
  | 'home'
  | 'chat'
  | 'projects'
  | 'code'
  | 'work'
  | 'skills'
  | 'research'
  | 'creative'
  | 'files'
  | 'memory'
  | 'tools'
  | 'integrations'
  | 'mcp'
  | 'models'
  | 'usage'
  | 'settings'
  | 'help';

interface AppSidebarProps {
  open: boolean;
  onClose: () => void;
  activeView: WorkspaceViewId;
  onSelectView: (view: WorkspaceViewId) => void;
  language: AppLanguage;
  user: PublicUser | null;
  conversations: Conversation[];
  activeConvId: string | null;
  searchQuery: string;
  showArchived: boolean;
  onSearchChange: (q: string) => void;
  onToggleArchived: () => void;
  onNewChat: () => void;
  onSelectConversation: (conv: Conversation) => void;
  onRenameConversation: (id: string, title: string) => Promise<void>;
  onUpdateConversation: (
    id: string,
    patch: { pinned?: boolean; archived?: boolean; folder?: string }
  ) => Promise<void>;
  onDeleteConversation: (id: string) => Promise<void>;
  onOpenAuth: () => void;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  open,
  onClose,
  activeView,
  onSelectView,
  language,
  user,
  conversations,
  activeConvId,
  searchQuery,
  showArchived,
  onSearchChange,
  onToggleArchived,
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onUpdateConversation,
  onDeleteConversation,
  onOpenAuth,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState('');
  const [folderFilter, setFolderFilter] = useState<string>('');

  const folders = Array.from(new Set(conversations.map((c) => c.folder).filter(Boolean)));
  const visibleConversations = folderFilter
    ? conversations.filter((c) => c.folder === folderFilter)
    : conversations;

  const pinnedList = visibleConversations.filter((c) => c.pinned);
  const regularList = visibleConversations.filter((c) => !c.pinned);

  const navGroups: Array<{
    heading: string;
    items: Array<{ id: WorkspaceViewId; label: string; icon: typeof MessageSquare; stageTwo?: boolean }>;
  }> = [
    {
      heading: language === 'ar' ? 'مساحة العمل' : 'Workspace',
      items: [
        { id: 'home', label: t(language, 'navHome'), icon: Home },
        { id: 'chat', label: t(language, 'navChat'), icon: MessageSquare },
        { id: 'projects', label: t(language, 'navProjects'), icon: FolderKanban },
        { id: 'files', label: t(language, 'navFiles'), icon: FileText },
        { id: 'memory', label: t(language, 'navMemory'), icon: Brain },
        { id: 'models', label: t(language, 'navModels'), icon: Cpu },
      ],
    },
    {
      heading: language === 'ar' ? 'الأدوات والتوسعات' : 'Capabilities',
      items: [
        { id: 'tools', label: t(language, 'navTools'), icon: Wrench },
        { id: 'integrations', label: t(language, 'navIntegrations'), icon: Plug },
        { id: 'mcp', label: t(language, 'navMcp'), icon: Server },
      ],
    },
    {
      heading: language === 'ar' ? 'الذكاء المتقدم' : 'Intelligence & Studios',
      items: [
        { id: 'code', label: t(language, 'navCode'), icon: Code2 },
        { id: 'work', label: t(language, 'navWork'), icon: Briefcase },
        { id: 'skills', label: t(language, 'navSkills'), icon: Sparkles },
        { id: 'research', label: t(language, 'navResearch'), icon: Globe },
        { id: 'creative', label: t(language, 'navCreative'), icon: Film },
      ],
    },
    {
      heading: language === 'ar' ? 'الحساب' : 'Account',
      items: [
        { id: 'usage', label: t(language, 'navUsage'), icon: BarChart3 },
        { id: 'settings', label: t(language, 'navSettings'), icon: Settings },
        { id: 'help', label: t(language, 'navHelp'), icon: HelpCircle },
      ],
    },
  ];

  const handleNavClick = (view: WorkspaceViewId) => {
    onSelectView(view);
    onClose();
  };

  const renderConversationItem = (c: Conversation) => {
    const active = activeView === 'chat' && activeConvId === c.id;
    return (
      <div
        key={c.id}
        className={`group flex items-center gap-1 rounded-xl px-2 py-1.5 transition-colors ${
          active
            ? 'bg-emerald-500/15 border border-emerald-500/35 text-emerald-950 dark:text-white'
            : 'border border-transparent text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-white/5'
        }`}
      >
        {renamingId === c.id ? (
          <input
            type="text"
            autoFocus
            aria-label={`Rename ${c.title}`}
            value={renamingTitle}
            onChange={(e) => setRenamingTitle(e.target.value)}
            onBlur={async () => {
              if (renamingTitle.trim()) await onRenameConversation(c.id, renamingTitle.trim());
              setRenamingId(null);
            }}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                if (renamingTitle.trim()) await onRenameConversation(c.id, renamingTitle.trim());
                setRenamingId(null);
              }
              if (e.key === 'Escape') setRenamingId(null);
            }}
            className="flex-1 rounded-lg bg-white dark:bg-[#050706] px-2 py-1 text-xs text-zinc-900 dark:text-white border border-emerald-500 focus:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              onSelectConversation(c);
              onClose();
            }}
            className="flex-1 flex items-center gap-1.5 text-start text-xs font-medium truncate min-h-[36px] cursor-pointer"
          >
            {c.pinned && <Pin className="w-3 h-3 text-emerald-500 shrink-0" />}
            <span className="truncate">{c.title}</span>
          </button>
        )}

        <div className="flex items-center opacity-80 lg:opacity-0 lg:group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            title={c.pinned ? t(language, 'unpin') : t(language, 'pin')}
            aria-label={`${c.pinned ? 'Unpin' : 'Pin'} ${c.title}`}
            onClick={() => onUpdateConversation(c.id, { pinned: !c.pinned })}
            className="p-1 text-zinc-500 hover:text-emerald-500 cursor-pointer"
          >
            <Pin className="w-3 h-3" />
          </button>
          <button
            type="button"
            title={c.archived ? t(language, 'unarchive') : t(language, 'archive')}
            aria-label={`${c.archived ? 'Unarchive' : 'Archive'} ${c.title}`}
            onClick={() => onUpdateConversation(c.id, { archived: !c.archived })}
            className="p-1 text-zinc-500 hover:text-amber-500 cursor-pointer"
          >
            <Archive className="w-3 h-3" />
          </button>
          <button
            type="button"
            title={t(language, 'rename')}
            aria-label={`Rename ${c.title}`}
            onClick={() => {
              setRenamingId(c.id);
              setRenamingTitle(c.title);
            }}
            className="p-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            type="button"
            title={t(language, 'delete')}
            aria-label={`Delete ${c.title}`}
            onClick={() => onDeleteConversation(c.id)}
            className="p-1 text-zinc-500 hover:text-red-500 cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  };

  const content = (
    <div className="flex h-full w-72 flex-col bg-zinc-50 dark:bg-[#080B09] border-e border-zinc-200 dark:border-emerald-500/15 text-zinc-900 dark:text-[#F1F5F3]">
      {/* Brand + New Chat */}
      <div className="p-3 border-b border-zinc-200 dark:border-white/8 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => handleNavClick('chat')}
            className="inline-flex items-center gap-2.5 cursor-pointer"
          >
            <LoodyLogo variant="primary-3d" size={28} />
            <span className="font-display text-base font-bold tracking-tight">LOODY</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            className="lg:hidden flex h-10 w-10 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-white/5 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            onNewChat();
            onClose();
          }}
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors min-h-[42px] cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t(language, 'newChat')}</span>
        </button>
      </div>

      {/* Scrollable Nav + History */}
      <div className="flex-1 overflow-y-auto px-2.5 py-3 space-y-4">
        {/* Search conversations */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute start-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            aria-label={t(language, 'searchConversations')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t(language, 'searchConversations')}
            className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#050706] ps-9 pe-3 py-2 text-xs text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-500 focus:border-emerald-500 focus:outline-none min-h-[38px]"
          />
        </div>

        {/* Navigation Groups */}
        <nav aria-label="Workspace navigation" className="space-y-2">
          {navGroups.map((group) => (
            <div key={group.heading} className="space-y-0.5">
              <div className="px-2.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                {group.heading}
              </div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavClick(item.id)}
                    className={`w-full flex items-center justify-between gap-2 rounded-xl px-2.5 py-1 text-xs font-medium transition-colors min-h-[30px] cursor-pointer ${
                      active
                        ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                        : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 truncate">
                      <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-emerald-500' : 'text-zinc-400'}`} />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {item.stageTwo && (
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500 whitespace-nowrap">Soon</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Chat History Section */}
        <div className="border-t border-zinc-200 dark:border-white/8 pt-3 space-y-2">
          <div className="flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t(language, 'recentConversations')}
            </span>
            <button
              type="button"
              onClick={onToggleArchived}
              className={`text-[11px] font-medium cursor-pointer ${
                showArchived ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
              }`}
            >
              {showArchived ? 'Active' : 'Archived'}
            </button>
          </div>

          {folders.length > 0 && (
            <div className="flex items-center gap-1.5 px-2 overflow-x-auto">
              <button
                type="button"
                onClick={() => setFolderFilter('')}
                className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] whitespace-nowrap cursor-pointer ${
                  folderFilter === ''
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-200/70 dark:bg-white/5 text-zinc-600 dark:text-zinc-400'
                }`}
              >
                All
              </button>
              {folders.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFolderFilter(f)}
                  className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] whitespace-nowrap cursor-pointer ${
                    folderFilter === f
                      ? 'bg-emerald-600 text-white'
                      : 'bg-zinc-200/70 dark:bg-white/5 text-zinc-600 dark:text-zinc-400'
                  }`}
                >
                  <Folder className="w-3 h-3" />
                  <span>{f}</span>
                </button>
              ))}
            </div>
          )}

          {!user ? (
            <div className="rounded-xl border border-zinc-200 dark:border-emerald-500/20 bg-white dark:bg-[#0D110F] p-3 text-xs text-zinc-500 dark:text-zinc-400">
              <p className="text-zinc-800 dark:text-zinc-200 font-medium mb-2">Sign in to sync chat history</p>
              <button
                type="button"
                onClick={() => {
                  onOpenAuth();
                  onClose();
                }}
                className="w-full rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[38px] cursor-pointer"
              >
                {t(language, 'signIn')}
              </button>
            </div>
          ) : visibleConversations.length === 0 ? (
            <p className="px-2 py-2 text-xs text-zinc-400 dark:text-zinc-500">{t(language, 'noConversations')}</p>
          ) : (
            <div className="space-y-1">
              {pinnedList.length > 0 && (
                <div className="space-y-0.5">
                  <div className="px-2 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">Pinned</div>
                  {pinnedList.map(renderConversationItem)}
                </div>
              )}
              {regularList.map(renderConversationItem)}
            </div>
          )}
        </div>
      </div>

      {/* User Footer */}
      <div className="border-t border-zinc-200 dark:border-white/8 p-3">
        {user ? (
          <button
            type="button"
            onClick={() => handleNavClick('settings')}
            className="w-full flex items-center justify-between gap-2 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-3 py-2 text-start hover:border-emerald-500/40 min-h-[44px] cursor-pointer"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-semibold text-xs">
                {user.displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold truncate">{user.displayName}</div>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate uppercase">{user.plan}</div>
              </div>
            </div>
            <Settings className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              onOpenAuth();
              onClose();
            }}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 min-h-[44px] cursor-pointer"
          >
            <UserIcon className="w-4 h-4" />
            <span>{t(language, 'signIn')}</span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block shrink-0 h-full">{content}</aside>
      {open && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="h-full shadow-2xl">{content}</div>
          <button
            type="button"
            aria-label="Close navigation overlay"
            onClick={onClose}
            className="flex-1 bg-black/60 backdrop-blur-[1px]"
          />
        </div>
      )}
    </>
  );
};
