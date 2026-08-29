# Commander CLI refactor

Status: Approved on 2026-08-29

## Problem

The CLI uses `node:util.parseArgs` for token parsing but keeps every option in one global definition. `runCli` then routes commands and validates command-specific arguments through a long sequence of conditionals. This duplicates validation and allows some commands to accept unrelated registered options.

## Public command tree

The public CLI uses Commander 15 and exposes these commands:

```text
roc-it onboard [--global]
roc-it cycle current
roc-it task import FILE
roc-it task import-github
roc-it task list
roc-it task hook trust <task-id> <prehook|posthook>
roc-it tokens [--no-color]
roc-it scheduler run [--base REF]
roc-it scheduler inspect
roc-it help
roc-it --help
```

The public CLI does not accept `--db`, `--repo`, `--backend`, or `--fake-script`. The Fake Harness remains available through internal test seams and is not exposed as a command-line backend.

## Project root

Project-bound commands search upward from the current directory for the nearest `.agile` directory. If none exists, they use the Git checkout root. A project-bound command fails when neither exists.

Local onboarding uses the same search, then falls back to the current directory so it can initialize a new project. Global onboarding and `cycle current` do not require a project root. Scheduler startup requires the resolved project root to be the Git checkout root.

Tests may inject a project root and bypass filesystem discovery.

## Database and runtime files

Every project-bound command uses `<project-root>/.agile/runtime/agile.db`. Runtime logging uses `<project-root>/.agile/runtime/agile.log`. No global setting stores either path.

## Command behavior

Each option belongs only to the command that accepts it. Commander rejects unknown commands, unknown options, missing required arguments, and excess positional arguments.

Successful command output and the custom onboarding transcript remain compatible with the current CLI. Generic help and usage errors may use Commander output. Exit codes retain their current meaning:

- `0` for success and help;
- `1` for an operational failure after a valid command is selected;
- `2` for an invalid command, argument, or option.

The `--base REF` scheduler option remains public and defaults to `HEAD`.

## Code boundaries

`runCli` builds and executes the command program with injected I/O and runtime dependencies. Command definitions and handlers live in modules grouped by top-level command. Project root and project path resolution live outside command handlers.

Every named production function follows the repository JSDoc rule.

## Acceptance criteria

1. `command-tree-parsing`: Commander parses the documented nested commands and rejects options outside their owning command with exit code `2`.
2. `fixed-project-database`: Project-bound commands use only `.agile/runtime/agile.db` beneath the resolved project root, and the four removed options are rejected.
3. `project-root-discovery`: Commands work from a project subdirectory, fall back to the Git root when `.agile` is absent, and report a usage or startup error when no project exists.
4. `public-cli-boundary`: The public scheduler command runs only the Codex backend, accepts optional `--base`, and does not expose Fake Harness inputs or a repository override.
5. `output-and-exit-compatibility`: Existing successful output, onboarding output, operational logging, and exit-code meanings remain intact while Commander owns generic help and usage errors.
6. `modular-command-handlers`: The command tree, project resolution, and grouped handlers replace the monolithic parse-and-dispatch block without changing scheduler, repository, or harness domain behavior.

## Approved test seams

- `runCli(args, io, runtime)` for vertical command behavior and exit codes.
- An exported project-root resolver for ancestor, Git-root, and failure boundary tests.
- Existing injected runtime and Fake Harness APIs for scheduler behavior without public fake CLI flags.

## Non-goals

- Changing scheduler sequencing, task state, branch retention, hook behavior, or model routing.
- Moving the database or cycle setting into a new configuration file.
- Adding interactive command completion, aliases, or new operational commands.
- Publishing a GitHub Issue, committing, pushing, or opening a pull request.
