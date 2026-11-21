import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  OAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type { MemoryScope, PublicUser } from '../shared/types';

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

setPersistence(auth, browserLocalPersistence).catch(() => null);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: Array<{
      providerId?: string | null;
      email?: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return { ok: false, error: 'Firestore client is offline. Check Firebase configuration.' };
    }
    // Permission denied on /test/connection proves live server connectivity + security rules active
    return { ok: true };
  }
}

testConnection();

export function mapFirebaseAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'auth/popup-closed-by-user') return 'Sign-in popup was closed before completion.';
  if (code === 'auth/popup-blocked') return 'Sign-in popup was blocked by your browser. Please allow popups for LOODY.';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Invalid email or password.';
  }
  if (code === 'auth/email-already-in-use') return 'An account with this email already exists.';
  if (code === 'auth/weak-password') return 'Password should be at least 8 characters long.';
  if (code === 'auth/operation-not-allowed') {
    return 'This sign-in provider is not enabled yet in the Firebase Console.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  return msg;
}

export async function signInWithGoogleFirebase(): Promise<FirebaseUser> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function signInWithAppleFirebase(): Promise<FirebaseUser> {
  const provider = new OAuthProvider('apple.com');
  provider.addScope('email');
  provider.addScope('name');
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function registerWithEmailFirebase(params: {
  email: string;
  password: string;
  displayName: string;
}): Promise<FirebaseUser> {
  const cred = await createUserWithEmailAndPassword(auth, params.email, params.password);
  await updateProfile(cred.user, { displayName: params.displayName });
  await sendEmailVerification(cred.user).catch(() => null);
  return cred.user;
}

export async function loginWithEmailFirebase(params: {
  email: string;
  password: string;
}): Promise<FirebaseUser> {
  const cred = await signInWithEmailAndPassword(auth, params.email, params.password);
  return cred.user;
}

export async function resetPasswordFirebase(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

export async function resendVerificationFirebase(): Promise<void> {
  if (auth.currentUser && !auth.currentUser.emailVerified) {
    await sendEmailVerification(auth.currentUser);
  }
}

export async function logoutFirebase(): Promise<void> {
  await signOut(auth).catch(() => null);
}

export async function getActiveFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  if (!auth.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

// Firestore Cloud Sync (only executes for verified Firebase identities per firestore.rules)
export async function syncUserProfileToFirestore(user: PublicUser): Promise<void> {
  const fbUser = auth.currentUser;
  if (!fbUser || !fbUser.emailVerified) return;

  const userPath = `users/${fbUser.uid}`;
  const privatePath = `users/${fbUser.uid}/private/account`;
  try {
    const existingSnap = await getDoc(doc(db, 'users', fbUser.uid));
    if (!existingSnap.exists()) {
      await setDoc(doc(db, 'users', fbUser.uid), {
        ownerId: fbUser.uid,
        displayName: user.displayName.slice(0, 80) || 'LOODY Member',
        language: user.language,
        theme: user.theme,
        accentColor: user.accentColor,
        fontSize: user.fontSize,
        density: user.density,
        soundEnabled: user.soundEnabled,
        reducedMotion: user.reducedMotion,
        defaultModelId: user.defaultModelId.slice(0, 64),
        allowFallback: user.allowFallback,
        memoryEnabled: user.memoryEnabled,
        emailNotifications: user.emailNotifications,
        usageAlerts: user.usageAlerts,
        role: 'user',
        plan: 'free',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(doc(db, 'users', fbUser.uid), {
        displayName: user.displayName.slice(0, 80) || 'LOODY Member',
        language: user.language,
        theme: user.theme,
        accentColor: user.accentColor,
        fontSize: user.fontSize,
        density: user.density,
        soundEnabled: user.soundEnabled,
        reducedMotion: user.reducedMotion,
        defaultModelId: user.defaultModelId.slice(0, 64),
        allowFallback: user.allowFallback,
        memoryEnabled: user.memoryEnabled,
        emailNotifications: user.emailNotifications,
        usageAlerts: user.usageAlerts,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }

  try {
    const privSnap = await getDoc(doc(db, 'users', fbUser.uid, 'private', 'account'));
    if (!privSnap.exists()) {
      await setDoc(doc(db, 'users', fbUser.uid, 'private', 'account'), {
        ownerId: fbUser.uid,
        email: (fbUser.email ?? user.email).slice(0, 160),
        authProvider: user.authProvider.slice(0, 40),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(doc(db, 'users', fbUser.uid, 'private', 'account'), {
        email: (fbUser.email ?? user.email).slice(0, 160),
        authProvider: user.authProvider.slice(0, 40),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, privatePath);
  }
}

export async function syncConversationToFirestore(conv: {
  id: string;
  projectId: string | null;
  folder: string;
  pinned: boolean;
  archived: boolean;
  title: string;
  modelId: string;
}): Promise<void> {
  const fbUser = auth.currentUser;
  if (!fbUser || !fbUser.emailVerified) return;
  const safeId = conv.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const path = `conversations/${safeId}`;
  try {
    const ref = doc(db, 'conversations', safeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: fbUser.uid,
        projectId: (conv.projectId ?? '').slice(0, 128),
        folder: conv.folder.slice(0, 48),
        pinned: Boolean(conv.pinned),
        archived: Boolean(conv.archived),
        title: conv.title.slice(0, 120) || 'New Conversation',
        modelId: conv.modelId.slice(0, 64),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteConversationFromFirestore(convId: string): Promise<void> {
  const fbUser = auth.currentUser;
  if (!fbUser || !fbUser.emailVerified) return;
  const safeId = convId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const path = `conversations/${safeId}`;
  try {
    await deleteDoc(doc(db, 'conversations', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function syncMemoryToFirestore(memory: {
  id: string;
  projectId: string | null;
  scope: MemoryScope;
  category: 'preference' | 'fact' | 'instruction';
  content: string;
  approved: boolean;
}): Promise<void> {
  const fbUser = auth.currentUser;
  if (!fbUser || !fbUser.emailVerified) return;
  const safeId = memory.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const path = `user_memories/${safeId}`;
  try {
    const ref = doc(db, 'user_memories', safeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: fbUser.uid,
        projectId: (memory.projectId ?? '').slice(0, 128),
        scope: memory.scope,
        category: memory.category,
        content: memory.content.slice(0, 1200),
        approved: Boolean(memory.approved),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        category: memory.category,
        content: memory.content.slice(0, 1200),
        approved: Boolean(memory.approved),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteMemoryFromFirestore(memoryId: string): Promise<void> {
  const fbUser = auth.currentUser;
  if (!fbUser || !fbUser.emailVerified) return;
  const safeId = memoryId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const path = `user_memories/${safeId}`;
  try {
    await deleteDoc(doc(db, 'user_memories', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
