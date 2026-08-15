import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Process-isolated smoke test: starts the real host entrypoint as its own
 * process (with --auto-accept, the smoke-only join-approval mode), joins two
 * independent CLI client processes over a real WebSocket, drives ordered
 * intents through their stdin, and reports the final revision/phase/position
 * that every process converged on. Both clients join WITHOUT a resource
 * identity to exercise the optional-identity contract, then report their
 * initial actual state so the session reaches ready.
 *
 * Exit code 0 means all processes converged; anything else is a failure.
 */
const DEFAULT_RESOURCE_URL = 'https://www.bilibili.com/video/BV1mkgw6mEQt/';
const resourceUrl = process.argv[2] ?? DEFAULT_RESOURCE_URL;

const hostEntry = fileURLToPath(new URL('./host.js', import.meta.url));
const clientEntry = fileURLToPath(new URL('./client.js', import.meta.url));

const JOIN_TIMEOUT_MS = 5000;
const REVISION_TIMEOUT_MS = 5000;
const EXIT_TIMEOUT_MS = 5000;
const HOST_READY_TIMEOUT_MS = 5000;

type StateLine = {
  type: 'state';
  revision: number;
  phase: string;
  position: number;
  rate: number;
};

type ChildHandle = {
  name: string;
  process: ChildProcess;
  latest: StateLine | undefined;
  /** Latest session-status ready flag broadcast to this client. */
  ready: boolean;
  stderrTail: string[];
};

const children: ChildHandle[] = [];
let host: ChildProcess | undefined;

function sendLine(handle: ChildHandle, line: string): void {
  handle.process.stdin?.write(`${line}\n`);
}

function atLeast(handle: ChildHandle, revision: number): boolean {
  return (handle.latest?.revision ?? -1) >= revision;
}

function handleClientLine(handle: ChildHandle, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const record = parsed as Record<string, unknown>;
  if (record.type === 'session-status' && typeof record.ready === 'boolean') {
    handle.ready = record.ready;
    return;
  }
  if (record.type === 'state' && typeof record.revision === 'number') {
    handle.latest = {
      type: 'state',
      revision: record.revision,
      phase: typeof record.phase === 'string' ? record.phase : '',
      position: typeof record.position === 'number' ? record.position : 0,
      rate: typeof record.rate === 'number' ? record.rate : 0,
    };
  }
}

function spawnClient(name: string, url: string, sessionId: string): ChildHandle {
  // No resource URL: the clients join without an identity and adopt the
  // session resource from join-accepted.
  const child = spawn(process.execPath, [clientEntry, url, sessionId, name], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const handle: ChildHandle = { name, process: child, latest: undefined, ready: false, stderrTail: [] };
  let stdoutBuffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) handleClientLine(handle, line);
  });
  let stderrBuffer = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        handle.stderrTail.push(trimmed);
        if (handle.stderrTail.length > 20) handle.stderrTail.shift();
      }
    }
  });
  return handle;
}

function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 25);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number, label: string): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`${label} did not exit in time`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

function waitForHostReady(child: ChildProcess, timeoutMs: number): Promise<{ port: number; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('host did not report session-ready in time'));
    }, timeoutMs);
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line.trim());
        } catch {
          continue;
        }
        if (typeof parsed !== 'object' || parsed === null) continue;
        const record = parsed as Record<string, unknown>;
        if (record.type === 'session-ready' && typeof record.port === 'number' && typeof record.sessionId === 'string') {
          clearTimeout(timer);
          child.off('exit', onExit);
          resolve({ port: record.port, sessionId: record.sessionId });
        }
      }
    });
    const onExit = () => {
      clearTimeout(timer);
      reject(new Error('host exited before reporting session-ready'));
    };
    child.once('exit', onExit);
  });
}

try {
  // --auto-accept: the authority approves the second participant without a
  // human join-decision, so the smoke needs no interactive input.
  host = spawn(process.execPath, [hostEntry, '0', resourceUrl, '--auto-accept'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const { port, sessionId } = await waitForHostReady(host, HOST_READY_TIMEOUT_MS);

  const a = spawnClient('smoke-a', `ws://127.0.0.1:${port}`, sessionId);
  const b = spawnClient('smoke-b', `ws://127.0.0.1:${port}`, sessionId);
  children.push(a, b);

  await waitFor(
    () => a.latest !== undefined && b.latest !== undefined,
    JOIN_TIMEOUT_MS,
    'clients did not join and receive the initial state',
  );

  // Both participants report the initial actual state (echoing the
  // authoritative state) so the session reaches ready.
  sendLine(a, 'report');
  sendLine(b, 'report');
  await waitFor(
    () => a.ready && b.ready,
    JOIN_TIMEOUT_MS,
    'session did not become ready after the initial actual-state reports',
  );

  sendLine(a, 'play');
  await waitFor(() => atLeast(a, 1) && atLeast(b, 1), REVISION_TIMEOUT_MS, 'clients did not converge on revision 1 (play)');

  sendLine(b, 'seek 42');
  await waitFor(() => atLeast(a, 2) && atLeast(b, 2), REVISION_TIMEOUT_MS, 'clients did not converge on revision 2 (seek 42)');

  sendLine(a, 'pause');
  await waitFor(() => atLeast(a, 3) && atLeast(b, 3), REVISION_TIMEOUT_MS, 'clients did not converge on revision 3 (pause)');

  // Re-report the final state and confirm the session returns to ready.
  sendLine(a, 'report');
  sendLine(b, 'report');
  await waitFor(
    () => a.ready && b.ready,
    REVISION_TIMEOUT_MS,
    'session did not return to ready after the final actual-state reports',
  );

  const finalA = a.latest!;
  const finalB = b.latest!;
  if (finalA.revision !== finalB.revision || finalA.phase !== finalB.phase || finalA.position !== finalB.position) {
    throw new Error(`clients diverged: smoke-a=${JSON.stringify(finalA)} smoke-b=${JSON.stringify(finalB)}`);
  }
  if (finalA.revision !== 3 || finalA.phase !== 'paused' || finalA.position < 42 || finalA.position > 44) {
    throw new Error(`unexpected final state: ${JSON.stringify(finalA)}`);
  }

  for (const handle of children) {
    sendLine(handle, 'quit');
    handle.process.stdin?.end();
  }
  for (const handle of children) {
    await waitForExit(handle.process, EXIT_TIMEOUT_MS, handle.name);
    if (handle.process.exitCode !== 0) {
      throw new Error(`${handle.name} exited with code ${handle.process.exitCode}`);
    }
  }

  host.kill('SIGTERM');
  await waitForExit(host, EXIT_TIMEOUT_MS, 'host');
  if (host.exitCode !== 0) {
    throw new Error(`host exited with code ${host.exitCode}`);
  }

  console.log(JSON.stringify({
    type: 'SMOKE_OK',
    sessionId,
    port,
    resourceUrl,
    sessionReady: a.ready && b.ready,
    final: finalA,
    clients: { 'smoke-a': finalA, 'smoke-b': finalB },
  }));
} catch (error) {
  console.error(`smoke:process: ${error instanceof Error ? error.message : String(error)}`);
  for (const handle of children) {
    if (handle.process.exitCode === null) handle.process.kill('SIGKILL');
    if (handle.stderrTail.length > 0) {
      console.error(`${handle.name} stderr:\n${handle.stderrTail.join('\n')}`);
    }
  }
  if (host && host.exitCode === null) host.kill('SIGKILL');
  console.error(JSON.stringify({ type: 'SMOKE_FAIL' }));
  process.exit(1);
}

function killAll(): void {
  for (const handle of children) {
    if (handle.process.exitCode === null) handle.process.kill('SIGKILL');
  }
  if (host && host.exitCode === null) host.kill('SIGKILL');
}
process.once('SIGINT', () => {
  killAll();
  process.exit(130);
});
process.once('SIGTERM', () => {
  killAll();
  process.exit(143);
});
