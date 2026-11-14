// A private tmux server runs the real Claude process. Machine events go to DSH;
// the attachable pane displays the same real tool lifecycle in readable form.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, open, stat, realpath, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createEventParser } from './index.js';
import { progressLines } from './worker.js';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--pane') {
  const dir = process.argv[3];
  const spec = JSON.parse(await readFile(join(dir, 'spec.json'), 'utf8'));
  const log = createWriteStream(join(dir, 'events.jsonl'), { mode: 0o600 });
  const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: process.env, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const parser = createEventParser(event => {
    for (const line of progressLines(event)) process.stdout.write(line + '\n');
  });
  let failure;
  child.stdout.on('data', chunk => {
    log.write(chunk);
    try { parser.push(chunk); } catch { failure = true; child.kill('SIGTERM'); }
  });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = true; });
  child.stdin.end(spec.prompt);
  const outcome = await new Promise(resolve => {
    child.once('error', () => resolve({ exitCode: 1 }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  try { parser.end(); } catch { failure = true; }
  await new Promise(resolve => log.end(resolve));
  await writeFile(join(dir, 'done.json'), JSON.stringify({ ...outcome, ...(failure ? { exitCode: 1 } : {}) }), { mode: 0o600 });
} else {
  const tmux = process.argv[2];
  const dir = await mkdtemp(join(tmpdir(), 'harness-bridge-tmux-'));
  const socket = join(dir, 'socket');
  const session = 'claude';
  let offset = 0, stopped = false, total = 0;
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  function command(args) {
    const result = spawnSync(tmux, ['-S', socket, ...args], { encoding: 'utf8', timeout: 3000, env: { ...process.env, TMUX: '' }, maxBuffer: 65536 });
    if (result.error || result.status !== 0) throw new Error('tmux command failed');
  }
  async function drain() {
    let handle;
    try {
      handle = await open(join(dir, 'events.jsonl'), 'r');
      const size = (await handle.stat()).size;
      while (offset < size) {
        const buffer = Buffer.alloc(Math.min(65536, size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead; total += bytesRead;
        if (total > 32 * 1024 * 1024) throw new Error('tmux events exceed limit');
        if (!process.stdout.write(buffer.subarray(0, bytesRead))) await new Promise(resolve => process.stdout.once('drain', resolve));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 2_000_000) throw new Error('tmux input exceeds limit');
    }
    const spec = JSON.parse(input);
    await writeFile(join(dir, 'spec.json'), JSON.stringify(spec), { mode: 0o600 });
    command(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-c', spec.cwd, process.execPath, self, '--pane', dir]);
    // Keep the pane until the supervisor has drained the final event and exit file.
    // A very short task can finish before this option is set; done.json remains authoritative.
    try { command(['set-option', '-t', session, 'remain-on-exit', 'on']); } catch { /* Already completed. */ }
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'harness_tmux', session, attach: `tmux -S '${socket}' attach -t ${session}` }) + '\n');
    const started = Date.now();
    while (!stopped) {
      await drain();
      try {
        const outcome = JSON.parse(await readFile(join(dir, 'done.json'), 'utf8'));
        await drain();
        process.exitCode = outcome.exitCode ?? 1;
        break;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (Date.now() - started > 3_600_000) throw new Error('tmux supervisor timeout');
      // Confirm a crashed pane cannot leave the supervisor waiting for an hour.
      try { command(['has-session', '-t', session]); }
      catch {
        try { await stat(join(dir, 'done.json')); } catch { throw new Error('tmux pane exited without an outcome'); }
      }
      await delay(100);
    }
    if (stopped) process.exitCode = 1;
  } catch {
    process.stderr.write('Managed tmux worker failed; check tmux availability and local Claude setup.\n');
    process.exitCode = 1;
  } finally {
    try { command(['kill-server']); } catch { /* Already stopped. */ }
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    const actual = await realpath(dir);
    if (actual !== dir || !dir.startsWith(join(tmpdir(), 'harness-bridge-tmux-'))) throw new Error('Unsafe tmux cleanup path');
    await rm(actual, { recursive: true });
  }
}
