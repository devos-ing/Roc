import { expect, test } from "bun:test";
import {
  probeArguments,
  productionReadGates,
} from "../../tools/github-production-read-probe";

test("production probe requires an explicit frozen baseline and validates complete stable gate evidence", () => {
  expect(() =>
    probeArguments(["--repo", "acme/test", "--baseline", "/fixture"]),
  ).toThrow();
  for (const max of ["0", "200", "NaN", "1.5"])
    expect(() =>
      probeArguments([
        "--live",
        "--repo",
        "acme/test",
        "--baseline",
        "/fixture",
        "--max-http",
        max,
      ]),
    ).toThrow();
  expect(
    probeArguments([
      "--live",
      "--repo",
      "acme/test",
      "--baseline",
      "/fixture",
      "--max-http",
      "199",
    ]).maxHttp,
  ).toBe(199);
  const legs: Parameters<typeof productionReadGates>[0] = [
    "rest",
    "graphql",
    "graphql",
    "rest",
    "rest",
    "graphql",
  ].map((kind) => ({
    kind: kind as "rest" | "graphql",
    startedAt: "2026-09-11T00:00:00Z",
    endedAt: "2026-09-11T00:00:01Z",
    elapsedMs: 1000,
    httpRequests: kind === "rest" ? 2 : 1,
    overshoot: 0,
    digest: "same",
    queries:
      kind === "rest"
        ? []
        : [{ cost: 1, limit: 5000, remaining: 4000, resetAt: 9999999 }],
    commands: [],
  }));
  expect(Object.values(productionReadGates(legs)).every(Boolean)).toBe(true);
  for (const fault of [
    "missing-quota",
    "drift",
    "missing-kind",
    "overshoot",
    "failed",
  ] as const) {
    const changed = structuredClone(legs);
    if (fault === "missing-quota") changed[1]!.queries = [];
    if (fault === "drift") changed[1]!.digest = "changed";
    if (fault === "missing-kind") for (const leg of changed) leg.kind = "rest";
    if (fault === "overshoot") changed[1]!.overshoot = 1;
    if (fault === "failed") changed[1]!.code = "permission";
    expect(Object.values(productionReadGates(changed)).every(Boolean)).toBe(
      false,
    );
  }
});
