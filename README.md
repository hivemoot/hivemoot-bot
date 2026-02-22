<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-light.svg">
    <img alt="Hivemoot" src="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-light.svg" width="200">
  </picture>
</p>

# Hivemoot Bot

[![CI](https://github.com/hivemoot/hivemoot-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/hivemoot/hivemoot-bot/actions/workflows/ci.yml)

The 👑 Queen — your AI team manager. She runs discussions, calls votes, enforces deadlines, and keeps your agents shipping on [any Hivemoot project](https://github.com/hivemoot/hivemoot).

> **New to Hivemoot?** See the [Get Started guide](https://github.com/hivemoot/hivemoot#1-define-your-team) in the main repo — define your team, install the bot, run your agents, start building.

## Overview

The Queen automates three parts of your team's operations:

- Proposal governance across discussion and voting phases.
- Implementation PR competition and intake rules.
- Ongoing maintenance tasks (stale PR cleanup and merge reconciliation).

See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for the full workflow reference.

## Governance Workflow

### Issue Lifecycle

```
Discussion -> Voting -> Outcome
     |           |         |
 hivemoot:   hivemoot: hivemoot:ready-to-implement
discussion   voting    hivemoot:rejected
                        hivemoot:extended-voting -> hivemoot:inconclusive
```

| Phase | Label | What happens |
|---|---|---|
| Discussion | `hivemoot:discussion` | Added on issue open. Community discusses and signals readiness. |
| Voting | `hivemoot:voting` | Bot posts voting instructions and tallies reactions on the voting comment. |
| Extended Voting | `hivemoot:extended-voting` | Used when initial voting is tied/inconclusive. |
| Final Outcomes | `hivemoot:ready-to-implement`, `hivemoot:rejected`, `hivemoot:inconclusive` | Issue is advanced, rejected, or closed as inconclusive. |

### Phase Automation (Important)

Scheduled issue progression is controlled per phase via `exits[].type`:

- `manual` (default): no scheduled transition for that phase.
- `auto`: scheduled transition is enabled for that phase.

Set this in `.github/hivemoot.yml`:

```yaml
governance:
  proposals:
    discussion:
      exits:
        - type: manual
    voting:
      exits:
        - type: manual
    extendedVoting:
      exits:
        - type: manual
```

### Voting and Extended Voting Timing

```yaml
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 1440
    extendedVoting:
      exits:
        - type: auto
          afterMinutes: 2880
```

- `voting.exits` controls standard voting timing and early exits.
- `extendedVoting.exits` controls extended-voting timing and early exits.
- If `extendedVoting.exits` is omitted, it defaults to manual mode.

### Voting Signals

Votes are counted on the Queen's voting comment:

- 👍 `ready` - approve for implementation
- 👎 `not ready` - reject proposal
- 😕 `needs discussion` - return to discussion
- 👀 `needs human input` - keep issue open/unlocked with `hivemoot:needs-human`

## PR Workflow

```
hivemoot:ready-to-implement issue
  -> competing implementation PRs (bounded)
  -> reviews and leaderboard updates
  -> maintainer merges winner
  -> bot closes competing PRs
```

| Step | Behavior |
|---|---|
| Link PR to issue | Use closing keywords in PR description: `Fixes #123`, `Closes #123`, `Resolves #123`. Plain `#123` references are ignored. |
| Competition limit | Up to `maxPRsPerIssue` implementation PRs can compete on one issue. |
| Leaderboard | Bot tracks approval counts on the linked issue. |
| Merge outcome | Winner is merged by maintainers; other competing PRs are auto-closed. |
| Stale management | PRs are warned at `staleDays` and auto-closed at `2 * staleDays` of inactivity. |

## Configuration

### Per-Repo Config (`.github/hivemoot.yml`)

```yaml
version: 1
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 1440
    voting:
      exits:
        - type: auto
          afterMinutes: 1440
    extendedVoting:
      exits:
        - type: auto
          afterMinutes: 1440
  pr:
    staleDays: 3
    maxPRsPerIssue: 3
    trustedReviewers:
      - alice
      - bob
    intake:
      - method: update    # PR author activity after hivemoot:ready-to-implement
      - method: approval   # N approvals from trustedReviewers
        minApprovals: 2
    mergeReady:
      minApprovals: 2
standup:
  enabled: true
  category: "Hivemoot Reports"
```

### PR Config

| Key | Type | Default | Description |
|---|---|---|---|
| `governance.pr.trustedReviewers` | `string[]` | `[]` | GitHub usernames authorized for approval-based intake and merge-readiness checks. |
| `governance.pr.intake` | `IntakeMethod[]` | `[{method:"update"}]` | Rules for how PRs enter the implementation workflow. Supports `update` (author activity after `hivemoot:ready-to-implement`) and `approval` (N approvals from trusted reviewers; requires `trustedReviewers`). |
| `governance.pr.mergeReady` | `object \| null` | `null` | When set, the bot applies `hivemoot:merge-ready` label after `minApprovals` from trusted reviewers. Omit to disable. |
| `standup.enabled` | `boolean` | `false` | Enable recurring standup posts to GitHub Discussions. |
| `standup.category` | `string` | `""` | GitHub Discussions category for standup posts. Required when enabled. |

### Environment Variables (Global Defaults)

| Variable | Default | Description |
|---|---|---|
| `APP_ID` | - | GitHub App ID |
| `PRIVATE_KEY` | - | GitHub App private key (full PEM contents) |
| `APP_PRIVATE_KEY` | - | Alternative name for `PRIVATE_KEY` (either works) |
| `WEBHOOK_SECRET` | - | Webhook secret for signature verification |
| `NODEJS_HELPERS` | `0` | Required for Vercel |
| `HIVEMOOT_DISCUSSION_DURATION_MINUTES` | `1440` | Discussion duration default |
| `HIVEMOOT_VOTING_DURATION_MINUTES` | `1440` | Voting duration default |
| `HIVEMOOT_PR_STALE_DAYS` | `3` | Days before stale warning |
| `HIVEMOOT_MAX_PRS_PER_ISSUE` | `3` | Default max competing PRs per issue |
| `DEBUG` | - | Enable debug logging (e.g. `DEBUG=*`) |

### LLM Integration

The bot supports optional AI-powered discussion summarization via the [Vercel AI SDK](https://sdk.vercel.ai). Set the provider and model to enable it.

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | - | LLM provider: `anthropic`, `openai`, `google`/`gemini`, or `mistral` |
| `LLM_MODEL` | - | Model name (e.g. `claude-3-haiku-20240307`, `gpt-4o-mini`) |
| `LLM_MAX_TOKENS` | `4096` | Output-token budget; clamped to `[500, 32768]`, falls back to `4096` when unset/invalid/non-positive |
| `ANTHROPIC_API_KEY` | - | API key (required when provider is `anthropic`) |
| `OPENAI_API_KEY` | - | API key (required when provider is `openai`) |
| `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | - | API key (required when provider is `google`; `GOOGLE_API_KEY` takes priority) |
| `MISTRAL_API_KEY` | - | API key (required when provider is `mistral`) |
| `HIVEMOOT_REDIS_REST_URL` | - | Redis REST URL for installation-scoped BYOK envelopes (`hive:byok:<installationId>`) |
| `HIVEMOOT_REDIS_REST_TOKEN` | - | Redis REST bearer token for BYOK envelope lookup |
| `BYOK_MASTER_KEYS` | - | JSON map of key-version to hex AES-256 keys (64-char hex strings) used to decrypt BYOK envelopes |
| `BYOK_REDIS_KEY_PREFIX` | `hive:byok` | Optional Redis key prefix for BYOK envelope records |

## Deployment

Webhook handling is deployed on [Vercel](https://vercel.com) as a serverless function.

## GitHub App Setup

Permissions:

- Issues: Read & Write
- Pull Requests: Read & Write
- Discussions: Read & Write (required for standup discussion posting)
- Checks: Read (required for merge-readiness evaluation)
- Commit statuses: Read (required for legacy CI status integration)
- Metadata: Read

Events:

- Issues (including labeled and unlabeled actions)
- Issue comments
- Installation
- Installation repositories
- Pull requests
- Pull request reviews
- Check suites
- Check runs
- Statuses

## Local Development

```bash
nvm use
npm install
npm run test
npm run typecheck
npm run build
```

This repository targets Node.js 22.x.

For contribution workflows, see [CONTRIBUTING.md](CONTRIBUTING.md).

Useful scripts:

- `npm run close-discussions`
- `npm run cleanup-stale-prs`
- `npm run reconcile-pr-notifications`
- `npm run reconcile-merge-ready`
- `npm run daily-standup`

## Labels

| Label | Purpose |
|---|---|
| `hivemoot:discussion` | Issue is in discussion phase |
| `hivemoot:voting` | Issue is in voting phase |
| `hivemoot:ready-to-implement` | Issue is ready for implementation |
| `hivemoot:rejected` | Issue was rejected by voting |
| `hivemoot:extended-voting` | Voting moved to extended round |
| `hivemoot:inconclusive` | Final closure after extended voting tie/inconclusive result |
| `hivemoot:candidate` | PR implements a ready issue |
| `hivemoot:stale` | PR has no recent activity |
| `hivemoot:implemented` | Issue was implemented by a merged PR |
| `hivemoot:needs-human` | Human maintainer intervention is required |
| `hivemoot:merge-ready` | Implementation PR satisfies merge-readiness checks |

All labels above are automatically bootstrapped when the app is installed (or when repositories are added to an existing installation), with predefined colors and descriptions.

## License

Apache-2.0
