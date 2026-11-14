import { prepare, createEventParser, BridgeError } from './index.js';
import { fileURLToPath } from 'node:url';

/** DSH-owned processes use the host service for cross-platform tree cleanup. */
export async function runManagedClaude(service, options, { signal, onEvent = () => {} }) {
  if (process.env.HARNESS_BRIDGE_DEPTH) throw new BridgeError('Recursive harness invocation refused');
  const spec = await prepare(options);
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new Error('Claude run timed out')), spec.timeoutMs);
  timer.unref();
  let child, read, final, sessionId, bytes = 0;
  try {
    combined.throwIfAborted();
    const executable = await service.resolveExecutable(spec.executable, undefined, combined);
    const argv = [executable, ...spec.args, ...(options.workerArgs ?? [])];
    if (!['headless', 'tmux'].includes(options.transport ?? 'headless')) throw new Error('transport must be headless or tmux');
    if (options.transport === 'tmux') {
      const tmux = await service.resolveExecutable('tmux', undefined, combined);
      argv.splice(0, argv.length, process.execPath, fileURLToPath(new URL('./tmux.js', import.meta.url)), tmux);
    }
    child = service.spawn({
      argv, cwd: spec.cwd,
      env: { HARNESS_BRIDGE_DEPTH: '1' },
      stdio: { stdin: { data: options.transport === 'tmux' ? JSON.stringify({ executable, args: [...spec.args, ...(options.workerArgs ?? [])], cwd: spec.cwd, prompt: spec.prompt }) : spec.prompt }, stdout: 'pipe', stderr: { maxBytes: 65536 } },
      graceMs: 2000, signal: combined,
    });
    const parser = createEventParser(event => {
      if (typeof event.session_id === 'string') sessionId = event.session_id;
      if (event.type === 'result') final = event;
      onEvent(event);
    });
    read = (async () => {
      for await (const chunk of child.stdout) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) throw new Error('Claude output exceeds 32 MiB limit');
        parser.push(chunk);
      }
      parser.end();
    })();
    const [outcome] = await Promise.all([child.done, read]);
    combined.throwIfAborted();
    const partial = { sessionId, exitCode: outcome.exitCode, exitSignal: outcome.signal };
    if (outcome.exitCode !== 0) throw new BridgeError('Claude exited unsuccessfully; inspect its local session for details', partial);
    if (!final) throw new BridgeError('Claude exited without a final result event', partial);
    const permissionDenials = Array.isArray(final.permission_denials) ? final.permission_denials : [];
    const ok = final.subtype === 'success' && final.is_error !== true && permissionDenials.length === 0;
    return {
      ok, status: permissionDenials.length ? 'permission_denied' : ok ? 'completed' : 'failed',
      ...partial, result: typeof final.result === 'string' ? final.result : '',
      subtype: final.subtype, permissionDenials,
      estimatedCostUsd: final.total_cost_usd, usage: final.usage,
    };
  } catch (error) {
    if (timeout.signal.aborted) throw new BridgeError('Claude run timed out', { sessionId });
    if (signal.aborted) throw new BridgeError('Run cancelled', { sessionId });
    throw new BridgeError(error.message, { sessionId, ...(error.partial ?? {}) });
  } finally {
    clearTimeout(timer);
    if (child) {
      child.terminate();
      await child.waitForExit();
      child.stdout.destroy();
      await Promise.allSettled([child.done, read]);
    }
  }
}
