# Grok and OpenAI-compatible gateways

The optional wrapper lets the same bridge run Claude Code against a user-configured OpenAI Chat Completions endpoint. The underlying model remains Grok (or the model you configure); running the Claude Code client does not turn it into a Claude model. Use endpoints and accounts that permit this client and workload.

## Why an extra adapter is needed

The tested Grok gateway exposes both `/v1/messages` and `/v1/chat/completions`. Its Messages implementation returns text but loses structured tool calls. A real file-read test produced literal `<tool_calls>…</tool_calls>` text, no `Read` event, and a CLI success status. The randomly generated file content was absent. A successful process exit therefore does not establish that a coding task ran.

The tested Grok Web route also discards OpenAI `tools` and `tool_choice` fields; changing only the wire format does not fix it. The wrapper therefore has two explicit modes: default translation for gateways with real OpenAI function calls, and `textTools: true` for this text-only gateway. The latter appends tool schemas and a strict JSON response protocol, validates the returned envelope and allowed tool names, then emits real `tool_use` SSE blocks for Claude Code to execute. It rejects arbitrary prose, Markdown fences, unknown tools and malformed arguments rather than guessing XML from model output. Both modes preserve system messages embedded in the message list by the tested CLI. Text-tool mode is an experimental model instruction protocol and has weaker reliability than native function calling.

```text
DSH → Harness Bridge → optional local wrapper → Claude Code
                           ↑                      ↓
                      loopback Messages proxy ← API requests
                           ↓
                existing OpenAI-compatible gateway → Grok
```

The core bridge does not change the existing gateway or manage its credentials. The optional wrapper is a separate, explicit operator choice.

## Configure the optional wrapper

Copy `examples/provider.example.json` to a private location outside the repository, restrict it to your own user (`chmod 600` on POSIX), and supply your own endpoint, key, model and absolute Claude executable. `baseURL` ends in `/v1`, without `/chat/completions`. The template contains no working credentials. For this Grok Web gateway, add `"textTools": true` to the private JSON configuration. Leave it false or absent for a provider with native OpenAI function calling.

For a standalone run from the checkout:

```bash
chmod +x bin/openai-claude.js
HARNESS_BRIDGE_PROVIDER_CONFIG=/absolute/private/provider.json \
  node bin/cli.js run --cwd /absolute/project \
  --executable /absolute/harness-bridge/bin/openai-claude.js \
  --prompt "Read calculator.mjs and report a concrete bug" --events
```

After an eventual npm installation, the executable is named `harness-bridge-openai-claude`. This package is currently unpublished.

For the native DSH plugin, create an operator-owned launcher with absolute paths:

```sh
#!/bin/sh
export HARNESS_BRIDGE_PROVIDER_CONFIG=/absolute/private/provider.json
exec /absolute/path/to/node /absolute/harness-bridge/bin/openai-claude.js "$@"
```

Make the launcher executable and set the existing plugin configuration's `executable` to that launcher. Keep the other plugin settings, including the explicit workspace and edit gate. DSH's credential environment scrub remains enabled. The launcher deliberately supplies the private configuration path after that scrub; the model cannot choose this path through tool arguments.

Standalone callers can alternatively configure `HARNESS_BRIDGE_OPENAI_BASE_URL`, `HARNESS_BRIDGE_OPENAI_MODEL`, `HARNESS_BRIDGE_OPENAI_API_KEY`, optionally `HARNESS_BRIDGE_CLAUDE_EXECUTABLE`, and explicitly `HARNESS_BRIDGE_OPENAI_TEXT_TOOLS=1` for this text-only Grok gateway in their existing environment. Never paste real keys into shell history, issues, screenshots or source files. The wrapper removes the upstream key and provider-config path from the CLI child's environment and gives it a fresh loopback token instead. The worker still runs as the same OS user and is not isolated from that user's files or environment inspection.

## Implemented limits

- The listener binds only `127.0.0.1` on a random port, requires a per-run token, and closes with the worker. It is not a public gateway or a background service.
- Text, client function tools and text tool results are supported. Images, PDFs, server-side tools, thinking blocks, prompt-cache semantics and token-count endpoints are unsupported. Unsupported content fails rather than being silently flattened.
- Upstream generation is buffered through a non-streaming Chat Completions request, then emitted as Anthropic SSE. This preserves tool semantics but does not expose upstream token-by-token latency.
- Request and response JSON are limited to 8 MiB. Each API request has a 90-second timeout; bridge task limits apply separately. There is no adapter-level retry or fallback. Claude Code and the upstream provider can have their own retry behavior.
- Redirects are rejected; upstream error bodies are not reflected to the worker. The example does not enforce outbound network policy or OS file isolation.
- Thinking is disabled for this wrapper. Tool names and schemas are passed through, subject to the bridge's configured tool list. Third-party model costs may be unknown or reported as zero by Claude Code; use gateway-side limits for billing controls.
- The example is not a complete Anthropic API emulator. Use a maintained protocol gateway for broader multimodal or production API compatibility.

## Evidence

Real Linux testing uses official Claude Code `2.1.325`, Node `22.22.3` and `grok-chat-expert` on the US node. No browser, Claude account login, account rotation or production gateway restart is involved. The test process runs as an unprivileged user inside a memory- and time-limited systemd unit. Fixtures are synthetic files.

The native Messages endpoint passes a plain-text smoke test and fails the random-file read test as described above. With strict JSON text-tool mode enabled, the final complete sequence passes plain output, random-file reading with an actual `Read` event, explicit UUID continuation, and a real `Read → Edit` followed by parent-side arithmetic checks. An earlier attempt claimed an edit without making one and failed those checks. The protocol does not guarantee truthful completion claims. See the [validation record](validation.md) for the exact scope and remaining release checks.

The native DSH tool schema and policy checks are exercised separately against the installed DSH API locally. A full installed DSH GUI session on the US node, a real Anthropic-hosted model, macOS and Windows remain outside this test scope.
