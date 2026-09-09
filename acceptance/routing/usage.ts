export type Usage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  known: boolean;
}>;
/** Sums recorded token use without counting the cache subset twice. */
export function summarizeUsage(items: readonly Usage[]): {
  totalTokens: number;
  cachedInputTokens: number;
  incomplete: boolean;
} {
  let totalTokens = 0;
  let cachedInputTokens = 0;
  let incomplete = false;

  for (const item of items) {
    totalTokens += item.inputTokens + item.outputTokens;
    cachedInputTokens += item.cachedInputTokens;
    if (item.known === false) {
      incomplete = true;
    }
  }

  return { totalTokens, cachedInputTokens, incomplete };
}
