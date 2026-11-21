# LOODY Security & Threat Model

## Authentication & Sessions
- Client identities authenticate via Firebase Authentication (Google Sign-In, Email/Password with email verification & recovery) or native email/password fallback.
- Passwords stored locally are hashed with Node `crypto.scryptSync` + 16-byte random per-user salt and verified with `crypto.timingSafeEqual`.
- Sessions are issued in HMAC-SHA256 signed `HttpOnly`, `SameSite=Lax` cookies (`loody_session`), plus Bearer Firebase ID token verification for synchronized sessions.
- Password recovery issues single-use, 15-minute expiring SHA-256 hashed tokens or delegates to Firebase password reset emails.

## Authorization & Developer Role
- Public registration always assigns `role = 'user'` and `plan = 'free'`. Client-supplied role or plan fields are ignored.
- Developer privileges are granted strictly server-side via the `DEVELOPER_ALLOWLIST_EMAILS` environment allowlist.
- Administrative routes (`/api/v1/models/admin/*`, `/api/v1/settings/admin/*`) enforce `requireDeveloper` and record denied attempts in `audit_logs`.

## User Data Isolation & Firestore Rules
- Every SQLite query for `projects`, `project_files`, `workspace_files`, `conversations`, `messages`, `token_usage`, `mcp_servers`, `mcp_approvals`, and `user_integrations` scopes strictly to `user_id = ?` of the authenticated user.
- Public conversation sharing (`/api/v1/share/:shareId`) is opt-in, returns sanitized snapshots only (never secrets, files, or sibling chats), and can be revoked immediately by the conversation owner.
- `firestore.rules` is validated via `npx eslint firestore.rules` with zero warnings/errors and enforces owner-only UID isolation, immutable schema fields, and `isValidString` / `isPositiveNumber` type checks.

## API Secret & Credential Protection
- `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `STRIPE_SECRET_KEY` exist exclusively on the server (`process.env`). Zero provider secrets are bundled into `src/`.
- User-supplied MCP tokens and admin custom provider keys are encrypted at rest with AES-256-GCM.

## MCP & Tool Safety
- External MCP endpoint URLs pass `validateExternalHttpUrl` (blocks non-HTTP(S) schemes and private/metadata IPs).
- Tools matching destructive or external-action patterns require an explicit pending user approval record (`mcp_approvals`) before execution.
- Tool executions enforce strict timeouts and isolate returned payloads as untrusted external data.

## Rate Limiting & Cost Controls
- Sliding-window rate limits protect `/api/v1/auth/*` and `/api/v1/chat/stream`.
- Token quotas (up to `1,000,000` daily ceiling) are verified server-side prior to upstream dispatch.
- Uploaded images are MIME-validated (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) and capped at 4 MB; uploaded documents are text-validated and sanitized.
