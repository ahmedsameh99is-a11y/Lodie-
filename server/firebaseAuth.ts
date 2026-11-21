import fs from 'node:fs';
import path from 'node:path';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface VerifiedFirebaseIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  authProvider: string;
}

let cachedProjectId: string | null | undefined;

function resolveFirebaseProjectId(): string | null {
  if (cachedProjectId !== undefined) return cachedProjectId;
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) {
    cachedProjectId = null;
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { projectId?: string };
    const pid = raw.projectId?.trim();
    if (!pid || pid === 'remixed-project-id') {
      cachedProjectId = null;
      return null;
    }
    cachedProjectId = pid;
    return pid;
  } catch {
    cachedProjectId = null;
    return null;
  }
}

function getFirebaseAdminAuth() {
  const projectId = resolveFirebaseProjectId();
  if (!projectId) return null;
  const app = getApps().length ? getApp() : initializeApp({ projectId });
  return getAuth(app);
}

export function isFirebaseConfigured(): boolean {
  return Boolean(resolveFirebaseProjectId());
}

export async function verifyFirebaseToken(idToken: string): Promise<VerifiedFirebaseIdentity | null> {
  const adminAuth = getFirebaseAdminAuth();
  if (!adminAuth) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    const email = (decoded.email ?? '').trim().toLowerCase();
    if (!email) return null;
    const provider = decoded.firebase?.sign_in_provider ?? 'firebase';
    return {
      uid: decoded.uid,
      email,
      emailVerified: Boolean(decoded.email_verified),
      displayName: (decoded.name ?? email.split('@')[0] ?? 'LOODY User').slice(0, 60),
      authProvider: provider,
    };
  } catch {
    return null;
  }
}
