# Architecture and task ownership

DSH owns planning, verification and the original Git repository. Claude Code owns one bounded CLI session inside a Git-free temporary copy. The plugin transfers prompts, structured events and reviewed file proposals between them.

## Execution choices

| Approach | Current behavior | Tradeoff |
| --- | --- | --- |
| Native DSH + headless CLI | Managed subprocess, native jobs, stream-json | Default; no separate terminal needed |
| Native DSH + tmux | Same CLI protocol inside a private attachable tmux server | Requires local tmux and terminal access to the same host/account |
| Standalone core / CLI | Direct debug runner | Does not provide managed copies, hooks, review, jobs or settings |
| Existing interactive Claude TUI | Not controlled by this plugin | Taking over arbitrary panes cannot establish the worker's settings or workspace boundary |
| Claude Agent SDK | Future option | Additional dependency; useful if interactive per-tool approval becomes necessary |
| MCP worker service | Future option | Extra transport and ownership surface |

Both managed modes use `claude -p --output-format stream-json --verbose`. tmux displays observed tool lifecycle lines; DSH consumes the original structured events from a private temporary JSONL file. Neither mode scrapes terminal paint or simulates keyboard input.

## Components

| Module | Responsibility |
| --- | --- |
| `src/index.js` | Profiles, validation, CLI flags, bounded event parser and low-level standalone process runner |
| `src/managed.js` | DSH subprocess contract, combined abort/timeout, output limits and transport selection |
| `src/dsh.js` | Native Config, volatile ref reads, settings discovery, native jobs, tool ownership, review records and DSH Git audit |
| `src/tmux.js` | Private tmux supervisor, real Claude pane child, JSONL forwarding and teardown |
| `src/worker.js` | Operator-owned CLI settings/hook arguments and safe progress formatting |
| `src/guard.js` | Fail-closed PreToolUse allowlist and file path/symlink checks |
| `src/workspace.js` | Bounded Git-free copies, actual diffs, frozen proposals, whole-source conflict checks, apply and rollback |
| `bin/openai-claude.js` | Optional private-provider wrapper with a per-run loopback token |
| `examples/openai-messages-proxy.mjs` | Messages/OpenAI translation and opt-in strict-JSON text-tool mode |

The [validation record](validation.md) distinguishes native host-contract tests from real model execution and full GUI integration.

## Settings and ownership

The exported `Config` uses volatile schema fields so DSH can render and edit language, transport, root, executable and limits in its settings interface. Cordis supplies readonly references for these fields. The adapter unwraps them on access, then snapshots settings before each task. Running tasks keep their snapshot.

The operator chooses the executable, original root, language, transport, edit capability and execution limits. The parent agent supplies task text, a relative directory, review/edit mode, foreground/background selection and an explicit UUID for continuation. It is instructed to read `harness_settings` before composing tasks in the selected language.

Each plugin instance allows one active worker and eight retained workspace records. A second check after asynchronous path validation prevents competing calls from both acquiring the worker slot. Records are scoped to the parent agent. Resume requires a retained matching root, directory, language, mode and UUID; applying/discarding removes the record. Plugin disposal cancels active work and disposes retained copies.

## Workspace and review protocol

1. Canonicalize the configured root and requested subdirectory.
2. Copy regular source files/directories, excluding `.git`, `.claude`, `node_modules`, symlinks and special files. Preserve executable modes. Stop on byte, file or entry limits.
3. Start the worker in the corresponding subdirectory of that copy. Load only bridge-owned settings and hook configuration, disable ordinary setting sources and slash commands, and use an empty MCP configuration.
4. Stream real tool lifecycle events to a native job. Retain complete raw events only in transport memory/temporary logs, not normal DSH progress text.
5. On termination, calculate actual changes and a readable bounded diff. Freeze the mirror fingerprint; return the record's review ID.
6. Inspection returns the captured proposal, original root and its SHA-256 digest. Apply requires that exact digest, the matching currently configured root, operator edit capability and an edit-mode record.
7. Apply checks the whole original snapshot, not just changed files, and verifies the frozen mirror. Preflight destinations and parents, reject symlink/hardlink collisions and deletions, then write only reviewed in-memory additions/modifications. Attempt rollback on cancellation or write failure.
8. DSH audits original Git status and diff and runs acceptance checks. Git writes use the parent's own tools and authorization.

The workspace API serializes its operations. Proposal records are memory-only. Snapshot limits are 64 MiB, 5,000 regular files, 10,000 entries; textual diffs explicitly truncate at 4 MiB. Binary changes receive summaries. An inspection digest gates exact proposal application; it is not a separate cryptographic user-consent system.

## Tool and Git boundaries

Review workers receive Read, Glob and Grep. Edit workers also receive Edit and Write. Bash, Agent, Task, NotebookEdit and MCP tools are denied. The PreToolUse hook additionally checks the current directory, requested paths, glob traversal, protected metadata and symlink ancestors. It fails closed if hook input cannot be parsed or validated.

The original `.git` is absent from the copy; protected path access and shell-based Git are denied to the worker. The plugin invokes Git only in DSH's `harness_git_audit`, with optional locks, prompts, external diff/textconv and configured fsmonitor execution disabled. The parent remains responsible for every stage, commit and push. Git audit data is not automatically included in CC task prompts.

These controls require a trusted CLI and operator-selected executable. They do not hide the Git binary from the OS, virtualize the process filesystem, isolate credentials or sandbox the CLI's own implementation. User/project settings sources are disabled, but this is not a claim that all CLI startup behavior is sandboxed. `danger-full-access` is a DSH policy gate, not an OS sandbox. Portable Node path checks and `O_NOFOLLOW` retain parent-rename TOCTOU risk; apply is optimistic concurrency with rollback, not an atomic transaction.

## Process and credential lifecycle

DSH owns the managed subprocess. Tool cancellation, plugin disposal and timeout combine into an AbortSignal. The transport terminates and waits for the worker and drains/destroys stdout in cleanup. The tmux supervisor handles termination by killing its private server and removing its temporary directory. Forced OS termination cannot provide a universal cleanup guarantee.

DSH's subprocess service scrubs credential-shaped ambient environment variables. The operator may use an explicit private provider wrapper after that scrub. The wrapper retains the upstream key and gives Claude only a per-run loopback token; HOME-based CLI login remains available. Sharing an OS account does not provide file or credential isolation.

The standalone runner inherits its invoking shell environment and has a different, lower-level contract. Its POSIX process group cleanup and Windows direct-child fallback are documented limitations. Linux is tested; no macOS/Windows support claim follows from the source being portable JavaScript.

## Verification and next steps

Local tests exercise actual DSH `defineTool`/volatile Config contracts, cancellation and proposal flows. Actual tmux tests launch a fixture process in a real private server and check events and socket removal. Real US-node tests use official Claude Code through Grok, verify file-derived random proof, UUID continuity, denied Git access, actual Read/Edit events, source immutability before apply and independent arithmetic checks afterward.

The isolated US DSH Web run also exercised the native language/settings form, both execution modes, actual proposal review/apply, Git audit and a successful client-side shell assertion call. Remaining release work includes the GUI Add plugin installation dialog, persistent records, deletion support, OS-level isolation, further real provider/OS testing and npm publication. Language settings are presentation preferences, not nationality or account-safety controls.

## References

- [Claude Code programmatic CLI](https://code.claude.com/docs/en/headless)
- [Claude Code flags](https://code.claude.com/docs/en/cli-reference)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [BLA README inspiration](https://github.com/qybaihe/bla)
