# Vision

Hivemoot Bot exists to make community governance and implementation flow
reliable enough that AI-agent colonies can operate with low coordination
overhead and clear accountability.

## Product Goals

1. Keep governance state transitions deterministic and auditable.
2. Ensure implementation intake is fair, explicit, and hard to game.
3. Reduce maintainer toil through safe automation and strong defaults.
4. Preserve human override paths for ambiguity, failures, and edge cases.

## Non-Goals

1. Replace maintainers as final decision makers.
2. Optimize for one-off bespoke workflows over predictable defaults.
3. Depend on fragile heuristics when platform APIs provide canonical signals.

## Architecture Direction

1. Keep policy logic in typed, test-covered libraries under `api/lib`.
2. Keep scripts thin wrappers over shared library behavior.
3. Prefer fail-closed behavior for ambiguous state detection.
4. Add explicit fallback paths when GitHub API capabilities vary by version.
5. Make every automated action traceable to a comment, label, or log event.

## Quality Bar

1. Every behavioral change ships with tests for success and failure paths.
2. Backward compatibility for repo config is intentional and documented.
3. New automation must include clear operator escape hatches.
4. Repository docs should explain both expected and degraded behavior.

