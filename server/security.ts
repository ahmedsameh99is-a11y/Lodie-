import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadOrCreateSecret(envVar: string, filename: string): Buffer {
  const envVal = process.env[envVar]?.trim();
  if (envVal && envVal.length >= 16) {
    return crypto.createHash('sha256').update(envVal).digest();
  }
  const secretPath = path.join(DATA_DIR, filename);
  if (fs.existsSync(secretPath)) {
    const hex = fs.readFileSync(secretPath, 'utf8').trim();
    if (hex.length === 64) {
      return Buffer.from(hex, 'hex');
    }
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(secretPath, generated.toString('hex'), { mode: 0o600 });
  return generated;
}

const SESSION_KEY = loadOrCreateSecret('SESSION_SECRET', '.session_secret');
const ENCRYPTION_KEY = loadOrCreateSecret('CREDENTIAL_ENCRYPTION_KEY', '.enc_key');

export const SESSION_COOKIE_NAME = 'loody_session';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface SessionPayload {
  uid: string;
  exp: number;
}

export function signSessionCookie(userId: string, ttlSeconds = 60 * 60 * 24 * 7): string {
  const payload: SessionPayload = {
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySessionCookie(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', SESSION_KEY).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.uid || typeof parsed.exp !== 'number') return null;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    ENCRYPTION_KEY,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const key = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export function setSessionCookie(res: Response, userId: string): void {
  const token = signSessionCookie(userId);
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

export function isDeveloperAllowlisted(email: string): boolean {
  const raw = process.env.DEVELOPER_ALLOWLIST_EMAILS ?? '';
  const allowlist = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(email.trim().toLowerCase());
}

export function isPrivateOrReservedIp(ipRaw: string): boolean {
  const cleaned = ipRaw.trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const mappedV4Match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(cleaned);
  const ip = mappedV4Match ? mappedV4Match[1] : cleaned;

  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (ipVersion === 6) {
    if (ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
    if (ip.startsWith('fe80:') || ip.startsWith('fec0:') || ip.startsWith('ff')) return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
    return false;
  }

  return false;
}

export function validateExternalHttpUrl(urlStr: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, reason: 'Only http:// and https:// endpoints are permitted.' };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, reason: 'Embedded credentials in URLs are blocked for security.' };
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) {
      return { valid: false, reason: 'Invalid URL hostname.' };
    }
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.localdomain') ||
      host === 'metadata.google.internal' ||
      host === '0.0.0.0'
    ) {
      return { valid: false, reason: 'Blocked localhost, private network, or metadata endpoint.' };
    }
    if (net.isIP(host) !== 0 && isPrivateOrReservedIp(host)) {
      return { valid: false, reason: 'Blocked private or reserved IP address target.' };
    }
    if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
      return { valid: false, reason: 'Blocked numeric/hex encoded host literal.' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid URL syntax.' };
  }
}

export async function assertSafeExternalUrl(urlStr: string): Promise<{ ok: boolean; reason?: string }> {
  const staticCheck = validateExternalHttpUrl(urlStr);
  if (!staticCheck.valid) {
    return { ok: false, reason: staticCheck.reason };
  }
  const parsed = new URL(urlStr);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) {
    return isPrivateOrReservedIp(host)
      ? { ok: false, reason: 'Blocked private or reserved IP address target.' }
      : { ok: true };
  }
  try {
    const records = await dns.lookup(host, { all: true });
    if (!records || records.length === 0) {
      return { ok: false, reason: 'Unable to resolve remote host.' };
    }
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return { ok: false, reason: `Host ${host} resolved to a blocked private/internal IP address.` };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `DNS resolution failed cleanly for host "${host}".` };
  }
}

export const DISALLOWED_EXECUTABLE_EXT = /\.(exe|dll|bat|cmd|msi|scr|com|vbs|pif|cpl|jar|apk|dmg|sh|ps1|elf|bin)$/i;

export function detectDisallowedExecutableMagic(buffer: Buffer): { blocked: boolean; reason?: string } {
  if (!buffer || buffer.length < 2) return { blocked: false };
  // MZ / Windows PE-DOS executable
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return { blocked: true, reason: 'Windows PE/MZ executable binary detected via file signature.' };
  }
  // ELF executable
  if (buffer.length >= 4 && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
    return { blocked: true, reason: 'Linux ELF executable binary detected via file signature.' };
  }
  // Mach-O 32/64/Fat or Java class (0xcafebabe)
  if (buffer.length >= 4) {
    const magicBE = buffer.readUInt32BE(0);
    if (
      magicBE === 0xfeedface ||
      magicBE === 0xcefaedfe ||
      magicBE === 0xfeedfacf ||
      magicBE === 0xcffaedfe ||
      magicBE === 0xcafebabe
    ) {
      return { blocked: true, reason: 'Compiled Mach-O/Java binary executable detected via file signature.' };
    }
  }
  return { blocked: false };
}

export function inspectUploadedBinarySafety(params: {
  fileName: string;
  mimeType: string;
  buffer?: Buffer;
}): { safe: boolean; reason?: string } {
  if (DISALLOWED_EXECUTABLE_EXT.test(params.fileName)) {
    return { safe: false, reason: 'Executable file extensions are blocked by LOODY workspace security policy.' };
  }
  if (!params.buffer || params.buffer.length === 0) {
    return { safe: true };
  }
  const magic = detectDisallowedExecutableMagic(params.buffer);
  if (magic.blocked) {
    return { safe: false, reason: magic.reason };
  }
  const lower = params.fileName.toLowerCase();
  if ((lower.endsWith('.pdf') || params.mimeType === 'application/pdf') && params.buffer.length >= 5) {
    const head = params.buffer.subarray(0, 16).toString('latin1');
    if (!head.includes('%PDF-')) {
      return { safe: false, reason: 'Invalid PDF header signature (%PDF- expected).' };
    }
  }
  if ((lower.endsWith('.png') || params.mimeType === 'image/png') && params.buffer.length >= 4) {
    if (
      params.buffer[0] !== 0x89 ||
      params.buffer[1] !== 0x50 ||
      params.buffer[2] !== 0x4e ||
      params.buffer[3] !== 0x47
    ) {
      return { safe: false, reason: 'Invalid PNG magic-byte header.' };
    }
  }
  return { safe: true };
}

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  scope: string;
}) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const cutoff = now - options.windowMs;
    const identity = (req as Request & { authUser?: { id: string } }).authUser?.id ?? req.ip ?? 'anon';
    const key = `${options.scope}:${identity}`;
    const existing = (hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (existing.length >= options.maxRequests) {
      res.status(429).json({
        error: 'Rate limit exceeded. Please wait briefly before trying again.',
        retryAfterSeconds: Math.ceil(options.windowMs / 1000),
      });
      return;
    }
    existing.push(now);
    hits.set(key, existing);
    next();
  };
}
