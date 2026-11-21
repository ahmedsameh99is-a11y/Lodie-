# LOODY Operations & Disaster Recovery Runbook

## 1. Local & Production Server Startup
- **Development**: `npm run dev` (`tsx server.ts` on `http://0.0.0.0:3000`)
- **Production Build & Start**:
  ```bash
  npm run build
  npm start
  ```
- **Health Endpoint**: `GET /api/health` returns `{ ok: true, service: 'loody-workspace', version, stage }`.

## 2. Database Storage, Backups & Recovery
- **SQLite WAL Store**: `data/loody.db` + binary uploads under `data/uploads/`.
- **Account Backup Export**: `GET /api/v1/settings/export` generates a `backupVersion: "1.0"` JSON snapshot containing projects, project files (extracted text & metadata), workspace files, conversations, messages, memories, custom skills, tasks/subtasks/milestones, LOODY Kore workspaces/files, and research reports.
- **Account Restore**: `POST /api/v1/settings/restore` (also accessible in **Settings → Restore Backup (JSON)**) performs a Zod-validated SQLite transaction with tenant-scoped ID resolution so cross-account imports never collide with or overwrite other accounts, and never elevate `role`, `plan`, or token quotas.
- **Full Instance Backup**: Pause writes or run SQLite online backup (`sqlite3 data/loody.db ".backup 'data/loody-backup.db'"`) alongside archiving `data/uploads/`.

## 3. Security & Secret Handling
- Server secrets (`GEMINI_API_KEY`, `SESSION_SECRET`, optional `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `HOSTED_OSS_BASE_URL`, `STRIPE_SECRET_KEY`, `SMTP_HOST`) are loaded server-side only and never bundled into Vite `dist/`.
- Inbound MCP tokens (`mcp_server_tokens`) and session cookies are stored SHA-256 hashed (`hashSecret`). Compromise response: revoke token via `DELETE /api/v1/mcp/server-tokens/:id` or disable via `PATCH /api/v1/mcp/server-tokens/:id`.
- SSRF protections reject private/loopback/link-local IPv4/IPv6 ranges and rebinding DNS lookups on both outbound MCP calls (`server/routes/mcp.ts`) and URL extraction (`server/tools/engine.ts`).
- Binary uploads inspect magic bytes (`server/security.ts`) to block disguised executables (`PE/MZ`, `ELF`, `Mach-O`).

## 4. Media & Video Pipeline Requirements
- Server-side MP4 video rendering (`POST /api/v1/creative/video/render`) invokes real `ffmpeg` / `ffprobe` binaries via `fluent-ffmpeg` with `spawn`/argument arrays (no shell interpolation). Verify `ffmpeg` availability via `GET /api/v1/creative/capabilities`.

## 5. Quality Verification Gates
- **Pure & Security Unit Tests**: `npx --yes tsx --test src/shared/*.test.ts server/security_knowledge.test.ts`
- **Full API Integration Tests**: `npx --yes tsx --test server/integration.test.ts`
- **Firestore Security Rules ESLint**: `npx eslint firestore.rules`
- **TypeScript + Vite Production Build**: `npm run lint` and `npm run build`
