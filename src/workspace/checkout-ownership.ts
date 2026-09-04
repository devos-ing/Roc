import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { AgileError } from "../runtime/errors";

export type CheckoutOwnership = {
  repoPath: string;
  lockPath: string;
  release(): Promise<void>;
};

type OwnerRecord = {
  version: 1;
  runId: string;
  ownerPid: number;
  acquiredAt: string;
  ownerToken: string;
};

/** Creates the sanitized error used when a repository already has a checkout guard. */
function checkoutInUseError(runId: string): AgileError {
  return new AgileError({
    code: "SCHEDULER_CHECKOUT_IN_USE",
    category: "startup",
    retryable: false,
    component: "workspace",
    runId,
    message: "Scheduler checkout is already in use",
  });
}

/** Creates the sanitized error used when an owner can no longer prove it owns a guard. */
function ownershipLostError(runId: string): AgileError {
  return new AgileError({
    code: "SCHEDULER_CHECKOUT_OWNERSHIP_LOST",
    category: "infra",
    retryable: false,
    component: "workspace",
    runId,
    message: "Scheduler checkout ownership could not be verified",
  });
}

/** Returns whether two filesystem entries refer to the same underlying file. */
function hasSameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Returns whether immutable metadata still exactly matches the record written by this owner. */
function hasOwnerMetadata(serialized: string, expected: string): boolean {
  return serialized === expected;
}

/** Verifies an existing lock is the original regular file with this owner's metadata. */
async function verifyOwnerFile(
  lockPath: string,
  expectedIdentity: Stats,
  expectedMetadata: string,
): Promise<boolean> {
  let current: Stats;
  try {
    current = await lstat(lockPath);
  } catch {
    return false;
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    !hasSameFileIdentity(current, expectedIdentity) ||
    current.size !== Buffer.byteLength(expectedMetadata)
  ) {
    return false;
  }

  let handle: FileHandle | undefined;
  let verified = false;
  try {
    handle = await open(lockPath, "r");
    const opened = await handle.stat();
    if (
      !hasSameFileIdentity(opened, expectedIdentity) ||
      opened.size !== Buffer.byteLength(expectedMetadata)
    ) {
      return false;
    }
    const serialized = await handle.readFile({ encoding: "utf8" });
    verified = hasOwnerMetadata(serialized, expectedMetadata);
  } catch {
    return false;
  } finally {
    try {
      await handle?.close();
    } catch {
      verified = false;
    }
  }
  return verified;
}

/** Acquires exclusive ownership of a repository's scheduler checkout. */
export async function acquireCheckoutOwnership(
  repoPath: string,
  runId: string,
): Promise<CheckoutOwnership> {
  const canonicalRepo = await realpath(resolve(repoPath));
  const lockPath = `${canonicalRepo}.agile-checkout.lock`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EEXIST" || error.code === "EISDIR")
    ) {
      throw checkoutInUseError(runId);
    }
    throw error;
  }

  const metadata: OwnerRecord = {
    version: 1,
    runId,
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString(),
    ownerToken: randomUUID(),
  };
  const serializedMetadata = JSON.stringify(metadata);
  try {
    await handle.writeFile(serializedMetadata);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const identity = await lstat(lockPath);
  if (identity.isSymbolicLink() || !identity.isFile()) {
    throw ownershipLostError(runId);
  }
  let releasePromise: Promise<void> | undefined;

  /** Removes the guard only after proving the original owner file remains in place. */
  async function releaseOwnedFile(): Promise<void> {
    if (!(await verifyOwnerFile(lockPath, identity, serializedMetadata))) {
      throw ownershipLostError(runId);
    }
    try {
      await unlink(lockPath);
    } catch {
      throw ownershipLostError(runId);
    }
  }

  /** Returns the sole release attempt so concurrent callers cannot unlink a successor guard. */
  function release(): Promise<void> {
    releasePromise ??= releaseOwnedFile();
    return releasePromise;
  }

  return { repoPath: canonicalRepo, lockPath, release };
}
