const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i;

function stripControlAndLeadingSpace(raw: string): string {
  // Remove ASCII control characters (including tabs/newlines inside schemes like "java\tscript:")
  return raw.replace(/[\u0000-\u001F\u007F]+/g, '').trim();
}

/**
 * Validates URLs before rendering them in <a href> or <img src>.
 * Blocks javascript:, vbscript:, data:text/html, data:image/svg+xml, protocol-relative //, etc.
 */
export function toSafeHref(rawUrl: string | undefined | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const cleaned = stripControlAndLeadingSpace(rawUrl);
  if (!cleaned) return null;

  if (cleaned.startsWith('#')) {
    return cleaned;
  }
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) {
    return cleaned;
  }

  try {
    const parsed = new URL(cleaned);
    if (ALLOWED_LINK_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return cleaned;
    }
    return null;
  } catch {
    return null;
  }
}

export function toSafeMarkdownUrl(rawUrl: string, key?: string): string {
  const cleaned = stripControlAndLeadingSpace(rawUrl);
  if (!cleaned) return '';

  if (key === 'src' && SAFE_DATA_IMAGE_RE.test(cleaned)) {
    return cleaned;
  }

  return toSafeHref(cleaned) ?? '';
}
