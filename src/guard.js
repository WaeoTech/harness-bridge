import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

/** Claude PreToolUse boundary: no shell, Git metadata, symlinks or files outside the copy. */
export async function checkTool(input, root, mode = 'review') {
  if (!root || !inside(root, resolve(input.cwd ?? root))) return false;
  const allowed = mode === 'edit' ? ['Read', 'Glob', 'Grep', 'Edit', 'Write'] : ['Read', 'Glob', 'Grep'];
  if (!allowed.includes(input.tool_name)) return false;
  const args = input.tool_input ?? {};
  if (['Glob', 'Grep'].includes(input.tool_name)) {
    const pattern = input.tool_name === 'Glob' ? args.pattern : args.glob;
    if (pattern && (typeof pattern !== 'string' || isAbsolute(pattern) || pattern.includes('..') || pattern.includes('\\') || pattern.includes('.git') || pattern.includes('.claude') || pattern.includes('\0'))) return false;
  }
  const raw = args.file_path ?? args.path ?? (['Glob', 'Grep'].includes(input.tool_name) ? '.' : undefined);
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) return false;
  const target = resolve(input.cwd ?? root, raw);
  if (!inside(root, target) || relative(root, target).split(/[\\/]/).some(p => p === '.git' || p === '.claude')) return false;
  // Walk every component, including existing ancestors of new Write targets.
  let current = target;
  while (inside(root, current)) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !inside(root, await realpath(current))) return false;
    } catch (error) { if (error.code !== 'ENOENT') return false; }
    if (current === root) break;
    current = dirname(current);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let text = '', allowed = false;
  try {
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 2_000_000) throw new Error('Hook input too large');
    }
    allowed = await checkTool(JSON.parse(text), await realpath(process.argv[2]), process.argv[3]);
  } catch { /* Fail closed. */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny',
    permissionDecisionReason: allowed ? 'Allowed workspace file operation' : 'Harness Bridge: only approved file tools inside the Git-free workspace are allowed',
  } }));
}
