import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_PLAN_LIMITS } from '../src/shared/quotas';
import type { PublicUser } from '../src/shared/types';
import { db, mapRowToPublicUser, recordAuditLog } from './db';
import { verifyFirebaseToken, type VerifiedFirebaseIdentity } from './firebaseAuth';
import { isDeveloperAllowlisted, parseCookies, SESSION_COOKIE_NAME, verifySessionCookie } from './security';

export interface AuthenticatedRequest extends Request {
  authUser?: PublicUser;
}

export function upsertUserFromFirebaseIdentity(identity: VerifiedFirebaseIdentity): PublicUser {
  const existing = db.prepare('SELECT * FROM users WHERE firebase_uid = ? OR email = ?').get(
    identity.uid,
    identity.email
  ) as Record<string, unknown> | undefined;

  const isDev = isDeveloperAllowlisted(identity.email);
  const now = new Date().toISOString();

  if (existing) {
    const id = String(existing.id);
    const nextRole = isDev ? 'developer' : String(existing.role);
    const nextPlan = isDev ? 'developer' : String(existing.plan);
    const devLimits = DEFAULT_PLAN_LIMITS.developer;

    db.prepare(`
      UPDATE users
      SET firebase_uid = ?,
          auth_provider = ?,
          email_verified = ?,
          role = ?,
          plan = ?,
          daily_token_limit = CASE WHEN ? = 'developer' THEN ? ELSE daily_token_limit END,
          monthly_token_limit = CASE WHEN ? = 'developer' THEN ? ELSE monthly_token_limit END,
          updated_at = ?
      WHERE id = ?
    `).run(
      identity.uid,
      identity.authProvider,
      identity.emailVerified ? 1 : 0,
      nextRole,
      nextPlan,
      nextRole,
      devLimits.daily,
      nextRole,
      devLimits.monthly,
      now,
      id
    );

    const refreshed = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
    return mapRowToPublicUser(refreshed);
  }

  const id = crypto.randomUUID();
  const role = isDev ? 'developer' : 'user';
  const plan = isDev ? 'developer' : 'free';
  const limits = DEFAULT_PLAN_LIMITS[plan];

  db.prepare(`
    INSERT INTO users (
      id, email, password_hash, display_name, role, plan, language,
      theme, accent_color, font_size, density,
      sound_enabled, reduced_motion, splash_completed, default_model_id, allow_fallback,
      auth_provider, email_verified, firebase_uid,
      daily_token_limit, monthly_token_limit, created_at, updated_at
    ) VALUES (?, ?, '', ?, ?, ?, 'en', 'dark', 'emerald', 'md', 'comfortable', 1, 0, 0, 'sonic-3', 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    identity.email,
    identity.displayName,
    role,
    plan,
    identity.authProvider,
    identity.emailVerified ? 1 : 0,
    identity.uid,
    limits.daily,
    limits.monthly,
    now,
    now
  );

  recordAuditLog({
    actorUserId: id,
    actorEmail: identity.email,
    action: 'firebase_user_provisioned',
    targetType: 'user',
    targetId: id,
    outcome: 'success',
    detail: `Linked Firebase ${identity.authProvider} identity (${role}/${plan})`,
  });

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
  return mapRowToPublicUser(created);
}

export async function attachAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        const identity = await verifyFirebaseToken(token);
        if (identity) {
          req.authUser = upsertUserFromFirebaseIdentity(identity);
          next();
          return;
        }
      }
    }

    const cookies = parseCookies(req);
    const cookieToken = cookies[SESSION_COOKIE_NAME];
    const payload = verifySessionCookie(cookieToken);
    if (payload) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid) as
        | Record<string, unknown>
        | undefined;
      if (row) {
        req.authUser = mapRowToPublicUser(row);
      }
    }
  } catch {
    // Ignore malformed auth headers cleanly
  }
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required. Please sign in to continue.' });
    return;
  }
  next();
}

export function requireDeveloper(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (req.authUser.role !== 'developer' && req.authUser.role !== 'admin') {
    recordAuditLog({
      actorUserId: req.authUser.id,
      actorEmail: req.authUser.email,
      action: 'developer_route_access',
      targetType: 'admin_endpoint',
      targetId: req.originalUrl,
      outcome: 'denied',
      detail: `Rejected non-developer role (${req.authUser.role}) from ${req.originalUrl}`,
    });
    res.status(403).json({ error: 'Developer or administrator privileges required.' });
    return;
  }
  next();
}

export function getUserQuotaUsage(userId: string): {
  dailyUsed: number;
  monthlyUsed: number;
} {
  const now = new Date();
  const usageDate = now.toISOString().slice(0, 10);
  const usageMonth = now.toISOString().slice(0, 7);

  const dayRow = db
    .prepare(
      'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM token_usage WHERE user_id = ? AND usage_date = ?'
    )
    .get(userId, usageDate) as { total: number };

  const monthRow = db
    .prepare(
      'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM token_usage WHERE user_id = ? AND usage_month = ?'
    )
    .get(userId, usageMonth) as { total: number };

  return {
    dailyUsed: Number(dayRow?.total ?? 0),
    monthlyUsed: Number(monthRow?.total ?? 0),
  };
}
