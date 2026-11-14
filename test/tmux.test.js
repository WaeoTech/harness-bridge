import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventParser } from '../src/index.js';

const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' });
const options = { skip: tmux.status === 0 ? false : 'tmux is not installed', timeout: 15000 };
const driver = fileURLToPath(new URL('../src/tmux.js', import.meta.url));
async function fixture(t, hang) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-tmux-test-'));
  t.after(async () => { assert.match(dir, /bridge-tmux-test-/); await rm(dir, { recursive: true }); });
  const path = join(dir, 'fake.mjs');
  await writeFile(path, `process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'actual.txt'}}]}})); ${hang ? 'setInterval(() => {},1000);' : "console.log(JSON.stringify({type:'result',subtype:'success',result:'actual fixture result'}));"} });`);
  return { executable: process.execPath, args: [path], cwd: dir, prompt: 'actual input' };
}
function launch(spec, onEvent) {
  const child = spawn(process.execPath, [driver, tmux.stdout.trim()], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [], parser = createEventParser(event => { events.push(event); onEvent?.(event); });
  child.stdout.on('data', chunk => parser.push(chunk));
  child.stdin.end(JSON.stringify(spec));
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { parser.end(); resolve({ code, events, stderr }); }); });
  return { child, done };
}

test('real tmux pane forwards actual tool events and final outcome, then removes its socket', options, async t => {
  const spec = await fixture(t, false);
  const { done } = launch(spec);
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.events.at(-1).result, 'actual fixture result');
  assert.equal(result.events[1].message.content[0].name, 'Read');
  const attach = result.events[0].attach;
  const socket = attach.match(/-S '([^']+)'/)[1];
  await assert.rejects(access(socket), { code: 'ENOENT' });
});

test('cancelling the supervisor kills its private tmux server and removes the socket', options, async t => {
  const spec = await fixture(t, true);
  let socket;
  const { child, done } = launch(spec, event => {
    if (event.subtype === 'harness_tmux') socket = event.attach.match(/-S '([^']+)'/)[1];
    if (event.type === 'assistant') child.kill('SIGTERM');
  });
  const result = await done;
  assert.equal(result.code, 1, result.stderr);
  await assert.rejects(access(socket), { code: 'ENOENT' });
});
