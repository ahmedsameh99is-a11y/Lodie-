# LOODY Model Registry

LOODY presents five commercial model labels backed by real, administrator-configurable provider adapters. Availability is never fabricated: models display `Operational` only when their backend provider credentials are configured, or `Awaiting Config` otherwise.

| Branded ID | Display Name | Tier | Default Provider | Default Upstream Model | Modalities |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `sonic-3` | Sonic 3 | Free | `gemini` | `gemini-3.1-flash-lite` | Text |
| `sonic-3.5` | Sonic 3.5 | Free | `gemini` | `gemini-4-hydrogen` | Text |
| `lodie-5.5` | Lodie 5.5 | Premium | `gemini` | `gemini-4-hydrogen` (XHIGH reasoning) | Text |
| `fables-5.3` | Fables 5.3 | Premium | `openai-compatible` / `anthropic-compatible` | `gpt-4.1` / `claude-sonnet-4-5` | Text |
| `loody-vision-1` | LOODY Vision 1 | Multimodal | `gemini` | `gemini-4-hydrogen` | Text, Image |

## Developer Configuration
Authenticated Developer accounts can remap any model's `provider`, `upstreamModelId`, `requiredPlan`, `thinkingPreset`, or custom endpoint from the **Model Hub** UI or `PATCH /api/v1/models/admin/:id`, and run live verification probes via `POST /api/v1/models/admin/:id/test`.
