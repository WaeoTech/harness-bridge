# Validation record

The development environment passes **44 automated tests, with zero failures and zero skips**. Real Claude Code tests on a US host also pass headless reading, explicit UUID resume, denied original Git access, real tmux editing and parent-reviewed apply. These are functional checks, not a benchmark or an account-safety claim.

## Local automated checks

Environment: Linux, Node `22.22.3`, actual installed DSH peer packages at `0.2.0-rc.2`, schemastery `3.18.4`, real local tmux.

| Area | Evidence |
| --- | --- |
| Core arguments and protocol | Permissions, limits, canonical paths, fragmented UTF-8/CRLF, malformed/oversized events and result semantics |
| Process lifecycle | Missing executable, exit errors, timeouts, abort and cleanup |
| Compatibility route | Tool schema/IDs/results, unsupported content, strict-JSON text-tool envelopes, authenticated loopback SSE and redacted errors |
| Native DSH API | Actual `defineTool`, actual volatile Config validation/readonly refs, live settings, legacy language fallback and restricted-session rejection |
| Native task lifecycle | Settings snapshots, proposal output, exact-digest apply, configured-root drift refusal, UUID/language continuation rules, simultaneous-request exclusion and background cancellation |
| DSH-owned Git | Real temporary Git repository; status and HEAD diff; configured fsmonitor cannot run during audit |
| Worker tool hook | Shell/subagent/MCP denial, Git/Claude metadata paths, glob traversal, absolute paths, symlink escape and read/edit capability |
| Real local tmux | A fixture process executes inside a real private tmux pane, forwards actual JSON events and final result; completion/cancellation removes the socket/server |
| Workspace review | Git-free copies, executable modes, protected-path exclusion, whole-source conflicts, symlink/hardlink collision refusal, frozen proposal checks and deletion refusal |
| Workspace failure behavior | Mid-write cancellation using the current apply request's signal restores original files/modes and removes additions; bounded copies/diffs and guarded idempotent disposal |

Commands:

```bash
npm test
npm run check
npm pack --dry-run
```

Native DSH tests explicitly skip when host peers are absent; tmux tests explicitly skip without tmux. The GitHub Actions matrix installs the matching tools/schema peers and ensures tmux is present, then checks import, tests, syntax and package contents under Node 22 and 24. A core-only checkout can run the remaining tests without installing DSH.

## Real CLI and Grok transport checks

The user authorized testing on a US host through their existing Grok reverse proxy. The run used official Claude Code `2.1.325`, Node `22.22.3`, model `grok-chat-expert` and the opt-in Messages/OpenAI compatibility wrapper with strict-JSON text-tool mode. Test workers ran as an unprivileged OS user. The upstream key remained in the private launcher environment; keys, host identifiers and raw logs are not published.

| Phase | Passed evidence | Observed duration |
| --- | --- | --- |
| Headless read | A real Read event and the exact random proof from a test file appeared; a valid UUID was returned | 23.5 s |
| Headless continuation | Explicit resume preserved the same UUID and recalled the previous file-derived proof | 5.9 s |
| Original Git denied | Claude attempted a Read of original `.git/config`; the tool result denied it and did not reveal the private random Git proof | 16.5 s |
| tmux edit proposal | A real private tmux session emitted its attach event; actual tools were Read, Read, Edit; exactly one file changed in the copy; the original file remained unchanged | 22.5 s |
| Parent-reviewed apply | The parent inspected and applied the frozen proposal; independent code execution verified `add(3, 4) === 7` and `add(-2, 5) === 3` | Passed |

The copy contained a deliberately incorrect arithmetic module. The test validated program behavior directly in the proposal and after apply; it did not count a natural-language claim or the appearance of a particular source string as proof of correctness. Durations reflect one functional run and are not representative latency measurements.

Earlier compatibility tests also demonstrated that this Grok Web route can turn native tools into ordinary text and drop tool schema/history. The explicit strict-JSON text-tool adapter produced genuine Claude tool-use/result events. That workaround is specific to the tested route and does not establish compatibility with every OpenAI-like gateway. [Setup and protocol limits](grok-compat.md).

## Real DSH Web interaction checks

An isolated US instance of DSH `0.2.0-rc.2` loaded the package as a local symlinked bundle, including its browser entry. The operator's production DSH instance did not load the four bridge tools. Browser automation connected through a private tunnel; only the chat/settings/terminal viewport is shown in the public screenshots.

| Check | Actual evidence |
| --- | --- |
| Native settings | **Plugins → Harness Bridge** rendered language, transport and edit proposal controls. Changes saved through `ConfigForm.set`; subsequent real `harness_settings` calls reported `en-US` and the selected transport |
| Headless read-only task | A Chinese request produced an English CC delegation, actual `Read` events for the two files, an English CC finding and a Chinese coordinator report. `harness_git_audit` returned an empty diff |
| tmux edit task | Actual `Read → Read → Edit` events produced one proposal. DSH called `harness_review inspect`, applied the exact digest under explicit authorization and obtained a Git diff changing only `add` from subtraction to addition |
| Independent parent execution | A real client-side DSH `bash` tool call imported the original module and asserted `add(3,4) === 7`, `add(-2,5) === 3` and `multiply(3,4) === 12`. Its actual tool result was `DSH_ASSERTIONS_OK: 3 checks passed` with `isError: false` |
| Language boundary | The source request and parent report were Chinese; the CC task and result were English. Translation was performed by the coordinator model under the task instructions |

The initial coordinator report claimed assertions without a corresponding DSH shell event; that claim was rejected. A follow-up also described an upstream environment that could not access the US workspace. The check counted as passed only after an explicit client tool envelope produced the actual DSH `tool/call` and matching successful `tool/result`. Conversational claims and upstream-only actions are not local execution evidence. The Grok text-tool adapter requires this distinction.

The native GUI tasks and form were exercised; installation through the GUI **Add plugin** dialog was not. The test used a symlinked local bundle and the documented private operator launcher for the provider config. It does not establish npm installation or support for every DSH version.

## Boundaries and remaining checks

- GUI Add plugin installation and npm publication remain untested; the live GUI run used a symlinked bundle.
- The tmux transport starts the plugin's own `claude -p` pane. Taking over a pre-existing interactive Claude TUI is not implemented.
- Anthropic-hosted model behavior and macOS/Windows integration remain untested. Linux tests do not establish support on other platforms.
- This plugin has no OS sandbox. File-tool hooks and Git-free copies do not isolate the CLI's account, filesystem or credentials. Trusted executable behavior is required.
- Applies use conflict checks and rollback, not an atomic multi-file transaction. Concurrent parent renames remain a portable Node filesystem limitation. Deletions are rejected.
- Review/UUID retention is instance-local and limited to eight copies. Restart/disposal removes retained records.
- npm publication, persistent records and stronger OS isolation remain future work. No language preset establishes nationality or protects an account from enforcement.
