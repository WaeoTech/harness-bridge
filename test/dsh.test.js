import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runManagedClaude } from '../src/managed.js';

function fakeService({ text, hang = false, onSpawn } = {}) {
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
      if (!hang) setImmediate(async () => {
        await onSpawn?.(options);
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
  const tools = new Map(), jobs = new Map(), progress = [];
  return {
    ctx: { tools: { register(t) { tool = t; tools.set(t.name, t); } }, jobs: { start(spec) {
      const id = `claude-code-${jobs.size + 1}`;
      const hooks = spec.run({ append(line) { progress.push(line); }, updateProgress() {} });
      jobs.set(id, hooks); return id;
    } }, sandboxPolicy: { resolve() { return { mode }; } }, subprocess: service, on(event, fn) { assert.equal(event, 'dispose'); dispose = fn; } },
    tools, jobs, progress,
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
  await c.dispose();
  await assert.rejects(c.tool.execute({ prompt: 'task' }, exec()));
});

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-test-'));
  await writeFile(join(root, 'calc.js'), 'old\n');
  t.after(async () => { assert.match(root, /bridge-native-test-/); await rm(root, { recursive: true }); });
  return root;
}

test('native edits stay in the copy until the exact proposal is reviewed and applied', peers, async t => {
  const root = await workspace(t);
  const events = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'calc.js' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } },
    { type: 'result', subtype: 'success', result: 'edited', session_id: '11111111-1111-4111-8111-111111111111' },
  ];
  const service = fakeService({ text: events.map(JSON.stringify).join('\n'), onSpawn: spec => writeFile(join(spec.cwd, 'calc.js'), 'new\n') });
  const c = context('danger-full-access', service);
  const config = { workspaceRoot: root, allowEdits: true, language: 'en-GB' };
  native.apply(c.ctx, config);
  t.after(c.dispose);
  const result = JSON.parse(await c.tool.execute({ prompt: 'edit calc.js', mode: 'edit' }, exec()));
  assert.equal(result.status, 'awaiting_review');
  assert.equal(result.language, 'en-GB');
  assert.equal(await readFile(join(root, 'calc.js'), 'utf8'), 'old\n');
  assert.ok(c.progress.some(line => line.includes('→ Edit')));
  assert.ok(service.spec.argv.includes('--settings'));
  const reviewTool = c.tools.get('harness_review');
  const review = JSON.parse(await reviewTool.execute({ action: 'inspect', reviewId: result.reviewId }, exec()));
  assert.match(review.diff, /new/); assert.equal(review.root, root);
  config.workspaceRoot = await workspace(t);
  await assert.rejects(reviewTool.execute({ action: 'apply', reviewId: result.reviewId, digest: review.digest }, exec()), /workspaceRoot changed/);
  config.workspaceRoot = root;
  await assert.rejects(reviewTool.execute({ action: 'apply', reviewId: result.reviewId, digest: 'wrong' }, exec()), /digest/);
  const applied = JSON.parse(await reviewTool.execute({ action: 'apply', reviewId: result.reviewId, digest: review.digest }, exec()));
  assert.equal(applied.status, 'applied');
  assert.equal(await readFile(join(root, 'calc.js'), 'utf8'), 'new\n');
  await assert.rejects(reviewTool.execute({ action: 'inspect', reviewId: result.reviewId }, exec()), /Unknown/);
});

test('live settings affect new tasks; resume refuses language drift or foreign UUIDs', peers, async t => {
  const root = await workspace(t);
  const c = context('danger-full-access');
  const config = { workspaceRoot: root, language: 'ja-JP' };
  native.apply(c.ctx, config); t.after(c.dispose);
  const first = JSON.parse(await c.tool.execute({ prompt: 'review' }, exec()));
  assert.equal(first.language, 'ja-JP');
  config.language = 'en-US'; config.transport = 'tmux';
  assert.deepEqual(JSON.parse(await c.tools.get('harness_settings').execute({}, exec())), { language: 'en-US', transport: 'tmux', allowEdits: false });
  const resumed = JSON.parse(await c.tool.execute({ prompt: 'review', sessionId: first.sessionId }, exec()));
  assert.equal(resumed.ok, false); assert.match(resumed.error, /Resume requires/);
});

test('actual DSH volatile Config refs resolve into plain per-task settings', peers, async t => {
  const root = await workspace(t);
  const validated = native.Config['~standard'].validate({ workspaceRoot: root, language: 'en-GB', allowEdits: true });
  assert.equal(validated.issues, undefined);
  assert.equal(typeof validated.value.language.get, 'function');
  const c = context('danger-full-access');
  native.apply(c.ctx, validated.value); t.after(c.dispose);
  const settings = JSON.parse(await c.tools.get('harness_settings').execute({}, exec()));
  assert.equal(settings.language, 'en-GB'); assert.equal(settings.allowEdits, true);
  const result = JSON.parse(await c.tool.execute({ prompt: 'Review only' }, exec()));
  assert.equal(result.ok, true); assert.equal(result.language, 'en-GB');
  const legacy = native.Config['~standard'].validate({ workspaceRoot: root, profile: 'ja-JP' });
  const older = context('danger-full-access'); native.apply(older.ctx, legacy.value); t.after(older.dispose);
  assert.equal(JSON.parse(await older.tools.get('harness_settings').execute({}, exec())).language, 'ja-JP');
});

test('DSH Git audit observes real status and diff without running configured fsmonitor', peers, async t => {
  const root = await workspace(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('add', 'calc.js'); git('-c', 'user.name=Bridge Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  await writeFile(join(root, 'calc.js'), 'new\n');
  git('config', 'core.fsmonitor', `touch ${join(root, 'monitor-ran')}`);
  const service = { async resolveExecutable(command) { return command; }, spawn(options) {
    const child = spawn(options.argv[0], options.argv.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(options.stdio.stdin.data); child.stderr.resume();
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
    return { stdout: child.stdout, done, terminate() { if (child.exitCode === null) child.kill(); }, async waitForExit() { await done; return true; } };
  } };
  const audit = await native.gitAudit(service, root, new AbortController().signal);
  assert.equal(audit.available, true); assert.equal(audit.diffExitCode, 0);
  assert.match(audit.status, /calc\.js/); assert.match(audit.diff, /-old\n\+new/);
  await assert.rejects(access(join(root, 'monitor-ran')), { code: 'ENOENT' });
});

test('simultaneous native requests cannot both acquire the worker slot', peers, async t => {
  const root = await workspace(t), service = fakeService({ hang: true });
  const c = context('danger-full-access', service); native.apply(c.ctx, { workspaceRoot: root }); t.after(c.dispose);
  const settled = await Promise.allSettled([0, 1].map(() => c.tool.execute({ prompt: 'review', run_in_background: true }, exec())));
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
  const ack = JSON.parse(settled.find(item => item.status === 'fulfilled').value);
  await service.started; c.jobs.get(ack.jobId).cancel(); await c.jobs.get(ack.jobId).done;
});

test('native background job streams progress and cancellation disposes its copy', peers, async t => {
  const root = await workspace(t), service = fakeService({ hang: true });
  const c = context('danger-full-access', service);
  native.apply(c.ctx, { workspaceRoot: root }); t.after(c.dispose);
  const ack = JSON.parse(await c.tool.execute({ prompt: 'review', run_in_background: true }, exec()));
  assert.equal(ack.status, 'running');
  await service.started;
  assert.notEqual(service.spec.cwd, root);
  c.jobs.get(ack.jobId).cancel('test cancellation');
  const outcome = await c.jobs.get(ack.jobId).done;
  assert.equal(outcome.status, 'killed');
  assert.equal(service.terminated, true);
  await assert.rejects(access(service.spec.cwd), { code: 'ENOENT' });
});
