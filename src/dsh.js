import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { isAbsolute, resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { profiles, prepare } from './index.js';
import { runManagedClaude } from './managed.js';
import { createWorkspace } from './workspace.js';
import { workerSettings, progressLines } from './worker.js';

export const name = 'harness-bridge';
export const inject = ['tools', 'subprocess', 'sandboxPolicy', 'jobs'];
export const Config = z.object({
  workspaceRoot: z.string().description('Workspace root / 工作目录（绝对路径）').volatile(),
  language: z.union(Object.keys(profiles)).description('Claude Code communication language / 与 CC 交流的语言（默认 zh-CN）').volatile(),
  profile: z.union(Object.keys(profiles)).description('Legacy language fallback').volatile(),
  transport: z.union(['headless', 'tmux']).default('headless').description('Claude Code execution mode / 执行方式').volatile(),
  allowEdits: z.boolean().default(false).description('Allow CC to propose file edits / 允许 CC 提出文件修改').volatile(),
  maxTurns: z.number().min(1).max(100).step(1).default(8).volatile(),
  maxBudgetUsd: z.number().min(0.01).max(100).default(2).volatile(),
  timeoutMs: z.number().min(1).max(3600000).step(1).default(300000).volatile(),
  executable: z.string().default('claude').description('Claude CLI or provider wrapper').volatile(),
});
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };

/** Git is invoked only here in DSH, never in the Claude worker. */
export async function gitAudit(service, root, signal) {
  const executable = await service.resolveExecutable('git', undefined, signal);
  async function run(args) {
    const child = service.spawn({ argv: [executable, '--no-pager', '-c', 'core.fsmonitor=false', '-C', root, ...args], cwd: root, env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      stdio: { stdin: { data: '' }, stdout: 'pipe', stderr: { maxBytes: 4096 } }, graceMs: 2000, signal });
    let text = '', bytes = 0;
    const read = (async () => { for await (const chunk of child.stdout) {
      bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Git audit output exceeds 1 MiB'); text += chunk.toString('utf8');
    } })();
    try { const [exit] = await Promise.all([child.done, read]); signal.throwIfAborted(); return { exitCode: exit.exitCode, text }; }
    finally { child.terminate(); await child.waitForExit(); child.stdout.destroy(); await Promise.allSettled([child.done, read]); }
  }
  const status = await run(['status', '--porcelain=v1', '--untracked-files=normal']);
  if (status.exitCode !== 0) return { available: false, reason: 'Git status failed; verify that workspaceRoot is a repository' };
  const diff = await run(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
  return { available: true, status: status.text, diff: diff.text, diffExitCode: diff.exitCode };
}

export function apply(ctx, config = {}) {
  // Cordis wraps volatile fields in readonly refs; keep live reads between tasks.
  config = new Proxy(config, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value?.get === 'function' ? value.get() : value;
  } });
  const lifecycle = new AbortController();
  const records = new Map();
  let busy = false, running;
  ctx.on('dispose', async () => {
    lifecycle.abort();
    await running;
    // Running jobs dispose their copy after cancellation. Retained reviews belong to this instance.
    await Promise.allSettled([...records.values()].map(record => record.workspace.dispose()));
    records.clear();
  });
  function policy(exec) {
    const resolved = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
    if (resolved.mode !== 'danger-full-access') throw new Error('Claude Code delegation requires an unrestricted DSH session');
    if (typeof config.workspaceRoot !== 'string' || !isAbsolute(config.workspaceRoot)) throw new Error('Operator must configure an absolute workspaceRoot before using this plugin');
    return AbortSignal.any([exec.signal, lifecycle.signal]);
  }
  function recordFor(id, exec) {
    const record = records.get(id);
    if (!record || record.owner !== exec.agent?.id) throw new Error('Unknown review for this DSH session');
    return record;
  }
  ctx.tools.register(defineTool({
    name: 'harness_settings', description: 'Read current worker language, execution mode and edit policy. Call before composing a Claude task, then write the delegated instructions in the configured language.',
    parameters: {}, output,
    async execute(_args, exec) { policy(exec).throwIfAborted(); return JSON.stringify({ language: config.language ?? config.profile ?? 'zh-CN', transport: config.transport ?? 'headless', allowEdits: config.allowEdits === true }); },
  }));
  ctx.tools.register(defineTool({
    name: 'harness_review',
    description: 'Inspect a Claude proposal, apply the exact reviewed digest to the original workspace, or discard it. Git is managed only in DSH. Inspect the actual diff and obtain user authorization before applying. Applying copies files only; it never stages, commits or pushes. Concurrent source or proposal changes refuse the whole apply. Applied/discarded workers cannot be resumed.',
    parameters: {
      reviewId: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['inspect', 'apply', 'discard'] },
      digest: { type: 'string', description: 'Exact digest from inspect; required for apply.' },
    }, output,
    async execute(args, exec) {
      const signal = policy(exec); signal.throwIfAborted();
      if (busy) throw new Error('Wait for the active Claude Code run');
      const record = recordFor(args.reviewId, exec);
      if (args.action === 'inspect') return JSON.stringify({ root: record.workspace.root, ...record.review });
      if (args.action === 'apply') {
        if (config.allowEdits !== true || record.mode !== 'edit') throw new Error('Edit delegation is disabled by the operator');
        if (!args.digest || args.digest !== record.review.digest) throw new Error('Exact reviewed digest required');
        busy = true;
        try {
          if (await realpath(config.workspaceRoot) !== record.workspace.root) throw new Error('Configured workspaceRoot changed; restore it or discard this review');
          signal.throwIfAborted();
          running = record.workspace.apply({ signal });
          await running;
          records.delete(args.reviewId); await record.workspace.dispose();
          return JSON.stringify({ ok: true, status: 'applied', changes: record.review.changes, git: 'DSH must audit, stage and commit separately' });
        } finally { busy = false; }
      }
      if (args.action !== 'discard') throw new Error('Unknown review action');
      records.delete(args.reviewId); await record.workspace.dispose();
      return JSON.stringify({ ok: true, status: 'discarded' });
    },
  }));
  ctx.tools.register(defineTool({
    name: 'harness_git_audit', description: 'DSH-owned read-only Git status and HEAD diff of the configured original workspace. Review these before DSH stages, commits or pushes. Claude Code never receives this Git output automatically.',
    parameters: {}, output,
    async execute(_args, exec) { const signal = policy(exec); return JSON.stringify(await gitAudit(ctx.subprocess, config.workspaceRoot, signal)); },
  }));
  ctx.tools.register(defineTool({
    name: 'claude_code',
    description: 'Delegate a scoped file task to Claude Code. Before composing instructions, call harness_settings and write the task in its returned language (default Simplified Chinese); CC responses use that language. Claude runs in a Git-free copy with only file tools. Actual tool events stream through the DSH job output. Edit results are proposals: inspect with harness_review and obtain user authorization before applying. Git stays in DSH. Resume only a session from this plugin instance with unchanged root, directory, mode and language. Never retry auth or policy failures automatically.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Task and acceptance criteria in the operator-configured worker language.' },
      directory: { type: 'string', description: 'Relative subdirectory under workspaceRoot.' },
      mode: { type: 'string', enum: ['review', 'edit'] },
      sessionId: { type: 'string', description: 'UUID from this plugin instance; never an external CLI session.' },
      run_in_background: { type: 'boolean', description: 'Return the native DSH job id immediately. Read real progress with job_output; stop with job_kill.' },
    }, output,
    async execute(args, exec) {
      const signal = policy(exec); signal.throwIfAborted();
      if (args.mode === 'edit' && config.allowEdits !== true) throw new Error('Edit delegation is disabled by the operator');
      if (busy) throw new Error('A Claude Code run is already active in this plugin; wait for it to finish');
      // Capture settings once: live setting edits affect the next task only.
      const settings = { ...config };
      const language = settings.language ?? settings.profile ?? 'zh-CN';
      const mode = args.mode ?? 'review';
      const transport = settings.transport ?? 'headless';
      const options = { ...settings, prompt: args.prompt, root: settings.workspaceRoot, cwd: resolve(settings.workspaceRoot, args.directory ?? '.'), profile: language, mode, sessionId: args.sessionId };
      let spec;
      try { spec = await prepare(options); } catch (error) { return JSON.stringify({ ok: false, status: 'failed', error: error.message }); }
      if (busy) throw new Error('A Claude Code run is already active in this plugin; wait for it to finish');
      if (records.size >= 8 && !args.sessionId) throw new Error('Discard or apply an earlier review before starting another worker (8 retained copies maximum)');
      busy = true;
      const controller = new AbortController();
      let done, result;
      try {
        const id = ctx.jobs.start({ kind: 'claude-code', label: `Claude Code · ${language} · ${transport}`, ...(exec.agent ? { owner: exec.agent.id } : {}),
          run(handle) {
            done = (async () => {
              let workspace, worker, record;
              const combined = AbortSignal.any([signal, controller.signal]);
              try {
                if (args.sessionId) {
                  record = [...records.values()].find(r => r.sessionId === args.sessionId && r.owner === exec.agent?.id);
                  if (!record || record.language !== language || record.mode !== mode || record.originalCwd !== spec.cwd || record.workspace.root !== await realpath(settings.workspaceRoot)) throw new Error('Resume requires a matching retained worker, root, directory, mode and language');
                  workspace = record.workspace;
                  records.delete(workspace.id);
                } else workspace = await createWorkspace(settings.workspaceRoot, { signal: combined });
                combined.throwIfAborted();
                worker = await workerSettings(workspace.directory, mode);
                const cwd = join(workspace.directory, relative(workspace.root, spec.cwd));
                const out = await runManagedClaude(ctx.subprocess, { ...options, root: workspace.directory, cwd, workerArgs: worker.args }, {
                  signal: combined, onEvent(event) { for (const line of progressLines(event)) { handle.append(line + '\n'); handle.updateProgress(line); } },
                });
                combined.throwIfAborted();
                const review = await workspace.review();
                review.digest = createHash('sha256').update(JSON.stringify(review)).digest('hex');
                records.set(workspace.id, { workspace, owner: exec.agent?.id, language, mode, originalCwd: spec.cwd, sessionId: out.sessionId, review });
                result = { ...out, language, transport, reviewId: workspace.id, proposal: review.changes, status: out.ok && review.changes.length ? 'awaiting_review' : out.status };
                workspace = undefined; // Ownership transferred to the retained review.
                handle.append(`Proposal: ${result.proposal.length} changed files; inspect with harness_review\n`);
                return { status: out.ok ? 'completed' : 'failed', result: JSON.stringify(result) };
              } catch (error) {
                result = { ok: false, status: combined.aborted ? 'cancelled' : 'failed', error: error.message, ...(error.partial ?? {}) };
                return { status: combined.aborted ? 'killed' : 'failed', result: JSON.stringify(result) };
              } finally { await worker?.dispose(); await workspace?.dispose(); busy = false; }
            })();
            running = done;
            return { done, cancel() { controller.abort(); } };
          },
        });
        if (args.run_in_background) return JSON.stringify({ ok: true, status: 'running', jobId: id, language, transport });
        await done;
        signal.throwIfAborted();
        return JSON.stringify({ ...result, jobId: id });
      } catch (error) { controller.abort(); if (done) await done; busy = false; throw error; }
    },
  }));
}
export { profiles };
