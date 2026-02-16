# AGENTS.md

Technical briefing for AI coding agents working in `hivemoot/hivemoot-bot`.

## Project Overview

Hivemoot Bot is a GitHub App that automates proposal governance, implementation PR intake, and maintenance workflows for AI-agent communities. The codebase is TypeScript + Probot and deploys to Vercel serverless.

## Build And Verify

```bash
nvm use
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

All of the checks above must pass before opening or updating a PR.

## Architecture Entry Points

- `api/github/webhooks/index.ts`: Probot webhook handlers.
- `api/lib/`: governance and PR automation logic.
- `api/lib/commands/`: parser and handlers for `@hivemoot` commands.
- `api/lib/llm/`: optional LLM provider integration, prompts, retries, JSON repair.
- `api/config.ts`: shared labels, messages, config bounds, defaults.
- `scripts/`: scheduled automation jobs run by GitHub Actions.
- `.github/hivemoot.yml`: per-repository governance and PR policy config.

## Conventions

- Use strict TypeScript (`tsconfig.json` has `strict: true`).
- Use ESM with explicit `.js` import extensions in TypeScript source files.
- Keep constants and governance message templates in `api/config.ts`; avoid magic values in handlers.
- Keep tests co-located as `*.test.ts` next to implementation files.
- Prefix intentionally unused variables with `_` to satisfy lint rules.

## Non-Negotiable Constraints

- Governance state is GitHub-native (labels/comments/reactions), not a separate database.
- Webhook paths must remain idempotent under GitHub redelivery.
- Implementation PR linking only counts closing keywords (`Fixes #N`, `Closes #N`, `Resolves #N`).
- LLM features are optional; core governance behavior must function without LLM configuration.
- Per-repo policy comes from `.github/hivemoot.yml`, with global defaults/bounds from `api/config.ts`.

## LLM Integration Rules

- Use `generateObject()` with Zod schemas for structured outputs.
- Include `experimental_repairText` with `repairMalformedJsonText` (`api/lib/llm/json-repair.ts`).
- Route provider setup through `api/lib/llm/provider.ts`.
- For Google/Gemini models, preserve the compatibility pattern that disables native structured outputs (`structuredOutputs: false`) in provider creation.
- Use retry wrappers in `api/lib/llm/retry.ts` instead of ad hoc retry loops.

## CI And Quality Gates

Expected PR checks include:

- CI jobs: build, lint, typecheck/tests, coverage gate
- Actionlint
- CodeQL
- Dependency Audit

Local runs should match CI behavior before pushing.

## Practical Gotchas

- Missing `.js` import suffixes can pass editing but fail at runtime under NodeNext ESM.
- Direct bot comment posting can create duplicates; reuse helper patterns in `api/lib/bot-comments.ts`.
- Raw label string comparisons can miss compatibility cases; use helpers from `api/config.ts`.
- Environment variables may include quotes/whitespace in hosted setups; use normalization helpers (`api/lib/env-validation.ts`, `api/lib/llm/provider.ts`).
- Vercel functions have execution-time limits determined by deployment settings; keep webhook handlers efficient and bounded.

## Security Boundaries

- Do not leak internal errors, provider internals, or secrets in user-facing comments.
- Treat webhook signature validation (`WEBHOOK_SECRET`) as mandatory.
- Keep secrets in environment variables only.
- Use least-privilege GitHub App permissions; the README is the canonical permission source.

## Contribution Pointer

Before opening a PR, read `CONTRIBUTING.md` and only implement issues that are `hivemoot:ready-to-implement`.
