import { SessionAuthority } from '../server/session-authority.js';
import { SessionClient } from '../client/session-client.js';
import { createBilibiliResourceIdentity } from '../shared/resource.js';
import { isResourceIdentityEqual } from '../shared/protocol.js';
import type { PlaybackState } from '../shared/protocol.js';
import { projectPlaybackPosition } from '../core/playback-state.js';

const RESOURCE_URL = 'https://www.bilibili.com/video/BV1mkgw6mEQt/';
const resourceIdentity = createBilibiliResourceIdentity(RESOURCE_URL);

// Automatic smoke: autoAcceptJoins lets the second participant join without a
// host join-decision. Manual sessions must NEVER pass it.
const authority = new SessionAuthority({ host: '127.0.0.1', port: 0, resourceIdentity, autoAcceptJoins: true });
const address = await authority.start();

const clientOptions = {
  url: `ws://127.0.0.1:${address.port}`,
  sessionId: address.sessionId,
};
// The first participant declares the resource; the second joins WITHOUT one so
// the optional-identity path (adoption from the join-accepted state) is
// exercised too.
const first = new SessionClient({ ...clientOptions, participantId: 'smoke-a', resourceIdentity });
const second = new SessionClient({ ...clientOptions, participantId: 'smoke-b' });

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
first.onState((state) => reportState(first, state));
second.onState((state) => reportState(second, state));

function bothReady(): boolean {
  return first.sessionStatus?.ready === true && second.sessionStatus?.ready === true;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForReady(timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!bothReady() && Date.now() < deadline) {
    await delay(25);
  }
  if (!bothReady()) throw new Error(message);
}

try {
  await first.connect();
  await second.connect();

  if (authority.participantCount !== 2) throw new Error('Session did not seat both participants');
  const adopted = second.state?.resourceIdentity;
  if (!adopted || !isResourceIdentityEqual(adopted, resourceIdentity)) {
    throw new Error('Second participant did not adopt the session resource identity from join-accepted');
  }

  // The initial actual-state reports (sent by the onState hook on join-accepted)
  // must bring the session to ready.
  await waitForReady(5000, 'Session did not become ready after the initial actual-state reports');

  first.submitIntent('play');
  await Promise.all([first.waitForRevision(1), second.waitForRevision(1)]);
  second.submitIntent('seek', { targetSeconds: 42 });
  await Promise.all([first.waitForRevision(2), second.waitForRevision(2)]);
  first.submitIntent('pause');
  await Promise.all([first.waitForRevision(3), second.waitForRevision(3)]);
  const duplicateId = 'duplicate-seek';
  first.submitIntent('seek', { targetSeconds: 7 }, duplicateId);
  await Promise.all([first.waitForRevision(4), second.waitForRevision(4)]);
  first.submitIntent('seek', { targetSeconds: 99 }, duplicateId);
  await delay(100);
  if (first.state?.stateRevision !== 4 || second.state?.stateRevision !== 4) throw new Error('Duplicate command changed the state');
  if (first.state.positionSeconds !== 7 || second.state.positionSeconds !== 7) throw new Error('Clients did not converge on duplicate-command state');

  // Both clients re-report every state, so the session returns to ready after
  // the final revision as well.
  await waitForReady(5000, 'Session did not return to ready after the final intents');

  const finalA = first.state!;
  const finalB = second.state!;
  if (
    finalA.stateRevision !== finalB.stateRevision
    || finalA.mediaPhase !== finalB.mediaPhase
    || finalA.positionSeconds !== finalB.positionSeconds
  ) {
    throw new Error(`Clients diverged: smoke-a=${JSON.stringify(finalA)} smoke-b=${JSON.stringify(finalB)}`);
  }
  if (finalA.stateRevision !== 4 || finalA.mediaPhase !== 'paused' || finalA.positionSeconds !== 7) {
    throw new Error(`Unexpected final state: ${JSON.stringify(finalA)}`);
  }

  console.log(JSON.stringify({
    type: 'SMOKE_OK',
    port: address.port,
    revision: finalA.stateRevision,
    phase: finalA.mediaPhase,
    position: finalA.positionSeconds,
    participantCount: authority.participantCount,
    sessionReady: bothReady(),
  }));
} finally {
  await Promise.all([first.close(), second.close()]);
  await authority.stop();
}
