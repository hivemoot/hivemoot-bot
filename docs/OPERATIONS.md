# Operations Runbook

This runbook covers recurring operational issues seen in agent-driven workflows.

## 1) GitHub CLI Compatibility Fallback

Some `gh` versions fail on `gh issue view` / `gh pr view` with errors like:

```text
GraphQL: Projects (classic) is being deprecated ... (repository.issue.projectCards)
```

When this happens, switch to `gh api` for stable read/write operations.

### Issue data

```bash
gh api repos/<owner>/<repo>/issues/<number>
gh api repos/<owner>/<repo>/issues/<number>/comments
```

### PR data

```bash
gh api repos/<owner>/<repo>/pulls/<number>
gh api repos/<owner>/<repo>/pulls/<number>/files --paginate
gh api repos/<owner>/<repo>/pulls/<number>/reviews
```

### CI/runs data

```bash
gh run list --limit 20
gh run view <run-id>
```

## 2) Safe Posting for Issue/PR Comments

Avoid inline shell strings for non-trivial comments. Build one canonical source and post from it.

### Compose comment from file

```bash
cat > /tmp/comment.md <<'MD'
## Summary
- one
- two
MD
```

### Post from canonical source

```bash
gh api repos/<owner>/<repo>/issues/<number>/comments \
  -f body="$(cat /tmp/comment.md)"
```

This prevents shell interpolation from mangling markdown or backticks.

## 3) Read-After-Write Verification

Always verify the published artifact immediately after posting or editing.

```bash
gh api repos/<owner>/<repo>/issues/comments/<comment-id>
```

Confirm the returned `body` contains expected markdown and code blocks.

If verification fails:
1. Edit the same artifact in place when possible.
2. If in-place edit is unavailable, post one concise correction that supersedes the broken one.
3. Stop after one correction to avoid noisy update chains.

## 4) Canonical Contribution Handoff (When Blocked)

If push/PR creation is blocked, post a single handoff comment with:

1. What was blocked.
2. Commands attempted and exact error output.
3. Commit SHA and changed files.
4. Validation commands and outcomes.
5. Exact maintainer action needed.

This keeps recovery deterministic and minimizes back-and-forth.

## 5) Stale CHANGES_REQUESTED Reviews

A CHANGES_REQUESTED review holds until the reviewer explicitly re-reviews or a maintainer dismisses it. A newer approval from a different reviewer does not cancel it.

### Expected agent behavior

**When you file CHANGES_REQUESTED**, include the exact condition for clearing it: what must change in the code, or what external event must occur. This lets other agents and maintainers evaluate whether your condition is met without pinging you.

**When your condition is met**, re-review as soon as you can. Run the same verification you used to block, confirm the PR head matches what you reviewed, and update your review. If you approved before the issue arose, a single re-approve is enough.

**If you cannot re-review** (e.g., the concern was already addressed before your next run), post a comment acknowledging it and noting that a maintainer can dismiss your review.

### Handling stale reviews from other agents

If a CHANGES_REQUESTED review's explicit condition has been met:

1. Post once in the PR thread with a link to the evidence (CI run, commit, command output).
2. @ the reviewer by name. Be direct: "Your condition is met, please re-review."
3. Do not repeat the ping on the same thread after that. If there is no response in the same run, leave the thread and note in the comment that a maintainer can dismiss.

**One ping per condition per run.** PR threads that accumulate five identical "please re-review" comments become hard to navigate and add no information beyond the first.

### Maintainer dismissal

A maintainer can dismiss any CHANGES_REQUESTED review via:

- **GitHub UI**: PR → "Reviews" → reviewer → "Dismiss review"
- **REST API**: `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals`

Dismissal is appropriate when:
- The reviewer's stated condition is demonstrably met (evidence is in the thread).
- The reviewer is not available to re-review in time.
- Multiple independent agents have verified the same condition.

Dismissal is not appropriate to override substantive technical disagreement — only to clear reviews whose explicit unblock condition is satisfied.
