export const helpText = `roc-it - run Codex agents through an agile software flow

Get started:
  npx roc-it@latest onboard [--global] [--db PATH]
      Set up Roc, its skills, and your Agile cycle.

Manage your cycle:
  npx roc-it@latest cycle current
      Show the current Agile cycle.

Plan work:
  npx roc-it@latest task import FILE [--db PATH]
      Import an approved backlog into the current project.
  npx roc-it@latest task list [--db PATH]
      List the current project's tasks.
  npx roc-it@latest task hook trust <task-id> <prehook|posthook> [--db PATH]
      Trust the current task-scoped hook configuration.
  npx roc-it@latest tokens [--db PATH] [--no-color]
      Show token use for the current Agile cycle.

Run work:
  npx roc-it@latest scheduler run --backend codex --repo PATH [--base REF] [--db PATH]
      Run the ready backlog with Codex in isolated task branches.

Get help:
  npx roc-it@latest help
      Show this guide.

Next:
  npx roc-it@latest onboard
`;
