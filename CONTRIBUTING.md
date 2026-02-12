# Contributing to Hivemoot Bot

This repository accepts contributions from both upstream-write collaborators and fork-only contributors.

## Prerequisites

- GitHub CLI authenticated (`gh auth status`)
- GitHub CLI configured for git operations (`gh auth setup-git`)
- Node.js 20.x and npm
- Local clone of `hivemoot/hivemoot-bot`

## Workflow: You Can Push to Upstream

```bash
git checkout -b your-branch-name
# make changes
npm test
npm run typecheck
git add -A
git commit -m "your concise commit title"
git push -u origin your-branch-name
gh pr create --base main --fill
```

If the PR implements an issue, include a closing keyword in the PR body:

- `Fixes #123`
- `Closes #123`
- `Resolves #123`

Plain `#123` mentions are ignored by implementation tracking.

## Workflow: No Upstream Write Access (403)

If push fails with `Permission denied` or HTTP `403`, use a fork immediately.

### 1. Configure remotes

```bash
# in an existing clone where origin points to upstream
git remote rename origin upstream
gh repo fork hivemoot/hivemoot-bot --remote
```

After this:

- `upstream` points to `hivemoot/hivemoot-bot`
- `origin` points to your fork

### 2. Create, validate, and push to your fork

```bash
git checkout -b your-branch-name
# make changes
npm test
npm run typecheck
git add -A
git commit -m "your concise commit title"
git push -u origin your-branch-name
```

### 3. Open a PR from fork to upstream

```bash
gh pr create \
  --repo hivemoot/hivemoot-bot \
  --base main \
  --head YOUR_GITHUB_LOGIN:your-branch-name \
  --fill
```

If this PR implements an issue, include a closing keyword in the PR body, for example:

```text
Fixes #5
```

## If Forking Is Blocked

If organization policy blocks forks:

1. Open an issue describing the blocker.
2. Include exact command output, the commit SHA with your validated fix, and the validation commands you ran.
3. Request one maintainer action: grant write access or cherry-pick your SHA.

## GitHub CLI Compatibility Fallbacks

Some `gh` builds still request deprecated GraphQL fields in default output paths.
Example seen in this repo:

- `gh pr view <n> --comments`
- error: `GraphQL: Projects (classic) is being deprecated ... (repository.pullRequest.projectCards)`

Use explicit JSON fields or REST endpoints to avoid that path:

```bash
# Safe PR comments read (explicit GraphQL fields)
gh pr view <n> --json comments,reviews,latestReviews

# REST fallback for issue/PR comments
gh api repos/hivemoot/hivemoot-bot/issues/<n>/comments --paginate
```

## Quality Bar

- Keep changes focused and reviewable.
- Add or update tests for behavior changes.
- Run `npm test` and `npm run typecheck` before opening a PR.
