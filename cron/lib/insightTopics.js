/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   INSIGHT TOPICS — v10 Field Insights                            ║
 * ║   cron/lib/insightTopics.js                                      ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Editorial topic bank for original AI/LLM/automation content.   ║
 * ║   No external source — the post IS the original content.         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Rotation is deterministic by UTC day so a run is reproducible, and the
 * pipeline dedups on `insight://<slug>` (30-day window) so a topic never
 * repeats within a month even though the bank cycles every ~30 days at
 * 2 posts/day.
 */

export const TOPICS = [
  // ── AI Engineering ──
  { slug: 'evals-not-vibes', category: 'AI ENGINEERING', title: 'Your model did not get worse — your evals were never measuring what you ship', angle: 'The gap between benchmark scores and production quality, and what to measure instead.' },
  { slug: 'prompt-diffs', category: 'AI ENGINEERING', title: 'Treat prompts like code: diff them, review them, roll them back', angle: 'A prompt change is a behavior change; it belongs in version control with review.' },
  { slug: 'context-budgets', category: 'AI ENGINEERING', title: 'Context windows are budgets, not dumping grounds', angle: 'Every token competes for attention; retrieval discipline beats bigger windows.' },
  { slug: 'small-loop', category: 'AI ENGINEERING', title: 'A 20B model with a tight loop beats a 400B model with a vague one', angle: 'Retries with state and tools with schemas matter more than raw parameters.' },
  { slug: 'latency-is-ux', category: 'AI ENGINEERING', title: 'Latency is the UX of AI features — nobody praises a smart but slow app', angle: 'Streaming, smaller draft models, and where the seconds actually go.' },
  { slug: 'fallback-chains', category: 'AI ENGINEERING', title: 'Every production LLM call needs a fallback chain, not a favorite model', angle: 'Provider outages happen weekly; design for graceful degradation.' },
  { slug: 'structured-outputs', category: 'AI ENGINEERING', title: 'If you are parsing JSON out of prose with regex, you are doing it wrong', angle: 'Tool calling and schema-constrained output modes exist — use them.' },
  { slug: 'eval-drift', category: 'AI ENGINEERING', title: 'Your eval set rots faster than your model does', angle: 'Refresh evals from production failures or you are grading last year’s exam.' },
  { slug: 'cost-per-outcome', category: 'AI ENGINEERING', title: 'Measure cost per successful task, not cost per token', angle: 'A cheaper model that needs three retries costs more than the expensive one.' },
  { slug: 'deterministic-guardrails', category: 'AI ENGINEERING', title: 'The best guardrail is the one that never calls a model', angle: 'Deterministic checks before and after generation catch what vibes cannot.' },
  { slug: 'llm-caching', category: 'AI ENGINEERING', title: 'Semantic caching is the cheapest latency win in LLM apps', angle: 'Cache by similarity, but decide your staleness policy before you ship.' },
  { slug: 'token-budgets', category: 'AI ENGINEERING', title: 'Give every AI feature a token budget like you give services a CPU budget', angle: 'Cost attribution per feature is the only way to find the runaway call.' },
  { slug: 'rag-untrusted-input', category: 'AI ENGINEERING', title: 'Every retrieved document is untrusted input — treat RAG like user input', angle: 'Prompt injection travels through your vector store; isolate instructions from data.' },
  { slug: 'eval-ci', category: 'AI ENGINEERING', title: 'Run evals in CI on every prompt change, or do not call it engineering', angle: 'Golden sets and regression thresholds turn prompt edits into reviewable changes.' },
  { slug: 'streaming-cancel', category: 'AI ENGINEERING', title: 'Streaming tokens is easy — cancelling them cleanly is the real work', angle: 'Abort controllers and partial state are where streaming implementations break.' },
  { slug: 'model-deprecation', category: 'AI ENGINEERING', title: 'Your provider will deprecate the model you built on — plan the swap now', angle: 'An abstraction layer plus eval-gated migration beats a panic rewrite.' },

  // ── LLMs ──
  { slug: 'tokenizer-gotchas', category: 'LLMS', title: 'Half of “LLMs can’t count” is tokenization, not reasoning', angle: 'Digits split across tokens; the strawberry problem is a tokenizer artifact.' },
  { slug: 'context-rot', category: 'LLMS', title: 'Long context is not free recall — models read the middle worse than the ends', angle: 'Lost-in-the-middle is measurable; place key facts deliberately.' },
  { slug: 'temperature-myth', category: 'LLMS', title: 'Temperature 0 does not mean deterministic — it means less deterministic', angle: 'Batching nondeterminism exists; test for it instead of assuming.' },
  { slug: 'finetune-vs-prompt', category: 'LLMS', title: 'Fine-tuning is for format and tone, not for facts', angle: 'Facts belong in retrieval; weights are an expensive place to store a wiki.' },
  { slug: 'model-router', category: 'LLMS', title: 'Routing easy queries to a small model is the cheapest optimization nobody does', angle: 'A classifier front door sends 80% of traffic to the cheap tier.' },
  { slug: 'distillation', category: 'LLMS', title: 'Distillation is how small models inherit big-model behavior without the bill', angle: 'Train on outputs, not just data — then eval the student on your tasks.' },
  { slug: 'reasoning-tokens', category: 'LLMS', title: 'Reasoning models think in tokens you pay for and users wait for', angle: 'When chain-of-thought is worth it, and why you should cap the budget.' },
  { slug: 'quantization', category: 'LLMS', title: 'Quantization is a free lunch until you measure it', angle: 'Eval after quantizing, not before — the regressions hide in edge cases.' },
  { slug: 'system-prompt-leak', category: 'LLMS', title: 'Your system prompt is one user message away from being public', angle: 'Never put secrets in prompts; extraction is a when, not an if.' },
  { slug: 'abstention', category: 'LLMS', title: 'A model that says “I don’t know” is a feature you have to train for', angle: 'Penalize confident wrongness in evals or you get fluent fabrication.' },

  // ── Agents ──
  { slug: 'agent-loop-logging', category: 'AGENTS', title: 'Log every tool call — the bug is almost always in the third one', angle: 'Observability for agent runs is the difference between debugging and guessing.' },
  { slug: 'tool-schema-design', category: 'AGENTS', title: 'Tool schemas are API contracts — vague schemas make vague agents', angle: 'Tight enums, examples, and units do more than a bigger model.' },
  { slug: 'agent-step-budget', category: 'AGENTS', title: 'An agent without a step budget is an infinite loop with a credit card', angle: 'Max steps, max cost, and a kill switch are table stakes.' },
  { slug: 'human-checkpoints', category: 'AGENTS', title: 'The best agent UX is a well-placed approval gate, not full autonomy', angle: 'Irreversible actions need a human; reversible ones do not.' },
  { slug: 'multi-agent-theater', category: 'AGENTS', title: 'Two agents arguing is not a review process', angle: 'Where multi-agent actually helps (parallel search) versus where it is theater.' },
  { slug: 'agent-memory', category: 'AGENTS', title: 'Agent memory is a database problem wearing an AI costume', angle: 'What to store, what to forget, and why TTLs matter more than embeddings.' },
  { slug: 'sandboxed-tools', category: 'AGENTS', title: 'Give agents sandboxed tools or give them nothing', angle: 'Code execution without isolation is an incident report waiting to happen.' },
  { slug: 'agent-trajectory-evals', category: 'AGENTS', title: 'You cannot eval an agent on final answers alone — score the trajectory', angle: 'Tool-choice accuracy and error recovery are the real metrics.' },
  { slug: 'retry-with-state', category: 'AGENTS', title: 'Retrying an agent without state is just asking it to fail again', angle: 'Checkpoint progress; resume, do not restart.' },
  { slug: 'agent-handoffs', category: 'AGENTS', title: 'Agent-to-agent handoffs fail at the interface, not the intelligence', angle: 'Shared state schemas beat clever prompts at every boundary.' },
  { slug: 'browser-agents', category: 'AGENTS', title: 'Browser agents break on layout changes, not on intelligence', angle: 'Prefer APIs; DOM selectors are brittle contracts with a UI you do not control.' },

  // ── Automation ──
  { slug: 'automate-boring-first', category: 'AUTOMATION', title: 'Automate the boring 80% before the impressive 20%', angle: 'The ROI lives in unglamorous workflows nobody demos.' },
  { slug: 'cron-observability', category: 'AUTOMATION', title: 'A cron job without alerts is a hope, not a system', angle: 'Dead man’s switches and run logging turn silence into signal.' },
  { slug: 'idempotent-jobs', category: 'AUTOMATION', title: 'Every automation should be safe to run twice', angle: 'Idempotency keys and dedup make retries boring instead of dangerous.' },
  { slug: 'queue-not-sleep', category: 'AUTOMATION', title: 'Do not coordinate workers with sleep() — use a queue', angle: 'Timing-based coordination is a race condition you scheduled yourself.' },
  { slug: 'secrets-in-ci', category: 'AUTOMATION', title: 'Your CI logs are one debug flag away from leaking every secret', angle: 'Mask, scope, and rotate — then assume it leaks anyway.' },
  { slug: 'rate-limit-respect', category: 'AUTOMATION', title: 'Scraping without respecting rate limits is a self-inflicted outage', angle: 'Backoff, rotation, and caching are cheaper than a ban.' },
  { slug: 'dry-run-mode', category: 'AUTOMATION', title: 'Every automation that writes needs a dry-run mode you actually use', angle: 'Test against the production shape without production side effects.' },
  { slug: 'partial-failure-alerts', category: 'AUTOMATION', title: 'The notification is part of the automation — silent failure is the default otherwise', angle: 'Alert on partial failure, not just crashes; half-done work is the worst kind.' },
  { slug: 'config-over-deploy', category: 'AUTOMATION', title: 'If changing a schedule requires a deploy, your automation is too rigid', angle: 'Env vars and config tables separate cadence from code.' },
  { slug: 'human-in-loop', category: 'AUTOMATION', title: 'Full automation is a spectrum — put the human where mistakes are expensive', angle: 'Approval queues on publish steps buy safety without killing throughput.' },
  { slug: 'scheduling-jitter', category: 'AUTOMATION', title: 'Every cron fleet needs jitter, or the API sees a thundering herd at minute zero', angle: 'Offset schedules deterministically; everyone’s “9am” lands at the same second.' },
  { slug: 'webhook-duplicates', category: 'AUTOMATION', title: 'Webhooks are at-least-once delivery — build consumers that expect duplicates', angle: 'Idempotency and replay protection are not optional.' },

  // ── Dev Tools ──
  { slug: 'boring-stack', category: 'DEV TOOLS', title: 'The boring stack ships; the exciting stack blogs', angle: 'Proven tools for the core, experiments at the edges.' },
  { slug: 'cli-design', category: 'DEV TOOLS', title: 'A good CLI is discoverable — a great one is scriptable', angle: '--json output, exit codes, and composability are the features that compound.' },
  { slug: 'local-first', category: 'DEV TOOLS', title: 'Local-first tools respect your users’ machines and your uptime budget', angle: 'Sync engines and offline support are a product feature, not a nicety.' },
  { slug: 'oss-maintenance-curve', category: 'DEV TOOLS', title: 'Adopting an open-source tool means adopting its maintenance curve', angle: 'Check commit cadence and bus factor before the dependency check.' },
  { slug: 'monorepo-when', category: 'DEV TOOLS', title: 'A monorepo solves coordination problems, not code problems', angle: 'Adopt when sharing hurts, not before.' },
  { slug: 'types-at-boundaries', category: 'DEV TOOLS', title: 'Types earn their keep at system boundaries, not inside pure functions', angle: 'Validate at the edge — API payloads, env vars, queue messages.' },
  { slug: 'feature-flags', category: 'DEV TOOLS', title: 'Feature flags are how you deploy on Friday without fear', angle: 'Decouple deploy from release and the weekend gets quieter.' },
  { slug: 'executable-docs', category: 'DEV TOOLS', title: 'If your docs drift from your code, make the docs executable', angle: 'Doctest-style validation turns stale READMEs into failing tests.' },
  { slug: 'preview-envs', category: 'DEV TOOLS', title: 'Preview environments pay for themselves the first time someone reviews a real URL', angle: 'Per-PR deploys collapse the feedback loop.' },
  { slug: 'migration-discipline', category: 'DEV TOOLS', title: 'Migrations should be boring, reversible, and tested on a copy of prod', angle: 'Expand-contract beats big-bang every time.' },
  { slug: 'oss-readme', category: 'DEV TOOLS', title: 'Your README is your landing page — the first screen decides the star', angle: 'What it does, who it is for, one command to try. Everything else is appendix.' },
];

/**
 * Deterministic rotation of the bank for a given UTC day. Two runs per day
 * walk the same order; the dedup window (30 days) is what actually prevents
 * a repeat, so the second run simply takes the next fresh topic.
 *
 * @param {Date} [date]
 * @returns {object[]} topics in run order, freshest pick first
 */
export function pickTopics(date = new Date()) {
  const dayIndex = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86400000);
  const offset = (dayIndex * 2) % TOPICS.length;
  return TOPICS.map((_, i) => TOPICS[(offset + i) % TOPICS.length]);
}

/** The dedup key a topic is stored under in generated_posts.source_url. */
export function topicDedupUrl(topic) {
  return `insight://${topic.slug}`;
}
