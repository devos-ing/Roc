import { z } from "zod";
import { HarnessActivitySchema } from "../../harness/contracts";

const ToolEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string().min(1).max(512),
    toolName: z.string().min(1),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string().min(1).max(512),
    toolName: z.string().min(1),
    isError: z.boolean(),
  }),
]);
const ToolArgumentsSchema = z.object({
  path: z.string().optional(),
  command: z.string().optional(),
});
type Activity = z.infer<typeof HarnessActivitySchema>;

/** Summarizes Pi tool lifecycles without retaining arguments, file contents, or command output. */
export function piActivity(
  rawEvent: unknown,
  previous?: Activity,
): Activity | undefined {
  const parsed = ToolEventSchema.safeParse(rawEvent);
  if (!parsed.success) return undefined;
  const event = parsed.data;
  if (event.type === "tool_execution_end" && previous !== undefined) {
    return { ...previous, status: event.isError ? "failed" : "completed" };
  }
  const args = ToolArgumentsSchema.safeParse(
    event.type === "tool_execution_start" ? event.args : {},
  );
  const path = args.success ? args.data.path : undefined;
  const command = args.success ? args.data.command : undefined;
  let action: Activity["action"] = "tool";
  let summary = `Call ${event.toolName}`;
  switch (event.toolName) {
    case "read":
      action = "read";
      summary = path ? `Read ${path}` : "Read file";
      break;
    case "edit":
    case "write":
      action = "edit";
      summary = path ? `Edit ${path}` : "Edit file";
      break;
    case "grep":
    case "find":
    case "ls":
      action = "search";
      summary = "Search files";
      break;
    case "bash":
      action =
        /^(?:rtk\s+)?(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|(?:cargo|go)\s+test|pytest|vitest|jest)(?:\s|$)/u.test(
          command?.trim() ?? "",
        )
          ? "test"
          : "command";
      summary = action === "test" ? "Run tests" : "Run command";
      break;
  }
  const activity = HarnessActivitySchema.safeParse({
    itemId: event.toolCallId,
    action,
    summary,
    status:
      event.type === "tool_execution_start"
        ? "running"
        : event.isError
          ? "failed"
          : "completed",
  });
  return activity.success ? activity.data : undefined;
}
