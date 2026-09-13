import { Type } from "typebox";
import { remoteMutationReason } from "./command.mjs";

/** Formats durable child state for both the TUI widget and model tool result. */
function agentLines(supervisor) {
  const runs = supervisor.list();
  return runs.length === 0
    ? ["No child agents"]
    : runs.map(
        (run) =>
          `${run.id}  ${run.role}  ${run.status}${run.model ? `  ${run.model}:${run.effort ?? "default"}` : ""}`,
      );
}

/** Returns whether a result ID already exists in the current Pi branch. */
function branchContainsResult(context, resultId) {
  return context.sessionManager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "openamp-result" &&
        entry.details?.resultId === resultId,
    );
}

/** Creates the Pi extension that exposes OpenAmp collaboration and delivery. */
export function createOpenAmpExtension(store, supervisor, workspace, delivery) {
  return {
    name: "openamp",
    factory(pi) {
      let currentContext;
      const pendingDeliveries = new Set();

      /** Refreshes the compact OpenAmp status shown by Pi's native footer. */
      function refreshStatus(context) {
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
      }

      /** Injects one persisted result into only its original parent session. */
      async function deliverResult(result, context, triggerTurn = true) {
        const sessionId = context.sessionManager.getSessionId();
        const run = store.state.runs[result.runId];
        if (run.parentSessionId && run.parentSessionId !== sessionId)
          return false;
        if (branchContainsResult(context, result.id)) {
          pendingDeliveries.delete(result.id);
          if (result.deliveredSessionId !== sessionId) {
            await store.update((state) => {
              state.results[result.id].deliveredSessionId = sessionId;
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
            state.results[result.id].deliveredSessionId = sessionId;
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
        pendingDeliveries.clear();
        const sessionId = context.sessionManager.getSessionId();
        const persistedUserInputs = context.sessionManager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "message" && entry.message?.role === "user",
          ).length;
        await store.update((state) => {
          state.sessionId = sessionId;
          state.sessionFile = context.sessionManager.getSessionFile();
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

      pi.on("before_agent_start", () => ({
        systemPrompt: [
          `You are the conversational main agent for OpenAmp change ${store.state.id}.`,
          `Work only in ${store.state.workspace}.`,
          "Delegate only when useful. Research agents are read-only; writer agents use isolated worktrees.",
          "Use integrate_result for selected writer results. Never push, create/modify/merge a PR, or call GitHub mutation APIs.",
          "When the requested modifying work is complete, call deliver_change with exact current requirements and validation commands. Delivery requires independent review and opens or updates the PR; only the user merges.",
        ].join("\n"),
      }));

      pi.on("input", async (event) => {
        if (event.source === "extension") return undefined;
        await store.update((state) => {
          state.inputGeneration = (state.inputGeneration ?? 0) + 1;
        });
        return undefined;
      });

      pi.on("tool_call", (event) => {
        if (event.toolName !== "bash") return undefined;
        const reason = remoteMutationReason(String(event.input.command ?? ""));
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
        description: "List OpenAmp child-agent roles and lifecycle states",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: agentLines(supervisor).join("\n") }],
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
          "Validate, independently review, and publish the current change as a PR",
        parameters: Type.Object({
          title: Type.String({ minLength: 1 }),
          requirements: Type.String({ minLength: 1 }),
          validation_commands: Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
          }),
        }),
        execute: async (_id, parameters) => {
          const pullRequest = await delivery.deliver({
            title: parameters.title,
            requirements: parameters.requirements,
            validationCommands: parameters.validation_commands,
            inputGeneration: store.state.inputGeneration ?? 0,
          });
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
