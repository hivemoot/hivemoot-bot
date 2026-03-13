# Configuration Reference

Hivemoot Bot is configured per repository via `.github/hivemoot.yml`. All settings have safe defaults; the file is optional.

## Config Hierarchy

1. **Global defaults** — environment variables, clamped to safe boundaries.
2. **Per-repo overrides** — `.github/hivemoot.yml`, validated and clamped at load time.

Invalid values are logged and replaced with defaults. The bot never fails to start due to bad config.

## Full Schema

```yaml
version: 1

governance:
  proposals:
    discussion:
      exits:
        - type: auto               # "auto" or "manual"
          afterMinutes: 1440        # 1-43200 (1 min to 30 days)
          minReady: 0               # 0-50, thumbs-up count needed before exit
          requiredReady:            # specific users who must signal ready
            minCount: 2             # how many from the list must react
            users:
              - alice
              - bob

    voting:
      exits:
        - type: auto
          afterMinutes: 1440
          requires: majority        # "majority" or "unanimous"
          minVoters: 3              # 0-50, minimum total voters required
          requiredVoters:           # specific users who must vote
            minCount: 1
            voters:
              - alice

    extendedVoting:
      exits:
        - type: auto
          afterMinutes: 2880
          requires: majority
          minVoters: 0

  pr:
    staleDays: 3                    # 1-30, days before stale warning
    maxPRsPerIssue: 3               # 1-10, competing PRs per issue
    trustedReviewers:               # GitHub usernames for approval-based intake
      - alice
      - bob
    intake:                         # how PRs enter the implementation workflow
      - method: update              # author activity triggers intake
      - method: approval            # trusted reviewer approvals trigger intake
        minApprovals: 2
    mergeReady:                     # auto-label PRs that meet merge criteria
      minApprovals: 2

standup:
  enabled: true
  category: "Colony Reports"        # GitHub Discussions category name
```

## Governance

### Phase Exits

Each governance phase (discussion, voting, extendedVoting) uses an `exits` array to control progression. Two exit types are supported:

| Type | Behavior |
|------|----------|
| `manual` | No automatic progression. A maintainer or command must advance the phase. |
| `auto` | Time-based progression after `afterMinutes`, subject to additional requirements. |

**Rules:**
- Mixing `manual` and `auto` exits in the same phase is not allowed. The bot falls back to `manual` with a warning.
- Multiple `auto` exits are sorted by `afterMinutes` ascending. The last one determines the phase duration.
- If all exit entries are invalid, the phase defaults to `manual`.

### Discussion Phase

Discussion exits support readiness requirements:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `afterMinutes` | number | — | Required for `auto`. Duration before phase can exit. |
| `minReady` | number | `0` | Minimum thumbs-up reactions on the discussion before auto-exit. |
| `requiredReady` | object/array | `{}` | Specific users who must signal readiness. |

**`requiredReady` formats:**

```yaml
# Array shorthand — all listed users must react
requiredReady:
  - alice
  - bob

# Object format — N of M users must react
requiredReady:
  minCount: 1
  users:
    - alice
    - bob
    - carol
```

### Voting Phase

Voting exits support quorum and approval requirements:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `afterMinutes` | number | — | Required for `auto`. Duration before phase can exit. |
| `requires` | string | `"majority"` | `"majority"` (>50%) or `"unanimous"` (100% approval). |
| `minVoters` | number | `3` | Minimum total voters before auto-exit. Range: 0-50. |
| `requiredVoters` | object/array | `{}` | Specific users who must vote. |

**`requiredVoters` formats:**

```yaml
# Array shorthand — all listed users must vote
requiredVoters:
  - alice
  - bob

# Object format — N of M users must vote
requiredVoters:
  minCount: 1
  voters:
    - alice
    - bob
    - carol
```

### Extended Voting Phase

Uses the same schema as voting. Configured independently under `extendedVoting.exits`. Defaults to `manual` if omitted.

## Pull Request Settings

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `staleDays` | number | `3` | 1-30 | Days of inactivity before stale warning. PRs are auto-closed at `2 * staleDays`. |
| `maxPRsPerIssue` | number | `3` | 1-10 | Maximum competing implementation PRs per issue. New PRs beyond the limit are auto-closed. |
| `trustedReviewers` | string[] | `[]` | Max 20 entries | GitHub usernames authorized for approval-based intake and merge-readiness checks. |

### Intake Methods

The `intake` array controls how PRs enter the implementation workflow. Each entry specifies a method:

| Method | Description |
|--------|-------------|
| `update` | PR enters the workflow when the author pushes commits or edits the description after the linked issue reaches ready-to-implement. Default method. |
| `approval` | PR enters the workflow when it receives `minApprovals` approvals from `trustedReviewers`. Requires `trustedReviewers` to be non-empty. |

If `intake` is omitted, defaults to `[{ method: "update" }]`.

### Merge Readiness

When `mergeReady` is configured, the bot automatically applies a `merge-ready` label to implementation PRs that meet approval thresholds.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `minApprovals` | number | `1` | 1-20 | Approvals from `trustedReviewers` needed for the label. Clamped to `trustedReviewers` list length. |

Merge readiness is **disabled** when:
- `mergeReady` is omitted from config.
- `trustedReviewers` is empty (cannot satisfy approval requirement).

## Standup

Automated daily standup posts to GitHub Discussions.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Opt-in. Must be explicitly set to `true`. |
| `category` | string | — | **Required when enabled.** Name of the GitHub Discussions category for standup posts. |

If `enabled: true` but `category` is missing or empty, standup is disabled with a warning.

## Environment Variables

Global defaults applied when `.github/hivemoot.yml` is absent or omits a setting.

| Variable | Default | Description |
|----------|---------|-------------|
### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_ID` | — | GitHub App ID (required) |
| `PRIVATE_KEY` | — | GitHub App private key, full PEM contents (required). Also accepted as `APP_PRIVATE_KEY` — `PRIVATE_KEY` takes priority. |
| `WEBHOOK_SECRET` | — | Webhook secret for signature verification (required) |
| `NODEJS_HELPERS` | `0` | Required for Vercel deployment |
| `HIVEMOOT_DISCUSSION_DURATION_MINUTES` | `1440` | Default discussion phase duration |
| `HIVEMOOT_VOTING_DURATION_MINUTES` | `1440` | Default voting phase duration |
| `HIVEMOOT_PR_STALE_DAYS` | `3` | Default days before stale warning |
| `HIVEMOOT_MAX_PRS_PER_ISSUE` | `3` | Default max competing PRs per issue |

### LLM (optional)

LLM powers discussion summaries, commit message generation, and standup reports. Core governance works without it.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | — | Provider: `openai`, `anthropic`, `google` / `gemini`, `mistral` |
| `LLM_MODEL` | — | Model name (e.g. `gpt-4o`, `claude-sonnet-4-5-20250929`, `gemini-2.0-flash`) |
| `LLM_MAX_TOKENS` | `4096` | Output token budget. Clamped to `CONFIG_BOUNDS.llmMaxTokens`. |
| `OPENAI_API_KEY` | — | Required when `LLM_PROVIDER=openai` |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |
| `GOOGLE_API_KEY` | — | Required when `LLM_PROVIDER=google` |
| `MISTRAL_API_KEY` | — | Required when `LLM_PROVIDER=mistral` |

## Validation Boundaries

All numeric values are clamped to safe ranges at load time:

| Setting | Min | Max |
|---------|-----|-----|
| Phase duration (minutes) | 1 | 43200 (30 days) |
| PR stale days | 1 | 30 |
| Max PRs per issue | 1 | 10 |
| Min voters | 0 | 50 |
| Merge-ready min approvals | 1 | 20 |
| Trusted reviewers list | — | 20 entries |
| Username length | — | 39 characters |

Usernames are normalized to lowercase, deduplicated, and validated against GitHub's username format. Leading `@` symbols are stripped automatically.

## Examples

### Minimal (all defaults)

```yaml
version: 1
```

All phases default to `manual` exit. PRs stale after 3 days, max 3 competing PRs per issue.

### Fully Automated Governance

```yaml
version: 1
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 1440
          minReady: 2
    voting:
      exits:
        - type: auto
          afterMinutes: 1440
          requires: majority
          minVoters: 3
    extendedVoting:
      exits:
        - type: auto
          afterMinutes: 2880
  pr:
    staleDays: 7
    maxPRsPerIssue: 5
    trustedReviewers:
      - alice
      - bob
    intake:
      - method: update
      - method: approval
        minApprovals: 1
    mergeReady:
      minApprovals: 1
standup:
  enabled: true
  category: "Daily Standup"
```

### Manual Governance with Merge Readiness

```yaml
version: 1
governance:
  proposals:
    discussion:
      exits:
        - type: manual
    voting:
      exits:
        - type: manual
  pr:
    trustedReviewers:
      - maintainer1
      - maintainer2
    mergeReady:
      minApprovals: 2
```
