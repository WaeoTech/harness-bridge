#!/usr/bin/env node
import { runClaude, profiles } from '../src/index.js';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === 'doctor') {
  const checks = ['claude', 'dsh'].map(command => {
    const r = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000, shell: false });
    return { command, available: !r.error && r.status === 0 };
  });
  console.log(JSON.stringify({ node: process.version, checks }, null, 2));
  process.exitCode = checks.every(c => c.available) ? 0 : 1;
} else if (args[0] !== 'run') {
  console.log(`Harness Bridge (local preview)
  harness-bridge doctor
  harness-bridge run --prompt "Review this project" [--cwd PATH]
    [--profile ${Object.keys(profiles).join('|')}] [--mode review|edit]
    [--resume UUID] [--max-turns 8] [--budget 2] [--timeout 300000] [--events]
    [--executable /absolute/path/to/claude-or-wrapper]

Review mode exposes file reading tools; edit adds Edit and Write.
Shell and MCP tools are unavailable. CLI hooks are still user-controlled.
This package is not yet published; run with node bin/cli.js from the checkout.`);
  if (args.length && !['help', '--help', '-h'].includes(args[0])) process.exitCode = 1;
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const mapping = { '--prompt': 'prompt', '--cwd': 'cwd', '--profile': 'profile', '--mode': 'mode', '--resume': 'sessionId', '--max-turns': 'maxTurns', '--budget': 'maxBudgetUsd', '--timeout': 'timeoutMs', '--executable': 'executable' };
    const options = {};
    let events = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--events') { events = true; continue; }
      const key = mapping[args[i]];
      if (!key || args[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${args[i]}`);
      options[key] = ['maxTurns', 'maxBudgetUsd', 'timeoutMs'].includes(key) ? Number(args[++i]) : args[++i];
    }
    // The CLI deliberately makes the requested cwd its workspace root.
    const result = await runClaude(options, {
      signal: controller.signal,
      onEvent: events ? event => process.stderr.write(JSON.stringify(event) + '\n') : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, ...(error.partial ?? {}) }));
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
