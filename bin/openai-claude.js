#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startProxy } from '../examples/openai-messages-proxy.mjs';

// Operator opt-in wrapper. stdout remains the real CLI's stream-json protocol.
let proxy, child;
try {
  const config = process.env.HARNESS_BRIDGE_PROVIDER_CONFIG
    ? JSON.parse(await readFile(process.env.HARNESS_BRIDGE_PROVIDER_CONFIG, 'utf8')) : {};
  const model = config.model ?? process.env.HARNESS_BRIDGE_OPENAI_MODEL;
  const token = randomBytes(32).toString('hex');
  proxy = await startProxy({
    baseURL: config.baseURL ?? process.env.HARNESS_BRIDGE_OPENAI_BASE_URL,
    apiKey: config.apiKey ?? process.env.HARNESS_BRIDGE_OPENAI_API_KEY,
    model, token, textTools: config.textTools === true || process.env.HARNESS_BRIDGE_OPENAI_TEXT_TOOLS === '1',
  });
  const env = { ...process.env,
    ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1', MAX_THINKING_TOKENS: '0',
  };
  // The real upstream key stays in this wrapper; Claude receives a local token.
  delete env.HARNESS_BRIDGE_OPENAI_API_KEY;
  delete env.HARNESS_BRIDGE_PROVIDER_CONFIG;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  child = spawn(config.executable ?? process.env.HARNESS_BRIDGE_CLAUDE_EXECUTABLE ?? 'claude', process.argv.slice(2), {
    env, shell: false, stdio: 'inherit', windowsHide: true,
  });
  const onSignal = () => child.kill('SIGTERM');
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
} catch {
  // Configuration paths and upstream errors may contain credentials; keep this generic.
  process.stderr.write('OpenAI compatibility wrapper failed; check operator configuration and upstream availability.\n');
  process.exitCode = 1;
} finally { await proxy?.close(); }
