import type { AgentHarness } from "../harness/contracts";
import type { CatalogModel, ModelMapping } from "../scheduler/model-routing";
import type { TaskBranchManager } from "../workspace/task-branch";

/**
 * A started backend for one scheduler run: the durable model catalog, the
 * running harness, and an idempotent cleanup handle. Providers keep their
 * process startup, native protocol, model discovery, and resume behavior
 * inside their factory instead of subclassing AgentHarness.
 */
export type BackendRuntime = {
  readonly catalog: readonly CatalogModel[];
  /**
   * Explicit profile-to-model routing for providers whose catalog IDs carry
   * no luna/terra/sol suffix; the shared advisor combines it with the
   * catalog instead of inferring profiles from provider model names.
   */
  readonly modelMapping?: ModelMapping;
  readonly harness: AgentHarness;
  /** Releases owned resources idempotently, rejecting if child exit or cleanup cannot be confirmed. */
  close(): Promise<void>;
};

/**
 * Starts a backend against the shared task branch manager. The common run
 * loop owns branch-manager creation, database setup, model advising,
 * daemon lifecycle, logging, and cleanup; a factory only starts its own
 * process and returns the runtime pieces the loop cannot know about.
 */
export type BackendFactory = (context: {
  branches: TaskBranchManager;
}) => Promise<BackendRuntime>;
