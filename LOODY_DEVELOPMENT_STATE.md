# LOODY — Persistent Development State & Resumption Tracker

Last Verified Updated: 2026-11-24T00:26:00-08:00 (UTC 08:26)  
Active Phase: **Phase 0.3 — Security & Stability Closure (Final Execution)**  
Next Planned Phase (ON HOLD until Phase 0.3 passes all acceptance gates): **Phase 1**

---

## 1. Status Taxonomy

Every tracked task, model, and capability in this document uses one explicit status tag:

- `PLANNED`: Specified and sequenced; implementation not yet started.
- `IN_PROGRESS`: Currently under diagnosis or active implementation.
- `IMPLEMENTED`: Code changes written; verification pending.
- `TESTED_WITH_MOCKS`: Verified only via unit/mock/temp-DB tests or local build/lint checks (not proof of live upstream inference).
- `LIVE_VERIFIED`: Verified via real HTTP/SSE/database calls against live running server and real upstream provider responses.
- `BLOCKED`: Blocked on external credentials, quota, hardware, or environment dependency.
- `NEEDS_REVIEW`: Implemented and tested; awaiting final audit/sign-off.
- `COMPLETE_APPROVED`: Verified end-to-end across automated tests, live probes, security audit, and browser inspection.

---

## 2. Recovery State Snapshot (Pre-Edit Baseline Verified)

- **Repository / VCS**: Not a Git repository (`git status` reports non-git workspace). Recoverable snapshots live under `.checkpoints/`:
  - `.checkpoints/phase03-final-pre-edit-src.tar.gz` (pre-edit source snapshot)
  - `.checkpoints/loody.db.phase03-final-pre-edit.bak` (pre-edit SQLite snapshot)
  - `.checkpoints/phase03-pre-fix-src.tar.gz`, `.checkpoints/loody.db.phase03-pre-fix.bak`
  - `.checkpoints/pre-five-identities-src.tar.gz`, `.checkpoints/loody.db.pre-five-identities.bak`
- **Database State (`data/loody.db`)**:
  - `PRAGMA integrity_check`: `ok`
  - Schema migration version: `v9` (`v9_heal_mismatched_vision_auth_error`)
  - Real account verified intact: `ahmedsameh99is@gmail.com` (`id: 95d3696c-7a54-4e12-95d8-924ce8a33fed`, `role: 'user'`, `plan: 'free'`, current DB quotas `25000` daily / `300000` monthly) — **STRICTLY PROTECTED** (never elevate `role` or `plan`).
  - Configured runtime server providers: `gemini` (`GEMINI_API_KEY`), `groq` (`GROQ_API_KEY`), `nvidia` (`NVIDIA_API_KEY` — note prior live calls show `401 Unauthorized access` on inference).
- **Baseline Checks Run & Verified**:
  - `npm run lint` (`tsc --noEmit`): **PASSED** (exit code `0`)
  - `npx --yes tsx --test src/shared/*.test.ts server/*.test.ts`: **PASSED 72/72** (`TESTED_WITH_MOCKS` — unit & temp-SQLite integration tests with mocked fallback probes; does not constitute live provider proof)
  - `npm run build` (`vite build`): **PASSED** (exit code `0`)
- **Current Live Model Registry State at Recovery**:
  - `sonic-3` (`Sonic 3`): `free` plan, `groq / openai/gpt-oss-20b`, `operational` (`329ms`)
  - `sonic-3.5` (`Sonic 3.5`): `free` plan, `gemini / gemini-3.6-flash`, `temporarily_unavailable` (`15003ms` timeout, `latency`)
  - `lodie-5.5` (`LOODY 5.5`): `premium` plan (paywalled), `gemini / gemini-3.6-flash`, `temporarily_unavailable` (`15002ms` timeout, `latency`)
  - `fables-5.3` (`Fables 5.3`): `premium` plan (paywalled), `groq / openai/gpt-oss-120b`, `operational` (`448ms`)
  - `loody-vision-1` (`LOODY Vision 1`): `free` plan, `gemini / gemini-3.5-flash`, `temporarily_unavailable` (`provider_unavailable`, Gemini circuit breaker `open` after 10 failures; NVIDIA backup `401 Unauthorized access` circuit `open`)

---

## 3. Phase 0.3 Task Breakdown & Progress

| Task | Scope | Status | Verification Evidence |
| --- | --- | --- | --- |
| **Recovery Setup** | Recover project state, baseline checks, checkpoint inventory, create `LOODY_DEVELOPMENT_STATE.md` | `LIVE_VERIFIED` | `npm run lint` pass, `72/72` mock/unit tests pass, `npm run build` pass, SQLite `ok` |
| **Task 1 — Gemini Timeouts & Vision Rescue** | Diagnose & fix Gemini `15s` timeouts (`sonic-3.5`, `lodie-5.5`, `loody-vision-1`), health-check parallel burst stampede, shared circuit breaker poisoning, & NVIDIA `401` failover noise | `IN_PROGRESS` | Pending live reproduction & fix |
| **Task 2 — Shared Policy & Clean Stale Model ID** | Create `src/shared/assistantPolicy.ts` (Rules A–J, identity + runtime transparency, XML untrusted data fencing), integrate across chat/studio routes, replace `gemini-4-hydrogen` references | `PLANNED` | — |
| **Task 3 — Generous Free Tier & Per-Model Budgets** | Unlock `lodie-5.5` & `fables-5.3` for Free tier (`v10` migration), cost-grounded generous daily/monthly + per-model budgets, UTC reset timestamps, remaining quotas in API/UI | `PLANNED` | — |
| **Task 4 — Universal Capability Parity & Image Hardening** | Enable verified text + PNG/JPEG/WebP/GIF vision + doc analysis + streaming + stop/cancel on all 5 models without silent model switching; add magic-byte validation on chat image uploads | `PLANNED` | — |
| **Task 5 — Security Audit, Live 5-Model Benchmark, Browser Verify & Closure** | Full test suite, live isolated Free-user 5-model EN/AR/PNG/JPEG/Doc matrix, `playwright-cli` desktop+mobile audit, cleanup, final report | `PLANNED` | — |

---

## 4. Branded Model Live Verification Matrix

| Model ID | Display Name | Primary Route (Verified) | Free Tier Access | Text (EN/AR) | PNG Vision | JPEG Vision | Docs / Files | Status Tag |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sonic-3` | Sonic 3 | `groq / openai/gpt-oss-20b` (+ Gemini vision route pending Task 4) | Yes | Pending live check | Pending Task 4 | Pending Task 4 | Pending live check | `IMPLEMENTED` |
| `sonic-3.5` | Sonic 3.5 | `gemini / gemini-3.6-flash` | Yes | Failing (15s timeout) | Pending Task 4 | Pending Task 4 | Pending live check | `IN_PROGRESS` |
| `lodie-5.5` | LOODY 5.5 | `gemini / gemini-3.6-flash` | No (`premium` — Task 3 unlocks) | Failing (15s timeout + 403 Free) | Pending Task 4 | Pending Task 4 | Pending Task 4 | `IN_PROGRESS` |
| `fables-5.3` | Fables 5.3 | `groq / openai/gpt-oss-120b` | No (`premium` — Task 3 unlocks) | 403 Free (needs unlock) | Pending Task 4 | Pending Task 4 | Pending Task 4 | `IMPLEMENTED` |
| `loody-vision-1` | LOODY Vision 1 | `gemini / gemini-3.5-flash` | Yes | Failing (circuit open / timeout) | Failing | Failing | Pending | `IN_PROGRESS` |

---

## 5. Resumption Checklist (When Continuing Work)

1. Always read `LOODY_DEVELOPMENT_STATE.md` first before making edits.
2. Never claim `LIVE_VERIFIED` unless an actual live request against the restarted port-3000 runtime succeeded after the final code edit.
3. Never promote or modify `ahmedsameh99is@gmail.com` (`role: 'user'`, `plan: 'free'`). Use only disposable test accounts and delete them after verification.
4. Keep dev server restarted via `restart_dev_server` after any server or frontend edit (HMR is disabled).
