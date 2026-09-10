import { expect, test } from "bun:test";
import {
  AcceptanceResultSchema,
  projectAcceptanceChecklist,
} from "../../src/domain/acceptance-checklist";

const criteria = ["first criterion", "duplicate wording", "duplicate wording"];
const binding = {
  currentSpecHash: "sha256:current",
  reviewedSpecHash: "sha256:current",
  currentHeadSha: "head",
  reviewedHeadSha: "head",
  currentBaseSha: "base",
  reviewedBaseSha: "base",
};

test("projects complete current Review evidence by its original criterion indexes", () => {
  expect(
    projectAcceptanceChecklist(
      criteria,
      [
        { criterionIndex: 2, status: "failed", evidence: "third failed" },
        { criterionIndex: 0, status: "passed", evidence: "first passed" },
        { criterionIndex: 1, status: "unverified", evidence: "not run" },
      ],
      binding,
    ),
  ).toEqual([
    {
      criterionIndex: 0,
      criterion: "first criterion",
      status: "passed",
      evidence: "first passed",
    },
    {
      criterionIndex: 1,
      criterion: "duplicate wording",
      status: "unverified",
      evidence: "not run",
    },
    {
      criterionIndex: 2,
      criterion: "duplicate wording",
      status: "failed",
      evidence: "third failed",
    },
  ]);
});

test("keeps every item unverified when evidence is partial, duplicate, stale, or empty", () => {
  const cases = [
    [{ criterionIndex: 0, status: "passed", evidence: "only one" }],
    [
      { criterionIndex: 0, status: "passed", evidence: "one" },
      { criterionIndex: 0, status: "passed", evidence: "duplicate" },
      { criterionIndex: 2, status: "passed", evidence: "three" },
    ],
    [
      { criterionIndex: 0, status: "passed", evidence: "one" },
      { criterionIndex: 1, status: "passed", evidence: "two" },
      { criterionIndex: 3, status: "passed", evidence: "out of range" },
    ],
  ] as const;
  for (const results of cases)
    expect(projectAcceptanceChecklist(criteria, results, binding)).toEqual(
      criteria.map((criterion, criterionIndex) => ({
        criterionIndex,
        criterion,
        status: "unverified",
      })),
    );
  expect(
    AcceptanceResultSchema.safeParse({
      criterionIndex: 0,
      status: "passed",
      evidence: " ",
    }).success,
  ).toBe(false);
  expect(
    projectAcceptanceChecklist(
      criteria,
      [
        { criterionIndex: 0, status: "passed", evidence: "one" },
        { criterionIndex: 1, status: "passed", evidence: "two" },
        { criterionIndex: 2, status: "passed", evidence: "three" },
      ],
      { ...binding, currentHeadSha: "new-head" },
    ).every((item) => item.status === "unverified"),
  ).toBe(true);
});
