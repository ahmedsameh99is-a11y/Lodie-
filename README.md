# LOODY — AI Super Workspace

**"Your AI. Your Workspace."**

LOODY is an independent, multi-model AI platform built with a black-and-emerald architectural visual system, light/dark/system themes, mobile-first PWA ergonomics, Firebase Auth + Firestore synchronization, server-side provider routing, token accounting, project contexts, workspace files, and permission-controlled MCP tools.

## Capabilities (v2.0)

- **Official Concept A Identity**: Geometric 3D-inspired capital **L** logo across 6 variants (`primary-3d`, `flat-2d`, `transparent-3d`, `android-icon`, `splash-3d`, `monochrome`) and installable PWA assets.
- **First-Launch Splash Screen**: Canvas 2D emerald particle field + 3D perspective L emblem assembly, gesture-safe Web Audio chime, reduced-motion support, Skip Intro, and replay in Settings.
- **LOODY Model Hub**: 5 branded models (`Sonic 3`, `Sonic 3.5`, `Lodie 5.5`, `Fables 5.3`, `LOODY Vision 1`) backed by configurable server-side adapters (`gemini`, `openai-compatible`, `anthropic-compatible`, `hosted-oss`), with automatic fallback option when an upstream endpoint is congested.
- **AI Chat Workspace**: Real SSE streaming, Stop Generation, Continue, Copy, Regenerate, Retry, Edit & Resend, Markdown + GFM + KaTeX math + syntax-highlighted code blocks with Copy & Download, expandable long turns, drag-and-drop image/document extraction, Web Speech STT voice input, in-thread search, Markdown/JSON export, opt-in share snapshots (`/?share=<id>`), and collapsible Right Context Panel.
- **Authentication & Persistence**: Firebase Authentication (Google Sign-In, Email/Password registration, login, verification, password recovery, plus Apple Sign-In integration hook) synchronized with server-side HTTP-only sessions (`loody_session`), SQLite persistence, and Firestore rules (`firestore.rules`).
- **Projects & Workspace Files**: Isolated projects with custom instructions, preferred model, per-project enabled tools, and attached knowledge documents alongside the dedicated Workspace Files manager (`Files`).
- **Tools, Integrations & MCP Hub**: Categorized built-in safe tools, JSON-RPC MCP registry with `tools/list` discovery, explicit user approval workflow for sensitive operations, untrusted-output isolation, and 6 connector readiness cards (`Google Drive`, `Gmail`, `Google Calendar`, `GitHub`, `Notion`, `Slack`).
- **Stage Two Honest Previews**: Dedicated architectural previews for **LOODY Code**, **LOODY Work**, and **LOODY Skills** gated transparently behind `feature_flags`.
- **Theming, RTL/LTR & Mobile**: Dark / Light / System themes, Emerald / Mint / Cyan accent presets, Font Size & Density controls, English (`LTR`) and Arabic (`RTL`) localization, responsive desktop `AppSidebar`, and mobile slide-over drawer + bottom thumb navigation.

## Quick Start

```bash
npm install
npm run dev
```

Run unit tests and Firestore rules lint:
```bash
npx --yes tsx --test src/shared/quotas.test.ts src/shared/modelRegistry.test.ts src/shared/chatExport.test.ts
npx eslint firestore.rules
```

Build and run production server:
```bash
npm run build
npm start
```

## External Credentials & Configuration Notes

- **Active**: Firebase Auth & Firestore (`atlantean-lamp-pv0ns`) and server-side `GEMINI_API_KEY` routing.
- **Owner-Provided When Enabling External Connectors**:
  - **Apple Sign-In**: Enable the Apple provider in Firebase Auth Console and supply Apple Developer Service ID, Team ID, Key ID, and `.p8` private key.
  - **Third-Party Integrations**: Configure OAuth Client ID/Secret and redirect URIs in `.env` for Google Workspace (`Drive`, `Gmail`, `Calendar`), `GitHub`, `Notion`, and `Slack`.
  - **Billing**: Configure `STRIPE_SECRET_KEY` and webhook secret to activate live checkout; otherwise plan switching remains in transparent test mode.
