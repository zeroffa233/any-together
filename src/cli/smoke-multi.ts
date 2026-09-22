import { SessionAuthority } from '../server/session-authority.js';
import { SessionClient } from '../client/session-client.js';
import { createBilibiliResourceIdentity } from '../shared/resource.js';
import type { PlaybackState } from '../shared/protocol.js';
import { projectPlaybackPosition } from '../core/playback-state.js';

const RESOURCE_URL = 'https://www.bilibili.com/video/BV1mkgw6mEQt/';
const resourceIdentity = createBilibiliResourceIdentity(RESOURCE_URL);

// Automatic smoke: autoAcceptJoins lets every joiner in without a host
// join-decision. Manual sessions must NEVER pass it. Three participants prove
// the multiplayer path end to end: identical broadcasts, converged intents and
// a forced resync that every participant follows.
const authority = new SessionAuthority({ host: '127.0.0.1', port: 0, resourceIdentity, autoAcceptJoins: true });
const address = await authority.start();

const clientOptions = {
  url: `ws://127.0.0.1:${address.port}`,
  sessionId: address.sessionId,
};
const smokeA = new SessionClient({ ...clientOptions, participantId: 'smoke-a', resourceIdentity });
const smokeB = new SessionClient({ ...clientOptions, participantId: 'smoke-b' });
const smokeC = new SessionClient({ ...clientOptions, participantId: 'smoke-c' });
const clients = [smokeA, smokeB, smokeC];

// The CLI has no media player: every authoritative state is echoed back as an
// applied actual-state report so the session can reach ready.
function reportState(client: SessionClient, state: PlaybackState): void {
  client.reportActualState({
    observedRevision: state.stateRevision,
    mediaPhase: state.mediaPhase,
    positionSeconds: projectPlaybackPosition(state, Date.now()),
    positionObservedAtMs: Date.now(),
    playbackRate: state.playbackRate,
    durationSeconds: state.durationSeconds,
    applyResult: 'applied',
  });
}
for (const client of clients) client.onState((state) => reportState(client, state));

function allReady(): boolean {
  return clients.every((client) => client.sessionStatus?.ready === true);
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForReady(timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!allReady() && Date.now() < deadline) await delay(25);
  if (!allReady()) throw new Error(message);
}

async function waitForAllRevisions(revision: number, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!clients.every((client) => (client.state?.stateRevision ?? -1) >= revision) && Date.now() < deadline) {
    await delay(25);
  }
  if (!clients.every((client) => (client.state?.stateRevision ?? -1) >= revision)) throw new Error(message);
}

function assertConverged(label: string): void {
  const states = clients.map((client) => client.state);
  const first = states[0];
  if (first === undefined) throw new Error(`${label}: no authoritative state observed`);
  for (const [index, state] of states.entries()) {
    if (state === undefined) throw new Error(`${label}: participant ${index} has no state`);
    if (state.stateRevision !== first.stateRevision
      || state.mediaPhase !== first.mediaPhase
      || state.positionSeconds !== first.positionSeconds) {
      throw new Error(`${label}: participants diverged: ${JSON.stringify(states)}`);
    }
  }
}

try {
  await smokeA.connect();
  await smokeB.connect();
  await smokeC.connect();

  if (authority.participantCount !== 3) throw new Error('Session did not seat all three participants');
  for (const client of [smokeB, smokeC]) {
    const adopted = client.state?.resourceIdentity;
    if (!adopted || adopted.adapterId !== 'bilibili') {
      throw new Error(`${client === smokeB ? 'smoke-b' : 'smoke-c'} did not adopt the session resource from join-accepted`);
    }
  }

  await waitForReady(5000, 'Session did not become ready after the initial actual-state reports');

  smokeA.submitIntent('play');
  await waitForAllRevisions(1, 5000, 'Not all participants reached revision 1 after play');
  smokeB.submitIntent('seek', { targetSeconds: 42 });
  await waitForAllRevisions(2, 5000, 'Not all participants reached revision 2 after seek');
  smokeC.submitIntent('pause');
  await waitForAllRevisions(3, 5000, 'Not all participants reached revision 3 after pause');
  assertConverged('after intents');

  // Persisted drift on ONE participant must resync it while the other two
  // follow the re-broadcast: the whole session converges on the new revision.
  const revisionBeforeDrift = 3;
  for (let sample = 0; sample < 3; sample += 1) {
    smokeB.reportActualState({
      observedRevision: revisionBeforeDrift,
      mediaPhase: 'paused',
      positionSeconds: (smokeB.state?.positionSeconds ?? 42) + 30,
      positionObservedAtMs: Date.now(),
      playbackRate: smokeB.state?.playbackRate ?? 1,
      durationSeconds: smokeB.state?.durationSeconds ?? null,
      applyResult: 'applied',
    });
    await delay(60);
  }
  await waitForAllRevisions(revisionBeforeDrift + 1, 5000, 'Drifting participant did not trigger a resync');
  assertConverged('after resync');

  await waitForReady(5000, 'Session did not return to ready after the resync');

  const finalA = smokeA.state!;
  if (finalA.mediaPhase !== 'paused') throw new Error(`Unexpected final phase: ${finalA.mediaPhase}`);
  if (finalA.positionSeconds !== smokeB.state!.positionSeconds || finalA.positionSeconds !== smokeC.state!.positionSeconds) {
    throw new Error('Final positions diverged');
  }

  console.log(JSON.stringify({
    type: 'SMOKE_OK',
    port: address.port,
    revision: finalA.stateRevision,
    phase: finalA.mediaPhase,
    position: finalA.positionSeconds,
    participantCount: authority.participantCount,
    sessionReady: allReady(),
  }));
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await authority.stop();
}
