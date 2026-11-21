import React, { useEffect, useState } from 'react';
import {
  Globe,
  Volume2,
  Sparkles,
  Shield,
  Trash2,
  LogOut,
  Terminal,
  Play,
  CreditCard,
  Sun,
  Moon,
  Monitor,
  Download,
  Upload,
  MailCheck,
  AlertCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { auth, logoutFirebase, resendVerificationFirebase } from '../lib/firebase';
import { triggerBrowserDownload } from '../shared/chatExport';
import { t } from '../shared/i18n';
import type { LoodyLogoVariant } from '../shared/logoGeometry';
import type {
  AccentColor,
  AppLanguage,
  AppTheme,
  AuditLogEntry,
  BrandedModel,
  DensityPref,
  FeatureFlag,
  FontSizePref,
  PublicUser,
} from '../shared/types';
import { LoodyLogo } from './LoodyLogo';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsViewProps {
  user: PublicUser | null;
  language: AppLanguage;
  theme: AppTheme;
  accentColor: AccentColor;
  fontSize: FontSizePref;
  density: DensityPref;
  soundEnabled: boolean;
  reducedMotion: boolean;
  models: BrandedModel[];
  onChangeLanguage: (lang: AppLanguage) => void;
  onChangeTheme: (theme: AppTheme) => void;
  onChangeAccentColor: (accent: AccentColor) => void;
  onChangeFontSize: (fontSize: FontSizePref) => void;
  onChangeDensity: (density: DensityPref) => void;
  onChangeSound: (enabled: boolean) => void;
  onChangeReducedMotion: (enabled: boolean) => void;
  onReplaySplash: () => void;
  onOpenUsage: () => void;
  onUserUpdated: (user: PublicUser | null) => void;
  onOpenAuth: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  user,
  language,
  theme,
  accentColor,
  fontSize,
  density,
  soundEnabled,
  reducedMotion,
  models,
  onChangeLanguage,
  onChangeTheme,
  onChangeAccentColor,
  onChangeFontSize,
  onChangeDensity,
  onChangeSound,
  onChangeReducedMotion,
  onReplaySplash,
  onOpenUsage,
  onUserUpdated,
  onOpenAuth,
}) => {
  const [deletePassword, setDeletePassword] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const [adminOverview, setAdminOverview] = useState<{
    users: Array<{
      id: string;
      email: string;
      display_name: string;
      role: string;
      plan: string;
      daily_token_limit: number;
    }>;
    usageStats: { requests: number; totalTokens: number; totalCostUsd: number };
    flags: FeatureFlag[];
    auditLogs: AuditLogEntry[];
  } | null>(null);

  const isDeveloper = user?.role === 'developer' || user?.role === 'admin';
  const firebaseUser = auth.currentUser;
  const needsEmailVerification = Boolean(firebaseUser && !firebaseUser.emailVerified);

  useEffect(() => {
    if (!isDeveloper) {
      setAdminOverview(null);
      return;
    }
    api.getAdminOverview().then(setAdminOverview).catch(() => null);
  }, [isDeveloper, user?.id]);

  const handleDefaultModelChange = async (modelId: string) => {
    if (!user) return;
    const res = await api.updatePreferences({ defaultModelId: modelId });
    onUserUpdated(res.user);
    setStatusMsg(`Default model updated to ${modelId}.`);
  };

  const handleToggleFallback = async () => {
    if (!user) return;
    const res = await api.updatePreferences({ allowFallback: !user.allowFallback });
    onUserUpdated(res.user);
    setStatusMsg(`Automatic model fallback ${res.user.allowFallback ? 'enabled' : 'disabled'}.`);
  };

  const handleExportAllData = async () => {
    if (!user) return;
    setExporting(true);
    try {
      const data = await api.exportAllUserData();
      triggerBrowserDownload(
        `loody-workspace-export-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(data, null, 2),
        'application/json;charset=utf-8'
      );
      setStatusMsg('Exported full workspace JSON archive.');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const handleRestoreBackup = async (file: File) => {
    if (!user) return;
    setRestoring(true);
    setStatusMsg(null);
    try {
      const archive = JSON.parse(await file.text()) as Record<string, unknown>;
      const res = await api.restoreUserData(archive);
      const summaryParts = Object.entries(res.restored)
        .filter(([, count]) => count > 0)
        .map(([key, count]) => `${count} ${key}`);
      setStatusMsg(
        summaryParts.length > 0
          ? `Backup restored cleanly: ${summaryParts.join(', ')}.`
          : 'Backup verified — all archived items already exist in your workspace.'
      );
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Backup restore failed.');
    } finally {
      setRestoring(false);
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.deleteAccount(deletePassword);
      await logoutFirebase();
      onUserUpdated(null);
      setShowDeleteConfirm(false);
      setDeletePassword('');
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Account deletion failed.');
    }
  };

  const logoVariants: Array<{ variant: LoodyLogoVariant; title: string }> = [
    { variant: 'primary-3d', title: '1. Primary 3D' },
    { variant: 'flat-2d', title: '2. Flat 2D' },
    { variant: 'transparent-3d', title: '3. Transparent 3D' },
    { variant: 'android-icon', title: '4. Android App Icon' },
    { variant: 'splash-3d', title: '5. Splash Emblem' },
    { variant: 'monochrome', title: '6. Monochrome' },
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">{t(language, 'navSettings')}</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{t(language, 'settingsSubtitle')}</p>
        </div>
        <PWAInstallButton label={t(language, 'installApp')} />
      </div>

      {statusMsg && (
        <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs text-emerald-800 dark:text-emerald-200">
          {statusMsg}
        </div>
      )}

      {needsEmailVerification && (
        <div role="alert" className="rounded-2xl border border-amber-500/40 bg-amber-50 dark:bg-amber-950/25 p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-start gap-2.5 text-amber-900 dark:text-amber-200">
            <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Verify your email address</div>
              <p className="mt-0.5 opacity-90">
                Verify {firebaseUser?.email} to enable cloud Firestore sync across devices.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={async () => {
              await resendVerificationFirebase();
              setStatusMsg('Verification email sent. Check your inbox and reload after verifying.');
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 py-2 font-semibold text-white hover:bg-amber-500 cursor-pointer"
          >
            <MailCheck className="w-3.5 h-3.5" />
            <span>Resend Verification</span>
          </button>
        </div>
      )}

      {/* Account Summary */}
      <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        {user ? (
          <>
            <div>
              <div className="font-display text-base font-bold text-zinc-900 dark:text-white">{user.displayName}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {user.email} · Plan: {user.plan} · Role: {user.role} · Provider: {user.authProvider}
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                await api.logout();
                await logoutFirebase();
                onUserUpdated(null);
              }}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/5 min-h-[44px] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>{t(language, 'signOut')}</span>
            </button>
          </>
        ) : (
          <>
            <div>
              <div className="font-display text-base font-bold text-zinc-900 dark:text-white">Guest Session</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                Sign in with Google or Email to sync preferences, projects, files, and chat history.
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenAuth}
              className="rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 min-h-[44px] whitespace-nowrap shrink-0 cursor-pointer"
            >
              {t(language, 'signIn')}
            </button>
          </>
        )}
      </section>

      {/* Plans & Usage Quick Link */}
      <section className="rounded-2xl border border-emerald-500/20 bg-white dark:bg-[#0D110F] p-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <CreditCard className="w-5 h-5 text-emerald-500 shrink-0" />
          <div>
            <div className="text-sm font-semibold text-zinc-900 dark:text-white">{t(language, 'plansShortcutTitle')}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, 'plansShortcutDesc')}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenUsage}
          className="rounded-xl border border-emerald-500/35 px-4 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer"
        >
          {t(language, 'openPlans')}
        </button>
      </section>

      {/* Appearance & Experience Controls */}
      <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] divide-y divide-zinc-100 dark:divide-white/5">
        {/* Theme Switcher */}
        <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-zinc-900 dark:text-white">{t(language, 'themeLabel')}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, 'themeDesc')}</div>
          </div>
          <div className="flex gap-2">
            {[
              { id: 'dark', label: 'Dark', icon: Moon },
              { id: 'light', label: 'Light', icon: Sun },
              { id: 'system', label: 'System', icon: Monitor },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onChangeTheme(item.id as AppTheme)}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap cursor-pointer ${
                    theme === item.id
                      ? 'bg-emerald-600 text-white'
                      : 'border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Accent Color, Font Size & Density */}
        <div className="p-5 grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="accent-select" className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
              Accent Palette
            </label>
            <select
              id="accent-select"
              value={accentColor}
              onChange={(e) => onChangeAccentColor(e.target.value as AccentColor)}
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
            >
              <option value="emerald">Emerald Core</option>
              <option value="teal">Deep Teal</option>
              <option value="mint">Electric Mint</option>
              <option value="slate">Obsidian Slate</option>
            </select>
          </div>
          <div>
            <label htmlFor="fontsize-select" className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
              Typography Scale
            </label>
            <select
              id="fontsize-select"
              value={fontSize}
              onChange={(e) => onChangeFontSize(e.target.value as FontSizePref)}
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
            >
              <option value="sm">Compact (14px)</option>
              <option value="md">Standard (16px)</option>
              <option value="lg">Comfortable (17.5px)</option>
            </select>
          </div>
          <div>
            <label htmlFor="density-select" className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
              Layout Density
            </label>
            <select
              id="density-select"
              value={density}
              onChange={(e) => onChangeDensity(e.target.value as DensityPref)}
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
            >
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
        </div>

        {/* Language RTL/LTR */}
        <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Globe className="w-5 h-5 text-emerald-500 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-white">{t(language, 'languageLabel')}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, 'languageDesc')}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onChangeLanguage('en')}
              className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
                language === 'en' ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300'
              }`}
            >
              English (LTR)
            </button>
            <button
              type="button"
              onClick={() => onChangeLanguage('ar')}
              className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
                language === 'ar' ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300'
              }`}
            >
              العربية (RTL)
            </button>
          </div>
        </div>

        {/* Sound Toggle */}
        <div className="p-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Volume2 className="w-5 h-5 text-emerald-500 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-white">{t(language, 'soundLabel')}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, 'soundDesc')}</div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={soundEnabled}
            onClick={() => onChangeSound(!soundEnabled)}
            className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
              soundEnabled ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400'
            }`}
          >
            {soundEnabled ? t(language, 'enabledLabel') : t(language, 'mutedLabel')}
          </button>
        </div>

        {/* Reduced Motion */}
        <div className="p-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Sparkles className="w-5 h-5 text-emerald-500 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-white">{t(language, 'reducedMotionLabel')}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, 'reducedMotionDesc')}</div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={reducedMotion}
            onClick={() => onChangeReducedMotion(!reducedMotion)}
            className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
              reducedMotion ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-500 dark:text-zinc-400'
            }`}
          >
            {reducedMotion ? t(language, 'reducedLabel') : t(language, 'standardLabel')}
          </button>
        </div>

        {/* Replay Splash */}
        <div className="p-5 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-zinc-900 dark:text-white">{t(language, 'replaySplash')}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{t(language, 'replayDesc')}</div>
          </div>
          <button
            type="button"
            onClick={onReplaySplash}
            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/35 px-4 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{t(language, 'replaySplash')}</span>
          </button>
        </div>

        {/* Default Model & Automatic Fallback */}
        {user && (
          <>
            <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <label htmlFor="default-model-select" className="text-sm font-semibold text-zinc-900 dark:text-white block">
                  Default Workspace Model
                </label>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">Preferred model selected when opening new sessions</div>
              </div>
              <select
                id="default-model-select"
                value={user.defaultModelId}
                onChange={(e) => handleDefaultModelChange(e.target.value)}
                className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-xs text-zinc-900 dark:text-white min-h-[40px]"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.provider})
                  </option>
                ))}
              </select>
            </div>

            <div className="p-5 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-white">Automatic Model Fallback</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Route cleanly to an operational backup model if your primary upstream provider experiences transient outages
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={user.allowFallback}
                onClick={handleToggleFallback}
                className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
                  user.allowFallback ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-500'
                }`}
              >
                {user.allowFallback ? t(language, 'enabledLabel') : 'Off'}
              </button>
            </div>

            <div className="p-5 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-white">Workspace Memory & RAG Context</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Inject approved global/project memories & relevant knowledge citations into new prompts
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={user.memoryEnabled}
                onClick={async () => {
                  const res = await api.updatePreferences({ memoryEnabled: !user.memoryEnabled });
                  onUserUpdated(res.user);
                  setStatusMsg(`Workspace Memory ${res.user.memoryEnabled ? 'enabled' : 'disabled'}.`);
                }}
                className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
                  user.memoryEnabled ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-500'
                }`}
              >
                {user.memoryEnabled ? t(language, 'enabledLabel') : 'Off'}
              </button>
            </div>

            <div className="p-5 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-white">Streaming Responses</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Stream generated tokens incrementally over Server-Sent Events (SSE)
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={user.chatStreaming}
                onClick={async () => {
                  const res = await api.updatePreferences({ chatStreaming: !user.chatStreaming });
                  onUserUpdated(res.user);
                  setStatusMsg(`Streaming mode updated.`);
                }}
                className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
                  user.chatStreaming ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-500'
                }`}
              >
                {user.chatStreaming ? t(language, 'enabledLabel') : 'Off'}
              </button>
            </div>

            <div className="p-5 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-white">Usage Quota Alerts</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Warn inside workspace views when approaching daily or monthly token thresholds
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={user.usageAlerts}
                onClick={async () => {
                  const res = await api.updatePreferences({ usageAlerts: !user.usageAlerts });
                  onUserUpdated(res.user);
                  setStatusMsg(`Usage alerts ${res.user.usageAlerts ? 'enabled' : 'disabled'}.`);
                }}
                className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
                  user.usageAlerts ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-500'
                }`}
              >
                {user.usageAlerts ? t(language, 'enabledLabel') : 'Off'}
              </button>
            </div>

            <div className="p-5 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-white">Email Notifications</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Receive security notices and workspace account alerts when email delivery is active
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={user.emailNotifications}
                onClick={async () => {
                  const res = await api.updatePreferences({ emailNotifications: !user.emailNotifications });
                  onUserUpdated(res.user);
                  setStatusMsg(`Email notification preference saved.`);
                }}
                className={`rounded-xl px-4 py-2 text-xs font-medium min-h-[40px] whitespace-nowrap shrink-0 cursor-pointer ${
                  user.emailNotifications ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-500'
                }`}
              >
                {user.emailNotifications ? t(language, 'enabledLabel') : 'Off'}
              </button>
            </div>
          </>
        )}
      </section>

      {/* Official Concept A 6-Variant Logo Kit */}
      <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
        <div>
          <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Official LOODY Identity — Concept A</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            All 6 brand assets share identical geometric coordinates without redesign across surfaces.
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {logoVariants.map((item) => (
            <div
              key={item.variant}
              className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 flex flex-col items-center gap-2 text-center"
            >
              <LoodyLogo variant={item.variant} size={52} />
              <span className="text-[11px] text-zinc-700 dark:text-zinc-300">{item.title}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Developer Console */}
      {isDeveloper && adminOverview && (
        <section className="rounded-2xl border border-emerald-500/35 bg-emerald-50/40 dark:bg-[#09120E] p-5 space-y-5">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-emerald-500" />
            <div>
              <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Developer Administration Console</h3>
              <p className="text-xs text-emerald-700 dark:text-emerald-300/80">
                Server-verified developer privileges · Total requests: {adminOverview.usageStats.requests} · Total tokens: {adminOverview.usageStats.totalTokens.toLocaleString()}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Feature Flags</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {adminOverview.flags.map((f) => (
                <div key={f.key} className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#050706] p-3 text-xs">
                  <div>
                    <div className="font-medium text-zinc-900 dark:text-white">{f.label}</div>
                    <div className="text-[11px] text-zinc-500 font-mono">{f.key} · {f.stage}</div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await api.updateAdminFlag(f.key, !f.enabled);
                      setAdminOverview((prev) => (prev ? { ...prev, flags: res.flags } : prev));
                    }}
                    className={`rounded-lg px-2.5 py-1.5 font-medium cursor-pointer ${
                      f.enabled ? 'bg-emerald-600 text-white' : 'border border-zinc-200 dark:border-white/10 text-zinc-500'
                    }`}
                  >
                    {f.enabled ? 'On' : 'Off'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Privacy, Export & Account Deletion */}
      <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
        <div className="flex items-start gap-3">
          <Shield className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">
              Privacy, Data Controls & Provider Disclosures
            </h3>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              LOODY is an independent AI workspace platform that routes requests server-side to configured third-party foundation model providers without exposing provider credentials in client bundles. All conversations, projects, files, and MCP tool executions are isolated per authenticated account.
            </p>
          </div>
        </div>

        {user && (
          <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 dark:border-white/5 pt-4">
            <button
              type="button"
              disabled={exporting}
              onClick={handleExportAllData}
              className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/35 px-4 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 min-h-[40px] cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{exporting ? 'Preparing Archive...' : 'Export Workspace Data (JSON)'}</span>
            </button>

            <label className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/35 px-4 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 min-h-[40px] cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              <span>{restoring ? 'Restoring Backup...' : 'Restore Backup (JSON)'}</span>
              <input
                type="file"
                accept=".json,application/json"
                disabled={restoring}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) handleRestoreBackup(f);
                }}
              />
            </label>

            {!showDeleteConfirm ? (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2 text-xs font-medium text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 min-h-[40px] cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{t(language, 'deleteAccount')}</span>
              </button>
            ) : (
              <form onSubmit={handleDeleteAccount} className="w-full space-y-3 max-w-sm pt-2">
                <label htmlFor="delete-acct-pw" className="block text-xs text-red-600 dark:text-red-300">
                  Confirm your password to permanently erase your account and all conversations:
                </label>
                <input
                  id="delete-acct-pw"
                  type="password"
                  required
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  className="w-full rounded-xl border border-red-500/40 bg-zinc-50 dark:bg-[#050706] px-3 py-2 text-sm text-zinc-900 dark:text-white min-h-[40px]"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 cursor-pointer"
                  >
                    Permanently Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="rounded-xl border border-zinc-200 dark:border-white/10 px-4 py-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
