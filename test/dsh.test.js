import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runManagedClaude } from '../src/managed.js';

function fakeService({ text, hang = false } = {}) {
  let spec, terminated = false, start;
  const started = new Promise(resolve => { start = resolve; });
  return {
    started,
    get spec() { return spec; },
    get terminated() { return terminated; },
    async resolveExecutable(command) { return `/resolved/${command}`; },
    spawn(options) {
      spec = options;
      start();
      const stdout = new PassThrough();
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const terminate = () => { terminated = true; stdout.end(); finish({ exitCode: null, signal: 'SIGTERM' }); };
      options.signal.addEventListener('abort', terminate, { once: true });
      if (!hang) setImmediate(() => {
        stdout.end(text ?? '{"type":"result","subtype":"success","result":"verified","session_id":"11111111-1111-4111-8111-111111111111"}\n');
        finish({ exitCode: 0, signal: null });
      });
      return { stdout, done, terminate, async waitForExit() { await done; return true; } };
    },
  };
}

test('managed transport obeys host service contract and always cleans up', async () => {
  const service = fakeService();
  const out = await runManagedClaude(service, { prompt: 'review', cwd: process.cwd() }, { signal: new AbortController().signal });
  assert.equal(out.ok, true);
  assert.equal(service.spec.stdio.stdin.data, 'review');
  assert.equal(service.spec.argv[0], '/resolved/claude');
  assert.deepEqual(service.spec.env, { HARNESS_BRIDGE_DEPTH: '1' });
  assert.equal(service.terminated, true);
});

test('managed malformed output, timeout and external abort terminate the worker', async () => {
  const malformed = fakeService({ text: 'bad\n' });
  await assert.rejects(runManagedClaude(malformed, { prompt: 'review' }, { signal: new AbortController().signal }), /Invalid Claude/);
  assert.equal(malformed.terminated, true);
  const hang = fakeService({ hang: true });
  // Keep an active handle for this fake transport, like a real child process would.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(runManagedClaude(hang, { prompt: 'review', timeoutMs: 30 }, { signal: new AbortController().signal }), /timed out/);
    const controller = new AbortController();
    const abortService = fakeService({ hang: true });
    const pending = runManagedClaude(abortService, { prompt: 'review' }, { signal: controller.signal });
    await abortService.started;
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(abortService.terminated, true);
  } finally { clearInterval(keepAlive); }
});

let native;
try { native = await import('../src/dsh.js'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const peers = { skip: native ? false : 'Native DSH peer packages unavailable' };
function context(mode, service = fakeService()) {
  let tool, dispose;
  return {
    ctx: { tools: { register(t) { tool = t; } }, sandboxPolicy: { resolve() { return { mode }; } }, subprocess: service, on(event, fn) { assert.equal(event, 'dispose'); dispose = fn; } },
    get tool() { return tool; }, get dispose() { return dispose; },
  };
}
const exec = () => ({ signal: new AbortController().signal });

test('native plugin registers through actual DSH defineTool and rejects restricted sessions', peers, async () => {
  const c = context('workspace-write');
  native.apply(c.ctx, { workspaceRoot: process.cwd() });
  assert.equal(c.tool.name, 'claude_code');
  assert.deepEqual(c.tool.parameters.required, ['prompt']);
  await assert.rejects(c.tool.execute({ prompt: 'task' }, exec()), /unrestricted/);
});

test('native plugin enforces operator root and edit gate', peers, async () => {
  const c = context('danger-full-access');
  native.apply(c.ctx, {});
  await assert.rejects(c.tool.execute({ prompt: 'task' }, exec()), /workspaceRoot/);
  const d = context('danger-full-access');
  native.apply(d.ctx, { workspaceRoot: process.cwd() });
  await assert.rejects(d.tool.execute({ prompt: 'task', mode: 'edit' }, exec()), /disabled/);
  await assert.rejects(d.tool.execute({ prompt: 'task', mode: 'bypass' }, exec()));
});

test('native plugin returns canonical string result and rejects directory escape', peers, async () => {
  const c = context('danger-full-access');
  native.apply(c.ctx, { workspaceRoot: process.cwd() });
  const result = await c.tool.execute({ prompt: 'review' }, exec());
  assert.equal(JSON.parse(result).ok, true);
  assert.equal(c.tool.output.render({}, result)[0].text, result);
  const escaped = JSON.parse(await c.tool.execute({ prompt: 'review', directory: '..' }, exec()));
  assert.equal(escaped.ok, false); assert.match(escaped.error, /inside/);
  c.dispose();
  await assert.rejects(c.tool.execute({ prompt: 'task' }, exec()));
});
