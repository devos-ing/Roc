import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  description?: string;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  publishConfig?: Record<string, string>;
  scripts?: Record<string, string>;
};

type PackResult = {
  files: Array<{ path: string }>;
};

async function readManifest(): Promise<PackageManifest> {
  const text = await readFile(resolve(projectRoot, "package.json"), "utf8");
  return JSON.parse(text) as PackageManifest;
}

test("package metadata exposes roc-it as a public Bun CLI", async () => {
  const manifest = await readManifest();

  expect(manifest.name).toBe("roc-it");
  expect(manifest.version).toBe("0.0.1");
  expect(manifest.private).toBeUndefined();
  expect(manifest.license).toBe("Apache-2.0");
  expect(manifest.bin).toEqual({ "roc-it": "./src/cli/main.ts" });
  expect(manifest.files).toEqual(["src", "README.md", "LICENSE"]);
  expect(manifest.engines).toEqual({ bun: ">=1.3.0" });
  expect(manifest.publishConfig).toEqual({ access: "public" });
  expect(manifest.scripts?.prepublishOnly).toBe("bun run check");
});

test("npm archive contains only runtime files", async () => {
  const child = Bun.spawn(
    ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`npm pack failed: ${stderr}`);
  }

  const results = JSON.parse(stdout) as PackResult[];
  expect(results).toHaveLength(1);

  const paths = results[0]!.files.map((file) => file.path).sort();
  const allowedRootFiles = new Set(["LICENSE", "README.md", "package.json"]);
  const unexpected = paths.filter(
    (path) => !allowedRootFiles.has(path) && !path.startsWith("src/"),
  );

  expect(unexpected).toEqual([]);
  expect(paths).toContain("LICENSE");
  expect(paths).toContain("README.md");
  expect(paths).toContain("package.json");
  expect(paths).toContain("src/cli/main.ts");
});
