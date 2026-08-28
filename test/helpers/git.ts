/** Runs Git in an isolated repository without inheriting an outer hook's Git environment. */
export async function git(
  args: string[],
  cwd: string,
  allowFailure = false,
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}
