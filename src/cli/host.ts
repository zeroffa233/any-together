import { networkInterfaces } from 'node:os';
import { SessionAuthority } from '../server/session-authority.js';
import { SessionApi } from '../server/session-api.js';
import { createBilibiliResourceIdentity } from '../shared/resource.js';

const DEFAULT_PORT = 8765;

// Flags are parsed separately so an optional resource URL never consumes a
// flag value. `--session-id ID` and `--session-id=ID` are equivalent; when
// omitted, SessionAuthority continues to generate a UUID.
const args = process.argv.slice(2);
const autoAccept = args.includes('--auto-accept');
const positional: string[] = [];
let fixedSessionId: string | undefined;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === undefined) continue;
  if (arg === '--auto-accept') continue;
  if (arg === '--session-id') {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      console.error('host: --session-id requires a non-empty value');
      process.exit(2);
    }
    fixedSessionId = value;
    index += 1;
    continue;
  }
  if (arg.startsWith('--session-id=')) {
    const value = arg.slice('--session-id='.length).trim();
    if (!value) {
      console.error('host: --session-id= requires a non-empty value');
      process.exit(2);
    }
    fixedSessionId = value;
    continue;
  }
  positional.push(arg);
}
const port = Number(positional[0] ?? DEFAULT_PORT);
const resourceUrl = positional[1];
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`host: invalid port ${JSON.stringify(positional[0])} (expected an integer in 0-65535)`);
  process.exit(2);
}

// Without a resource URL the session starts UNBOUND: the authority has no
// resourceIdentity until the first host join carries one or a joined host
// sends resource-bind. Playback intents are rejected until then.
const authority = new SessionAuthority({
  host: '0.0.0.0',
  port,
  ...(fixedSessionId === undefined ? {} : { sessionId: fixedSessionId }),
  autoAcceptJoins: autoAccept,
  ...(resourceUrl === undefined ? {} : { resourceIdentity: createBilibiliResourceIdentity(resourceUrl) }),
});

let address: { host: string; port: number; sessionId: string };
try {
  address = await authority.start();
} catch (error) {
  console.error(`host: failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// The local session API shares the authority's lifetime: it reports the
// session id, ports and binding status, and never touches media or authority
// state. Default API port is wsPort + 1 (8766 for the default 8765).
const api = new SessionApi({ authority, wsPort: address.port });
let apiAddress: { host: string; port: number };
try {
  apiAddress = await api.start();
} catch (error) {
  console.error(`host: failed to start session API: ${error instanceof Error ? error.message : String(error)}`);
  try {
    await authority.stop();
  } catch {
    // The process exits below; the ws server is torn down regardless.
  }
  process.exit(1);
}

// The authority binds 0.0.0.0, which listens on every interface, so enumerate
// the LAN IPv4 addresses another device on the network can actually reach us on.
const lanAddresses: string[] = [];
for (const interfaces of Object.values(networkInterfaces())) {
  for (const info of interfaces ?? []) {
    if (info.family === 'IPv4' && !info.internal) lanAddresses.push(info.address);
  }
}
const endpoints = [...new Set(['127.0.0.1', ...lanAddresses])];

const sessionState = authority.getState();
console.log(JSON.stringify({
  type: 'session-ready',
  host: address.host,
  port: address.port,
  sessionId: address.sessionId,
  apiPort: apiAddress.port,
  resourceUrl: resourceUrl ?? null,
  resourceIdentity: sessionState.resourceIdentity,
}));
console.log(`host: session ${address.sessionId} ready on ws://0.0.0.0:${address.port}`);
if (resourceUrl === undefined) {
  console.log('host: 等待主机页面绑定: the session starts with no resource; the first host join (or resource-bind) will bind it');
} else {
  console.log(`host: resource ${JSON.stringify(sessionState.resourceIdentity)} (normalized from ${resourceUrl})`);
}
console.log(`host: session API on http://127.0.0.1:${apiAddress.port} (GET /api/session)`);
console.log('host: Session 复制信息 (paste into the host page):');
console.log(`host:   ws://127.0.0.1:${address.port}`);
console.log(`host:   ${address.sessionId}`);
console.log(`host:   http://127.0.0.1:${apiAddress.port}/api/session`);
if (autoAccept) {
  console.log('host: auto-accept joins enabled (--auto-accept): the second participant joins without human approval — intended for automatic CLI smoke runs only');
} else {
  console.log('host: join approval required: the first client to join is the host participant and approves the second with accept/decline');
}
for (const endpoint of endpoints) {
  console.log(`host: connect via ws://${endpoint}:${address.port}`);
}
console.log(`host: join with  node dist/src/cli/client.js ws://<address>:${address.port} ${address.sessionId} <participant-id> [bilibili-url]`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  const state = authority.getState();
  console.log(JSON.stringify({
    type: 'host-final-state',
    sessionId: state.sessionId,
    revision: state.stateRevision,
    phase: state.mediaPhase,
    position: state.positionSeconds,
    rate: state.playbackRate,
    participantCount: authority.participantCount,
  }));
  console.log(`host: ${signal} received, shutting down`);
  try {
    await api.stop();
    await authority.stop();
  } catch (error) {
    console.error(`host: error while stopping: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
