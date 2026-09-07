<p align="center">
  <img src="https://raw.githubusercontent.com/devos-ing/Roc/main/output/imagegen/roc-avatar-tech.png" alt="Roc project avatar" width="220" />
</p>

[English](README.md) · [繁體中文](README.zh-HK.md)

# Roc

Turn a conversation into coding tasks. A local daemon implements them, opens
pull requests, and updates task status. You review and merge the results.

## How it works

```mermaid
flowchart LR
    A["Chat and clarify"] --> B["Approve tasks and specs"]
    B --> C["Roc daemon"]
    C --> D["Pi: Scout → Implement → Review"]
    D --> E["Pull request and task status"]
```

**Pi is the execution core.** Onboarding connects your ChatGPT account and selects
a Codex model. Claude and GLM are advanced provider options.
Roc uses Pi's tools and agent loop; it does not launch Codex CLI or Claude Code.
One daemon runs one task at a time. Each task keeps its own branch.
`done` means the PR is published; you still merge it yourself.

**Development version:** use this checkout, as shown below. The Pi-only workflow
is not yet published to npm. Automated checks do not establish live provider
success; see [validation status](README.details.md#validation-status).

## Quick start

You need Bun 1.3+, Node.js 22.19+, Git, GitHub CLI, and your project's build/test
tools. Start with the local task queue on one machine.

### 1. Set up Roc

Run `bun install` in this Roc checkout. Pi is included as a dependency.
Then enter the project you want Roc to modify. Replace the entrypoint with
this checkout's absolute path:

```bash
export ROC_CLI_ENTRY=/absolute/path/to/Roc/src/cli/main.ts
cd /path/to/your-project
gh auth login
bun "$ROC_CLI_ENTRY" onboard
```

Onboarding installs Roc's skills, lets you choose trusted skills and an Agile
cycle, and asks once for permission to run coding tools with your account's
permissions. It opens your browser for ChatGPT login when needed, tests a small
Codex prompt, and saves the model after a successful response. Existing Pi
credentials are reused. You do not need to install or log into Pi separately.
The test uses a small amount of your model quota.

### 2. Create tasks through chat

Open the project in your usual coding assistant and ask:

```text
Use roc-create-tasks to add team invitations. Use the local queue and the Roc entrypoint in ROC_CLI_ENTRY.
```

The skill asks questions and proposes tasks with acceptance criteria. It saves
them after you approve the complete plan. If the assistant cannot read your
terminal environment, give it the absolute Roc entrypoint path.
Install `grilling` and `unslop` in your planning assistant if missing; see
[planning skills](README.details.md#planning-skills).

### 3. Start the daemon

In the same project and terminal, replace `main` with your target branch:

```bash
bun "$ROC_CLI_ENTRY" task list
bun "$ROC_CLI_ENTRY" scheduler run --base-branch main
```

Leave the terminal open. Press `Ctrl-C` to stop; repeat the command to recover
saved work. Roc keeps task branches in a sibling `<project>.agile-checkout`.
For unattended work, use OS/container isolation because Pi has no built-in sandbox.

### 4. Follow progress

In another terminal, set the same `ROC_CLI_ENTRY`, enter the same project, and run:

```bash
bun "$ROC_CLI_ENTRY" task board
```

The board is read-only. Press `Enter` for details or `Q` to quit.
Use `task list`, `scheduler inspect`, or `help` for more information.

## Go further

The [detailed guide](README.details.md) covers the architecture diagram, provider
setup, GitHub Issues as a shared task source, daemon deployment, and recovery.
Start with two clones on the same machine; move the execution clone later.

Development and releases: [CONTRIBUTING.md](CONTRIBUTING.md).
License: [Apache 2.0](LICENSE).
