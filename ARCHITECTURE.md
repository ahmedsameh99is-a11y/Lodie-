# LOODY System Architecture

## Overview

LOODY separates client presentation (`src/`), shared domain logic (`src/shared/`), Firebase client auth & Firestore persistence (`src/lib/firebase.ts`, `firestore.rules`), and Express server routing, SQLite persistence, and AI inference adapters (`server/`, `server.ts`).

## Layers

1. **Shared Domain Layer (`src/shared/`)**
   - `types.ts`: Canonical interfaces for users, models, conversations, projects, files, MCP servers, tools, integrations, themes, and audit logs.
   - `logoGeometry.ts`: Single source of truth for Concept A geometric L brand mark.
   - `quotas.ts`: Pure entitlement, quota ceiling (`1,000,000` daily max), cost estimation, and token reconciliation rules.
   - `modelRegistry.ts`: Pure compatibility and lineup validation logic.
   - `chatExport.ts`: Markdown/JSON export builders, text document validation, sanitization, and browser download helpers.
   - `i18n.ts`: English (`LTR`) and Arabic (`RTL`) localization strings.

2. **Server Layer (`server/`)**
   - `server.ts`: Express entry point mounting `/api/v1/*` and `/api/*` routes plus Vite middlewares in dev (`DISABLE_HMR=true`) or static `dist/` in production.
   - `server/db.ts`: SQLite (`better-sqlite3`, WAL mode, foreign keys ON) with versioned `schema_migrations` (`conversations`, `messages`, `projects`, `project_files`, `workspace_files`, `token_usage`, `mcp_servers`, `mcp_approvals`, `user_integrations`, `audit_logs`, `feature_flags`, `share_links`).
   - `server/security.ts`: `scrypt` password hashing, HMAC-SHA256 HTTP-only session cookies, Firebase ID token verification bridge, AES-256-GCM secret encryption, sliding-window rate limiting, and SSRF URL validation.
   - `server/providers/index.ts`: Provider adapters supporting `@google/genai`, OpenAI-compatible, Anthropic-compatible, and hosted open-source endpoints with timeouts, backoff retries, and clean error extraction.

3. **Frontend Layer (`src/`)**
   - React 19 + Tailwind CSS v4 + VitePWA (`vite-plugin-pwa`) + KaTeX (`rehype-katex`) + `rehype-highlight`.
   - Pre-paint theme script in `index.html` prevents Dark/Light theme flash on initial load.
   - Desktop `AppSidebar` (12 workspace views, folder filters, pin/archive/rename) and mobile slide-over drawer + bottom navigation bar.
   - Stage Two features (`LOODY Code`, `LOODY Work`, `LOODY Skills`) are registered via `feature_flags` (`stage = 'stage_2'`) with honest architectural preview pages.
