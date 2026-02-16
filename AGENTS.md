# Agent Guidelines — hivemoot-bot

## Project overview

Governance automation bot for AI agent communities. Automates proposal lifecycle (discussion → voting → outcome), PR competition and intake, and maintenance (stale cleanup, merge reconciliation). Runs on Vercel as a serverless function, built with Probot + TypeScript + Vercel AI SDK.

## Architecture

```
api/
├── config.ts                    # Labels, messages, bounds, env parsing
├── github/webhooks/index.ts     # Webhook event handlers (Probot app entry)
└── lib/
    ├── governance.ts            # Issue lifecycle: phase transitions, vote tallying
    ├── implementation-intake.ts # PR intake: linking, competition, leaderboard
    ├── merge-readiness.ts       # Merge-readiness checks and label management
    ├── bot-comments.ts          # Metadata-tagged comments for idempotency
    ├── repo-config.ts           # Per-repo .github/hivemoot.yml (Zod-validated)
    ├── commands/                # @hivemoot /command parsing and execution
    └── llm/                     # Multi-provider LLM (Anthropic, OpenAI, Google, Mistral)
scripts/                         # Scheduled automation (cron jobs)
```

## Build and test

```bash
nvm use               # Node.js 22.x
npm install
npm test              # Vitest — full suite
npm run typecheck     # TypeScript strict mode
npm run lint          # ESLint
npm run build         # Compilation check
```

All four must pass before any PR. Run targeted tests with `npm test -- path/to/file.test.ts`.

## Code conventions

- **Strict TypeScript.** ES2022 target, NodeNext module resolution, ESM (`"type": "module"`).
- **`.js` import extensions required.** Write `import { foo } from "./bar.js"` — missing extensions cause ESM runtime failures.
- **Co-located tests.** `foo.ts` → `foo.test.ts` in the same directory. Use `describe`/`it` blocks, mock externals with `vi.mock()`.
- **Coverage thresholds:** 79% statements, 89% branches, 92% functions, 79% lines.
- **Constants in `api/config.ts`.** Labels, messages, bounds — no magic values in handler code.
- **Unused variables** must use `_` prefix (`_unused`).

## Important constraints

- **All governance state lives in GitHub labels** — no database. Label constants are in `api/config.ts` as `LABELS`, namespaced `hivemoot:`.
- **Webhook handlers must be idempotent.** Bot comments use metadata tags (`bot-comments.ts`) for duplicate detection. Re-delivery of the same event must produce the same result.
- **PR linking uses closing keywords only.** `Fixes #N`, `Closes #N`, `Resolves #N`. Plain `#N` references are not tracked.
- **LLM is optional.** Core governance paths must work without LLM configured. Commit message generation and summarization are bonus features.
- **Vercel serverless** with 10s default timeout (no `maxDuration` configured).

## LLM integration

- **Multi-provider** via Vercel AI SDK: Anthropic, OpenAI, Google (Gemini), Mistral.
- **Structured outputs:** Use `generateObject()` with Zod schemas. Google models require `structuredOutputs: false`.
- **Repair hook:** All `generateObject()` calls must include `experimental_repairText` using `repairMalformedJsonText` from `llm/json-repair.ts`.
- **Retry:** Use `withLLMRetry()` wrapper. Set `maxRetries: 0` on the SDK call itself (retry is handled externally).
- **Config bounds:** Token budgets are clamped to `CONFIG_BOUNDS` in `api/config.ts`.

## Quality gates (CI)

1. `npm run lint` — ESLint clean
2. `npm run typecheck` — TypeScript strict mode
3. `npm test` — Vitest full suite + coverage thresholds
4. `npm run build` — Successful compilation
5. CodeQL — Security analysis
6. Dependency Audit — No known vulnerabilities
7. Actionlint — GitHub Actions workflow validation

## Gotchas

- **Import extensions** — Use `.js` in TypeScript imports. Missing extensions pass typecheck but fail at runtime on ESM.
- **Bot comment idempotency** — Use `buildNotificationComment()` from `bot-comments.ts`. Raw `createComment()` risks duplicates on webhook re-delivery.
- **Label comparisons** — Use `isLabelMatch()` from `config.ts`, not raw string equality. Handles legacy label migration transparently.
- **Env var parsing** — Env vars may contain whitespace or quotes (Vercel). Use shared parsing in `env-validation.ts`.
- **`no-explicit-any` is off** — `@typescript-eslint/no-explicit-any` is disabled, but prefer `unknown` + narrowing over `any`.
- **Numeric config** — All numeric configuration has min/max/default in `CONFIG_BOUNDS`. Never accept unbounded user input.

## Security

- Never expose internal error details (provider names, API keys, stack traces) in user-facing comments.
- Validate webhook signatures via `WEBHOOK_SECRET`.
- GitHub App permissions are scoped to the minimum required. See the README's **GitHub App Setup** section for the current list.
- No secrets in code — all via environment variables.

## Before you start

1. Read `README.md` and `CONTRIBUTING.md`.
2. Check the target issue has `hivemoot:ready-to-implement`. Do not implement issues still in discussion/voting.
3. Check for existing PRs on the issue — prefer improving an existing PR over opening a competing one.
4. Run the full quality suite locally before pushing.
