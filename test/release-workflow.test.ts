import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

/** Reads a repository file relative to the project root. */
async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(projectRoot, path), "utf8");
}

/** Asserts that each supplied fragment occurs after the previous fragment. */
function expectInOrder(source: string, parts: string[]): void {
  let cursor = -1;
  for (const part of parts) {
    const next = source.indexOf(part, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

test("stable tags publish with OIDC before creating a generated GitHub Release", async () => {
  const workflow = await readProjectFile(".github/workflows/release.yml");

  expect(workflow).toContain('      - "v*.*.*"');
  expect(workflow).toContain(
    "permissions:\n  contents: write\n  id-token: write\n\nconcurrency:",
  );
  expect(workflow).not.toContain("NPM_TOKEN");
  expect(workflow).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
  expect(workflow).toContain('if [[ "$tag" != "v$version" ]]; then');
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain('npm view "roc-it@$VERSION" dist.integrity');
  expect(workflow).toContain("roc-it@$VERSION exists with different bytes");
  expect(workflow).toContain('echo "publish=false" >> "$GITHUB_OUTPUT"');
  expect(workflow).toContain('grep -q "E404" "$error_file"');
  expect(workflow).toContain("npm publish --access public");
  expect(workflow).toContain('gh release view "$GITHUB_REF_NAME"');
  expect(workflow).toContain("--generate-notes");

  expectInOrder(workflow, [
    "Validate tag and package version",
    "bun install --frozen-lockfile",
    "bun run check",
    "npm pack --json --ignore-scripts",
    "npm publish --access public",
    "Verify published package integrity",
    'gh release create "$GITHUB_REF_NAME"',
  ]);
});
