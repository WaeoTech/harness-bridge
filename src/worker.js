import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function workerSettings(directory, mode) {
  const temp = await mkdtemp(join(tmpdir(), 'harness-bridge-settings-'));
  const guard = fileURLToPath(new URL('./guard.js', import.meta.url));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, guard, directory, mode].map(quote).join(' ');
  const settings = join(temp, 'settings.json');
  await writeFile(settings, JSON.stringify({
    permissions: { deny: ['Bash', 'Agent', 'Task', 'NotebookEdit', 'mcp__*'] },
    hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 10 }] }] },
  }), { mode: 0o600 });
  return {
    args: ['--setting-sources', '', '--settings', settings, '--disable-slash-commands', '--mcp-config', '{"mcpServers":{}}'],
    async dispose() {
      const actual = await realpath(temp);
      if (actual !== temp || !temp.startsWith(join(tmpdir(), 'harness-bridge-settings-'))) throw new Error('Unsafe settings cleanup path');
      await rm(actual, { recursive: true });
    },
  };
}

/** Keep logs useful without echoing file bodies, credentials or hidden reasoning. */
export function progressLines(event) {
  if (event.type === 'system' && event.subtype === 'harness_tmux') return [`tmux: ${event.session} (attach: ${event.attach})`];
  if (event.type === 'system' && event.subtype === 'init') return ['Claude Code started'];
  if (event.type === 'assistant') return (event.message?.content ?? []).flatMap(block =>
    block.type === 'tool_use' ? [`→ ${block.name} ${JSON.stringify({ path: block.input?.file_path ?? block.input?.path, pattern: block.name === 'Glob' ? block.input?.pattern : undefined })}`] : []);
  if (event.type === 'user') return (event.message?.content ?? []).flatMap(block =>
    block.type === 'tool_result' ? [`← ${block.tool_use_id}: ${block.is_error ? 'failed' : 'completed'}`] : []);
  if (event.type === 'result') return [`Claude Code: ${event.subtype ?? 'finished'}`];
  return [];
}
