import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { remoteMutationReason } from "./command.js";

/** Installs the normal-path remote mutation boundary in a Pi process. */
export default function piedPiperBoundary(pi: ExtensionAPI): void {
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
}
