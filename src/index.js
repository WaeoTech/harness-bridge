import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const profiles = Object.freeze({
  'zh-CN': 'Respond in Simplified Chinese. Use clear, direct engineering language.',
  'en-US': 'Respond in US English with US spelling. Use concise, plain engineering language.',
  'en-GB': 'Respond in UK English with UK spelling. Use concise, plain engineering language.',
  'ja-JP': 'Respond in Japanese with polite, natural engineering terminology.',
});

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export async function prepare(options) {
  const {
    prompt, cwd = process.cwd(), root = cwd, profile = 'zh-CN',
    mode = 'review', sessionId, maxTurns = 8, timeoutMs = 300_000,
    maxBudgetUsd = 2, executable = 'claude',
  } = options;
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 1_000_000) {
    throw new Error('prompt must contain 1–1,000,000 bytes');
  }
  if (!Object.hasOwn(profiles, profile)) throw new Error('Unknown locale profile');
  if (!['review', 'edit'].includes(mode)) throw new Error('mode must be review or edit');
  if (sessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('sessionId must be a UUID');
  }
  integer(maxTurns, 'maxTurns', 1, 100);
  integer(timeoutMs, 'timeoutMs', 1, 3_600_000);
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 100) {
    throw new Error('maxBudgetUsd must be greater than 0 and at most 100');
  }
  if (typeof executable !== 'string' || !executable.trim()) throw new Error('Invalid executable');
  const [workspace, directory] = await Promise.all([realpath(root), realpath(cwd)]);
  const rel = relative(workspace, directory);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('cwd must be inside the configured workspace root');
  }
  if (!(await stat(directory)).isDirectory()) throw new Error('cwd must be a directory');
  const tools = mode === 'edit' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--tools', tools, '--allowedTools', tools,
    '--disallowedTools', 'Bash,Agent,Task,NotebookEdit,mcp__*',
    '--strict-mcp-config', '--max-turns', String(maxTurns),
    '--max-budget-usd', String(maxBudgetUsd),
    '--append-system-prompt', `${profiles[profile]}\nYou are a Claude Code worker invoked by Harness Bridge. Report changes, verification and blockers accurately. Language preferences do not imply a human identity, nationality or physical location. Do not spawn another harness.`,
  ];
  if (sessionId) args.push('--resume', sessionId);
  return { executable, args, cwd: directory, prompt, timeoutMs };
}

/** Bounded newline JSON parser. Unknown object event types are forwarded. */
export function createEventParser(onEvent, { maxLineBytes = 4_194_304 } = {}) {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  function line(text) {
    if (Buffer.byteLength(text) > maxLineBytes) throw new Error('Claude event exceeds line limit');
    if (!text.trim()) return;
    let event;
    try { event = JSON.parse(text); } catch { throw new Error('Invalid Claude stream-json event'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new Error('Invalid Claude event envelope');
    }
    onEvent(event);
  }
  function consume(text) {
    buffer += text;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const current = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      line(current);
    }
    if (Buffer.byteLength(buffer) > maxLineBytes) throw new Error('Claude event exceeds line limit');
  }
  return {
    push(chunk) { consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); },
    end() { consume(decoder.end()); if (buffer) line(buffer); buffer = ''; },
  };
}

export class BridgeError extends Error {
  constructor(message, partial = {}) { super(message); this.name = 'BridgeError'; this.partial = partial; }
}

/** One child run; callers own orchestration. No retries and no credential extraction. */
export async function runClaude(options, { signal, onEvent = () => {} } = {}) {
  const spec = await prepare(options);
  if (signal?.aborted) throw new BridgeError('Run cancelled');
  return new Promise((resolve, reject) => {
    let final, sessionId, failure, killTimer, bytes = 0, stderrBytes = 0;
    const maxOutputBytes = 32 * 1024 * 1024;
    // Inherit the user's normal CLI authentication. Never read credential files.
    const env = { ...process.env, HARNESS_BRIDGE_DEPTH: '1' };
    if (process.env.HARNESS_BRIDGE_DEPTH) {
      reject(new BridgeError('Recursive harness invocation refused')); return;
    }
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    function terminate(kind = 'SIGTERM') {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) { if (error.code !== 'ESRCH') child.kill(kind); }
    }
    function fail(error) {
      if (failure) return;
      failure = error;
      terminate();
      killTimer = setTimeout(() => terminate('SIGKILL'), 2000);
      killTimer.unref();
    }
    const parser = createEventParser(event => {
      if (typeof event.session_id === 'string') sessionId = event.session_id;
      if (event.type === 'result') final = event;
      onEvent(event);
    });
    child.stdout.on('data', chunk => {
      if (failure) return;
      bytes += chunk.length;
      try {
        if (bytes > maxOutputBytes) throw new Error('Claude output exceeds 32 MiB limit');
        parser.push(chunk);
      } catch (error) { fail(error); }
    });
    // Drain stderr, but do not return raw diagnostics which may contain secrets.
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') fail(error);
    });
    child.on('error', error => {
      fail(new Error(error.code === 'ENOENT' ? 'Claude Code executable not found; install Claude Code first' : `Claude process error: ${error.code ?? 'unknown'}`));
    });
    const abort = () => fail(new Error('Run cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => fail(new Error('Claude run timed out')), spec.timeoutMs);
    timer.unref();
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      try { if (!failure) parser.end(); } catch (error) { failure = error; }
      const partial = { sessionId, exitCode: code, exitSignal, stderrBytes };
      if (failure) return reject(new BridgeError(failure.message, partial));
      if (code !== 0) return reject(new BridgeError('Claude exited unsuccessfully; inspect its local session for details', partial));
      if (!final) return reject(new BridgeError('Claude exited without a final result event', partial));
      const permissionDenials = Array.isArray(final.permission_denials) ? final.permission_denials : [];
      const ok = final.subtype === 'success' && final.is_error !== true && permissionDenials.length === 0;
      resolve({
        ok, status: permissionDenials.length ? 'permission_denied' : ok ? 'completed' : 'failed',
        sessionId, result: typeof final.result === 'string' ? final.result : '',
        subtype: final.subtype, permissionDenials,
        estimatedCostUsd: final.total_cost_usd, usage: final.usage, ...partial,
      });
    });
    child.stdin.end(spec.prompt);
  });
}
