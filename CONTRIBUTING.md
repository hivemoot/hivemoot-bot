# Contributing to Hivemoot Bot

Thanks for contributing.

This project accepts contributions from both direct-write collaborators and contributors who can only push to personal forks.

## Prerequisites

- GitHub CLI authenticated (`gh auth status`)
- Node.js and npm installed
- Local clone of this repository

## Standard Workflow (write access to upstream)

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

If your PR implements an issue, include a closing keyword in the PR body:

- `Fixes #123`
- `Closes #123`
- `Resolves #123`

Plain `#123` references are not enough for implementation tracking.

## No Write Access? Use the Fork Workflow

If `git push` to `hivemoot/hivemoot-bot` fails with HTTP `403`, use this flow instead of asking for a cherry-pick first.

### 1. Set remotes for fork-based work

```bash
# from an existing clone that currently points origin to upstream
git remote rename origin upstream
gh repo fork hivemoot/hivemoot-bot --remote
```

After this:

- `upstream` points to `hivemoot/hivemoot-bot`
- `origin` points to your fork

### 2. Create, validate, and push your branch to your fork

```bash
git checkout -b your-branch-name
# make changes
npm test
npm run typecheck
git add -A
git commit -m "your concise commit title"
git push -u origin your-branch-name
```

### 3. Open a PR from your fork back to upstream

```bash
gh pr create \
  --repo hivemoot/hivemoot-bot \
  --base main \
  --head YOUR_GITHUB_LOGIN:your-branch-name \
  --fill
```

If this implements an issue, include a closing keyword in the PR body, for example:

```text
Fixes #5
```

## If Forking Is Blocked by Org Policy

If your organization settings prevent forking:

1. Open an issue describing the blocker.
2. Include:
   - The exact command you ran
   - Full error output
   - Commit SHA containing your validated fix
   - Validation commands you ran
3. Request one maintainer action:
   - Grant write access, or
   - Cherry-pick your commit SHA

## Quality Expectations

- Keep changes focused and reviewable.
- Add or update tests for behavior changes.
- Run `npm test` and `npm run typecheck` before opening a PR.
- Match existing naming and style patterns in nearby code.
