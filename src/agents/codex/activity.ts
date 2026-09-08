import { z } from "zod";
import { HarnessActivitySchema } from "../../harness/contracts";

const ToolItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("commandExecution"),
    id: z.string(),
    command: z.string(),
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    exitCode: z.number().int().nullable().optional(),
    commandActions: z
      .array(
        z.object({
          type: z.string(),
          path: z.string().nullable().optional(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal("fileChange"),
    id: z.string(),
    status: z.enum(["inProgress", "completed", "failed", "declined"]),
    changes: z.array(z.object({ path: z.string() })),
  }),
  z.object({
    type: z.enum(["mcpToolCall", "dynamicToolCall"]),
    id: z.string(),
    status: z.enum(["inProgress", "completed", "failed"]),
    tool: z.string(),
    success: z.boolean().nullable().optional(),
  }),
]);

/** Projects supported tool items into bounded activity without command arguments, diffs, or output. */
export function codexActivity(
  rawItem: unknown,
  phase: "started" | "completed",
): z.infer<typeof HarnessActivitySchema> | undefined {
  const parsed = ToolItemSchema.safeParse(rawItem);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  let action: z.infer<typeof HarnessActivitySchema>["action"];
  let summary: string;
  switch (item.type) {
    case "commandExecution": {
      const read = item.commandActions?.find((entry) => entry.type === "read");
      if (read) {
        action = "read";
        summary = read.path ? `Read ${read.path}` : "Read file";
      } else if (
        item.commandActions?.some((entry) => entry.type === "search")
      ) {
        action = "search";
        summary = "Search files";
      } else if (
        /^(?:rtk\s+)?(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|(?:cargo|go)\s+test|pytest|vitest|jest)(?:\s|$)/u.test(
          item.command.trim(),
        )
      ) {
        action = "test";
        summary = "Run tests";
      } else {
        action = "command";
        summary = "Run command";
      }
      break;
    }
    case "fileChange":
      action = "edit";
      summary =
        item.changes.length === 1
          ? `Edit ${item.changes[0]?.path}`
          : `Edit ${item.changes.length} files`;
      break;
    default:
      action = "tool";
      summary = `Call ${item.tool}`;
  }
  const failed =
    item.status === "failed" ||
    item.status === "declined" ||
    (item.type === "commandExecution" &&
      item.exitCode != null &&
      item.exitCode !== 0) ||
    ("success" in item && item.success === false);
  const activity = HarnessActivitySchema.safeParse({
    itemId: item.id,
    action,
    summary,
    status: phase === "started" ? "running" : failed ? "failed" : "completed",
  });
  return activity.success ? activity.data : undefined;
}
