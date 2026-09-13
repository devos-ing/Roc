# Which models are used as advisors?

Observed 2026-09-11. This research compares public configurations, router implementations, and available usage methodology. It does not establish a market-wide most-used advisor model. No model calls or configuration changes were made.

The strongest concrete advisor example found is Oh My OpenAgent's Oracle architecture consultant, configured with GPT-5.6 Sol in its OpenCode edition. That role provides technical advice. Roc's `ModelAdvisor` selects the model for another role, which is closer to a router. The distinction changes which evidence applies.

| System | What it uses | What the evidence establishes |
| --- | --- | --- |
| Oh My OpenAgent, OpenCode edition | Oracle: GPT-5.6 Sol; Prometheus planner: Claude Fable 5.1; Sisyphus orchestrator: Claude Opus 5; Atlas execution orchestrator: Claude Sonnet 5 | Maintainer-configured role/provider chains on the current development branch, subject to overrides and availability |
| Oh My OpenAgent, newer Senpi/core configuration | Main agent inherits the session model; plan-consultant starts with Claude Sonnet 4.6; plan-reviewer starts with GPT-6 Astra | Another edition of the same project's current development configuration, not an independent adoption sample |
| OpenCode | Plan inherits the configured model unless overridden | No universal named planning model in the default inheritance rule |
| OpenRouter Auto | A lightweight task classifier followed by task-specific model rankings and policy filters | A routing architecture; the documentation does not name a public flagship LLM as the classifier |
| RouteLLM | Trained routing models, including its recommended matrix-factorization router | A model-selection mechanism; the downstream strong/weak models are not the advisor itself |
| Not Diamond | A specialized selection service called with a candidate list and cost/latency preferences | A router API, without evidence that one named consumer LLM is its universal advisor |

The Oh My OpenAgent evidence comes from the upstream `dev` branch, not a verified npm release. The OpenCode-edition chains list Oracle at GPT-5.6 Sol xhigh, with a Copilot high variant; Prometheus at Fable 5.1 xhigh; and Sisyphus at Opus 5 max. Oracle is a read-only architectural consultant and does not delegate tasks. These defaults do not count how many users chose them. [OpenCode-edition provider chains](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/opencode-config.md#agent-provider-chains)

The newer edition instead keeps the user's session model as the main agent and recommends models including Opus 5 and GPT-5.6 Sol. Its categories select worker model chains. This is closer to Roc's distinction between a role performing work and a policy choosing that role's model. Version and edition matter; old search snippets can describe a different setup. [Role/model guide](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/agent-model-matching.md), [curated fallback source](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/senpi-task/src/agents/builtin/fallback-chains.ts)

OpenCode's documentation says primary agents use the globally configured model and subagents inherit their invoking primary agent's model unless overridden. A particular model shown in an example configuration is not a measured popular choice. [OpenCode model inheritance](https://opencode.ai/docs/agents/#model)

OpenRouter describes a lightweight classifier that assigns a task type, followed by rankings based on trailing seven-day spend for that task type. Cost tiers, allowed models, and other restrictions affect the resulting candidate set. This is evidence of a classifier-plus-policy design, not evidence that its classifier is GPT, Claude, Kimi, or GLM. [Auto Router mechanism](https://openrouter.ai/docs/guides/routing/routers/auto-router)

RouteLLM's matrix-factorization router chooses between stronger and cheaper models using learned preferences and a calibrated threshold. Its documented GPT/Mixtral example names the models selected for answering, not a GPT model hired to choose between them. [RouteLLM implementation](https://github.com/lm-sys/RouteLLM)

Not Diamond likewise separates selection from execution. Its `select_model` API returns a recommendation from the supplied model list. The caller then invokes the selected model. Its coding-agent router is a separate offering; its public documentation does not provide advisor-model adoption counts. [Chat router](https://docs.notdiamond.ai/docs/quickstart-routing), [coding router](https://code.notdiamond.ai/docs/)

OpenRouter's public rankings are real usage evidence, but the leaderboard measures token volume through OpenRouter. The methodology explicitly excludes a whole-market interpretation and does not equate tokens with users, requests, or task preference. That ranking cannot establish the most-used advisor model. No representative role-specific user-count dataset was found in this research. [Ranking methodology](https://openrouter.ai/rankings)

For Roc, my inference is to keep model selection deterministic while the existing Scout or planner supplies task context. If later adding model-assisted classification, use it for bounded task metadata and validate that output against the approved task constraints. It must not silently lower approved risk or invent model IDs. There is no evidence here that adding a flagship advisor call to every task would improve routing enough to justify its cost.

If the desired new role is an architecture consultant, GPT-5.6 Sol is a concrete public configuration example. It is not a proven popularity winner. If the desired role is the worker-model selector, the closer examples are category mappings and specialized routers. This research does not change the approved status or scope of the [Pi implementation plan](../superpowers/plans/2026-09-11-pi-multi-model-routing.md).
