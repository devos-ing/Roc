import { expect, test } from "bun:test";
import { createModelAdvisor } from "../../src/scheduler/model-routing";

const catalog = [
  { id: "gpt-5.6-luna", supportedReasoningEfforts: ["medium", "high"] },
  {
    id: "gpt-5.6-terra",
    supportedReasoningEfforts: ["medium", "high", "xhigh"],
  },
  { id: "gpt-5.6-sol", supportedReasoningEfforts: ["medium", "high", "xhigh"] },
];

test("Astra uses high for reasoning roles and medium for implementation across risks and retries", () => {
  const model = "openai-codex/gpt-6-astra";
  const advisor = createModelAdvisor(
    [{ id: model, supportedReasoningEfforts: ["medium", "high", "xhigh"] }],
    { luna: model, terra: model, sol: model },
  );
  for (const role of ["scout", "implement", "review"] as const) {
    for (const risk of ["low", "medium", "high"] as const) {
      expect(advisor.decide({ role, risk, retryIndex: 0 })).toMatchObject({
        model,
        effort: role === "implement" ? "medium" : "high",
      });
    }
    expect(
      advisor.decide({
        role,
        risk: "high",
        retryIndex: 2,
        priorProfile: "sol",
      }),
    ).toMatchObject({
      model,
      effort: role === "implement" ? "medium" : "high",
    });
  }
  const unsupported = createModelAdvisor(
    [{ id: model, supportedReasoningEfforts: ["high"] }],
    { luna: model, terra: model, sol: model },
  );
  expect(
    unsupported.decide({ role: "implement", risk: "low", retryIndex: 0 }),
  ).toBeUndefined();
});

test("resolves profiles to actual models without ever selecting low", () => {
  const advisor = createModelAdvisor(catalog);

  expect(
    advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "luna",
    model: "gpt-5.6-luna",
    effort: "high",
    fallbacks: ["gpt-5.6-terra", "gpt-5.6-sol"],
  });
  expect(
    advisor.decide({ role: "scout", risk: "high", retryIndex: 0 }),
  ).toMatchObject({
    profile: "sol",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  expect(
    advisor.decide({
      role: "implement",
      risk: "medium",
      retryIndex: 2,
      priorProfile: "terra",
      priorErrorCode: "backend_unavailable",
    }),
  ).toMatchObject({ profile: "sol", model: "gpt-5.6-sol", effort: "medium" });
});

test("high-risk roles and retries stay on Sol and never infer around its explicit mapping", () => {
  const advisor = createModelAdvisor(catalog);
  for (const role of ["scout", "implement", "review"] as const) {
    expect(
      advisor.decide({
        role,
        risk: "high",
        retryIndex: 1,
        priorProfile: "luna",
      }),
    ).toMatchObject({
      profile: "sol",
      effort: role === "implement" ? "medium" : "high",
      fallbacks: [],
    });
  }
  const mapped = createModelAdvisor(
    [
      ...catalog,
      { id: "provider/selected", supportedReasoningEfforts: ["medium"] },
    ],
    { sol: "provider/selected" },
  );
  expect(
    mapped.decide({ role: "scout", risk: "high", retryIndex: 0 }),
  ).toBeUndefined();
  expect(
    createModelAdvisor(catalog, { sol: "missing" }).decide({
      role: "review",
      risk: "medium",
      retryIndex: 0,
    }),
  ).toBeUndefined();
});

test("returns undefined when no model supports the required effort", () => {
  const advisor = createModelAdvisor([
    { id: "gpt-5.6-luna", supportedReasoningEfforts: ["low", "medium"] },
  ]);

  expect(
    advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 }),
  ).toBeUndefined();
});

test("honors exact profile mapping and catalog order for compatible fallbacks", () => {
  const advisor = createModelAdvisor(
    [
      {
        id: "gpt-5.6-first-terra",
        supportedReasoningEfforts: ["medium", "high"],
      },
      { id: "codex-model-2", supportedReasoningEfforts: ["medium", "high"] },
      { id: "codex-model-3", supportedReasoningEfforts: ["medium", "high"] },
    ],
    {
      terra: "codex-model-2",
      sol: "codex-model-3",
    },
  );

  expect(
    advisor.decide({ role: "implement", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "terra",
    model: "codex-model-2",
    fallbacks: ["codex-model-3"],
  });

  expect(
    createModelAdvisor([
      {
        id: "gpt-5.6-first-terra",
        supportedReasoningEfforts: ["medium", "high"],
      },
      {
        id: "gpt-5.6-second-terra",
        supportedReasoningEfforts: ["medium", "high"],
      },
    ]).decide({ role: "implement", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    model: "gpt-5.6-first-terra",
  });
});

test("recognizes only a terminal profile token", () => {
  const advisor = createModelAdvisor([
    { id: "gpt-5.6-luna-terra", supportedReasoningEfforts: ["medium", "high"] },
    { id: "gpt-5.6-lunaish", supportedReasoningEfforts: ["medium", "high"] },
    {
      id: "gpt-5.6-current-luna",
      supportedReasoningEfforts: ["medium", "high"],
    },
  ]);

  expect(
    advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "luna",
    model: "gpt-5.6-current-luna",
  });
  expect(
    advisor.decide({ role: "implement", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "terra",
    model: "gpt-5.6-luna-terra",
  });
  expect(
    createModelAdvisor([
      { id: "gpt-5.6-lunaish", supportedReasoningEfforts: ["medium", "high"] },
    ]).decide({ role: "scout", risk: "medium", retryIndex: 0 }),
  ).toBeUndefined();
});

test("keeps an immutable snapshot of catalog and mapping inputs", () => {
  const mutableCatalog = [
    { id: "model-a", supportedReasoningEfforts: ["medium", "high"] },
    { id: "model-b", supportedReasoningEfforts: ["medium", "high"] },
  ];
  const mapping = { luna: "model-a", terra: "model-b" };
  const advisor = createModelAdvisor(mutableCatalog, mapping);

  mutableCatalog[0]!.id = "model-a-mutated";
  mutableCatalog[0]!.supportedReasoningEfforts.splice(0);
  mapping.luna = "model-b";

  expect(
    advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "luna",
    model: "model-a",
  });
});

test("applies configured per-role efforts and leaves unset roles unchanged", () => {
  const advisor = createModelAdvisor(catalog, undefined, {
    efforts: { implement: "high", scout: "medium" },
  });

  expect(
    advisor.decide({ role: "implement", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "terra",
    model: "gpt-5.6-terra",
    effort: "high",
    rationale: [
      "implement baseline",
      "medium risk",
      "effort high (configured)",
    ],
  });
  expect(
    advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "luna",
    model: "gpt-5.6-luna",
    effort: "medium",
  });
  expect(
    advisor.decide({ role: "review", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "sol",
    model: "gpt-5.6-sol",
    effort: "high",
    rationale: ["review baseline", "medium risk"],
  });
});

test("routes a configured xhigh effort and advances the chain for support", () => {
  const advisor = createModelAdvisor(catalog, undefined, {
    efforts: { implement: "xhigh" },
  });
  expect(
    advisor.decide({ role: "implement", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "terra",
    model: "gpt-5.6-terra",
    effort: "xhigh",
  });

  const terraWithoutXhigh = createModelAdvisor(
    [
      { id: "gpt-5.6-luna", supportedReasoningEfforts: ["medium", "high"] },
      { id: "gpt-5.6-terra", supportedReasoningEfforts: ["medium", "high"] },
      {
        id: "gpt-5.6-sol",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
      },
    ],
    undefined,
    { efforts: { implement: "xhigh" } },
  );
  expect(
    terraWithoutXhigh.decide({
      role: "implement",
      risk: "medium",
      retryIndex: 0,
    }),
  ).toMatchObject({
    profile: "sol",
    model: "gpt-5.6-sol",
    effort: "xhigh",
  });
});

test("falls back to the role default with one diagnostic per role when the configured effort is unsupported", () => {
  const mediumHighOnly = [
    { id: "gpt-5.6-luna", supportedReasoningEfforts: ["medium", "high"] },
    { id: "gpt-5.6-terra", supportedReasoningEfforts: ["medium", "high"] },
    { id: "gpt-5.6-sol", supportedReasoningEfforts: ["medium", "high"] },
  ];
  const diagnostics: string[] = [];
  const advisor = createModelAdvisor(mediumHighOnly, undefined, {
    efforts: { implement: "xhigh" },
    onDiagnostic: (message) => diagnostics.push(message),
  });

  expect(
    advisor.decide({ role: "implement", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({
    profile: "terra",
    model: "gpt-5.6-terra",
    effort: "medium",
    rationale: [
      "implement baseline",
      "medium risk",
      "configured effort xhigh unsupported",
      "effort medium (default)",
    ],
  });
  expect(diagnostics).toEqual([
    'Configured implement effort "xhigh" is unsupported by the routed models; using the default "medium" instead.',
  ]);

  advisor.decide({
    role: "implement",
    risk: "high",
    retryIndex: 1,
    priorProfile: "terra",
  });
  expect(diagnostics).toHaveLength(1);

  expect(
    advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({ profile: "luna", model: "gpt-5.6-luna", effort: "high" });
  expect(diagnostics).toHaveLength(1);
});

test("returns undefined when both configured and default efforts are unsupported", () => {
  const diagnostics: string[] = [];
  const advisor = createModelAdvisor(
    [{ id: "provider/astra", supportedReasoningEfforts: ["high"] }],
    { luna: "provider/astra", terra: "provider/astra", sol: "provider/astra" },
    {
      efforts: { implement: "xhigh" },
      onDiagnostic: (message) => diagnostics.push(message),
    },
  );

  expect(
    advisor.decide({ role: "implement", risk: "low", retryIndex: 0 }),
  ).toBeUndefined();
  expect(diagnostics).toEqual([
    'Configured implement effort "xhigh" is unsupported by the routed models; using the default "medium" instead.',
  ]);
});
