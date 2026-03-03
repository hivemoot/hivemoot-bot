# Queen Chat & Cross-Repo Research

Design exploration for adding conversational chat and deep research capabilities to the Queen.

## Status: Research / RFC

---

## Problem Statement

The Queen currently operates in **single-shot command mode**: a user posts `@hivemoot /vote` in a GitHub comment, the Queen performs one action, and the interaction ends. There are two gaps:

1. **No conversational interface** — Users can't ask the Queen questions, discuss implementation strategies, or get advice. Every interaction must be a formal command.
2. **No cross-repo research** — The Queen's knowledge is scoped to one issue/PR at a time. She can't investigate code across repositories, trace dependencies, or synthesize information from multiple sources to inform governance decisions.

## Current Architecture (Constraints)

| Layer | Technology | Constraint |
|-------|-----------|------------|
| Runtime | Vercel serverless functions | **120s max execution time** |
| Framework | Probot (GitHub App) | Webhook-driven, stateless |
| State | GitHub-native (labels, comments, reactions) | No database |
| LLM | Vercel AI SDK + multi-provider | Structured output via `generateObject()` |
| Commands | `@hivemoot /verb` in comments | Single-shot, line-anchored parser |

Key tension: **deep research takes minutes, webhooks must respond in seconds.**

---

## Part 1: Queen Chat Interface

### Approach: GitHub Comments as Conversational Channel

The lowest-friction approach builds on what already exists — GitHub issue/PR comments. Instead of requiring a formal `/command`, the Queen responds to conversational @mentions.

#### How It Works

```
User:  @hivemoot what's the best approach for implementing auth here?
Queen: Based on the discussion in #45 and the existing patterns in api/lib/...
       I'd recommend [detailed response with context].

User:  @hivemoot can you elaborate on the JWT approach?
Queen: [continues conversation with thread context]
```

#### Detection: Chat vs Command

The parser (`api/lib/commands/parser.ts`) already distinguishes commands from prose — unrecognized verbs without a leading `/` are ignored. The chat handler activates on @mentions that **don't** match a command:

```
@hivemoot /vote          → command handler (existing)
@hivemoot vote           → command handler (known verb, existing)
@hivemoot great work     → ignored today → NEW: chat handler
@hivemoot what is the    → ignored today → NEW: chat handler
  status of this issue?
```

#### Implementation: `@hivemoot chat` (Explicit) vs Implicit

Two options for activation:

| Option | Trigger | Pros | Cons |
|--------|---------|------|------|
| **Explicit** | `@hivemoot /chat <message>` or `@hivemoot chat <message>` | Clear intent, no false positives, easy to add to `KNOWN_VERBS` | Extra friction, feels robotic |
| **Implicit** | Any `@hivemoot` that isn't a command | Natural conversation, zero friction | Could trigger on accidental mentions, costs LLM tokens on noise |

**Recommendation: Start explicit (`@hivemoot chat`), graduate to implicit later.** Add `"chat"` to `KNOWN_VERBS` in the parser. The handler can always be loosened later once we understand usage patterns.

#### Context Assembly

The chat handler builds a conversation context from the GitHub thread:

```typescript
interface ChatContext {
  // Current issue/PR metadata
  issue: { number: number; title: string; body: string; labels: string[] };

  // Thread history (all comments, not just @hivemoot ones)
  thread: Array<{ author: string; body: string; createdAt: string }>;

  // Recent Queen ↔ user exchanges (for multi-turn coherence)
  recentExchanges: Array<{ role: "user" | "assistant"; content: string }>;

  // Repository context
  repo: { owner: string; name: string; description?: string };
}
```

The handler:
1. Fetches the full comment thread for the issue/PR
2. Filters Queen's own prior chat responses (identified by a chat-specific signature marker)
3. Builds a message history for multi-turn coherence
4. Calls the LLM with a chat-oriented system prompt
5. Posts the response as a comment

#### System Prompt Design

```
You are the Hivemoot Queen — an AI team manager for open-source agent communities.
You're having a conversation in a GitHub issue thread.

Context:
- Repository: {owner}/{repo}
- Issue/PR #{number}: {title}
- Current phase: {labels → governance phase}
- You have access to the full discussion thread below.

Your role:
- Answer questions about this issue, the project, or governance process
- Help users understand the discussion, voting outcomes, and implementation status
- Provide technical guidance grounded in the discussion context
- Be concise — this is a GitHub comment, not an essay

You do NOT:
- Make governance decisions (voting, labeling) outside the formal command system
- Speculate about code you haven't seen
- Promise outcomes or timelines
```

#### Token/Cost Management

Every chat response costs LLM tokens. Mitigations:

- **Thread truncation**: Same strategy as `blueprint.ts` — recent comments prioritized, older ones truncated from ~100k char budget
- **Rate limiting**: Per-user cooldown (e.g., 5 chat messages per issue per hour) enforced via reaction-based state or simple comment counting
- **Opt-in per repo**: Gate behind `hivemoot.yml` config: `chat: { enabled: true }`

#### New Files

```
api/lib/chat/
├── context.ts          # ChatContext assembly from GitHub thread
├── handler.ts          # Chat command handler (LLM call + response formatting)
├── prompts.ts          # System/user prompt templates
└── handler.test.ts     # Tests
```

Wire into existing command dispatch in `api/lib/commands/handlers.ts` as a new verb handler.

---

## Part 2: Cross-Repo Research via hivemoot-agent

### The Problem

Chat alone is limited to the current issue context. Real value comes when the Queen can **research across the codebase** — read source files, trace dependencies, check implementations in other repos — and bring that knowledge into the conversation.

### Architecture: Agentic Tool-Use Loop

The Vercel AI SDK supports **tool calling** (`generateText` with `tools`). The Queen gets tools for GitHub API operations and runs an agentic loop:

```
User: @hivemoot chat how does the voting system work across our repos?

Queen (internally):
  1. LLM decides: "I need to search for voting-related code"
  2. Tool call: searchCode({ query: "voting", org: "hivemoot" })
  3. Tool call: readFile({ repo: "hivemoot-bot", path: "api/lib/governance.ts" })
  4. Tool call: readFile({ repo: "hivemoot-agent", path: "..." })
  5. LLM synthesizes findings into a response
  6. Posts response as GitHub comment
```

### Tool Definitions

```typescript
const researchTools = {
  searchCode: {
    description: "Search code across repositories in the organization",
    parameters: z.object({
      query: z.string(),
      org: z.string().optional(),    // defaults to current org
      repo: z.string().optional(),   // scope to single repo
      path: z.string().optional(),   // file path filter
    }),
    execute: async ({ query, org, repo, path }) => {
      // Uses GitHub Code Search API via octokit
      // GET /search/code?q={query}+org:{org}
    },
  },

  readFile: {
    description: "Read a file from a repository",
    parameters: z.object({
      repo: z.string(),
      path: z.string(),
      ref: z.string().optional(),    // branch/tag/sha
    }),
    execute: async ({ repo, path, ref }) => {
      // Uses GitHub Contents API via octokit
      // GET /repos/{owner}/{repo}/contents/{path}
    },
  },

  listDirectory: {
    description: "List files in a repository directory",
    parameters: z.object({
      repo: z.string(),
      path: z.string().optional(),
    }),
    execute: async ({ repo, path }) => {
      // GET /repos/{owner}/{repo}/contents/{path}
    },
  },

  getIssue: {
    description: "Get details of an issue or PR from any repo in the org",
    parameters: z.object({
      repo: z.string(),
      number: z.number(),
    }),
    execute: async ({ repo, number }) => {
      // GET /repos/{owner}/{repo}/issues/{number}
    },
  },

  searchIssues: {
    description: "Search issues and PRs across repositories",
    parameters: z.object({
      query: z.string(),
      repo: z.string().optional(),
    }),
    execute: async ({ query, repo }) => {
      // GET /search/issues?q={query}
    },
  },
};
```

### The 120s Problem

Agentic research with multiple tool calls can easily exceed Vercel's 120s function limit. Options:

#### Option A: Synchronous with Budget

Run the agentic loop within the webhook handler with a strict time budget:

```typescript
const RESEARCH_BUDGET_MS = 90_000; // leave 30s for overhead
const MAX_TOOL_CALLS = 10;

const result = await generateText({
  model,
  tools: researchTools,
  maxSteps: MAX_TOOL_CALLS,
  abortSignal: AbortSignal.timeout(RESEARCH_BUDGET_MS),
  // ...
});
```

- **Pro**: Simple, no new infrastructure
- **Con**: Deep research may time out, response quality limited by time budget

#### Option B: Async Research Jobs

Separate the research from the response:

1. Webhook receives `@hivemoot chat` → posts "🔍 Researching..." reaction
2. Dispatches a GitHub Actions workflow (or separate long-running process) for the research
3. Research job completes → calls GitHub API to post the response comment

```
Webhook (2s)           Research Job (5-10min)           Response
    │                        │                              │
    ├─ React 🔍 ──────────►├─ Agentic loop ──────────────►├─ Post comment
    ├─ Dispatch job ────────┤  - search code                │
    │                       │  - read files                 │
    │                       │  - synthesize                 │
    └───────────────────────┴───────────────────────────────┘
```

Implementation via `workflow_dispatch`:

```yaml
# .github/workflows/queen-research.yml
on:
  workflow_dispatch:
    inputs:
      owner: { type: string }
      repo: { type: string }
      issue_number: { type: number }
      user_message: { type: string }
      thread_context: { type: string }
```

- **Pro**: No time limit, deep research possible, can use `hivemoot-agent` tooling
- **Con**: More infrastructure, latency (user waits for GH Actions to spin up), need to manage job status

#### Option C: Hybrid — Fast Chat + Background Research

Best of both worlds:

1. **Fast path** (synchronous, within 120s): Simple questions answered immediately using thread context + 2-3 quick tool calls
2. **Deep research path** (async): Complex questions that need cross-repo investigation are dispatched as background jobs

The LLM itself decides which path to take based on the question complexity:

```typescript
// Step 1: Quick classification
const classification = await generateObject({
  model,
  schema: z.object({
    needsResearch: z.boolean(),
    reason: z.string(),
  }),
  prompt: `Does this question require reading code across repositories,
           or can it be answered from the issue context alone?
           Question: "${userMessage}"`,
});

if (classification.needsResearch) {
  // Dispatch async research job
  await dispatchResearchWorkflow(ctx);
  await react(ctx, "eyes"); // 👀 = researching
} else {
  // Answer directly
  const response = await generateChatResponse(ctx);
  await reply(ctx, response);
}
```

**Recommendation: Start with Option A (synchronous + budget), add Option C later.** Option A fits the existing architecture with zero new infrastructure. The 90s budget is enough for 5-10 tool calls which covers most questions. Option C can be layered on when we hit the limits.

### Connecting to hivemoot-agent

The `hivemoot-agent` reference in the codebase suggests a companion agent system. Two integration patterns:

#### Pattern 1: hivemoot-agent as a Library

Import research utilities from hivemoot-agent as an npm dependency:

```typescript
import { CodeSearchAgent } from "@hivemoot/agent";

const agent = new CodeSearchAgent({ octokit, org: "hivemoot" });
const findings = await agent.research("How does voting work?");
```

#### Pattern 2: hivemoot-agent as a Service

Call hivemoot-agent via API or GitHub Actions dispatch:

```typescript
// Dispatch to hivemoot-agent's research endpoint
await octokit.rest.actions.createWorkflowDispatch({
  owner: "hivemoot",
  repo: "hivemoot-agent",
  workflow_id: "research.yml",
  ref: "main",
  inputs: {
    question: userMessage,
    callback_repo: `${owner}/${repo}`,
    callback_issue: issueNumber,
  },
});
```

**Recommendation: Start with Pattern 1 (library) or build the tools directly into hivemoot-bot.** Keep the research tools self-contained until hivemoot-agent has a stable API surface.

---

## Part 3: Configuration

### Per-Repo Config (`hivemoot.yml`)

```yaml
version: 1
chat:
  enabled: true
  # Whether to allow cross-repo research (requires org-level app installation)
  research: true
  # Repos the Queen is allowed to read during research
  allowedRepos:
    - hivemoot-bot
    - hivemoot-agent
    - hivemoot
  # Max chat responses per issue per hour (rate limiting)
  maxResponsesPerHour: 10
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HIVEMOOT_CHAT_ENABLED` | `false` | Global chat feature flag |
| `HIVEMOOT_CHAT_MAX_TOOL_CALLS` | `10` | Max research tool calls per chat |
| `HIVEMOOT_CHAT_TIMEOUT_MS` | `90000` | Time budget for chat + research |

---

## Part 4: Implementation Plan

### Phase 1: Basic Chat (No Research)

**Scope**: Queen responds to `@hivemoot chat <message>` using issue thread context only.

1. Add `"chat"` to `KNOWN_VERBS` in `api/lib/commands/parser.ts`
2. Create `api/lib/chat/context.ts` — thread context assembly
3. Create `api/lib/chat/prompts.ts` — chat system prompt
4. Create `api/lib/chat/handler.ts` — LLM call + response formatting
5. Wire chat verb into `executeCommand()` dispatch in `api/lib/commands/handlers.ts`
6. Add `chat` config section to `api/lib/repo-config.ts`
7. Tests + documentation

**Estimated new files**: 3 source + 1 test
**Dependencies**: None new (uses existing Vercel AI SDK)

### Phase 2: Research Tools

**Scope**: Queen can read code and search across repos during chat.

1. Create `api/lib/chat/tools.ts` — GitHub API research tools
2. Switch from `generateObject` to `generateText` with `tools` in chat handler
3. Add tool-call budget and timeout management
4. Add `allowedRepos` config for scoping research
5. Tests for each tool + integration tests

**Dependencies**: May need additional GitHub App permissions (Contents: Read on other repos)

### Phase 3: Async Research (Optional)

**Scope**: Background research jobs for complex questions.

1. Create GitHub Actions workflow for long-running research
2. Add research job dispatch to chat handler
3. Implement callback mechanism (research job posts comment when done)
4. Add job status tracking (reaction-based: 👀 = researching, ✅ = done)

**Dependencies**: GitHub Actions workflow, possibly hivemoot-agent integration

---

## Security Considerations

- **Scope control**: Research tools only access repos the GitHub App is installed on — no broader access possible
- **Allowed repos config**: Additional per-repo restriction on which repos the Queen can read during research
- **No write operations**: Research tools are read-only — the Queen cannot modify code, create PRs, or push commits during chat
- **Token limits**: All LLM calls bounded by existing `LLM_MAX_TOKENS` config
- **Rate limiting**: Per-user, per-issue cooldowns prevent abuse
- **Secret safety**: Research tool responses are filtered to exclude `.env`, credentials, private keys before being passed to the LLM or posted as comments

## Open Questions

1. **Should chat responses have a distinct visual signature?** (e.g., different from governance comments)
2. **Multi-turn memory**: How many prior exchanges to include in context? Entire thread or sliding window?
3. **hivemoot-agent status**: Is there an existing agent codebase to integrate with, or do we build research tools from scratch?
4. **Discord integration**: Should chat live in Discord instead of (or in addition to) GitHub? Discord gives real-time UX but fragments the conversation away from the code.
5. **Cost allocation**: Chat is open-ended and can burn tokens. Should per-installation BYOK be required for chat, or does the shared key cover it?
