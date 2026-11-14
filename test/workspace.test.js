import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, symlink, link, unlink, rename, rm, open, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createWorkspace } from '../src/workspace.js';

async function fixture(t) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'harness-workspace-test-'));
  const identity = await lstat(parent);
  t.after(async () => {
    assert.equal(dirname(parent), await realpath(tmpdir()));
    assert.ok(basename(parent).startsWith('harness-workspace-test-'));
    const actual = await lstat(parent);
    assert.equal(actual.ino, identity.ino);
    assert.ok(actual.isDirectory() && !actual.isSymbolicLink());
    await rm(parent, { recursive: true, force: true });
  });
  const root = join(parent, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet', root]);
  return { parent, root };
}
async function workspace(t, root, options) {
  const ws = await createWorkspace(root, options);
  t.after(() => ws.dispose());
  return ws;
}
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

test('mirrors real repositories, empty directories and executable modes without protected metadata or symlinks', async t => {
  const { root, parent } = await fixture(t);
  await mkdir(join(root, 'nested', 'empty'), { recursive: true });
  for (const name of ['.claude', 'node_modules', 'nested/.git']) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'secret'), 'excluded');
  }
  await writeFile(join(root, 'run'), '#!/bin/sh\necho okay\n', { mode: 0o755 });
  await writeFile(join(parent, 'outside'), 'outside');
  await symlink(join(parent, 'outside'), join(root, 'link'));
  await symlink(parent, join(root, 'directory-link'));
  execFileSync('mkfifo', [join(root, 'fifo')]);
  const alias = join(parent, 'root-alias');
  await symlink(root, alias);
  const ws = await workspace(t, alias);
  assert.equal(ws.root, await realpath(root));
  assert.match(ws.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(ws.directory, root);
  assert.equal(await readFile(join(ws.directory, 'run'), 'utf8'), '#!/bin/sh\necho okay\n');
  assert.equal((await lstat(join(ws.directory, 'run'))).mode & 0o777, 0o755);
  assert.ok((await lstat(join(ws.directory, 'nested', 'empty'))).isDirectory());
  for (const path of ['.git', '.claude', 'node_modules', 'nested/.git', 'link', 'directory-link', 'fifo']) await absent(join(ws.directory, path));
  assert.deepEqual(await ws.changes(), []);
});

test('review and metadata leave source unchanged; apply adds and modifies only reviewed files', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'a.txt'), 'before\n');
  const ws = await workspace(t, root);
  await writeFile(join(ws.directory, 'a.txt'), 'after\n');
  await mkdir(join(ws.directory, 'new'));
  await writeFile(join(ws.directory, 'new', 'b.txt'), 'added\n', { mode: 0o755 });
  await assert.rejects(ws.apply(), /Review is required/);
  const review = await ws.review();
  assert.equal(review.id, ws.id);
  assert.deepEqual(review.changes.map(c => [c.path, c.kind]), [['a.txt', 'modify'], ['new/b.txt', 'add']]);
  assert.match(review.changes[0].beforeHash, /^[0-9a-f]{64}$/);
  assert.match(review.changes[0].afterHash, /^[0-9a-f]{64}$/);
  assert.equal(review.changes[1].beforeHash, null);
  assert.match(review.diff, /-before\n/);
  assert.match(review.diff, /\+after\n/);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'before\n');
  await absent(join(root, 'new'));
  // Returned metadata is not trusted state.
  review.changes[0].afterHash = 'tampered';
  const applied = await ws.apply();
  assert.equal(applied.changes.length, 2);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'after\n');
  assert.equal(await readFile(join(root, 'new', 'b.txt'), 'utf8'), 'added\n');
  assert.equal((await lstat(join(root, 'new', 'b.txt'))).mode & 0o777, 0o755);
  await assert.rejects(ws.apply(), /already applied/);
});

test('a conflict in any original blocks all changes, including changes to unrelated files', async t => {
  const { root } = await fixture(t);
  for (const name of ['a', 'b', 'untouched']) await writeFile(join(root, name), 'initial');
  const ws = await workspace(t, root);
  for (const name of ['a', 'b']) await writeFile(join(ws.directory, name), 'mirror');
  await ws.review();
  await writeFile(join(root, 'untouched'), 'external');
  await assert.rejects(ws.apply(), /Source conflict/);
  for (const name of ['a', 'b']) assert.equal(await readFile(join(root, name), 'utf8'), 'initial');
});

test('new source files and source parent symlinks fail preflight before writes', async t => {
  const { root, parent } = await fixture(t);
  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'a'), 'initial');
  await writeFile(join(root, 'dir', 'b'), 'initial');
  const ws = await workspace(t, root);
  await writeFile(join(ws.directory, 'a'), 'mirror');
  await writeFile(join(ws.directory, 'dir', 'b'), 'mirror');
  await ws.review();
  await writeFile(join(root, 'extra'), 'external');
  await assert.rejects(ws.apply(), /Source conflict/);
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'initial');
  await unlink(join(root, 'extra'));
  const moved = join(parent, 'moved');
  await rename(join(root, 'dir'), moved);
  await symlink(moved, join(root, 'dir'));
  await assert.rejects(ws.apply(), /Source conflict|symlink/);
  assert.equal(await readFile(join(moved, 'b'), 'utf8'), 'initial');
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'initial');
});

test('mirror changes after review require another review, including executable mode changes', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'a'), 'initial');
  const ws = await workspace(t, root);
  await writeFile(join(ws.directory, 'a'), 'first');
  await ws.review();
  await writeFile(join(ws.directory, 'a'), 'second');
  await assert.rejects(ws.apply(), /changed since review/);
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'initial');
  await ws.review();
  await chmod(join(ws.directory, 'a'), 0o755);
  await assert.rejects(ws.apply(), /changed since review/);
  await ws.review();
  await ws.apply();
  assert.equal((await lstat(join(root, 'a'))).mode & 0o777, 0o755);
});

test('new mirror symlinks are rejected by changes, review and apply', async t => {
  const { root, parent } = await fixture(t);
  await writeFile(join(root, 'a'), 'initial');
  const ws = await workspace(t, root);
  await writeFile(join(ws.directory, 'a'), 'mirror');
  await ws.review();
  await symlink(parent, join(ws.directory, 'escape'));
  await assert.rejects(ws.changes(), /symlink/);
  await assert.rejects(ws.review(), /symlink/);
  await assert.rejects(ws.apply(), /symlink/);
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'initial');
});

test('protected mirror paths are excluded from review and never applied', async t => {
  const { root, parent } = await fixture(t);
  const ws = await workspace(t, root);
  await mkdir(join(ws.directory, '.git'));
  await symlink(parent, join(ws.directory, '.git', 'ignored-link'));
  await writeFile(join(ws.directory, '.git', 'config'), 'untrusted');
  await writeFile(join(ws.directory, 'safe'), 'safe');
  const review = await ws.review();
  assert.deepEqual(review.changes.map(c => c.path), ['safe']);
  const config = await readFile(join(root, '.git', 'config'), 'utf8');
  await ws.apply();
  assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), config);
  await absent(join(root, '.git', 'ignored-link'));
});

test('deletion metadata is explicit and apply rejects all writes for deletions', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'a'), 'initial');
  const ws = await workspace(t, root);
  await unlink(join(ws.directory, 'a'));
  await writeFile(join(ws.directory, 'b'), 'added');
  const review = await ws.review();
  assert.equal(review.changes[0].kind, 'delete');
  assert.equal(review.changes[0].afterHash, null);
  await assert.rejects(ws.apply(), /deletions are not supported/);
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'initial');
  await absent(join(root, 'b'));
});

test('excluded source symlink collisions and source hardlinks cannot be overwritten', async t => {
  const { root, parent } = await fixture(t);
  const outside = join(parent, 'outside');
  await writeFile(outside, 'outside');
  await symlink(outside, join(root, 'link'));
  const ws = await workspace(t, root);
  await writeFile(join(ws.directory, 'link'), 'replacement');
  await ws.review();
  await assert.rejects(ws.apply(), /unsafe destination|Source conflict/);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  const { root: second } = await fixture(t);
  await link(outside, join(second, 'hardlink'));
  const hard = await workspace(t, second);
  await writeFile(join(hard.directory, 'hardlink'), 'replacement');
  await hard.review();
  await assert.rejects(hard.apply(), /unsafe destination/);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('apply rolls back modified files and created files/directories after cancellation mid-write', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'a'), 'original', { mode: 0o755 });
  const controller = new AbortController();
  const ws = await workspace(t, root);
  await writeFile(join(ws.directory, 'a'), 'modified');
  await mkdir(join(ws.directory, 'b'));
  await writeFile(join(ws.directory, 'b', 'added'), 'added');
  await writeFile(join(ws.directory, 'z'), 'last');
  await ws.review();
  const probe = await open(join(root, 'a'), 'r');
  const prototype = Object.getPrototypeOf(probe), originalWrite = prototype.write;
  await probe.close();
  let writes = 0;
  const mocked = t.mock.method(prototype, 'write', async function (...args) {
    const result = await originalWrite.apply(this, args);
    if (++writes === 2) controller.abort(new Error('test cancellation'));
    return result;
  });
  try { await assert.rejects(ws.apply({ signal: controller.signal }), /test cancellation/); } finally { mocked.mock.restore(); }
  assert.equal(await readFile(join(root, 'a'), 'utf8'), 'original');
  assert.equal((await lstat(join(root, 'a'))).mode & 0o777, 0o755);
  await absent(join(root, 'b'));
  await absent(join(root, 'z'));
});

test('byte limits fail explicitly during snapshot and review; aborted creation fails', async t => {
  const { root } = await fixture(t);
  const handle = await open(join(root, 'large'), 'w');
  await handle.truncate(64 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(createWorkspace(root), /64 MiB/);
  await unlink(join(root, 'large'));
  const ws = await workspace(t, root);
  const mirror = await open(join(ws.directory, 'large'), 'w');
  await mirror.truncate(64 * 1024 * 1024 + 1);
  await mirror.close();
  await assert.rejects(ws.review(), /64 MiB/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(createWorkspace(root, { signal: controller.signal }), /cancelled/);
});

test('file limit fails explicitly rather than silently dropping entries', async t => {
  const { root } = await fixture(t);
  const ws = await workspace(t, root);
  for (let start = 0; start < 5001; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 5001 - start) }, (_, index) => writeFile(join(ws.directory, `file-${start + index}`), '')));
  }
  await assert.rejects(ws.review(), /5000 file limit/);
});

test('binary diffs are readable and large textual diffs explicitly report truncation', async t => {
  const { root } = await fixture(t);
  const ws = await workspace(t, root);
  await writeFile(join(ws.directory, 'binary'), Buffer.from([0, 255]));
  await writeFile(join(ws.directory, 'large'), 'x'.repeat(5 * 1024 * 1024));
  const review = await ws.review();
  assert.match(review.diff, /Binary files differ/);
  assert.match(review.diff, /Diff truncated/);
  assert.ok(Buffer.byteLength(review.diff) < 4 * 1024 * 1024 + 100);
});

test('dispose is idempotent and rejects a replaced temporary root without touching replacement', async t => {
  const { root, parent } = await fixture(t);
  const ws = await createWorkspace(root);
  const saved = join(parent, 'saved-mirror');
  await rename(ws.directory, saved);
  await symlink(root, ws.directory);
  await assert.rejects(ws.dispose(), /Refusing disposal/);
  assert.ok((await lstat(root)).isDirectory());
  // Verify the actual symlink before unlinking this exact mkdtemp path.
  assert.ok((await lstat(ws.directory)).isSymbolicLink());
  await unlink(ws.directory);
  await rename(saved, ws.directory);
  await ws.dispose();
  await ws.dispose();
  await absent(ws.directory);
  await assert.rejects(ws.changes(), /disposed/);
});
