import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTool } from '../src/guard.js';
import { progressLines, workerSettings } from '../src/worker.js';

test('worker hook denies shell, Git, escapes and symlinks; edit is an operator capability', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-guard-test-')));
  t.after(async () => { assert.match(root, /bridge-guard-test-/); await rm(root, { recursive: true }); });
  await mkdir(join(root, 'sub')); await writeFile(join(root, 'file'), 'safe');
  await symlink(tmpdir(), join(root, 'outside'));
  const check = (tool_name, tool_input, mode = 'review', cwd = root) => checkTool({ tool_name, tool_input, cwd }, root, mode);
  assert.equal(await check('Read', { file_path: 'file' }), true);
  assert.equal(await check('Write', { file_path: 'new/file', content: 'data' }, 'edit'), true);
  for (const path of ['../secret', '/etc/passwd', '.git/config', 'sub/../.claude/settings.json', 'outside/secret']) {
    assert.equal(await check('Read', { file_path: path }), false, path);
  }
  assert.equal(await check('Read', { file_path: 'file' }, 'review', '/etc'), false);
  assert.equal(await check('Write', { file_path: 'file' }), false);
  for (const tool of ['Bash', 'Agent', 'Task', 'mcp__git__status']) assert.equal(await check(tool, {}), false);
  for (const pattern of ['/etc/**', '{../../**,**}', '..\\**', '**/.git/**', '**/.claude/**']) assert.equal(await check('Glob', { pattern }), false);
  assert.equal(await check('Grep', { pattern: 'data', path: root, glob: '../../**' }), false);
  assert.equal(await check('Glob', { pattern: '**/*.js', path: 'sub' }), true);
});

test('real tool lifecycle progress excludes bodies and hidden reasoning', () => {
  assert.deepEqual(progressLines({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'SECRET' },
    { type: 'tool_use', name: 'Write', input: { file_path: 'answer.js', content: 'SECRET' } },
  ] } }), ['→ Write {"path":"answer.js"}']);
  assert.deepEqual(progressLines({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'SECRET' }] } }), ['← tool-1: failed']);
});

test('worker hook settings load no repository or user hooks', async () => {
  const settings = await workerSettings('/tmp/workspace with space', 'review');
  try {
    assert.ok(settings.args.includes('--setting-sources'));
    assert.ok(settings.args.includes(''));
    assert.ok(settings.args.includes('--disable-slash-commands'));
    assert.ok(settings.args.includes('{"mcpServers":{}}'));
  } finally { await settings.dispose(); }
});
