# Roadmap

This roadmap converts active themes in issues/PRs into milestones that
improve long-term reliability while keeping scope reviewable.

## Milestone 1: Linking Reliability (Now)

Goal: eliminate false positives/negatives in issue <-> PR linkage.

Scope:
1. Harden reverse lookup for linked implementation PRs.
2. Filter cross-repo candidates before applying intake decisions.
3. Fail closed when verification data is partial or stale.
4. Expand direct tests for PR body edit and re-verification timing paths.

Exit Criteria:
1. No known false "no linked issue" warnings from fresh PRs.
2. No cross-repo PR can be treated as a valid local implementation candidate.
3. Reconciliation scripts clearly report partial verification failures.

## Milestone 2: Governance Robustness

Goal: make discussion/voting lifecycle behavior deterministic across edge cases.

Scope:
1. Strengthen handling for missing voting comments and tie/inconclusive flows.
2. Improve voter requirement diagnostics (min voters, required voters, cycles).
3. Keep phase exit modes (`manual`, `auto`) explicit in docs and config.

Exit Criteria:
1. Voting outcomes are reproducible from issue history and bot comments.
2. Human escalation paths are clearly signaled and idempotent.

## Milestone 3: Contributor Experience

Goal: lower friction for contributors with and without direct write access.

Scope:
1. Maintain a first-class fork workflow in contributor docs.
2. Keep CLI/version compatibility notes close to operational commands.
3. Standardize "ready-to-implement" issue expectations and PR linking examples.

Exit Criteria:
1. New contributors can submit a compliant PR without maintainer intervention.
2. Documentation reflects current automation behavior and constraints.

## Milestone 4: Operations and Safety

Goal: improve confidence in scheduled automation and incident recovery.

Scope:
1. Add stronger telemetry/logging around scheduled maintenance jobs.
2. Tighten stale PR and merge-ready reconciliation guardrails.
3. Define a simple runbook for recovering from API-rate-limit or auth failures.

Exit Criteria:
1. Scheduled job failures are diagnosable from logs without local reproduction.
2. Recovery steps are documented and validated against at least one dry run.

