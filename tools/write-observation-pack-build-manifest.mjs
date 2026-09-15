import { createHash } from "node:crypto";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot =
  process.env.PIEDPIPER_OBSERVATION_SOURCE_ROOT ??
  join(root, "src", "third-party", "sol-pi");
const outputRoot =
  process.env.PIEDPIPER_OBSERVATION_OUTPUT_ROOT ??
  join(root, "dist", "third-party", "sol-pi");
const manifestPath = join(sourceRoot, "PROVENANCE.json");
const expectedManifestFingerprint =
  "7975b4c4b16729c8bcb370f05f192a6c0ac157bb6f0235261181a1e0dc3bfdf9";
const expectedPatchSha256 =
  "8bf0618ba036047b8dbacde65455e77e5eea8a803b626040a83623a78857373f";
const expectedUpstreamCommit = "d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0";
const allowedSourceFiles = [
  "LICENSE",
  "PROVENANCE.json",
  "extensions/observation-pack/index.ts",
  "extensions/observation-pack/ledger.ts",
  "extensions/observation-pack/observation.ts",
  "runtime-paths.ts",
  "tui.ts",
];

/** Returns a lower-case SHA-256 digest for one file payload. */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Lists the compiled JavaScript files below the package artifact root. */
async function compiledFiles(directory = outputRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await compiledFiles(path)));
    else if (entry.isFile() && path.endsWith(".js")) files.push(path);
  }
  return files.sort();
}

/** Lists every regular source file with a path relative to the vendor root. */
async function sourceFiles(directory = sourceRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile()) files.push(relative(sourceRoot, path));
    else throw new Error("ObservationPack source contains a non-regular file");
  }
  return files.sort();
}

/** Validates raw snapshot identity and bytes before recording a compiled artifact. */
async function validateRawSnapshot() {
  const manifest = await readFile(manifestPath);
  if (sha256(manifest) !== expectedManifestFingerprint) {
    throw new Error("ObservationPack source manifest fingerprint is invalid");
  }
  const provenance = JSON.parse(manifest.toString("utf8"));
  if (
    !provenance ||
    provenance.upstreamCommit !== expectedUpstreamCommit ||
    provenance.patchSha256 !== expectedPatchSha256 ||
    JSON.stringify(Object.keys(provenance.files ?? {}).sort()) !==
      JSON.stringify(
        allowedSourceFiles.filter((path) => path !== "PROVENANCE.json").sort(),
      ) ||
    JSON.stringify(await sourceFiles()) !==
      JSON.stringify([...allowedSourceFiles].sort())
  ) {
    throw new Error("ObservationPack source provenance is invalid");
  }
  for (const [path, expected] of Object.entries(provenance.files)) {
    if (
      typeof expected !== "string" ||
      sha256(await readFile(join(sourceRoot, path))) !== expected
    ) {
      throw new Error("ObservationPack source hash mismatch");
    }
  }
  return manifest;
}

const sourceManifest = await validateRawSnapshot();
await cp(manifestPath, join(outputRoot, "PROVENANCE.json"));
await cp(join(sourceRoot, "LICENSE"), join(outputRoot, "LICENSE"));
const files = Object.fromEntries(
  await Promise.all(
    (await compiledFiles()).map(async (path) => [
      relative(outputRoot, path),
      sha256(await readFile(path)),
    ]),
  ),
);
await writeFile(
  join(outputRoot, "BUILD-PROVENANCE.json"),
  `${JSON.stringify(
    {
      sourceManifestFingerprint: sha256(sourceManifest),
      files,
    },
    null,
    2,
  )}\n`,
);
