export type Usage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  known: boolean;
}>;
/** Sums recorded token use without counting the cache subset twice. */
export function summarizeUsage(_items: readonly Usage[]): {
  totalTokens: number;
  cachedInputTokens: number;
  incomplete: boolean;
} {
  throw new Error("Not implemented");
}
