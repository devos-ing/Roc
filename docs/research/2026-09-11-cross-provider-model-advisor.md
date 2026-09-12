# Cross-provider model selection for Roc

Research date: 2026-09-11. This is a research recommendation, not an approved routing change. No paid model comparisons were run. Model availability in provider documentation does not establish availability through the user's Pi account.

Roc should select models from measured outcomes for each role. My starting recommendation is a strong planner, a cheaper implementer for well-specified work, and a strong reviewer in a fresh session. Difficult implementation should also start with a strong model. Public evidence supports testing these arrangements, but does not establish one cross-provider winner for all three roles.

An advisor should choose a complete execution configuration: provider, model, reasoning setting, agent runtime, tools, and context policy. Anthropic explicitly describes agent evaluation as evaluation of the model and its surrounding execution system together. Changing the tools while comparing models changes the experiment. [Anthropic's agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

Roc already has a useful foundation. `createModelAdvisor` takes role, risk, retry count, and previous failure information. It maps Scout to Luna, Implement to Terra, and Review to Sol, and filters candidates by advertised reasoning support. High-risk work selects Sol. The profiles are configuration slots and can map to exact provider/model identifiers. [Current advisor](../../src/scheduler/model-routing.ts)

The current advisor also assumes that Luna, Terra, and Sol form one ascending quality order for every role. An unavailable model can trigger an upgrade. Those are simple initial rules, but cross-provider selection needs role-specific results and separate handling for service failures. A provider outage does not show that the task needs more reasoning.

The approved specification preserves exact model and effort on recovery, confirms actual execution settings, and uses an independent Review session. Keep those guarantees. The September 9 live validation proves that Astra with high Scout/Review and medium Implement can complete the tested flows. It does not compare models or establish a cost saving. [Routing specification](../specs/model-routing-context.md), [live validation](../validation/role-routing-live-2026-09-09.md)

The following role recommendations are hypotheses for evaluation, rather than benchmark rankings.

| Work | Starting policy | Evidence required before cheaper routing |
| --- | --- | --- |
| Scout that retrieves files, tests, and constraints | Small model with source tools and a bounded handoff | Correct source locations, essential context retained, no invented facts |
| Planning with unclear requirements or architectural tradeoffs | Strong reasoning model | A usable plan, explicit assumptions, appropriate scope, and acceptance criteria |
| Routine implementation with a clear specification | Balanced model with moderate reasoning where supported | Independent acceptance tests pass, existing behavior remains correct, and no excessive rework |
| Complex implementation or a high-impact change | Strong reasoning model from the first attempt | Same checks, with focused failure and recovery cases |
| Review | Strong model in a fresh session with the specification, exact commit, and relevant source | Real defect recall, finding precision, and correct acceptance of clean changes |

Scout and planning need different treatment even if Roc currently performs both in one role. Cheap retrieval can identify relevant files. Resolving an ambiguous requirement or defining recovery behavior is a harder decision. A role name alone does not capture that difference.

OpenAI's current documentation identifies `gpt-6-astra` as its most capable model for difficult reasoning and coding. `gpt-5.6-sol` is a flagship option, `gpt-5.6-terra` balances intelligence and cost, and `gpt-5.6-luna` targets inexpensive high-volume work. I would test Astra for planning and review, Terra for routine implementation, and Luna for bounded retrieval. Sol is another implementation candidate when Terra needs too much correction. These assignments are my inference from provider positioning. [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

The cross-provider shortlist is deliberately broader than Codex. These exact identifiers were checked against current provider documentation or model cards. The proposed roles remain hypotheses.

| Provider | Model identifier | Why include it in Roc's comparison |
| --- | --- | --- |
| Anthropic | `claude-opus-5` | Complex planning and implementation, plus independent review |
| Anthropic | `claude-fable-5-1` | Escalation for difficult reasoning or repeated quality failures |
| Anthropic | `claude-sonnet-5` | Everyday implementation with a lower per-token price than Opus |
| Google | `gemini-3.8-flash` | Balanced implementation, broad context analysis, and an alternative reviewer |
| DeepSeek | `deepseek-flash` | Budget implementation and review challenger, currently resolving to V4.1 Flash |
| Qwen | `Qwen/Qwen3.8-Flash-Next` | Open-weight implementation candidate when deployment control matters |

Anthropic positions Opus 5 for complex coding, Sonnet 5 for a balance of speed and intelligence, and Fable 5.1 for more demanding work. I would begin with Sonnet for routine implementation and Opus for planning. Fable is an escalation candidate if local results justify its additional cost. [Anthropic lineup](https://platform.claude.com/docs/en/models/overview), [Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview), [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview), [Sonnet 5](https://platform.claude.com/docs/en/models/sonnet-5/overview)

Google's guide recommends Gemini 3.8 Flash with medium thinking for complex coding and agentic work, and high thinking for harder multistep reasoning. This makes it a credible implementation trial despite the Flash name. [Google model guide](https://ai.google.dev/gemini-api/docs/latest-model)

DeepSeek's lifecycle notice illustrates why a routing catalog needs dates. On September 14, 2026 at 12:00 Beijing time, the provider says `deepseek-v4-pro` will start resolving to V4.1 Flash. Store the requested ID, observed version where exposed, and observation date. When a provider does not expose an immutable version, record that uncertainty and requalify the alias after a documented change. [DeepSeek model and lifecycle table](https://api-docs.deepseek.com/quick_start/pricing/)

Qwen's model card provides open-weight deployment instructions. Its benchmark notes also describe a refined SWE-bench Pro evaluation and differences in baseline evaluation setups. Its scores cannot establish superiority over the other models in this shortlist. Self-hosting adds serving and hardware costs that API token prices do not capture. [Qwen's official model card](https://huggingface.co/Qwen/Qwen3.8-Flash-Next)

For a practical first comparison, I would test Opus 5 planning, Sonnet 5 implementation, and Astra review against Roc's existing all-Astra baseline. Then test Gemini 3.8 Flash as the implementer. Include DeepSeek and Qwen when budget or deployment control is a primary requirement. This sequencing limits experiment size; it is not a claim that the first combination wins.

Reasoning settings must be validated through each provider adapter. Astra's API documentation lists low, medium, high, xhigh, and max. Those names do not establish equal compute or behavior in another provider. Preserve both the requested policy and the effective provider settings in the attempt record. [Astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)

Public review benchmarks are useful for selecting experiments. Factory's April 2026 table reports GPT-5.2 at 60.5% mean F1, Opus 4.6 at 59.8%, and GPT-5.5 at 47.9% in its review setup. That is evidence against assuming a newer model must review better. Its methodology excludes runs that error or hit token limits, so the quality table alone does not measure operational reliability. These results are historical and do not rank September models. [Factory review benchmark](https://docs.factory.ai/benchmarks/review-benchmark)

CodeReviewBench reports DeepSeek V4 Pro at 43.9 F1 on 30 PRs with 95 known bugs. It uses one production review system, one model run per entry, and a model judge. Many confidence intervals overlap. Its current leaderboard lists several recent frontier models as unmeasured. This makes DeepSeek a worthwhile review challenger, but does not prove it is the best reviewer for Roc. Do not compare its F1 directly with Factory's different test set. [Methodology](https://www.codereviewbench.com/), [leaderboard](https://www.codereviewbench.com/leaderboard)

For the advisor itself, I recommend deterministic selection first. Anthropic's routing pattern permits either an LLM or an ordinary classifier. RouteLLM demonstrates learned routing between stronger and cheaper models using preference data, with thresholds calibrated to the workload. Its published results do not establish reliable routing for Roc's planning and review tasks. A learned router becomes useful after Roc has representative outcome data. [Routing pattern](https://www.anthropic.com/engineering/building-effective-agents), [RouteLLM paper](https://arxiv.org/abs/2406.18665), [RouteLLM implementation](https://github.com/lm-sys/RouteLLM)

The proposed decision sequence is:

1. Filter to configured, available models that support the required tools, context, output contract, and effective reasoning setting. Respect explicit user model selections.
2. Classify the work using observable facts: requirement ambiguity, affected modules, external dependencies, impact of failure, available tests, and previous failure category. If an LLM helps classify, validate its structured output and treat uncertain cases conservatively.
3. Choose from a role-specific candidate order backed by local results. Until those results exist, retain a known working baseline and label alternatives as experimental.
4. Require evidence before accepting the role's output. Planning needs grounded constraints and acceptance criteria. Implementation needs the resulting commit and independent checks. Review needs a concrete trigger, source location, and consequence for each blocking finding.
5. Respond to failure by category. Retry transient service failures within a limit. Repair missing environment prerequisites. Escalate repeated reasoning failures. Return contradictory requirements for replanning.
6. Record the effective configuration, outcome, retries, latency, usage, and reason for selection. Preserve the original descriptor when recovering an existing attempt.

If an LLM advisor is added later, its job should be to classify task characteristics against a supplied catalog and measured results. It should not invent model identities or choose from remembered leaderboards. A deterministic layer should enforce eligibility and budget limits after its recommendation. There is no evidence here that paying for a flagship advisor on every task would outperform the existing rules.

Independent review should start with the requirement and code, without the implementer's persuasive narrative. Trying a different provider may expose different errors, but provider diversity is not proof of independence or higher accuracy. Compare fresh same-model review with fresh cross-provider review. Keep the second arrangement only if it catches additional real defects at an acceptable false-alarm rate.

The smallest useful local experiment is a pilot of roughly 12 to 20 representative tasks, with clean and defective patches for review. Include routine changes, ambiguous plans, cross-file changes, and a few existing failure or recovery cases. This is enough to reject poor candidates, not enough to claim narrow statistical wins.

Hold the repository revision, requirements, tools, acceptance checks, and budgets constant. Start with the recorded Astra configuration as a baseline. Change the implementation model first, then the planning model, then the reviewer. Repeat close comparisons on a held-out subset. Run the winning combination end to end because a weaker handoff can make the next role worse.

Evaluate planning by requirement coverage, false assumptions, unnecessary scope, and how much correction an implementer needs. Evaluate implementation by accepted outcomes, regressions, retries, and scope control. Evaluate review by confirmed defects found, false findings, missed severe defects, and correct acceptance of clean patches. Count tool errors and exhausted budgets as failures in end-to-end reporting. Human checks should calibrate any model grading. [Evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

Compare total cost per accepted task, including failed attempts, advisor calls, review, and repairs. Also report wall time and user intervention. Token price alone cannot answer this question. Subscription usage and catalog estimates are not actual billed API cost. [Existing Roc accounting caveat](../specs/model-routing-context.md)

Apply the repository's simplification rule to the experiment: remove the LLM advisor, extra reviewer, or separate planning pass one at a time, when the task permits it. Keep each removal if required behavior and quality survive. These are proposed ablation experiments; none were run for this research.
