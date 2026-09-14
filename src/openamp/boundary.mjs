import { remoteMutationReason } from "./command.mjs";

/** Installs the normal-path remote mutation boundary in a Pi process. */
export default function openAmpBoundary(pi) {
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
}
