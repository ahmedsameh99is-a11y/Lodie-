# LOODY — Persistent Development State & Resumption Tracker

Last Verified Updated: 2026-11-25T12:19:00Z  
Active Phase: **Phase 0.3 — Final UX, Navigation & Provider Expansion (Workstreams A & B)**  
Phase 0.3 Status: **`COMPLETE_PENDING_USER_APPROVAL`**  
Next Planned Phase (ON HOLD until user approves Phase 0.3 closure): **Phase 1**

---

## 1. Status Taxonomy

- `PLANNED`: Specified and sequenced; implementation not yet started.
- `IN_PROGRESS`: Currently under diagnosis or active implementation.
- `IMPLEMENTED`: Code changes written; verification pending.
- `TESTED_WITH_MOCKS`: Verified only via unit/mock/temp-DB tests or local build/lint checks.
- `LIVE_VERIFIED`: Verified via real HTTP/SSE/database calls against live running server and real upstream provider responses.
- `BLOCKED`: Blocked on external credentials, account balance/quota, hardware, or environment dependency.
- `NEEDS_REVIEW`: Implemented and tested; awaiting final audit/sign-off.
- `COMPLETE_PENDING_USER_APPROVAL`: Verified end-to-end across automated tests, live probes, security audit, and browser inspection; awaiting user sign-off before Phase 1.

---

## 2. Recovery & Checkpoint Inventory

- **Workspace**: Non-Git directory. Recoverable checkpoints stored under `.checkpoints/`:
  - `.checkpoints/pre-workstream-a-b-src.tar.gz` & `.checkpoints/loody.db.pre-workstream-a-b.bak`
  - `.checkpoints/post-workstream-a-src.tar.gz` & `.checkpoints/loody.db.post-workstream-a.bak`
  - `.checkpoints/post-workstream-b-src.tar.gz` & `.checkpoints/loody.db.post-workstream-b.bak`
- **Database State (`data/loody.db`)**:
  - `PRAGMA integrity_check`: `ok`
  - Protected account verified intact: `ahmedsameh99is@gmail.com` (`id: 95d3696c-7a54-4e12-95d8-924ce8a33fed`, `role: 'user'`, `plan: 'free'`, `daily_token_limit: 150000`, `monthly_token_limit: 2500000`).
  - Additive schema upgrades (`db.ts`): `messages.upstream_attribution`, `token_usage.upstream_attribution`, `token_usage.latency_ms`, `token_usage.fallback_attempts`, `token_usage.error_class`.
- **Verification Summary**:
  - `npm run build` (`vite build`): **PASSED**
  - `npm run lint` (`tsc --noEmit`): **PASSED** (exit `0`)
  - `npx --yes tsx --test src/shared/*.test.ts server/*.test.ts`: **PASSED 83/83** (`pass: 83, fail: 0`)
  - Headless Chromium (`playwright-cli`) Desktop (`1440x900`) & Mobile (`390x844`): **PASSED** (0 console/page errors, unified left drawer verified, zero mobile bottom nav bar, live UI chat stream verified on `Sonic 3`).
  - Client Bundle Security Scan (`dist/`): **PASSED** (`0` leaked provider keys or server env var references).

---

## 3. Phase 0.3 Workstream Completion Matrix

| Workstream | Scope | Status | Verification Evidence |
| --- | --- | --- | --- |
| **Workstream A — Unified Navigation & Clean Chat UI** | Unified collapsible left drawer (`AppSidebar.tsx`, `App.tsx`, `ChatWorkspace.tsx`, `i18n.ts`), removed mobile bottom navigation & duplicate header controls, kept EN/AR RTL + Dark/Light/System toggles | `LIVE_VERIFIED` | Desktop `1440x900` & Mobile `390x844` Playwright screenshots + live mobile UI stream (`0` console errors) |
| **Workstream B — OpenRouter Adapter & Live Gateway** | `OPENROUTER_API_KEY` header/routing support (`HTTP-Referer`, `X-OpenRouter-Title`), verified OpenRouter routes across all 5 branded models, optional upstream provider attribution & usage cost persistence (no fabricated metadata), bounded 5xx/429 retry honoring `Retry-After` | `LIVE_VERIFIED` | Live `/models` discovery (`120` catalog entries), live text completion (`nvidia/nemotron-3.5-lightning:free`, 200 OK, `upstreamAttribution: "Nvidia"`, `circuitState: "closed"`), live VLM completion (`nvidia/nemotron-3.5-super-vl:free`, 200 OK) |
| **Workstream B — DeepInfra Adapter, Catalog & 402 Guard** | `DEEPINFRA_API_KEY` OpenAI-compatible adapter (`supportsVision: true` at catalog level, strict per-route text vs VLM enforcement in `providerMatrix.ts`), verified DeepInfra catalog IDs, HTTP `402` / positive-balance / top-up classification as non-retryable `quota_exceeded` | `LIVE_VERIFIED` (adapter, `/models` discovery, HTTP `402` classification) / `BLOCKED` (live token completion pending positive account balance) | Live `/v1/openai/models` discovery (`120` entries, no error); live `/chat/completions` returned HTTP `402` ("You need positive balance to do inference"), classified as `errorClass: "quota_exceeded"`, `circuitState: "open"` |

---

## 4. Branded Model Live Verification Matrix (Post-Final-Edit)

| Model ID | Display Name | Primary Route (Verified) | Free Tier | Live Text / Vision Stream Check | Latency | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `sonic-3` | Sonic 3 | `groq / openai/gpt-oss-20b` | Yes | `S3-OK` (`200`, `done: true`) | `420ms` | `LIVE_VERIFIED` |
| `sonic-3.5` | Sonic 3.5 | `gemini / gemini-3.1-flash-lite` | Yes | `S35-OK` (`200`, `done: true`) | `3118ms` | `LIVE_VERIFIED` |
| `lodie-5.5` | LOODY 5.5 | `gemini / gemini-3.1-flash-lite` | Yes | TLS explanation (`200`, `done: true`, `174` chars) | `5717ms` | `LIVE_VERIFIED` |
| `fables-5.3` | Fables 5.3 | `groq / openai/gpt-oss-120b` | Yes | Arabic reply `مرحبًا` (`200`, `done: true`) | `553ms` | `LIVE_VERIFIED` |
| `loody-vision-1` | LOODY Vision 1 | `gemini / gemini-3.1-flash-lite` | Yes | PNG vision reply (`200`, `done: true`, `65` chars) | `987ms` | `LIVE_VERIFIED` |

---

## 5. Resumption Checklist (When Entering Phase 1)

1. Wait for explicit user approval of Phase 0.3 before starting Phase 1 features.
2. Never promote or modify `ahmedsameh99is@gmail.com` (`role: 'user'`, `plan: 'free'`).
3. If DeepInfra balance is topped up later, call `POST /api/v1/models/providers/deepinfra/reset-circuit` and `POST /api/v1/models/providers/deepinfra/test` to transition DeepInfra from `quota_exceeded` (`open`) to live operational status.
4. Keep `restart_dev_server` after any server or frontend edit (HMR is disabled).
