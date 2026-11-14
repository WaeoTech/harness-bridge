import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude, prepare, createEventParser } from '../src/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'harness-bridge-test-'));
  // Only remove the exact temporary directory returned by mkdtemp.
  t.after(async () => { assert.match(root, /harness-bridge-test-/); await rm(root, { recursive: true, force: true }); });
  const executable = join(root, 'fake-claude');
  await writeFile(executable, `#!${process.execPath}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', s => input += s);
process.stdin.on('end', () => {
  if (input === 'hang') { setInterval(() => {}, 1000); return; }
  if (input === 'malformed') { console.log('not-json'); return; }
  if (input === 'missing') { console.log(JSON.stringify({type:'system'})); return; }
  if (input === 'exit') { process.stderr.write('secret diagnostic'); process.exitCode = 3; return; }
  console.log(JSON.stringify({type:'system', subtype:'init', session_id:'11111111-1111-4111-8111-111111111111'}));
  const denied = input === 'deny';
  console.log(JSON.stringify({type:'result', subtype: input === 'limit' ? 'error_max_turns' : 'success', is_error: input === 'limit', result:input, total_cost_usd:0.01, permission_denials: denied ? [{tool_name:'Edit'}] : []}));
});
`, { mode: 0o700 });
  return { root, cwd: root, executable, prompt: 'hello' };
}

 test('argument vector keeps user prompt out of command line and has bounded permissions', async t => {
  const f = await fixture(t);
  const spec = await prepare({ ...f, prompt: '$(touch NOPE); --dangerously-skip-permissions' });
  assert.ok(!spec.args.includes(spec.prompt));
  assert.ok(spec.args.includes('dontAsk'));
  assert.ok(spec.args.includes('Read,Glob,Grep'));
  assert.ok(!spec.args.includes('--dangerously-skip-permissions'));
 });

test('validation rejects traversal, symlink escape and malformed limits', async t => {
  const f = await fixture(t);
  await assert.rejects(prepare({ ...f, cwd: tmpdir() }), /inside/);
  const link = join(f.root, 'outside');
  await symlink(tmpdir(), link);
  await assert.rejects(prepare({ ...f, cwd: link }), /inside/);
  for (const bad of [{ maxTurns: 0 }, { timeoutMs: Infinity }, { maxBudgetUsd: NaN }, { sessionId: '--flag' }, { profile: '__proto__' }, { mode: 'bypassPermissions' }]) {
    await assert.rejects(prepare({ ...f, ...bad }));
  }
  const nested = join(f.root, 'nested'); await mkdir(nested);
  assert.equal((await prepare({ ...f, cwd: nested })).cwd, nested);
});

test('parser handles fragmented UTF-8, CRLF, final line and unknown event types', () => {
  const events = [];
  const p = createEventParser(e => events.push(e));
  const bytes = Buffer.from('{"type":"future","text":"中文"}\r\n{"type":"result"}');
  for (const byte of bytes) p.push(Buffer.from([byte]));
  p.end();
  assert.deepEqual(events, [{ type: 'future', text: '中文' }, { type: 'result' }]);
});

test('parser rejects malformed, non-object and oversized messages', () => {
  for (const line of ['oops\n', 'null\n', '[]\n', '{}\n']) {
    assert.throws(() => createEventParser(() => {}).push(line));
  }
  assert.throws(() => createEventParser(() => {}, { maxLineBytes: 8 }).push('123456789'), /limit/);
});

const posix = { skip: process.platform === 'win32' ? 'POSIX fixture executable; Windows needs native smoke test' : false };

test('real child process emits final result and session identity', posix, async t => {
  const events = [];
  const out = await runClaude(await fixture(t), { onEvent: e => events.push(e) });
  assert.equal(out.ok, true); assert.equal(out.result, 'hello');
  assert.equal(out.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(events.length, 2);
});

test('permission denials and turn limits are never reported as success', posix, async t => {
  const f = await fixture(t);
  const denied = await runClaude({ ...f, prompt: 'deny' });
  assert.equal(denied.ok, false); assert.equal(denied.status, 'permission_denied');
  const limited = await runClaude({ ...f, prompt: 'limit' });
  assert.equal(limited.status, 'failed');
});

test('malformed stream, missing result, exit errors and missing binary fail closed', posix, async t => {
  const f = await fixture(t);
  await assert.rejects(runClaude({ ...f, prompt: 'malformed' }), /Invalid Claude/);
  await assert.rejects(runClaude({ ...f, prompt: 'missing' }), /without a final/);
  await assert.rejects(runClaude({ ...f, prompt: 'exit' }), e => {
    assert.equal(e.partial.exitCode, 3); assert.ok(!e.message.includes('secret')); return true;
  });
  await assert.rejects(runClaude({ ...f, executable: join(f.root, 'absent') }), /not found/);
});

test('timeout and AbortSignal stop child processes', posix, async t => {
  const f = await fixture(t);
  await assert.rejects(runClaude({ ...f, prompt: 'hang', timeoutMs: 100 }), /timed out/);
  const controller = new AbortController();
  const result = runClaude({ ...f, prompt: 'hang' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(result, /cancelled/);
});
