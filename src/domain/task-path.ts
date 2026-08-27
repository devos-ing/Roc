import { z } from "zod";

export const SafeTaskPathComponentSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Unsafe task path component");

export function safeTaskPathComponent(value: string): string {
  return SafeTaskPathComponentSchema.parse(value);
}
