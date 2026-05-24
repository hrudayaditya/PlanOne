# What PlanOne Is

PlanOne is an autonomous software engineering pipeline. It receives a task (bug report, feature request, GitHub issue), runs it through a multi-stage pipeline of LLM agents, and produces a correct, tested pull request with no human intervention.

It is a CLI application. Not a desktop app. Not a web server. A CLI.

## What PlanOne Is NOT

- Not a chatbot
- Not a wrapper around Claude Code or Codex CLI
- Not a LangChain application
- Not a single LLM call
- Not built yet beyond Week 1 foundation

## Technology Stack

- Language: TypeScript, strict ESM (`type: "module"` in `package.json`)
- Runtime: Node.js >= 18
- Execution: `tsx` for direct TS execution
- Build: `tsup`
- Tests: `vitest`
- Schema validation: `zod` (everywhere, no exceptions)
- State machine: `xstate` v5
- SQLite: `better-sqlite3`
- Token counting: `tiktoken`
- LLM providers: Anthropic SDK, OpenAI SDK, `@google/generative-ai`
- Git operations: `simple-git`
- Queue: `p-queue`

## BaseMemory - The Retrieval Foundation

PlanOne uses BaseMemory MCP for all codebase intelligence. No agent ever reads files directly from disk. Every codebase fact comes through BaseMemory MCP tools.

BaseMemory is used through its documented MCP stdio entrypoint. PlanOne should launch the BaseMemory MCP CLI with `--project <repoRoot>` and optional `--config <path>`. Do not assume a localhost HTTP server exists unless a future BaseMemory release documents one explicitly. The `index_health_check` tool confirms the server is healthy at task intake.

### Confirmed MCP Tool Names (all 16, verified from source)

**Search and retrieval:**

- `codebase_search` - semantic + keyword search, returns full code content, structured output with pagination cursor, score breakdowns, filters
- `codebase_peek` - same search, metadata only (~90% fewer tokens), use first
- `find_similar` - find code semantically similar to a pasted snippet
- `implementation_lookup` - find WHERE a symbol is defined, prefers impl over tests

**Index management:**

- `index_codebase` - incremental indexing with embeddings
- `index_status` - chunk count, provider, index readiness
- `index_health_check` - GC stale entries, confirms server is live
- `index_coverage` - files truncated by chunk cap, invisible symbols
- `index_metrics` - performance stats (requires debug config)
- `index_logs` - recent debug logs by category/level

**Structural graph tools (structured output, use these over `call_graph`):**

- `symbol_info` - stable `symbol_id`, kind, signature, file location - REQUIRED first call before any symbol operation
- `callers` - paginated callers, `include_tests` filter, cursor pagination
- `callees` - callees with per-entry `resolved`/`unresolved` flag
- `call_chain` - shortest call path between two symbols, BFS up to depth 15
- `tests_for` - tests covering a symbol or file via call graph + naming heuristics

**Legacy graph tool (exists but prefer `callers`/`callees` above):**

- `call_graph` - combined callers/callees via `direction` param, text output only

### Important: `blast_radius` and `neighborhood` are NOT tools

The architecture refers to "blast_radius" and "neighborhood" conceptually. These do not exist as MCP tools. Implement them as composed helpers in `src/basememory/tools.ts` that call real tools:

- `blastRadius` = `symbol_info` + recursive `callers` + `callees`
- `neighborhood` = `codebase_search` or `codebase_peek` with `graphDepth: 1 | 2`

## Critical Architectural Invariants

These must NEVER be violated:

1. Context budget: executor context window must never exceed 60% of model limit. This is a hard infrastructure-level reject, not a warning.
2. Permanent anchors: task description, enriched packet, User/Repo Rules, current step - these NEVER get evicted from context, no matter what.
3. No direct file reads: all code context comes from BaseMemory MCP tools only.
4. Cross-model-family: executor model and verifier model must always be from different providers (Claude executor -> Gemini/GPT verifier, always).
5. Raw Trace Store: every agent, every step, everything is logged here. Written synchronously before any other action. Never deleted.
6. Unresolved call graph edges must never be fabricated into resolved links. The `resolved` field from BaseMemory must be preserved as-is.
7. Escalation exit: `EscalationRequired` is thrown for SEK violations, retry exhaustion, and critical disagreements. The top-level pipeline catches it and surfaces a clean structured message. Never swallow it.

## File Structure

```text
src/
  index.ts
  cli.ts
  escalation/
    index.ts
  intake/
    index.ts
    prompt-enhancer.ts
    complexity-classifier.ts
    rules.ts
  llm/
    index.ts
    anthropic.ts
    openai.ts
    gemini.ts
    schemas.ts
    cost-tracker.ts
  basememory/
    client.ts
    tools.ts
  pipeline/
    index.ts
    state-machine.ts
    context-budget.ts
  panel/
    index.ts
    member.ts
    synthesis.ts
    citation-verifier.ts
  orchestrator/
    index.ts
    plan.ts
    retry.ts
  executor/
    index.ts
    step.ts
    compression.ts
  monitor/
    index.ts
    veto.ts
    anchor-recurrence.ts
  verifier/
    index.ts
    gates/
      functional.ts
      mutation.ts
    confidence.ts
  memory/
    raw-trace-store/
      index.ts
    tier2/
      index.ts
    context-db/
      index.ts
      schema.ts
      memory-use-gate.ts
      amac.ts
      staleness.ts
      query-router.ts
      ab-modes.ts
  sek/
    index.ts
    diff-policy.ts
    injection-classifier.ts
  ab-test/
    index.ts
    reporter.ts
  git/
    index.ts
  utils/
    logger.ts
    tokens.ts
    cost.ts
tests/
  unit/
    context-budget.test.ts
    memory-use-gate.test.ts
    state-machine.test.ts
    diff-policy.test.ts
    citation-verifier.test.ts
    context-db-schema.test.ts
    compression.test.ts
    escalation.test.ts
  integration/
    pipeline-e2e.test.ts
    basememory-mcp.test.ts
    ab-modes.test.ts
    verifier-gates.test.ts
benchmarks/
  swe-bench/
    runner.ts
    harness.ts
  results/
config/
  planone.rules.example.yaml
```

## ContextDB Status

NOT YET IMPLEMENTED as of end of Week 2.
Planned for Week 3.
The RawTraceStore is the only implemented memory layer.
ContextDB is empty in early Phase 1 — this is expected and correct.

## Week Checkpoints

- Week 1: Foundation (current scope)
- Week 2: Context budget enforcer + XState state machine
- Week 3: Intake pipeline + ContextDB schema + Memory Use Gate
- Week 4: Panel + Orchestrator + Compression
- Week 5: Executor + Monitor + Verifier gates 1-2 + SEK
- Week 6: SWE-bench wiring + A/B reporting + measurement

## Commands

- `npm run dev` -> `tsx src/cli.ts`
- `npm run build` -> `tsup`
- `npm run test` -> `vitest run`
- `npm run typecheck` -> `tsc --noEmit`
- `npm run ab-report` -> `tsx src/cli.ts ab-report`

## Week 1 Rules

1. Do not build anything not listed in Week 1.
2. Every exported function and type must have a JSDoc comment explaining what it does, what it returns, and any critical invariants.
3. Every LLM response type is a zod schema. No raw `JSON.parse()` without schema validation anywhere.
4. Use `structuredContent` from BaseMemory MCP responses, not text content.
5. The Raw Trace Store `append()` is synchronous and never throws.
6. Import paths must use `.js` extensions.
7. Run `npm run typecheck` and fix all errors before considering Week 1 done.
8. Do not install additional dependencies not listed above without noting why.

## Executor Tool Layer

The executor LLM cannot edit files or run commands on its own. PlanOne provides 
a tool layer defined in src/executor/tools.ts. The executor sends these tool 
definitions with every LLM call. When the model returns a tool use block, 
PlanOne executes it locally and loops.

Tools: read_file, write_file, apply_patch, run_command, run_tests, 
list_directory, search_in_files, git_diff, git_status

The SEK intercepts every write_file, apply_patch, and run_command call 
before execution. The budget enforcer runs before every LLM call in the loop.

This inner tool loop runs inside the EXECUTE state of the step state machine.

## ContextDB Phase 2 Upgrade Spec

Do not implement these in Phase 1. Design is locked. Implementation 
is Phase 2. Reference this section when writing Phase 2 prompts.

### Upgrade 1: BM25 Textual Relevance in Query Router

Current: queryText flows into routeQuery() and is ignored.
Required: BM25 scoring against chunk_description as secondary 
  scoring dimension inside scoreChunks().

Schema change: add chunk_description: string (required) to 
  ContextChunkBase. admitCycleToContextDb() must populate it.

Formula: final_score = (bm25_score * 0.4) + (gate_quality * 0.6)
Package: wink-bm25-text-search or inline BM25 implementation.
Trigger: implement when store has 50+ real entries.

### Upgrade 2: Gate Result Caching

Current: runMemoryUseGate() makes 4+ serial BaseMemory calls per 
  chunk with no caching. 80 calls for 20 chunks.

Cache key: chunk_id + ':' + base_memory_snapshot.call_graph_hash
Cache value: GateResult
TTL: 5 minutes

Add optional parameter to routeQuery():
  gateCache?: GateResultCache

GateResultCache interface:
  get(key: string): GateResult | null
  set(key: string, result: GateResult): void
  invalidate(symbolId: string): void

Phase 1: no-op (always returns null, parameter ignored).
Phase 2: in-process Map with TTL eviction.
Phase 3: Redis-backed distributed cache.

### Upgrade 3: Parallel Gate Evaluation

Current: scoreChunks() evaluates gates serially.
Change: Promise.all() with concurrency limit of 5 via p-limit.
Trigger: implement when store has 20+ real entries.

### Upgrade 4: Batch Symbol Existence Check

Current: runMemoryUseGate() calls symbolExists() once per symbol.
Change: single codebasePeek() across all chunk.symbols, parse results.
Implement alongside Upgrade 3.

### Upgrade 5: SymbolChunk Full Population

Current: SymbolChunk entries have empty symbol_id, file_path, kind.
Change: call symbolInfo() for each symbol after verifier passes,
  populate before admit(). Wrap in try/catch.
Trigger: implement in same pass as Upgrade 3.

## Confirmed Zero-Cost Provider Configuration

One OpenRouter API key + one Google API key. No Anthropic key required.

Role assignments:
  Executor:    inclusionai/ling-2.6-1t:free  →  OPENROUTER_API_KEY
  Panel:       gemini-3.1-flash-lite-preview →  GEMINI_API_KEY
  Verifier:    gemini-3.1-flash-lite-preview →  GEMINI_API_KEY
  Intake:      gemini-2.5-flash              →  GEMINI_API_KEY
  Compression: gemini-3-flash-preview        →  GEMINI_API_KEY

Cross-family: inclusionai (OpenRouter) vs google (Gemini) ✓

Required env vars:
  OPENROUTER_API_KEY=sk-or-v1-...
  GEMINI_API_KEY=AI...

Rate limit reality:
  OpenRouter free: 50 req/day → ~2 full tasks/day
  (executor uses ~20 calls per task)
  Gemini free: 50 req/day per model → sufficient for all other roles

For SWE-bench measurement (50+ tasks): upgrade to paid OpenRouter.
Paid upgrade: set openrouterPath 'paid', fund account with credits.
