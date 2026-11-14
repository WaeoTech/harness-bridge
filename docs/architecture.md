# Architecture and delivery process

The first release should expose one worker tool inside DSH. The parent remains responsible for planning and verification; the bridge should not start a second autonomous planner.

## Integration options

| Approach | Fit | Cost or limitation | Decision |
| --- | --- | --- | --- |
| Native DSH tool + Claude print CLI | Existing DSH users who already installed Claude | DSH prerelease API coupling; no interactive approval callback | Implemented preview |
| Standalone CLI core | Debugging and use from other local tools | Caller must orchestrate tasks and cancellations | Implemented preview |
| Claude Agent SDK | Rich structured events, interactive tool permission callbacks | Additional dependency and SDK/runtime compatibility work | Evaluate after real CLI smoke tests |
| MCP server around the worker | Reuse from several parent harnesses | Extra transport and lifecycle layer; parent/client compatibility | Add after stabilizing the core |
| Terminal/PTY automation | Interactive UI demonstrations | Fragile parsing, ANSI, terminal size and prompt detection | Avoid for the execution protocol |
| Wrapping DSH around Claude around another DSH | Unbounded nested autonomy | Context drift, duplicate costs, unclear permissions and ownership | No recursive workers |

Claude's official CLI already provides an event protocol. It is cheaper to maintain a thin adapter over that protocol than a terminal scraper. The SDK becomes useful when the product genuinely needs per-tool parent approvals; do not rebuild that protocol by simulating keyboard input.

## Components

- `src/index.js`: option validation, command construction, bounded event parsing and the standalone Node child-process transport.
- `src/managed.js`: DSH host subprocess transport, environment scrubbing supplied by DSH and managed process-tree cleanup.
- `src/dsh.js`: native tool schema, host-owned configuration, unrestricted-session gate, edit gate and instance concurrency guard.
- `bin/cli.js`: diagnostic and local invocation interface.
- `bin/openai-claude.js`: optional operator-configured provider wrapper with a per-run loopback token.
- `examples/openai-messages-proxy.mjs`: bounded Messages/OpenAI translation, plus an explicit strict-JSON tool mode for text-only gateways; see [compatibility and limits](grok-compat.md).
- `cordis.patch.yml`: installable DSH bundle row.

The [validation record](validation.md) distinguishes local DSH API tests, real Linux Claude Code/Grok tasks, and untested release requirements.

The core passes a prompt over stdin, uses an argument array with `shell: false`, preserves explicit session identity and treats missing final results as failures. Both transports cap event lines and stdout. Raw event data stays out of the parent result unless it is the final worker answer. The CLI opt-in event stream is intentionally a debugging surface.

## Authority and boundaries

The operator controls executable, absolute workspace root, locale, editing capability, turns, budget and timeout. The parent agent controls task text, a relative subdirectory, review/edit selection and explicit session continuation. The child cannot select a different executable or loosen operator limits through tool arguments.

The root check resolves symlinks and constrains the process starting directory. It does not implement chroot, filesystem isolation or host credential isolation. The bridge refuses restricted DSH session modes because claiming to preserve their sandbox would be incorrect. The default read tools also do not prevent Claude startup hooks from executing. A future sandboxed execution mode needs actual OS-level process/file isolation and a deliberate Claude configuration strategy.

The DSH service owns worker processes. Tool cancellation, plugin disposal and timeout flow into a combined AbortSignal. The standalone transport terminates its POSIX process group and escalates after two seconds; its Windows fallback only signals the direct child. Prefer the DSH transport for cross-platform process ownership. Windows and macOS must still receive real smoke tests before a release claims support.

The core does not copy parent credentials into the worker. HOME-based Claude login stays with the user's CLI. The DSH subprocess service strips credential-shaped ambient variables; the standalone CLI inherits its own shell environment. An optional operator-owned provider wrapper can explicitly load a private configuration after that scrub and expose a loopback token to Claude instead of the upstream key. It shares the OS user and does not isolate that user's files. Never print auth configuration or call `gh auth token` as part of this product.

## Recommended task loop

1. **Scope:** parent records target workspace, acceptance checks, edit permission and a small task.
2. **Prepare:** use a disposable worktree for edits. Confirm the existing working tree state and avoid overlapping writers.
3. **Execute:** delegate one task. Keep locale stable and limits explicit.
4. **Inspect:** parse final status, permission denials and session ID. Authentication and permission errors stop the loop.
5. **Verify:** parent inspects the actual diff, checks for unrelated files and runs targeted tests. The worker's own completion claim is evidence, not proof.
6. **Continue:** if checks fail, return specific failing evidence to the same session. Limit the product loop to a fixed number of iterations.
7. **Report:** summarize verified changes and unresolved blockers. External publishing remains a separate user decision.

Only the bounded single-worker execution primitive is implemented. Automatic worktree creation, persisted task records, loop counters and parent-side test selection are roadmap items, not current capabilities. A practical next milestone is a three-iteration maximum controller with a durable task ID, session UUID, workspace root, stable locale and verification evidence.

## Release acceptance

| Check | Required evidence |
| --- | --- |
| DSH schema | Register through the actual supported `defineTool` implementation |
| CLI protocol | A real read-only run on each supported Claude version |
| Permissions | Denied operations must produce a blocker; restricted DSH sessions must not spawn |
| Sessions | Resume exact UUID in the same project without relying on latest session |
| Editing | Fixture plus real worktree task; parent inspects diff and runs tests |
| Cancellation | Tool abort and timeout terminate the owned process tree |
| Packaging | `npm pack --dry-run`, MIT license, no secrets or local dependencies in tarball |
| Documentation | Installation steps work from a clean checkout and declare actual tested versions |

Do not advertise benchmark results, account-safety guarantees or universal CLI compatibility before collecting evidence. Language profiles are a presentation feature; account eligibility and service restrictions remain external constraints.

## Documentation references

- [Claude Code programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude Code flags](https://code.claude.com/docs/en/cli-reference)
- [DeepSeek Harness source](https://github.com/deepseek-ai/deepseek-harness)
- [BLA README inspiration](https://github.com/qybaihe/bla)
