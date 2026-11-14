import { constants } from 'node:fs';
import { open, lstat, readdir, realpath, mkdtemp, mkdir, rm, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, join, dirname, basename, sep } from 'node:path';

const MAX_BYTES = 64 * 1024 * 1024, MAX_FILES = 5000, MAX_ENTRIES = 10000;
const MAX_DIFF = 4 * 1024 * 1024, PREFIX = 'harness-bridge-workspace-';
const PROTECTED = new Set(['.git', '.claude', 'node_modules']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const ignored = path => path.split(/[\\/]/).some(part => PROTECTED.has(part.toLowerCase()));

function inside(root, path) {
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || ignored(rel)) throw new Error(`Unsafe workspace path: ${path}`);
  return target;
}
async function optionalStat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Recheck every parent before operations. Node lacks portable openat; these checks
// plus O_NOFOLLOW do not promise isolation from a hostile concurrent renamer.
async function parents(root, path, allowMissing = false) {
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink() || await realpath(root) !== root) throw new Error('Workspace root changed or became a symlink');
  const target = inside(root, path);
  let current = root;
  for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    current = join(current, part);
    const parent = await optionalStat(current);
    if (!parent && allowMissing) continue;
    if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error(`Unsafe parent or symlink: ${path}`);
  }
  return target;
}
async function readRegular(root, path, remaining) {
  const target = await parents(root, path), before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Not a regular file (or symlink): ${path}`);
  if (before.size > remaining) throw new Error('Workspace exceeds 64 MiB byte limit');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile() || !sameInode(before, st)) throw new Error(`File changed while reading: ${path}`);
    const chunks = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, remaining - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > remaining) throw new Error('Workspace exceeds 64 MiB byte limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat(), actual = await lstat(await parents(root, path));
    if (!sameInode(st, actual) || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) throw new Error(`File changed while reading: ${path}`);
    const bytes = Buffer.concat(chunks, size);
    return { bytes, hash: hash(bytes), mode: st.mode & 0o777, dev: st.dev, ino: st.ino };
  } finally { await handle.close(); }
}
async function snapshot(root, { initial = false, signal } = {}) {
  const files = new Map(), directories = new Map();
  let total = 0, entries = 0;
  async function walk(path = '') {
    signal?.throwIfAborted();
    if (path) await parents(root, join(path, '_'));
    else if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error('Unsafe workspace root');
    const names = await readdir(path ? inside(root, path) : root);
    names.sort();
    for (const name of names) {
      signal?.throwIfAborted();
      const child = path ? join(path, name) : name;
      if (ignored(child)) continue;
      if (++entries > MAX_ENTRIES) throw new Error('Workspace exceeds 10000 entry limit');
      const st = await lstat(await parents(root, child));
      if (st.isSymbolicLink()) {
        if (initial) continue; // Initial symlinks are explicitly excluded.
        throw new Error(`New symlink in workspace: ${child}`);
      }
      if (st.isDirectory()) { directories.set(child, st.mode & 0o777); await walk(child); }
      else if (st.isFile()) {
        if (files.size >= MAX_FILES) throw new Error('Workspace exceeds 5000 file limit');
        const file = await readRegular(root, child, MAX_BYTES - total);
        total += file.bytes.length; files.set(child, file);
      } else if (!initial) throw new Error(`Special file in workspace: ${child}`);
      // Initial sockets, devices and FIFOs are deliberately excluded.
    }
  }
  await walk();
  return { files, directories };
}
function fingerprint(state) {
  return hash(JSON.stringify({ files: [...state.files].map(([path, f]) => [path, f.hash, f.mode]), directories: [...state.directories] }));
}
function metadata(before, after) {
  return [...new Set([...before.files.keys(), ...after.files.keys()])].sort().flatMap(path => {
    const a = before.files.get(path), b = after.files.get(path);
    return a?.hash === b?.hash && a?.mode === b?.mode ? [] : [{ path, beforeHash: a?.hash ?? null, afterHash: b?.hash ?? null, kind: !a ? 'add' : !b ? 'delete' : 'modify' }];
  });
}
function textualDiff(before, after, changes) {
  const parts = [];
  let size = 0, truncated = false;
  function append(text) {
    if (size + Buffer.byteLength(text) > MAX_DIFF) { truncated = true; return false; }
    parts.push(text); size += Buffer.byteLength(text); return true;
  }
  outer: for (const change of changes) {
    const a = before.files.get(change.path), b = after.files.get(change.path);
    if (!append(`diff --workspace ${JSON.stringify(change.path)}\n--- ${a ? JSON.stringify(change.path) : '/dev/null'}\n+++ ${b ? JSON.stringify(change.path) : '/dev/null'}\n`)) break;
    if (a?.mode !== b?.mode && !append(`mode ${a?.mode.toString(8) ?? '-'} -> ${b?.mode.toString(8) ?? '-'}\n`)) break;
    if (a?.hash === b?.hash) continue;
    if ([a, b].some(f => f && (f.bytes.includes(0) || !Buffer.from(f.bytes.toString('utf8')).equals(f.bytes)))) {
      if (!append('Binary files differ\n')) break;
      continue;
    }
    for (const [file, prefix] of [[a, '-'], [b, '+']]) {
      if (!file) continue;
      const text = file.bytes.toString('utf8');
      let start = 0;
      while (true) {
        const end = text.indexOf('\n', start);
        if (!append(`${prefix}${text.slice(start, end < 0 ? text.length : end)}\n`)) break outer;
        if (end < 0) break;
        start = end + 1;
      }
    }
  }
  if (truncated) parts.push('\n[Diff truncated at 4 MiB; hashes cover complete files.]\n');
  return parts.join('');
}

/**
 * Bounded isolated mirror, excluding .git, .claude, node_modules, initial symlinks
 * and special files. review() freezes full contents/modes; apply() requires review
 * and checks ALL source files/directories against the initial snapshot. Only adds
 * and modifications apply; deletions explicitly fail. Callers obtain approval of
 * review() before apply(). Methods serialize. Writes roll back on failure, but
 * this optimistic concurrency API is not an OS sandbox or atomic transaction.
 * dispose() removes only the verified exact mkdtemp directory, even after abort.
 */
export async function createWorkspace(root, { signal } = {}) {
  signal?.throwIfAborted();
  root = await realpath(root);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace root must be a directory');
  const initial = await snapshot(root, { initial: true, signal });
  const temporaryParent = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryParent, PREFIX));
  const identity = await lstat(directory), id = randomUUID();
  let disposed = false, applied = false, reviewed, queue = Promise.resolve();
  function serial(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
  function active() { if (disposed) throw new Error('Workspace is disposed'); signal?.throwIfAborted(); }
  async function dispose() {
    if (disposed) return;
    const actual = await optionalStat(directory);
    if (!actual?.isDirectory() || actual.isSymbolicLink() || !sameInode(identity, actual) || dirname(directory) !== temporaryParent || !basename(directory).startsWith(PREFIX) || await realpath(directory) !== directory || await realpath(temporaryParent) !== temporaryParent) throw new Error('Refusing disposal: temporary workspace identity changed');
    await rm(directory, { recursive: true, force: false });
    disposed = true;
  }
  try {
    for (const path of initial.directories.keys()) { signal?.throwIfAborted(); await mkdir(inside(directory, path)); }
    for (const [path, file] of initial.files) {
      signal?.throwIfAborted();
      const handle = await open(await parents(directory, path), 'wx', file.mode);
      try { await handle.writeFile(file.bytes); await handle.chmod(file.mode); } finally { await handle.close(); }
    }
    // Mirror directory structure with writable private-copy permissions; regular
    // file modes (including executable bits) are preserved exactly above.
  } catch (error) { await dispose(); throw error; }
  async function current() { active(); return snapshot(directory, { signal }); }
  const workspaceSignal = signal;
  async function apply({ signal = workspaceSignal } = {}) {
    signal = signal && workspaceSignal ? AbortSignal.any([signal, workspaceSignal]) : signal ?? workspaceSignal;
    const current = () => { active(); return snapshot(directory, { signal }); };
    active(); signal?.throwIfAborted();
    if (applied) throw new Error('Workspace was already applied');
    if (!reviewed) throw new Error('Review is required before apply');
    const mirror = await current();
    if (fingerprint(mirror) !== reviewed) throw new Error('Mirror changed since review; review again');
    const changes = metadata(initial, mirror);
    if (changes.some(c => c.kind === 'delete')) throw new Error('Workspace deletions are not supported');
    if (fingerprint(await snapshot(root, { initial: true, signal })) !== fingerprint(initial)) throw new Error('Source conflict: original workspace changed');
    const opened = [], written = [], createdDirectories = [];
    try {
      // Preflight every destination, including excluded source-file collisions.
      for (const change of changes) {
        signal?.throwIfAborted();
        const target = await parents(root, change.path, true), st = await optionalStat(target), before = initial.files.get(change.path);
        if (st && (!before || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1)) throw new Error(`Source conflict or unsafe destination: ${change.path}`);
        if (before && (!st || !sameInode(before, st))) throw new Error(`Source conflict: ${change.path}`);
        if (before) {
          const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          opened.push({ change, handle });
          const actual = await handle.stat();
          if (!actual.isFile() || !sameInode(st, actual) || actual.nlink !== 1 || (await readRegular(root, change.path, MAX_BYTES)).hash !== before.hash) throw new Error(`Source conflict: ${change.path}`);
        } else opened.push({ change, handle: null });
      }
      if (fingerprint(await current()) !== reviewed || fingerprint(await snapshot(root, { initial: true, signal })) !== fingerprint(initial)) throw new Error('Workspace changed during apply preflight');
      for (const entry of opened) {
        signal?.throwIfAborted();
        const { change } = entry, target = await parents(root, change.path, true);
        let parent = root;
        for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
          parent = join(parent, part);
          if (!(await optionalStat(parent))) {
            await parents(root, join(relative(root, parent), '_'), true);
            await mkdir(parent); createdDirectories.push({ path: relative(root, parent), stat: await lstat(parent) });
          }
        }
        await parents(root, change.path);
        if (entry.handle) {
          const st = await lstat(target);
          if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !sameInode(st, await entry.handle.stat()) || (await readRegular(root, change.path, MAX_BYTES)).hash !== initial.files.get(change.path).hash) throw new Error(`Source conflict: ${change.path}`);
        } else entry.handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mirror.files.get(change.path).mode);
        entry.identity = await entry.handle.stat();
        written.push(entry); // Include partial writes in rollback.
        const file = mirror.files.get(change.path);
        await entry.handle.truncate(0);
        let offset = 0;
        while (offset < file.bytes.length) {
          const { bytesWritten } = await entry.handle.write(file.bytes, offset, file.bytes.length - offset, offset);
          if (!bytesWritten) throw new Error('Unable to write workspace file');
          offset += bytesWritten;
        }
        await entry.handle.chmod(file.mode);
      }
      signal?.throwIfAborted();
      applied = true; reviewed = undefined;
      return { id, changes };
    } catch (error) {
      const failures = [];
      for (const entry of written.reverse()) {
        try {
          const before = initial.files.get(entry.change.path);
          if (before) {
            await entry.handle.truncate(0);
            let offset = 0;
            while (offset < before.bytes.length) {
              const result = await entry.handle.write(before.bytes, offset, before.bytes.length - offset, offset);
              if (!result.bytesWritten) throw new Error('Unable to restore original file');
              offset += result.bytesWritten;
            }
            await entry.handle.chmod(before.mode);
          } else {
            const target = await parents(root, entry.change.path), st = await lstat(target);
            if (!st.isFile() || st.isSymbolicLink() || !sameInode(st, entry.identity)) throw new Error('Refusing rollback unlink: destination changed');
            await unlink(target);
          }
        } catch (failure) { failures.push(failure); }
      }
      for (const dir of createdDirectories.reverse()) {
        try {
          const target = await parents(root, dir.path), st = await lstat(target);
          if (!st.isDirectory() || st.isSymbolicLink() || !sameInode(st, dir.stat)) throw new Error('Refusing rollback rmdir: directory changed');
          await rmdir(target);
        } catch (failure) { failures.push(failure); }
      }
      if (failures.length) throw new AggregateError([error, ...failures], 'Workspace apply failed; rollback incomplete');
      throw error;
    } finally { await Promise.all(opened.map(entry => entry.handle?.close())); }
  }
  return Object.freeze({ root, directory, id,
    changes: () => serial(async () => metadata(initial, await current())),
    review: () => serial(async () => {
      const mirror = await current(), changes = metadata(initial, mirror), diff = textualDiff(initial, mirror, changes);
      reviewed = fingerprint(mirror); return { id, changes, diff };
    }),
    apply: options => serial(() => apply(options)), dispose: () => serial(dispose),
  });
}
