# LOODY API Documentation (`v1`)

All endpoints are mounted under `/api/v1` (with `/api` aliases). Authenticated routes accept either the signed `loody_session` HTTP-only cookie or `Authorization: Bearer <firebaseIdToken>`.

## Health & Sharing
- `GET /api/health` — Returns service name, version (`2.0.0-workspace`), and active stage.
- `GET /api/v1/share/:shareId` — Public read-only endpoint returning an opt-in shared conversation snapshot (no auth required; returns 404 when revoked).

## Authentication (`/api/v1/auth`)
- `POST /register` — Create user account (`email`, `password`, `displayName`, `language?`).
- `POST /login` — Authenticate and set signed session cookie.
- `POST /firebase/exchange` — Verify Firebase ID token and synchronize user profile + signed session cookie.
- `GET /providers/status` — Report real server/OAuth readiness for Google & Apple sign-in.
- `POST /logout` — Clear session cookie.
- `GET /me` — Return sanitized current user profile and daily/monthly token usage.
- `POST /password-reset/request` & `POST /password-reset/confirm` — Expiring token recovery flow.
- `DELETE /account` — Permanently delete user account and cascade-remove user data.

## Models (`/api/v1/models`)
- `GET /` — List the 5 branded models with real availability status and capability metadata.
- `PATCH /admin/:id` *(Developer)* — Reassign provider, upstream model, plan gate, or encrypted custom key.
- `POST /admin/:id/test` *(Developer)* — Run live connectivity verification probe.

## Chat & Conversations (`/api/v1`)
- `GET /conversations` — Supports `folder` (`all` | `pinned` | `archived`), `projectId`, and `q` search filtering.
- `POST /conversations`, `PATCH /conversations/:id` (`title`, `pinned`, `archived`, `folder`, `projectId`), `DELETE /conversations/:id`
- `POST /conversations/clear` — Bulk remove active conversations owned by the user.
- `POST /conversations/:id/share` & `DELETE /conversations/:id/share` — Create or revoke public read-only snapshot link.
- `GET /conversations/:id/messages`
- `POST /chat/stream` — Server-Sent Events (`meta`, `chunk`, `done`, `error`) streaming with entitlement, modality, quota enforcement, `allowFallback`, `documentAttachments`, `enabledToolIds`, and `mode`: `send` | `continue` | `regenerate` | `edit_resend`.

## Projects & Workspace Files
- `GET /api/v1/projects`, `POST /`, `PATCH /:id`, `DELETE /:id` — User-isolated project contexts (`systemPrompt`, `preferredModelId`, `enabledTools`).
- `GET /api/v1/projects/:id/files`, `POST /:id/files`, `DELETE /:id/files/:fileId` — Attach/remove knowledge files inside a project.
- `GET /api/v1/files`, `POST /`, `DELETE /:id` — Workspace knowledge documents (`workspace_files`).

## MCP, Tools & Integrations
- `GET /api/v1/mcp/servers`, `POST /servers`, `DELETE /servers/:id`, `POST /servers/:id/discover`
- `GET /api/v1/mcp/approvals`, `POST /approvals/:id/decide`, `POST /execute`
- `GET /api/v1/mcp/builtin-tools`, `PATCH /builtin-tools/:id`, `POST /builtin-tools/:id/execute`
- `GET /api/v1/integrations`, `POST /:id/connect`, `POST /:id/disconnect`

## Billing & Settings
- `GET /api/v1/billing/summary`, `POST /api/v1/billing/upgrade`, `POST /api/v1/billing/cancel`
- `PATCH /api/v1/settings/preferences` (`language`, `theme`, `accentColor`, `fontSize`, `density`, `soundEnabled`, `reducedMotion`, `defaultModelId`, `allowFallback`)
- `GET /api/v1/settings/export` — Download sanitized JSON archive of the authenticated user's conversations, messages, projects, and files.
- `GET /api/v1/settings/flags`
- `GET /api/v1/settings/admin/overview`, `PATCH /api/v1/settings/admin/flags/:key`, `PATCH /api/v1/settings/admin/users/:id/quota` *(Developer)*
