# Validation record

The current preview passes local automated tests and a real Linux Claude Code/Grok task sequence. This is a compatibility smoke test, not a reliability benchmark or a release certification.

## Local automated checks

`npm test` passes 19 tests with zero failures and zero skips in the development environment, where the supported DSH peer packages are available. Coverage includes argument construction, directory/symlink checks, fragmented UTF-8 and JSON events, permission failures, limits, subprocess failure, timeouts, cancellation, DSH tool registration and policy gates, managed cleanup, and both protocol modes of the optional proxy. HTTP tests use local fixture servers and no real credentials.

The adapter tests explicitly skip if DSH peers are absent. This distinction matters when running a clean standalone checkout. Syntax and package-content checks are separate from these tests.

## Real US-node smoke test

| Component | Tested configuration |
| --- | --- |
| OS | Linux x86-64, US node |
| Node | 22.22.3, isolated test runtime |
| Client | Official Claude Code 2.1.325 Linux x64 package |
| Model | grok-chat-expert through the existing gateway |
| Transport | Optional loopback wrapper, strict JSON text-tool mode explicitly enabled |
| Execution | Unprivileged process, memory/time-limited systemd unit, synthetic workspace |
| Parent | Standalone bridge runner and independent Python/Node verification |

| Task | Acceptance evidence | Latest result |
| --- | --- | --- |
| Plain text | Exact `US_GROK_BRIDGE_OK`, no tool needed | Pass |
| Read file | Actual `Read` event plus an unpredictable proof string read from the file | Pass |
| Resume | Explicit same UUID and workspace; recall that proof string without another tool call | Pass |
| Edit file | Actual `Read` and `Edit` events; `add(a,b)` changed from subtraction to addition | Pass |
| Parent verification | `add(3,4) === 7`, `add(-2,5) === 3`, and the unrelated proof file unchanged | Pass (`ARITHMETIC_OK`) |

The official Node archive and Claude package checksums were verified during test setup. Gateway credentials stayed in the existing operator-owned configuration; the runner redacts the key and writes private logs with restrictive permissions. The running gateway and DSH Web service were not restarted.

## Failures discovered during integration

1. The gateway's native Messages route returned literal tool-looking XML as text, with no `Read` event, while Claude Code reported success. The random-file proof failed.
2. Switching to OpenAI wire format alone did not fix the current Grok Web route: it does not carry its OpenAI `tools` fields through as native function calls. A worker claimed the probe file was absent without calling `Read`. The verifier rejected it.
3. An earlier strict-JSON edit attempt returned a valid final answer claiming a change, but emitted no editing event and left the arithmetic broken. The verifier rejected it. Explicit tool-use instructions in the final protocol and task passed the subsequent complete sequence.
4. The real CLI includes a `system` message inside `messages` as well as the top-level system field. The translator now preserves this role; regression coverage also accepts explicitly typed `custom` client tools.

Strict JSON validates syntax and permitted tool names. It cannot establish that a model's completion claim is true. The task-specific checks above remain necessary, and the earlier failures remain relevant when judging this backend's reliability. The bridge's `ok`/`completed` status means the client completed without a reported error; it does not replace parent-side acceptance tests.

## Remaining release checks

- An installed native plugin task inside a full DSH GUI session, including managed process teardown on real tool cancellation.
- A supported Anthropic-hosted model and normal user authentication, independently of the Grok compatibility wrapper.
- Real denied-operation, cancellation and timeout scenarios on each supported operating system; current automated coverage uses fixture workers.
- macOS and Windows installation and process-tree cleanup.
- Clean-machine DSH plugin installation, a published release and a broader compatibility/reliability matrix.

The current native DSH integration is checked locally against the actual `defineTool` API; the real US tasks exercise the shared core and optional wrapper. These are separate pieces of evidence.
