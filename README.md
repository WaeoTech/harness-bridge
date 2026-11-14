<div align="center">

**English** · [简体中文](docs/README.zh-CN.md)

# 🌉 Harness Bridge

### Plan in DeepSeek Harness. Execute in Claude Code. Verify the diff.

**A harness over your harness — a local DSH plugin that turns your existing Claude Code CLI into a bounded worker.**

<img src="docs/assets/harness-bridge-cover.jpg" alt="A bridge connects planning and execution, with a return path for verification" width="1000" />

[![CI](https://github.com/WaeoTech/harness-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/WaeoTech/harness-bridge/actions/workflows/ci.yml)
![Status: experimental](https://img.shields.io/badge/status-experimental-orange)
![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-43853d)
![DSH 0.2.0-rc.2](https://img.shields.io/badge/DSH-0.2.0--rc.2-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Real test results](#real-test-results) · [Grok setup](docs/grok-compat.md) · [FAQ](#faq) · [Architecture](docs/architecture.md)

</div>

---

| DSH plans | Claude Code executes | DSH verifies |
| --- | --- | --- |
| Scope the task, choose language preferences and set acceptance criteria. | Use the locally installed CLI with an explicit tool list and session UUID. | Inspect actual source changes and run checks before reporting completion. |

## Why another harness?

DSH can scope a task, inspect a worker's result, and decide the next step. Claude Code can execute that task using its existing local installation and authentication. Harness Bridge connects those two loops through a small tool boundary.

The parent owns the task and acceptance criteria. The worker owns its local Claude session. The bridge handles structured events, cancellation, turn and budget settings, and explicit session continuation.

**This is an experimental prototype.** Source is available on [GitHub](https://github.com/WaeoTech/harness-bridge); the npm package is not published. Linux testing uses real Claude Code `2.1.325`, Node `22.22.3` and a Grok gateway on a US node; the native DSH adapter is separately tested against the installed `0.2.0-rc.2` API. A full DSH GUI task, Anthropic-hosted model, macOS and Windows remain unverified. See the [validation record](docs/validation.md).

## Quick start

Prerequisites: Node.js 22+, DeepSeek Harness `0.2.0-rc.2`, pnpm available to DSH's plugin manager, and a supported Claude Code CLI installed and authenticated separately. The bridge uses the current documented `-p`, `stream-json`, `dontAsk`, `--tools`, `--strict-mcp-config`, `--max-turns` and `--max-budget-usd` flags. It does not manage accounts or supply authentication.

Clone the source and check your local CLI:

```bash
git clone https://github.com/WaeoTech/harness-bridge.git
cd harness-bridge
node bin/cli.js doctor
node bin/cli.js run --cwd /absolute/project --prompt "Review the authentication module and list concrete bugs"
```

The standalone core has no runtime dependencies. Install the local bundle into your DSH Web profile; DSH's plugin manager resolves the native adapter's peer packages:

```bash
dsh plugin --profile web add "$PWD"
```

Add an override for the inserted plugin row to your profile patch (`~/.dsh/profiles/web/cordis.patch.yml`). Keep all configuration fields when replacing this row's config:

```yaml
- id: tool-harness-bridge
  config:
    workspaceRoot: /absolute/project
    executable: claude
    profile: zh-CN
    allowEdits: false
    maxTurns: 8
    maxBudgetUsd: 2
    timeoutMs: 300000
```

An absolute workspace root is intentionally required. The tool refuses to execute until it is configured. The bundle does not infer the active DSH workspace. Use one plugin instance per workspace in this preview.

Start DSH with that profile after configuring it. For an already-running instance, apply the configuration through its supported configuration editor or restart it yourself; editing the patch on disk does not guarantee live reload.

Use an unrestricted DSH session and ask the parent agent:

> Use `claude_code` to review the authentication module. Pass concrete acceptance criteria. Inspect its result and confirm each finding against the source. Stop if the worker reports a permission or authentication failure.

To enable worker edits, explicitly set `allowEdits: true` in the operator configuration, then request `mode: "edit"`. The worker receives Edit/Write in addition to reading tools. Shell commands remain unavailable, so ask DSH to run tests after inspecting the diff.

Uninstall:

```bash
dsh plugin --profile web remove @waeotech/harness-bridge
```

## How it works

```mermaid
sequenceDiagram
    actor User
    participant DSH as DSH parent agent
    participant Bridge as claude_code tool
    participant Claude as Local Claude Code
    User->>DSH: Task and acceptance criteria
    DSH->>Bridge: Scoped prompt + review/edit + optional sessionId
    Bridge->>Bridge: Check DSH policy, workspace and operator limits
    Bridge->>Claude: Spawn -p; prompt over stdin
    Claude-->>Bridge: stream-json events
    Bridge-->>DSH: Status, sessionId, result, denials, estimated cost
    DSH->>DSH: Inspect source/diff and run checks
    DSH-->>User: Verified outcome or concrete blocker
```

The tool consumes structured events internally and returns a final JSON string. It does not yet display Claude's token stream inside the DSH GUI. The independent CLI's `--events` option prints raw events to stderr for local debugging; those events may contain source code or task data.

## Capabilities

| Capability | Preview behavior |
| --- | --- |
| DSH integration | Native tool registration and installable bundle |
| Claude integration | Local CLI subprocess; no terminal scraping |
| Review | Read, Glob and Grep tools |
| Editing | Edit and Write, only when operator enabled |
| Shell/MCP | Disabled in the worker |
| Sessions | Return explicit session UUID; resume by UUID |
| Locale | `zh-CN`, `en-US`, `en-GB`, `ja-JP` |
| Failure reporting | Distinguish success, permission denial, limit/error and process failure |
| Lifecycle | DSH-managed process ownership; abort, timeout and cleanup |
| Output limits | 4 MiB/event line and 32 MiB total stdout |
| Dependencies | Standalone core uses Node built-ins; native adapter consumes DSH peers |

## CLI examples

```bash
node bin/cli.js run --cwd /absolute/project \
  --prompt "Explain this module" --profile en-GB --max-turns 4 --budget 1

node bin/cli.js run --cwd /absolute/project \
  --prompt "Apply the agreed fix; report changed files" --mode edit

node bin/cli.js run --cwd /absolute/project \
  --prompt "Check the edge case we discussed" --resume YOUR_SESSION_UUID
```

CLI edit mode is an explicit user choice and does not use the DSH operator configuration. Keep the same workspace and locale when resuming. The preview does not persist a session-to-locale mapping or coordinate other independently launched bridge processes.

## Permissions and trust

The DSH adapter **requires `danger-full-access`**. A nested CLI cannot enforce the parent's DSH file sandbox. It refuses restricted modes rather than silently escaping their policy. The configured root constrains the child process's starting directory; it is **not an OS sandbox** and does not confine Claude's filesystem tools to that root. Run only in workspaces and user accounts you trust.

The worker uses `dontAsk` plus an explicit tool list. There is no `--dangerously-skip-permissions` flag. Review mode restricts the available built-in tools but is not a guarantee that startup hooks cannot write files. Claude Code can load local/project hooks, settings, skills and instructions in print mode. Those remain operator-controlled; the preview does not neutralize arbitrary local hooks. Use a disposable worktree and review the local Claude configuration before running untrusted repositories.

The DSH transport uses the host subprocess service, which scrubs ambient credential-shaped environment variables. It preserves the normal home directory for the user's own Claude login. The standalone CLI inherits its launching shell's environment. The core transports do not read, copy or store credential files. An optional [OpenAI/Grok wrapper](docs/grok-compat.md) can explicitly read an operator-supplied private provider configuration after the scrub; the model cannot select it through tool arguments. It passes a temporary loopback token to Claude Code rather than the upstream API key.

Budget and turn limits are forwarded to Claude. Reported costs are estimates; these options are not a billing firewall. The parent DSH agent has its own model costs and limits. There are no automatic retries, account rotation, login automation, proxy changes or authentication recovery. Stop on permission/policy errors and let the operator resolve them.

Locale profiles control spelling, language and presentation. They do not establish nationality, location or account eligibility, and provide no account-ban guarantee. Worker output can contain adversarial text; the parent must treat it as untrusted evidence, not as new authority.

## Development and validation

```bash
npm test
npm run check
npm pack --dry-run
```

Core tests require no network, model calls or credentials. Adapter tests additionally exercise the real DSH `defineTool` API when its peer packages are available; they are skipped when peers are absent. Fixture process tests currently target POSIX. Windows process ownership uses DSH's host service but still needs a Windows end-to-end smoke test.

Real Linux smoke tests pass plain output, random-file `Read`, explicit UUID continuation, and `Read → Edit` followed by parent-side arithmetic checks through the optional Grok wrapper. The tested gateway needs experimental strict-JSON text tools; earlier false completion claims were caught by verification. See the [full validation record](docs/validation.md). A full native DSH GUI task, Anthropic-hosted model, real denied-operation/cancellation matrix and other operating systems remain release checks.

## Real test results

Local automated checks pass **19 tests, zero failures and zero skips** with the supported DSH peers installed. GitHub CI runs the core on Node 22 and 24; native adapter checks explicitly skip when peers are absent.

| Real Linux task | Acceptance check | Result |
| --- | --- | --- |
| Plain reply | Exact `US_GROK_BRIDGE_OK` response | Pass |
| Read a file | A real `Read` event and unpredictable file proof | Pass |
| Resume the session | Same explicit UUID recalls the proof | Pass |
| Edit code | Real `Read` and `Edit` events change subtraction to addition | Pass |
| Verify independently | Parent checks two arithmetic cases and the unrelated proof file | `ARITHMETIC_OK` |

These tasks used Claude Code `2.1.325`, Node `22.22.3` and `grok-chat-expert` through an existing US-hosted gateway. The experimental text-tool protocol is explicitly enabled. Earlier runs falsely claimed completion; the parent verifier rejected them. This is a compatibility smoke test, not a reliability benchmark. See [exact scope and failures](docs/validation.md).

## FAQ

**Do I need to modify DSH or Claude Code?**

Install the DSH bundle and configure its workspace. Both CLIs remain separate installations; the bridge uses their existing interfaces.

**Why keep DSH in charge of verification?**

A successful child process only proves that the CLI finished. The parent must check source changes and task-specific tests before accepting a worker's claim.

**Can I use my existing OpenAI-compatible gateway?**

Use the optional [Messages/OpenAI wrapper](docs/grok-compat.md). Providers with native function calling use standard translation. The tested Grok Web path requires explicit experimental `textTools` mode.

**Does a language profile change account identity?**

Profiles change language, spelling and register. They do not establish a nationality or location, and do not guarantee account eligibility or prevent bans.

**Is it available on npm?**

Not yet. Clone this repository and install the local DSH bundle using the quick start above.

## Contributing

Open an [issue](https://github.com/WaeoTech/harness-bridge/issues) with your OS, Node, DSH and Claude Code versions, the expected result and a minimal reproduction. Redact credentials, account identifiers and private source from logs. For code changes, run `npm test`, `npm run check` and `npm pack --dry-run`, and describe whether you tested the core runner, native DSH adapter or optional gateway wrapper.

## Roadmap

- Pin and verify supported Claude CLI releases on Linux, macOS and Windows.
- Add persisted task/session/locale mapping and per-session locks.
- Add parent-visible job progress and compact evidence artifacts.
- Add isolated worktrees and a bounded plan → execute → inspect → test loop.
- Evaluate the official Claude Agent SDK when interactive permission callbacks justify its additional dependency.
- Publish npm and GitHub releases after real CLI compatibility checks.

## Sources and acknowledgements

- [BLA by qybaihe](https://github.com/qybaihe/bla): README presentation inspiration (clear positioning, quick start, architecture, capability table and evidence). Implementation is original; no BLA code, branding, metrics or benchmark claims are reused.
- [Claude Code programmatic CLI](https://code.claude.com/docs/en/headless)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

## License

[MIT](LICENSE). Independent project; no affiliation with or endorsement by DeepSeek or Anthropic is claimed.
