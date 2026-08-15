import { createInterface } from 'node:readline';
import { SessionClient } from '../client/session-client.js';
import { createBilibiliResourceIdentity } from '../shared/resource.js';
import { MAX_PLAYBACK_RATE } from '../shared/protocol.js';
import { projectPlaybackPosition } from '../core/playback-state.js';

const url = process.argv[2];
const sessionId = process.argv[3];
const participantId = process.argv[4];
// The resource identity is OPTIONAL: pass a bilibili URL to join with a
// declared resource, '-' to explicitly join without one, or nothing at all.
// Identity-less joiners adopt the session resource from join-accepted.
const resourceArg = process.argv[5];
const resourceIdentity = resourceArg === undefined || resourceArg === '-'
  ? undefined
  : createBilibiliResourceIdentity(resourceArg);
const argCommands = process.argv.slice(6);

if (!url || !sessionId || !participantId) {
  console.error('Usage: client <ws-url> <session-id> <participant-id> [bilibili-url] [command ...]');
  console.error('  bilibili-url is optional: omit it (or pass "-") to join without a resource identity and adopt the session resource; use "-" as a placeholder when passing commands without a URL.');
  console.error('Commands: play | pause | seek <seconds> | rate <number> | replay | report | snapshot | accept | decline | quit');
  process.exit(2);
}

const client = new SessionClient({
  url,
  sessionId,
  participantId,
  ...(resourceIdentity === undefined ? {} : { resourceIdentity }),
});

console.log(`client: connecting to ${url} (session ${sessionId}, participant ${participantId})`);
if (resourceIdentity === undefined) {
  console.log('client: joining without a resource identity; the session resource is adopted on join-accepted');
} else {
  console.log(`client: resource ${JSON.stringify(resourceIdentity)} (from ${resourceArg})`);
}

client.onState((state) => {
  console.log(JSON.stringify({
    type: 'state',
    revision: state.stateRevision,
    sequence: state.lastSequence,
    phase: state.mediaPhase,
    position: state.positionSeconds,
    rate: state.playbackRate,
  }));
});
client.onDiagnostic((message) => console.log(JSON.stringify(message)));
client.onSessionStatus((status) => console.log(JSON.stringify(status)));
client.onJoinRequest((request) => {
  console.log(JSON.stringify(request));
  if (client.role !== 'host') {
    console.error('client: received a join request but this participant is not the host; ignoring');
    return;
  }
  if (argCommands.length > 0) {
    // One-shot mode has no interactive approval: accept deterministically so a
    // scripted host can never leave a joiner hanging.
    console.log(`client: auto-accepting join request from ${JSON.stringify(request.participantId)} (one-shot mode cannot ask interactively)`);
    try {
      client.sendJoinDecision(true);
    } catch (error) {
      console.error(`client: failed to accept join request: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  console.log(`client: participant ${JSON.stringify(request.participantId)} requests to join; type "accept" or "decline"`);
});

let accepted: { role: 'host' | 'client'; participantId: string };
try {
  accepted = await client.connect();
} catch (error) {
  console.error(`client: join failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
console.log(`client: joined as ${accepted.role} (participant ${accepted.participantId})`);
if (accepted.role === 'host') {
  console.log('client: you are the session host; a second participant joins only after your accept/decline decision');
}

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  const state = client.state;
  if (state) {
    console.log(JSON.stringify({
      type: 'final-state',
      sessionId: state.sessionId,
      revision: state.stateRevision,
      phase: state.mediaPhase,
      position: state.positionSeconds,
      rate: state.playbackRate,
    }));
  }
  await client.close();
  process.exit(code);
}

process.once('SIGINT', () => void shutdown(130));
process.once('SIGTERM', () => void shutdown(143));

/**
 * Parse and execute one command line. Returns false when the command is
 * invalid or fails; interactive mode ignores the result, one-shot mode turns
 * it into a non-zero exit.
 *
 * Intent commands (play/pause/replay/seek/rate) are submitted and — when
 * `awaitRevision` is set — awaited through the authoritative revision they are
 * expected to produce (latest observed + 1: the authority bumps the revision
 * by exactly one per applied intent, and broadcasts arrive in order), so a
 * subsequent command never runs against stale pre-command state.
 */
async function runCommand(line: string, awaitRevision: boolean): Promise<boolean> {
  const [command, value] = line.trim().split(/\s+/);
  if (!command) return true;
  try {
    if (command === 'play' || command === 'pause' || command === 'replay') {
      if (value !== undefined) {
        console.error(`client: ${command} takes no value`);
        return false;
      }
      const expectedRevision = (client.state?.stateRevision ?? 0) + 1;
      client.submitIntent(command);
      if (awaitRevision) await client.waitForRevision(expectedRevision);
    } else if (command === 'seek') {
      const target = Number(value);
      if (value === undefined || !Number.isFinite(target) || target < 0) {
        console.error('client: usage: seek <non-negative seconds>');
        return false;
      }
      const expectedRevision = (client.state?.stateRevision ?? 0) + 1;
      client.submitIntent('seek', { targetSeconds: target });
      if (awaitRevision) await client.waitForRevision(expectedRevision);
    } else if (command === 'rate') {
      const rate = Number(value);
      if (value === undefined || !Number.isFinite(rate) || rate <= 0 || rate > MAX_PLAYBACK_RATE) {
        console.error(`client: usage: rate <number in (0, ${MAX_PLAYBACK_RATE}]>`);
        return false;
      }
      const expectedRevision = (client.state?.stateRevision ?? 0) + 1;
      client.submitIntent('set-rate', { playbackRate: rate });
      if (awaitRevision) await client.waitForRevision(expectedRevision);
    } else if (command === 'snapshot') {
      if (value !== undefined) {
        console.error('client: snapshot takes no value');
        return false;
      }
      client.requestSnapshot();
    } else if (command === 'report') {
      if (value !== undefined) {
        console.error('client: report takes no value');
        return false;
      }
      let state = client.state;
      if (!state) {
        // connect() can resolve before the join-accepted snapshot has been
        // observed, so a one-shot report right after joining would race the
        // connection. Boundedly wait for the first authoritative state; a
        // genuine timeout with no state still fails the command.
        try {
          state = await client.waitForRevision(0);
        } catch {
          console.error('client: no state to report yet');
          return false;
        }
      }
      // The CLI has no media player: echo the authoritative state as an
      // applied actual-state report (position projected to observation time).
      client.reportActualState({
        observedRevision: state.stateRevision,
        mediaPhase: state.mediaPhase,
        positionSeconds: projectPlaybackPosition(state, Date.now()),
        positionObservedAtMs: Date.now(),
        playbackRate: state.playbackRate,
        durationSeconds: state.durationSeconds,
        applyResult: 'applied',
      });
    } else if (command === 'accept' || command === 'decline') {
      if (value !== undefined) {
        console.error(`client: ${command} takes no value`);
        return false;
      }
      client.sendJoinDecision(command === 'accept');
    } else if (command === 'quit') {
      void shutdown(0);
    } else {
      console.error(`client: unknown command: ${command}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`client: command failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

if (argCommands.length > 0) {
  // One-shot mode: commands come from argv and are executed sequentially —
  // each intent awaits the authoritative revision it produces before the next
  // command is submitted, so later commands (e.g. report) observe the
  // accumulated effects instead of the stale join-time state. Any invalid
  // command, rejected intent, authority error, or desync diagnosis for this
  // participant fails the run with a non-zero exit.
  let failed = false;
  const offDiagnostics = client.onDiagnostic((message) => {
    if (message.type === 'error') failed = true;
    if (
      message.type === 'diagnostic'
      && (message.code === 'desync' || message.code === 'actual-state-mismatch')
      && message.participantId === participantId
    ) {
      failed = true;
    }
  });

  const tokens = [...argCommands];
  while (tokens.length > 0) {
    const token = tokens.shift()!;
    const line = token === 'seek' || token === 'rate' ? `${token} ${tokens.shift() ?? ''}` : token;
    if (!(await runCommand(line, true))) {
      failed = true;
      break;
    }
  }
  offDiagnostics();

  if (failed) {
    await shutdown(1);
  } else {
    // Final settle: pull a snapshot and wait for a short quiet period (bounded
    // by a hard cap) so the reported final-state is the latest authoritative
    // state before exiting cleanly.
    let received = false;
    let lastStateAt = Date.now();
    const settled = new Promise<void>((resolve) => {
      const off = client.onState(() => {
        received = true;
        lastStateAt = Date.now();
      });
      const poll = setInterval(() => {
        if (received && Date.now() - lastStateAt >= 150) {
          clearInterval(poll);
          clearTimeout(cap);
          off();
          resolve();
        }
      }, 25);
      const cap = setTimeout(() => {
        clearInterval(poll);
        off();
        resolve();
      }, 1500);
    });
    try {
      client.requestSnapshot();
    } catch (error) {
      console.error(`client: snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await settled;
    await shutdown(received ? 0 : 1);
  }
} else {
  // Interactive mode: commands come from stdin until EOF or 'quit'.
  console.log('client: commands: play | pause | seek <seconds> | rate <number> | replay | report | snapshot | accept | decline | quit');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  readline.on('line', (line) => { void runCommand(line, false); });
  readline.on('close', () => void shutdown(0));
}
