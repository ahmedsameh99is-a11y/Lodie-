import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  MessageSquare,
  Cpu,
  FolderKanban,
  Wrench,
  Settings,
  Menu,
  Share2,
} from 'lucide-react';
import { api } from './lib/api';
import { auth, syncUserProfileToFirestore } from './lib/firebase';
import { parseSharedTranscriptSafely } from './shared/chatStream';
import { t } from './shared/i18n';
import type {
  AccentColor,
  AppLanguage,
  AppTheme,
  BrandedModel,
  Conversation,
  ConversationShare,
  DensityPref,
  DocumentAttachment,
  FontSizePref,
  Project,
  PublicUser,
} from './shared/types';
import { AppSidebar, type WorkspaceViewId } from './components/AppSidebar';
import { AuthModal } from './components/AuthModal';
import { ChatWorkspace } from './components/ChatWorkspace';
import { CreativeStudioView } from './components/CreativeStudioView';
import { InlineMarkdownErrorBoundary } from './components/ErrorBoundary';
import { FilesView } from './components/FilesView';
import { HelpView } from './components/HelpView';
import { HomeView } from './components/HomeView';
import { KoreWorkspace } from './components/KoreWorkspace';
import { LoodyLogo } from './components/LoodyLogo';
import { MemoryView } from './components/MemoryView';
import { ModelHub } from './components/ModelHub';
import { OfflineBanner } from './components/PWAInstallButton';
import { ProjectsView } from './components/ProjectsView';
import { ResearchView } from './components/ResearchView';
import { SettingsView } from './components/SettingsView';
import { SkillsView } from './components/SkillsView';
import { SplashScreen } from './components/SplashScreen';
import { SubscriptionsUsageView } from './components/SubscriptionsUsageView';
import { WorkAgentsView } from './components/WorkAgentsView';
import { WorkspaceToolsView } from './components/WorkspaceToolsView';

export default function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [usage, setUsage] = useState<{ dailyUsed: number; monthlyUsed: number }>({
    dailyUsed: 0,
    monthlyUsed: 0,
  });
  const [models, setModels] = useState<BrandedModel[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const [activeView, setActiveView] = useState<WorkspaceViewId>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [activeModelId, setActiveModelId] = useState<string>('sonic-3');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [queuedDocAttachment, setQueuedDocAttachment] = useState<DocumentAttachment | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // Read-only ?share= viewer
  const [sharedSnapshot, setSharedSnapshot] = useState<ConversationShare | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  const [language, setLanguage] = useState<AppLanguage>(() =>
    localStorage.getItem('loody_lang') === 'ar' ? 'ar' : 'en'
  );
  const [theme, setTheme] = useState<AppTheme>(() => {
    const saved = localStorage.getItem('loody_theme');
    return saved === 'light' || saved === 'system' ? saved : 'dark';
  });
  const [accentColor, setAccentColor] = useState<AccentColor>(() => {
    const saved = localStorage.getItem('loody_accent');
    return saved === 'teal' || saved === 'mint' || saved === 'slate' ? saved : 'emerald';
  });
  const [fontSize, setFontSize] = useState<FontSizePref>(() => {
    const saved = localStorage.getItem('loody_fontsize');
    return saved === 'sm' || saved === 'lg' ? saved : 'md';
  });
  const [density, setDensity] = useState<DensityPref>(() =>
    localStorage.getItem('loody_density') === 'compact' ? 'compact' : 'comfortable'
  );
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => localStorage.getItem('loody_sound') !== '0');
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    const prefersReduced =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return localStorage.getItem('loody_reduced_motion') === '1' || prefersReduced;
  });

  const [showSplash, setShowSplash] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1' || params.get('share')) return false;
    return localStorage.getItem('loody_splash_seen') !== '1';
  });
  const [isReplaySplash, setIsReplaySplash] = useState(false);

  // Sync RTL / LTR
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem('loody_lang', language);
  }, [language]);

  // Sync Theme + Accent + Typography + Density
  useEffect(() => {
    const applyTheme = () => {
      const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      const isDark = theme === 'dark' || (theme === 'system' && systemDark);
      document.documentElement.classList.toggle('dark', isDark);
    };
    applyTheme();
    localStorage.setItem('loody_theme', theme);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', applyTheme);
    return () => mq?.removeEventListener?.('change', applyTheme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.accent = accentColor;
    document.documentElement.dataset.fontSize = fontSize;
    document.documentElement.dataset.density = density;
    localStorage.setItem('loody_accent', accentColor);
    localStorage.setItem('loody_fontsize', fontSize);
    localStorage.setItem('loody_density', density);
  }, [accentColor, fontSize, density]);

  // Handle ?share= URL parameter
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const shareId = sp.get('share');
    if (!shareId) return;
    api
      .getShareSnapshot(shareId)
      .then((res) => setSharedSnapshot(res.share))
      .catch((err) => setShareError(err instanceof Error ? err.message : 'Shared link unavailable.'));
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const res = await api.getModels();
      setModels(res.models);
    } catch {
      // Ignore transient
    }
  }, []);

  const loadProjects = useCallback(async (authenticated: boolean) => {
    if (!authenticated) {
      setProjects([]);
      return;
    }
    try {
      const res = await api.getProjects();
      setProjects(res.projects);
    } catch {
      setProjects([]);
    }
  }, []);

  const loadConversations = useCallback(
    async (authenticated: boolean) => {
      if (!authenticated) {
        setConversations([]);
        return;
      }
      try {
        const res = await api.getConversations({
          q: searchQuery || undefined,
          projectId: activeProjectId || undefined,
          archived: showArchived ? '1' : undefined,
        });
        setConversations(res.conversations);
      } catch {
        setConversations([]);
      }
    },
    [searchQuery, activeProjectId, showArchived]
  );

  const applyUserPreferences = useCallback((u: PublicUser) => {
    setLanguage(u.language);
    setTheme(u.theme);
    setAccentColor(u.accentColor);
    setFontSize(u.fontSize);
    setDensity(u.density);
    setSoundEnabled(u.soundEnabled);
    setReducedMotion(u.reducedMotion);
    setActiveModelId(u.defaultModelId || 'sonic-3');
  }, []);

  const bootstrap = useCallback(async () => {
    await loadModels();
    try {
      const session = await api.getSession();
      setUser(session.user);
      if (session.usage) setUsage(session.usage);
      if (session.user) {
        applyUserPreferences(session.user);
        await Promise.all([loadProjects(true), loadConversations(true)]);
      }
    } catch {
      // Unauthenticated
    }
  }, [loadModels, loadProjects, loadConversations, applyUserPreferences]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  // Keep Firebase Auth state synced with backend session
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) return;
      try {
        const idToken = await fbUser.getIdToken();
        const res = await api.firebaseExchange(idToken);
        setUser(res.user);
        setUsage(res.usage);
        syncUserProfileToFirestore(res.user).catch(() => null);
      } catch {
        // Ignore transient sync error
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    loadConversations(Boolean(user));
  }, [user?.id, searchQuery, activeProjectId, showArchived, loadConversations]);

  const handleSplashComplete = useCallback(
    async (markSeen: boolean) => {
      setShowSplash(false);
      setIsReplaySplash(false);
      if (markSeen) {
        localStorage.setItem('loody_splash_seen', '1');
        if (user && !user.splashCompleted) {
          api.updatePreferences({ splashCompleted: true }).catch(() => null);
        }
      }
    },
    [user]
  );

  const updatePref = async (patch: Parameters<typeof api.updatePreferences>[0]) => {
    if (!user) return;
    const res = await api.updatePreferences(patch).catch(() => null);
    if (res) {
      setUser(res.user);
      syncUserProfileToFirestore(res.user).catch(() => null);
    }
  };

  if (sharedSnapshot || shareError) {
    const parsedShare = sharedSnapshot
      ? parseSharedTranscriptSafely(sharedSnapshot.transcript)
      : { ok: true, messages: [], error: null };
    const effectiveShareError = shareError ?? parsedShare.error;
    return (
      <div className="min-h-dvh bg-[#F8FAF9] dark:bg-[#050706] text-zinc-900 dark:text-[#F1F5F3] px-4 py-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/10 pb-4">
            <div className="flex items-center gap-3">
              <LoodyLogo variant="primary-3d" size={32} />
              <div>
                <h1 className="font-display text-lg font-bold">
                  {sharedSnapshot ? sharedSnapshot.title : 'Shared Conversation'}
                </h1>
                <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <Share2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span>LOODY Read-Only Snapshot</span>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                window.history.replaceState({}, '', '/');
                setSharedSnapshot(null);
                setShareError(null);
              }}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
            >
              Open LOODY Workspace
            </button>
          </div>

          {effectiveShareError ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-50 dark:bg-red-950/30 p-5 text-sm text-red-700 dark:text-red-200">
              {effectiveShareError}
            </div>
          ) : (
            <div className="space-y-4">
              {parsedShare.messages.map((m, idx) => (
                <article
                  key={idx}
                  className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5"
                >
                  <div className="mb-2 text-xs font-semibold uppercase text-emerald-600 dark:text-emerald-400">
                    {m.role}
                  </div>
                  <div className="prose prose-zinc dark:prose-invert prose-sm max-w-none">
                    <InlineMarkdownErrorBoundary fallbackText={m.content} resetKey={m.content}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </InlineMarkdownErrorBoundary>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full bg-[#F8FAF9] dark:bg-[#050706] text-zinc-900 dark:text-[#F1F5F3] overflow-hidden">
      {showSplash && (
        <SplashScreen
          language={language}
          soundEnabled={soundEnabled}
          reducedMotion={reducedMotion}
          isReplay={isReplaySplash}
          onComplete={handleSplashComplete}
        />
      )}

      {/* Left Desktop & Mobile Drawer Sidebar */}
      <AppSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeView={activeView}
        onSelectView={setActiveView}
        language={language}
        user={user}
        conversations={conversations}
        activeConvId={activeConvId}
        searchQuery={searchQuery}
        showArchived={showArchived}
        onSearchChange={setSearchQuery}
        onToggleArchived={() => setShowArchived((v) => !v)}
        onNewChat={() => {
          setActiveConvId(null);
          setActiveView('chat');
        }}
        onSelectConversation={(conv) => {
          setActiveConvId(conv.id);
          setActiveModelId(conv.modelId);
          setActiveView('chat');
        }}
        onRenameConversation={async (id, title) => {
          await api.updateConversation(id, { title });
          await loadConversations(Boolean(user));
        }}
        onUpdateConversation={async (id, patch) => {
          await api.updateConversation(id, patch);
          await loadConversations(Boolean(user));
        }}
        onDeleteConversation={async (id) => {
          await api.deleteConversation(id);
          if (activeConvId === id) setActiveConvId(null);
          await loadConversations(Boolean(user));
        }}
        onOpenAuth={() => setAuthModalOpen(true)}
      />

      {/* Right Workspace Column */}
      <div className="flex flex-1 flex-col min-w-0 h-full">
        {/* Compact Mobile Top Header (Desktop uses Sidebar brand + user footer, saving vertical height) */}
        <header className="lg:hidden shrink-0 h-[52px] border-b border-zinc-200 dark:border-emerald-500/15 bg-white/95 dark:bg-[#070A08]/95 backdrop-blur-md px-3 flex items-center justify-between gap-3 pt-safe z-30">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-200 cursor-pointer"
            >
              <Menu className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setActiveView('chat')}
              className="inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
            >
              <LoodyLogo variant="primary-3d" size={26} />
              <span className="font-display text-base font-bold">LOODY</span>
            </button>
          </div>

          {user ? (
            <button
              type="button"
              onClick={() => setActiveView('settings')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-white/10 px-2.5 py-1.5 text-xs font-medium min-h-[36px] cursor-pointer"
            >
              <Settings className="w-3.5 h-3.5 text-emerald-500" />
              <span className="max-w-[96px] truncate">{user.displayName}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setAuthModalOpen(true)}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white min-h-[36px] cursor-pointer"
            >
              {t(language, 'signIn')}
            </button>
          )}
        </header>

        {/* Active View Canvas */}
        <main className="flex-1 min-h-0 overflow-y-auto pb-[64px] md:pb-0">
          {activeView === 'home' && (
            <HomeView
              user={user}
              usage={usage}
              models={models}
              activeModelId={activeModelId}
              conversations={conversations}
              projects={projects}
              onNewChat={() => {
                setActiveConvId(null);
                setActiveView('chat');
              }}
              onSelectConversation={(conv) => {
                setActiveConvId(conv.id);
                setActiveModelId(conv.modelId);
                setActiveView('chat');
              }}
              onOpenProjectChat={(proj) => {
                setActiveProjectId(proj.id);
                if (proj.preferredModelId) setActiveModelId(proj.preferredModelId);
                setActiveView('chat');
              }}
              onNavigate={setActiveView}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'chat' && (
            <ChatWorkspace
              user={user}
              language={language}
              models={models}
              projects={projects}
              conversations={conversations}
              activeConvId={activeConvId}
              activeModelId={activeModelId}
              activeProjectId={activeProjectId}
              queuedDocAttachment={queuedDocAttachment}
              onConsumeQueuedDocAttachment={() => setQueuedDocAttachment(null)}
              onSelectConvId={setActiveConvId}
              onSelectModel={setActiveModelId}
              onSelectProject={setActiveProjectId}
              onOpenSidebar={() => setSidebarOpen(true)}
              onOpenModelHub={() => setActiveView('models')}
              onOpenAuth={() => setAuthModalOpen(true)}
              onRefreshConversations={() => loadConversations(Boolean(user))}
              onUsageUpdate={setUsage}
            />
          )}

          {activeView === 'models' && (
            <ModelHub
              user={user}
              models={models}
              activeModelId={activeModelId}
              onSelectModel={(id) => {
                setActiveModelId(id);
                setActiveView('chat');
              }}
              onModelsUpdated={loadModels}
            />
          )}

          {activeView === 'projects' && (
            <ProjectsView
              user={user}
              projects={projects}
              models={models}
              conversations={conversations}
              onRefresh={() => loadProjects(Boolean(user))}
              onOpenProjectChat={(proj) => {
                setActiveProjectId(proj.id);
                if (proj.preferredModelId) setActiveModelId(proj.preferredModelId);
                setActiveView('chat');
              }}
              onOpenConversation={(conv) => {
                setActiveConvId(conv.id);
                setActiveModelId(conv.modelId);
                if (conv.projectId) setActiveProjectId(conv.projectId);
                setActiveView('chat');
              }}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'files' && (
            <FilesView
              user={user}
              onUseInChat={(docAtt) => {
                setQueuedDocAttachment(docAtt);
                setActiveView('chat');
              }}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'memory' && (
            <MemoryView
              user={user}
              projects={projects}
              onUserUpdated={(nextUser) => {
                setUser(nextUser);
                syncUserProfileToFirestore(nextUser).catch(() => null);
              }}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'help' && <HelpView models={models} onNavigate={setActiveView} />}

          {(activeView === 'tools' || activeView === 'integrations' || activeView === 'mcp') && (
            <WorkspaceToolsView
              user={user}
              initialTab={activeView === 'tools' ? 'tools' : activeView === 'integrations' ? 'integrations' : 'mcp'}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'code' && (
            <KoreWorkspace
              user={user}
              projects={projects}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'work' && (
            <WorkAgentsView
              user={user}
              projects={projects}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'skills' && (
            <SkillsView
              user={user}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'research' && (
            <ResearchView
              user={user}
              projects={projects}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'creative' && (
            <CreativeStudioView
              user={user}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}

          {activeView === 'usage' && (
            <SubscriptionsUsageView
              user={user}
              onOpenAuth={() => setAuthModalOpen(true)}
              onPlanChanged={bootstrap}
            />
          )}

          {activeView === 'settings' && (
            <SettingsView
              user={user}
              language={language}
              theme={theme}
              accentColor={accentColor}
              fontSize={fontSize}
              density={density}
              soundEnabled={soundEnabled}
              reducedMotion={reducedMotion}
              models={models}
              onChangeLanguage={(next) => {
                setLanguage(next);
                updatePref({ language: next });
              }}
              onChangeTheme={(next) => {
                setTheme(next);
                updatePref({ theme: next });
              }}
              onChangeAccentColor={(next) => {
                setAccentColor(next);
                updatePref({ accentColor: next });
              }}
              onChangeFontSize={(next) => {
                setFontSize(next);
                updatePref({ fontSize: next });
              }}
              onChangeDensity={(next) => {
                setDensity(next);
                updatePref({ density: next });
              }}
              onChangeSound={(next) => {
                setSoundEnabled(next);
                localStorage.setItem('loody_sound', next ? '1' : '0');
                updatePref({ soundEnabled: next });
              }}
              onChangeReducedMotion={(next) => {
                setReducedMotion(next);
                localStorage.setItem('loody_reduced_motion', next ? '1' : '0');
                updatePref({ reducedMotion: next });
              }}
              onReplaySplash={() => {
                setIsReplaySplash(true);
                setShowSplash(true);
              }}
              onOpenUsage={() => setActiveView('usage')}
              onUserUpdated={(nextUser) => {
                setUser(nextUser);
                if (!nextUser) {
                  setProjects([]);
                  setConversations([]);
                  setActiveConvId(null);
                  setUsage({ dailyUsed: 0, monthlyUsed: 0 });
                }
              }}
              onOpenAuth={() => setAuthModalOpen(true)}
            />
          )}
        </main>

        {/* Mobile Bottom Tab Bar */}
        <nav
          aria-label="Mobile bottom navigation"
          className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-[60px] border-t border-zinc-200 dark:border-emerald-500/15 bg-white/95 dark:bg-[#070A08]/95 backdrop-blur-md grid grid-cols-5 items-center pb-safe"
        >
          {[
            { id: 'chat', label: t(language, 'navChat'), icon: MessageSquare },
            { id: 'models', label: t(language, 'navModels'), icon: Cpu },
            { id: 'projects', label: t(language, 'navProjects'), icon: FolderKanban },
            { id: 'tools', label: t(language, 'navTools'), icon: Wrench },
            { id: 'settings', label: t(language, 'navSettings'), icon: Settings },
          ].map((item) => {
            const Icon = item.icon;
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveView(item.id as WorkspaceViewId)}
                className={`flex flex-col items-center justify-center h-full min-h-[44px] text-[10px] font-medium transition-colors cursor-pointer ${
                  active ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="mt-0.5 truncate max-w-[68px]">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <AuthModal
        open={authModalOpen}
        language={language}
        onClose={() => setAuthModalOpen(false)}
        onAuthenticated={(authedUser, authedUsage) => {
          setUser(authedUser);
          setUsage(authedUsage);
          applyUserPreferences(authedUser);
          loadProjects(true);
          loadConversations(true);
        }}
      />

      <OfflineBanner />
    </div>
  );
}
