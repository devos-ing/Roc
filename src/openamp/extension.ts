import {
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { remoteMutationReason } from "./command.js";
import type { ChangeDelivery } from "./delivery.js";
import {
  MAX_PLAN_ITEMS,
  planContext,
  progressLines,
  progressText,
  updateTaskPlan,
} from "./progress.js";
import type { AgentResult, ChangeState, ChangeStore } from "./state.js";
import type { AgentSupervisor } from "./supervisor.js";
import type { ChangeWorkspace } from "./workspace.js";

/** Formats durable child state for both the TUI widget and model tool result. */
function agentLines(supervisor: AgentSupervisor): string[] {
  const runs = supervisor.list();
  return runs.length === 0
    ? ["No child agents"]
    : runs.map(
        (run) =>
          `${run.id}  ${run.role}  ${run.status}${run.model ? `  ${run.model}:${run.effort ?? "default"}` : ""}`,
      );
}

/** Returns whether a result ID already exists in the current Pi branch. */
function branchContainsResult(
  context: ExtensionContext,
  resultId: string,
): boolean {
  return context.sessionManager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "openamp-result" &&
        (entry.details as { resultId?: string } | undefined)?.resultId ===
          resultId,
    );
}

/** Returns a persisted result that must still exist during delivery. */
function requireResult(state: ChangeState, resultId: string): AgentResult {
  const result = state.results[resultId];
  if (!result) throw new Error(`Persisted result is missing: ${resultId}`);
  return result;
}

/** Creates the Pi extension that exposes OpenAmp collaboration and delivery. */
export function createOpenAmpExtension(
  store: ChangeStore,
  supervisor: AgentSupervisor,
  workspace: ChangeWorkspace,
  delivery: ChangeDelivery,
): InlineExtension {
  return {
    name: "openamp",
    factory(pi: ExtensionAPI) {
      let currentContext: ExtensionContext | undefined;
      const pendingDeliveries = new Set<string>();
      let mainBusy = false;
      let planExpanded = false;

      /** Returns bounded status for the same owned child and cancels only on an explicit abort. */
      async function waitForChild(
        runId: string,
        waitMs: number,
        signal: AbortSignal | undefined,
        context: ExtensionContext,
      ) {
        const run = store.state.runs[runId];
        if (
          !run ||
          (run.parentSessionId &&
            run.parentSessionId !== context.sessionManager.getSessionId())
        ) {
          throw new Error(
            "This child does not belong to the current parent session",
          );
        }
        let cancellation: Promise<void> | undefined;
        /** Links explicit tool interruption to the existing child's cancellation path. */
        const cancel = () => {
          if (
            ["queued", "starting", "running", "cancelling"].includes(run.status)
          ) {
            cancellation ??= supervisor.cancel(runId);
            void cancellation.catch(() => undefined);
          }
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        try {
          const state = await supervisor.waitForStatus(runId, waitMs);
          if (signal?.aborted)
            throw new Error(`Child wait cancelled: ${runId}`);
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `${state.id} ${state.status}`,
                  state.model
                    ? `Model: ${state.model}; effort: ${state.effort}`
                    : "Model startup not yet confirmed.",
                  state.resultId
                    ? `Result ${state.resultId} is saved; its advice appears in the parent result message.`
                    : (state.failure ??
                      "If still active, wait again with agent_wait; do not start a duplicate."),
                ].join("\n"),
              },
            ],
            details: {
              runId: state.id,
              status: state.status,
              resultId: state.resultId,
              model: state.model,
              effort: state.effort,
            },
          };
        } finally {
          signal?.removeEventListener("abort", cancel);
          await cancellation;
        }
      }

      /** Refreshes the compact OpenAmp status shown by Pi's native footer. */
      function refreshStatus(context: ExtensionContext | undefined): void {
        if (!context) return;
        const active = supervisor
          .list()
          .filter((run) =>
            ["queued", "starting", "running", "cancelling"].includes(
              run.status,
            ),
          );
        context.ui.setStatus(
          "openamp",
          `${store.state.id} · ${active.length} agent${active.length === 1 ? "" : "s"} · ${store.state.phase}`,
        );
        context.ui.setWidget(
          "openamp-progress",
          progressLines(store.state, planExpanded, mainBusy),
        );
      }

      const stopObserving = store.observeChanges(() =>
        refreshStatus(currentContext),
      );
      pi.on("session_shutdown", () => {
        stopObserving();
        currentContext = undefined;
      });

      /** Injects one persisted result into only its original parent session. */
      async function deliverResult(
        result: AgentResult,
        context: ExtensionContext,
        triggerTurn = true,
      ): Promise<boolean> {
        const sessionId = context.sessionManager.getSessionId();
        const run = store.state.runs[result.runId];
        if (!run) throw new Error(`Result run is missing: ${result.runId}`);
        if (run.parentSessionId && run.parentSessionId !== sessionId)
          return false;
        if (branchContainsResult(context, result.id)) {
          pendingDeliveries.delete(result.id);
          if (result.deliveredSessionId !== sessionId) {
            await store.update((state) => {
              requireResult(state, result.id).deliveredSessionId = sessionId;
            });
          }
          refreshStatus(context);
          return true;
        }
        if (pendingDeliveries.has(result.id)) return false;
        pendingDeliveries.add(result.id);
        try {
          pi.sendMessage(
            {
              customType: "openamp-result",
              content: [
                `OpenAmp child result ${result.id} from ${result.runId} (${result.role}).`,
                run.model
                  ? `Model: ${run.model}; effort: ${run.effort ?? "default"}.`
                  : "",
                result.role === "oracle"
                  ? "Oracle advice is not a publication approval; verify it against the current code."
                  : "",
                result.role === "oracle" &&
                run.inputGeneration !== store.state.inputGeneration
                  ? "The parent received new input after this consultation started; the advice may be stale."
                  : "",
                result.commit
                  ? `Verified result commit: ${result.commit}`
                  : "No result commit.",
                result.summary,
              ].join("\n\n"),
              display: true,
              details: { resultId: result.id, runId: result.runId },
            },
            { deliverAs: "followUp", triggerTurn },
          );
        } catch (error) {
          pendingDeliveries.delete(result.id);
          throw error;
        }
        if (branchContainsResult(context, result.id)) {
          pendingDeliveries.delete(result.id);
          await store.update((state) => {
            requireResult(state, result.id).deliveredSessionId = sessionId;
          });
        }
        refreshStatus(context);
        return branchContainsResult(context, result.id);
      }

      supervisor.setDeliveryHandler(async (result) => {
        if (currentContext) await deliverResult(result, currentContext);
      });

      pi.on("session_start", async (_event, context) => {
        currentContext = context;
        mainBusy = false;
        planExpanded = false;
        pendingDeliveries.clear();
        const sessionId = context.sessionManager.getSessionId();
        const persistedUserInputs = context.sessionManager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "message" && entry.message?.role === "user",
          ).length;
        await store.update((state) => {
          if (
            state.activity?.status === "running" &&
            (state.activity.owner === "main" ||
              !state.activity.runId ||
              !["starting", "running", "cancelling"].includes(
                state.runs[state.activity.runId]?.status ?? "",
              ))
          ) {
            state.activity.status = "interrupted";
          }
          state.sessionId = sessionId;
          state.sessionFile = context.sessionManager.getSessionFile() ?? null;
          state.inputGeneration = Math.max(
            state.inputGeneration ?? 0,
            persistedUserInputs,
          );
        });
        context.ui.setTitle(`OpenAmp · ${store.state.id}`);
        context.ui.setWidget("openamp-change", [
          `OpenAmp ${store.state.id}`,
          `workspace: ${store.state.workspace}`,
          `branch: ${store.state.branch ?? "none (conversation only)"}`,
          `Oracle: ${store.state.oracleModel ? `${store.state.oracleModel} · high` : "not configured (optional)"}`,
          store.state.repoRoot
            ? `PR target: ${store.state.baseBranch ?? "unavailable"}`
            : "Git unavailable: writer agents and PR delivery are disabled",
        ]);
        refreshStatus(context);
        for (const result of Object.values(store.state.results)) {
          if (!store.state.runs[result.runId]?.deliveryOnly)
            await deliverResult(result, context, false);
        }
      });

      pi.on("agent_end", async (_event, context) => {
        for (const resultId of [...pendingDeliveries]) {
          const result = store.state.results[resultId];
          if (!result) {
            pendingDeliveries.delete(resultId);
            continue;
          }
          if (!branchContainsResult(context, resultId)) {
            pendingDeliveries.delete(resultId);
          }
          await deliverResult(result, context, false);
        }
      });

      pi.on("agent_start", (_event, context) => {
        currentContext = context;
        mainBusy = true;
        refreshStatus(context);
      });

      pi.on("agent_settled", async (_event, context) => {
        mainBusy = false;
        await store.update((state) => {
          if (
            state.activity?.owner === "main" &&
            state.activity.status === "running"
          )
            state.activity.status = "interrupted";
        });
        refreshStatus(context);
      });

      pi.on("tool_execution_start", async (event) => {
        await store.update((state) => {
          state.activity = {
            owner: "main",
            tool: progressText(event.toolName, 80),
            status: "running",
            at: new Date().toISOString(),
          };
        });
      });

      pi.on("tool_execution_end", async (event) => {
        await store.update((state) => {
          state.activity = {
            owner: "main",
            tool: progressText(event.toolName, 80),
            status: event.isError ? "failed" : "completed",
            at: new Date().toISOString(),
          };
        });
      });

      pi.on("session_before_switch", async (_event, context) => {
        const active = supervisor
          .list()
          .some((run) =>
            ["queued", "starting", "running", "cancelling"].includes(
              run.status,
            ),
          );
        if (active) {
          context.ui.notify(
            "Stop or wait for child agents before switching sessions",
            "warning",
          );
          return { cancel: true };
        }
        return undefined;
      });

      pi.on("before_agent_start", (event) => ({
        systemPrompt: [
          event.systemPrompt,
          `You are the main coding agent for OpenAmp change ${store.state.id}.`,
          `Work only in ${store.state.workspace}.`,
          "For multi-step work, maintain a short checklist with update_plan. Use stable step IDs and the current expected_revision; only one step may be in progress. Completed steps need concrete evidence in note, and blocked steps need a reason. Use agent_status to refresh a stale revision. Checklist completion is reported progress, not validation or publication approval. Do not create a checklist for a simple question.",
          planContext(store.state),
          "Plan, edit code, run checks, and apply fixes in this main thread. Delegate independent work only when useful. Research agents are read-only; delegated writers use isolated worktrees.",
          "Use ask_oracle for a focused second opinion on difficult planning, debugging, tradeoffs, or review. Oracle use is optional; you remain responsible for edits and checking its advice. If it is still running, use agent_wait on the returned ID rather than starting another consultation. Advice arrives once as an OpenAmp result message and never grants publication approval.",
          "Use integrate_result for selected writer results. Never push, create/modify/merge a PR, or call GitHub mutation APIs.",
          "When the requested modifying work is complete, call deliver_change with exact current requirements and validation commands. Delivery validates and opens or updates the PR; independent review is optional. Set review=true only when review is requested. Only the user merges.",
        ].join("\n"),
      }));

      pi.on("input", async (event) => {
        if (event.source === "extension") return undefined;
        store.state.inputGeneration = (store.state.inputGeneration ?? 0) + 1;
        await store.update(() => undefined);
        return undefined;
      });

      pi.on("tool_call", (event) => {
        if (!isToolCallEventType("bash", event)) return undefined;
        const reason = remoteMutationReason(event.input.command);
        return reason ? { block: true, reason } : undefined;
      });

      pi.on("user_bash", (event) => {
        const reason = remoteMutationReason(event.command);
        return reason
          ? {
              result: {
                output: reason,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            }
          : undefined;
      });

      pi.registerTool({
        name: "update_plan",
        label: "Update checklist",
        description:
          "Persist the current change's checklist without changing delivery approval; use evidence notes for completed steps and reasons for blockers",
        parameters: Type.Object({
          expected_revision: Type.Integer({ minimum: 0 }),
          items: Type.Array(
            Type.Object({
              id: Type.String({ minLength: 1, maxLength: 40 }),
              text: Type.String({ minLength: 1, maxLength: 160 }),
              status: Type.Union([
                Type.Literal("pending"),
                Type.Literal("in_progress"),
                Type.Literal("blocked"),
                Type.Literal("completed"),
              ]),
              note: Type.Optional(Type.String({ maxLength: 240 })),
            }),
            { maxItems: MAX_PLAN_ITEMS },
          ),
        }),
        execute: async (_id, parameters) => {
          const plan = await updateTaskPlan(
            store,
            parameters.expected_revision,
            parameters.items,
          );
          return {
            content: [{ type: "text", text: planContext(store.state) }],
            details: { revision: plan.revision },
          };
        },
      });

      pi.registerTool({
        name: "ask_oracle",
        label: "Ask Oracle",
        description:
          "Consult the configured read-only high-effort Oracle and return its existing run status; advice arrives in a result message",
        parameters: Type.Object({
          question: Type.String({ minLength: 1, maxLength: 4000 }),
          context: Type.Optional(Type.String({ maxLength: 16000 })),
        }),
        execute: async (_id, parameters, signal, _onUpdate, context) => {
          if (signal?.aborted)
            throw new Error("Oracle request cancelled before launch");
          if (!parameters.question.trim())
            throw new Error("Oracle question must not be empty");
          const selected = store.state.oracleModel;
          if (!selected)
            throw new Error(
              "Configure --oracle-model <provider/model> to enable Oracle advice",
            );
          const model = context.modelRegistry
            .getAvailable()
            .find((item) => `${item.provider}/${item.id}` === selected);
          if (!model?.reasoning)
            throw new Error(
              "The selected Oracle must be an authenticated Pi reasoning model; no fallback was selected",
            );
          const run = await supervisor.delegate({
            role: "oracle",
            prompt: [parameters.question.trim(), parameters.context ?? ""]
              .filter(Boolean)
              .join("\n\nRelevant context:\n"),
            parentSessionId: context.sessionManager.getSessionId(),
          });
          refreshStatus(context);
          return waitForChild(run.id, 1000, signal, context);
        },
      });

      pi.registerTool({
        name: "agent_wait",
        label: "Wait for agent",
        description:
          "Wait briefly for one existing child; expiration returns status and leaves the same child running",
        parameters: Type.Object({
          run_id: Type.String({ minLength: 1 }),
          wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
        }),
        execute: async (_id, parameters, signal, _onUpdate, context) =>
          waitForChild(
            parameters.run_id,
            parameters.wait_ms ?? 10000,
            signal,
            context,
          ),
      });

      pi.registerTool({
        name: "delegate",
        label: "Delegate",
        description:
          "Start a bounded researcher or isolated writer Pi child agent",
        promptGuidelines: [
          "Use delegate only when a focused child assignment improves speed or independence; children cannot delegate.",
        ],
        parameters: Type.Object({
          role: Type.Union([
            Type.Literal("researcher"),
            Type.Literal("writer"),
          ]),
          prompt: Type.String({ minLength: 1 }),
        }),
        execute: async (_id, parameters) => {
          const run = await supervisor.delegate({
            ...parameters,
            parentSessionId: store.state.sessionId,
          });
          refreshStatus(currentContext);
          return {
            content: [
              {
                type: "text",
                text: `${run.id} ${run.status}; continue the main conversation while OpenAmp owns its result delivery.`,
              },
            ],
            details: { runId: run.id, status: run.status },
          };
        },
      });

      pi.registerTool({
        name: "agent_status",
        label: "Agent status",
        description:
          "Read the current checklist revision and child-agent lifecycle states",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [
            {
              type: "text",
              text: [planContext(store.state), ...agentLines(supervisor)].join(
                "\n",
              ),
            },
          ],
          details: {},
        }),
      });

      pi.registerTool({
        name: "integrate_result",
        label: "Integrate result",
        description:
          "Integrate one verified writer result into the feature workspace",
        parameters: Type.Object({ result_id: Type.String({ minLength: 1 }) }),
        execute: async (_id, parameters) => {
          const head = await workspace.integrate(parameters.result_id);
          refreshStatus(currentContext);
          return {
            content: [
              {
                type: "text",
                text: `Integrated ${parameters.result_id} at ${head}`,
              },
            ],
            details: { resultId: parameters.result_id, head },
          };
        },
      });

      pi.registerTool({
        name: "deliver_change",
        label: "Deliver change",
        description:
          "Validate and publish the current change as a PR, optionally requesting independent review",
        parameters: Type.Object({
          title: Type.String({ minLength: 1 }),
          requirements: Type.String({ minLength: 1 }),
          review: Type.Optional(
            Type.Boolean({
              description:
                "Request a fresh independent review before publishing; defaults to false",
            }),
          ),
          validation_commands: Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
          }),
        }),
        execute: async (_id, parameters, signal) => {
          const pullRequest = await delivery.deliver(
            {
              title: parameters.title,
              review: parameters.review ?? false,
              requirements: parameters.requirements,
              validationCommands: parameters.validation_commands,
              inputGeneration: store.state.inputGeneration ?? 0,
            },
            signal,
          );
          refreshStatus(currentContext);
          return {
            content: [
              { type: "text", text: `Pull request ready: ${pullRequest.url}` },
            ],
            details: pullRequest,
          };
        },
      });

      pi.registerCommand("agents", {
        description: "Show OpenAmp child agents",
        handler: async (_arguments, context) => {
          context.ui.setWidget("openamp-agents", [
            "OpenAmp agents",
            ...agentLines(supervisor),
          ]);
          refreshStatus(context);
        },
      });

      pi.registerCommand("plan", {
        description: "Expand or collapse the current change's checklist",
        handler: async (_arguments, context) => {
          planExpanded = !planExpanded;
          refreshStatus(context);
        },
      });

      pi.registerCommand("agent-send", {
        description: "Send steering: /agent-send <run-id> <message>",
        handler: async (argumentsText, context) => {
          const [runId, ...parts] = argumentsText.trim().split(/\s+/u);
          if (!runId || parts.length === 0) {
            context.ui.notify(
              "Usage: /agent-send <run-id> <message>",
              "warning",
            );
            return;
          }
          await supervisor.send(runId, parts.join(" "));
          context.ui.notify(`Sent steering to ${runId}`, "info");
        },
      });

      pi.registerCommand("agent-cancel", {
        description: "Cancel one child: /agent-cancel <run-id>",
        handler: async (runId, context) => {
          await supervisor.cancel(runId.trim());
          refreshStatus(context);
          context.ui.notify(`Cancelled ${runId.trim()}`, "info");
        },
      });
    },
  };
}
