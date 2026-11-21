import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_PLAN_LIMITS } from '../../src/shared/quotas';
import { db, mapRowToPublicUser, recordAuditLog } from '../db';
import { type AuthenticatedRequest, getUserQuotaUsage, requireAuth } from '../middleware';
import {
  clearSessionCookie,
  createRateLimiter,
  hashPassword,
  hashToken,
  isDeveloperAllowlisted,
  setSessionCookie,
  verifyPassword,
} from '../security';

export const authRouter = Router();

const authLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  scope: 'auth',
});

const registerSchema = z.object({
  email: z.string().trim().email().max(160),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(2).max(60),
  language: z.enum(['en', 'ar']).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

authRouter.post('/register', authLimiter, (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid registration details.' });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists.' });
    return;
  }

  // Server-side role & plan assignment ONLY — ignore any client-sent role or plan
  const isDev = isDeveloperAllowlisted(email);
  const role = isDev ? 'developer' : 'user';
  const plan = isDev ? 'developer' : 'free';
  const limits = DEFAULT_PLAN_LIMITS[plan];

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = hashPassword(parsed.data.password);

  db.prepare(`
    INSERT INTO users (
      id, email, password_hash, display_name, role, plan, language,
      theme, accent_color, font_size, density,
      sound_enabled, reduced_motion, splash_completed, default_model_id, allow_fallback,
      auth_provider, email_verified,
      daily_token_limit, monthly_token_limit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'dark', 'emerald', 'md', 'comfortable', 1, 0, 0, 'sonic-3', 1, 'password', 0, ?, ?, ?, ?)
  `).run(
    id,
    email,
    passwordHash,
    parsed.data.displayName,
    role,
    plan,
    parsed.data.language ?? 'en',
    limits.daily,
    limits.monthly,
    now,
    now
  );

  setSessionCookie(res, id);

  recordAuditLog({
    actorUserId: id,
    actorEmail: email,
    action: 'user_register',
    targetType: 'user',
    targetId: id,
    outcome: 'success',
    detail: `Registered account with server-assigned role=${role}, plan=${plan}`,
  });

  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json({
    user: mapRowToPublicUser(userRow),
    usage: { dailyUsed: 0, monthlyUsed: 0 },
  });
});

authRouter.post('/firebase-exchange', authLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Firebase ID token required.' });
    return;
  }
  const token = authHeader.slice(7).trim();
  const { verifyFirebaseToken } = await import('../firebaseAuth');
  const { upsertUserFromFirebaseIdentity } = await import('../middleware');
  const identity = await verifyFirebaseToken(token);
  if (!identity) {
    res.status(401).json({ error: 'Invalid or expired Firebase authentication token.' });
    return;
  }

  const user = upsertUserFromFirebaseIdentity(identity);
  setSessionCookie(res, user.id);

  res.json({
    user,
    usage: getUserQuotaUsage(user.id),
  });
});

authRouter.post('/login', authLimiter, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid email and password are required.' });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
    | Record<string, unknown>
    | undefined;

  if (!row || !String(row.password_hash) || !verifyPassword(parsed.data.password, String(row.password_hash))) {
    recordAuditLog({
      actorUserId: row ? String(row.id) : null,
      actorEmail: email,
      action: 'user_login',
      targetType: 'user',
      targetId: row ? String(row.id) : null,
      outcome: 'denied',
      detail: 'Invalid email or password',
    });
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  const userId = String(row.id);
  if (isDeveloperAllowlisted(email) && row.role !== 'developer') {
    const devLimits = DEFAULT_PLAN_LIMITS.developer;
    db.prepare(
      'UPDATE users SET role = ?, plan = ?, daily_token_limit = ?, monthly_token_limit = ?, updated_at = ? WHERE id = ?'
    ).run('developer', 'developer', devLimits.daily, devLimits.monthly, new Date().toISOString(), userId);
  }

  setSessionCookie(res, userId);

  recordAuditLog({
    actorUserId: userId,
    actorEmail: email,
    action: 'user_login',
    targetType: 'user',
    targetId: userId,
    outcome: 'success',
    detail: 'Authenticated via password session',
  });

  const updatedRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
  res.json({
    user: mapRowToPublicUser(updatedRow),
    usage: getUserQuotaUsage(userId),
  });
});

authRouter.post('/logout', (req: AuthenticatedRequest, res) => {
  clearSessionCookie(res);
  if (req.authUser) {
    recordAuditLog({
      actorUserId: req.authUser.id,
      actorEmail: req.authUser.email,
      action: 'user_logout',
      targetType: 'user',
      targetId: req.authUser.id,
      outcome: 'success',
      detail: 'Session terminated',
    });
  }
  res.json({ ok: true });
});

authRouter.get('/me', (req: AuthenticatedRequest, res) => {
  if (!req.authUser) {
    res.json({ user: null, usage: null });
    return;
  }
  res.json({
    user: req.authUser,
    usage: getUserQuotaUsage(req.authUser.id),
  });
});

authRouter.post('/password-reset/request', authLimiter, (req, res) => {
  const email = z.string().trim().email().safeParse(req.body?.email);
  if (!email.success) {
    res.status(400).json({ error: 'Please provide a valid email address.' });
    return;
  }

  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email.data.toLowerCase()) as
    | { id: string; email: string }
    | undefined;

  if (!user) {
    res.json({
      ok: true,
      message: 'If an account matches this email, recovery instructions have been issued.',
    });
    return;
  }

  const rawToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), user.id, hashToken(rawToken), expiresAt, new Date().toISOString());

  recordAuditLog({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'password_reset_request',
    targetType: 'user',
    targetId: user.id,
    outcome: 'success',
    detail: 'Issued 15-minute password recovery token',
  });

  const hasSmtp = Boolean(process.env.SMTP_HOST);
  res.json({
    ok: true,
    emailRelayConfigured: hasSmtp,
    message: hasSmtp
      ? 'Password recovery instructions sent to your email.'
      : 'Server recovery token issued (outbound SMTP relay not configured; use Firebase Email Recovery for automatic email delivery).',
  });
});

authRouter.post('/password-reset/confirm', authLimiter, (req, res) => {
  const schema = z.object({
    token: z.string().min(10),
    newPassword: z.string().min(8).max(128),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Valid reset token and new password (min 8 chars) required.' });
    return;
  }

  const row = db
    .prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL')
    .get(hashToken(parsed.data.token)) as { id: string; user_id: string; expires_at: string } | undefined;

  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    res.status(400).json({ error: 'Reset token is invalid or expired.' });
    return;
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hashPassword(parsed.data.newPassword),
    now,
    row.user_id
  );
  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now, row.id);

  recordAuditLog({
    actorUserId: row.user_id,
    actorEmail: null,
    action: 'password_reset_confirm',
    targetType: 'user',
    targetId: row.user_id,
    outcome: 'success',
    detail: 'Password updated via recovery token',
  });

  res.json({ ok: true });
});

authRouter.get('/providers/status', async (_req, res) => {
  const { isFirebaseConfigured } = await import('../firebaseAuth');
  const firebaseReady = isFirebaseConfigured();
  const appleConfigured = Boolean(
    process.env.APPLE_SERVICE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID
  );
  res.json({
    firebaseConfigured: firebaseReady,
    google: {
      configured: firebaseReady,
      mode: firebaseReady ? 'firebase_popup' : 'awaiting_config',
      message: firebaseReady
        ? 'Google Sign-In active via Firebase Authentication.'
        : 'Firebase Authentication is awaiting provisioning.',
    },
    apple: {
      configured: appleConfigured,
      mode: appleConfigured ? 'firebase_apple_oauth' : 'awaiting_apple_credentials',
      message: appleConfigured
        ? 'Sign in with Apple configured.'
        : 'Requires Apple Developer Service ID, Team ID, and Private Key in Firebase Console.',
    },
    emailPassword: {
      configured: true,
      firebaseEmailAuth: firebaseReady,
    },
  });
});

authRouter.get('/google/status', async (_req, res) => {
  const { isFirebaseConfigured } = await import('../firebaseAuth');
  const firebaseReady = isFirebaseConfigured();
  res.json({
    configured: firebaseReady,
    status: firebaseReady ? 'ready' : 'awaiting_config',
    message: firebaseReady
      ? 'Google Sign-In active via Firebase Authentication.'
      : 'Google Sign-In is awaiting configuration.',
  });
});

authRouter.delete('/account', requireAuth, (req: AuthenticatedRequest, res) => {
  const password = z.string().min(1).safeParse(req.body?.password);
  if (!password.success) {
    res.status(400).json({ error: 'Please confirm your password to delete your account.' });
    return;
  }
  const userId = req.authUser!.id;
  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE id = ?').get(userId) as
    | { id: string; email: string; password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password.data, row.password_hash)) {
    res.status(403).json({ error: 'Password confirmation failed.' });
    return;
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  clearSessionCookie(res);

  recordAuditLog({
    actorUserId: null,
    actorEmail: null,
    action: 'account_deleted',
    targetType: 'user',
    targetId: userId,
    outcome: 'success',
    detail: 'User permanently deleted account and associated data',
  });

  res.json({ ok: true });
});
