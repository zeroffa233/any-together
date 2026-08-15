import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { SessionAuthority } from '../server/session-authority.js';
import { SessionApi } from '../server/session-api.js';
import { LocalMediaServer, type LocalShare } from '../server/local-media-server.js';
import { createLocalVideoResourceIdentity } from '../shared/local-resource.js';
import { createBilibiliResourceIdentity } from '../shared/resource.js';

const DEFAULT_PORT = 8765;

// Flags are parsed separately so an optional resource URL never consumes a
// flag value. `--session-id ID` and `--session-id=ID` are equivalent; when
// omitted, SessionAuthority continues to generate a UUID.
const args = process.argv.slice(2);
const autoAccept = args.includes('--auto-accept');
const positional: string[] = [];
let fixedSessionId: string | undefined;
let sharePath: string | undefined;
let mediaPort: number | undefined;
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
  if (arg === '--share') {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      console.error('host: --share requires an absolute path to a file');
      process.exit(2);
    }
    sharePath = value;
    index += 1;
    continue;
  }
  if (arg.startsWith('--share=')) {
    const value = arg.slice('--share='.length).trim();
    if (!value) {
      console.error('host: --share= requires an absolute path to a file');
      process.exit(2);
    }
    sharePath = value;
    continue;
  }
  if (arg === '--media-port') {
    const value = args[index + 1];
    const parsedValue = value === undefined ? NaN : Number(value);
    if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > 65535) {
      console.error('host: --media-port requires an integer in 0-65535');
      process.exit(2);
    }
    mediaPort = parsedValue;
    index += 1;
    continue;
  }
  if (arg.startsWith('--media-port=')) {
    const parsedValue = Number(arg.slice('--media-port='.length).trim());
    if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > 65535) {
      console.error('host: --media-port requires an integer in 0-65535');
      process.exit(2);
    }
    mediaPort = parsedValue;
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
if (mediaPort !== undefined && sharePath === undefined) {
  console.error('host: --media-port requires --share');
  process.exit(2);
}
if (sharePath !== undefined && resourceUrl !== undefined) {
  console.error('host: --share cannot be combined with a positional resource URL');
  process.exit(2);
}
if (sharePath !== undefined) {
  if (!isAbsolute(sharePath)) {
    console.error(`host: --share requires an absolute file path (got ${JSON.stringify(sharePath)})`);
    process.exit(2);
  }
  let isRegularFile: boolean;
  try {
    isRegularFile = (await stat(sharePath)).isFile();
  } catch {
    console.error(`host: --share file not found: ${sharePath}`);
    process.exit(2);
  }
  if (!isRegularFile) {
    console.error(`host: --share path is not a regular file: ${sharePath}`);
    process.exit(2);
  }
}

// The media server (if any) advertises a LAN-reachable URL. The authority and
// the API bind wildcard/loopback addresses, so enumerate the LAN IPv4
// addresses another device on the network can actually reach us on up front.
const lanAddresses: string[] = [];
for (const interfaces of Object.values(networkInterfaces())) {
  for (const info of interfaces ?? []) {
    if (info.family === 'IPv4' && !info.internal) lanAddresses.push(info.address);
  }
}
const endpoints = [...new Set(['127.0.0.1', ...lanAddresses])];
const lanHost = lanAddresses[0] ?? '127.0.0.1';

// With --share the media server starts BEFORE the authority: its share URL is
// the session's local-video resource identity, so it must exist before the
// authority is constructed. Without --share no media listener is created at
// all. The default media port is wsPort + 2 (wsPort + 1 is the session API).
const mediaServer = sharePath === undefined
  ? null
  : new LocalMediaServer({ filePath: sharePath, port: mediaPort ?? port + 2, urlHost: lanHost });
let mediaShare: LocalShare | null = null;
if (mediaServer !== null) {
  try {
    mediaShare = await mediaServer.start();
  } catch (error) {
    console.error(`host: failed to start media server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Without a resource URL (positional or --share) the session starts UNBOUND:
// the authority has no resourceIdentity until the first host join carries one
// or a joined host sends resource-bind. Playback intents are rejected until
// then.
const authority = new SessionAuthority({
  host: '0.0.0.0',
  port,
  ...(fixedSessionId === undefined ? {} : { sessionId: fixedSessionId }),
  autoAcceptJoins: autoAccept,
  ...(resourceUrl === undefined ? {} : { resourceIdentity: createBilibiliResourceIdentity(resourceUrl) }),
  ...(mediaShare === null ? {} : { resourceIdentity: createLocalVideoResourceIdentity(mediaShare.url) }),
});

let address: { host: string; port: number; sessionId: string };
try {
  address = await authority.start();
} catch (error) {
  console.error(`host: failed to start: ${error instanceof Error ? error.message : String(error)}`);
  if (mediaServer !== null) {
    try {
      await mediaServer.stop();
    } catch {
      // The process exits below; the media port is released regardless.
    }
  }
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
    if (mediaServer !== null) await mediaServer.stop();
    await authority.stop();
  } catch {
    // The process exits below; the servers are torn down regardless.
  }
  process.exit(1);
}

const sessionState = authority.getState();
console.log(JSON.stringify({
  type: 'session-ready',
  host: address.host,
  port: address.port,
  sessionId: address.sessionId,
  apiPort: apiAddress.port,
  resourceUrl: resourceUrl ?? mediaShare?.url ?? null,
  resourceIdentity: sessionState.resourceIdentity,
}));
console.log(`host: session ${address.sessionId} ready on ws://0.0.0.0:${address.port}`);
if (resourceUrl === undefined && mediaShare === null) {
  console.log('host: 等待主机页面绑定: the session starts with no resource; the first host join (or resource-bind) will bind it');
} else if (mediaShare !== null) {
  console.log(`host: resource ${JSON.stringify(sessionState.resourceIdentity)} (shared local video ${mediaShare.url})`);
} else {
  console.log(`host: resource ${JSON.stringify(sessionState.resourceIdentity)} (normalized from ${resourceUrl})`);
}
if (mediaShare !== null) {
  console.log(`host: media server on 0.0.0.0:${mediaShare.port}`);
  console.log(`host: share URL: ${mediaShare.url}`);
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
    // Media first: revoking the share token before the API/authority stop
    // guarantees no session advertises a dead URL.
    if (mediaServer !== null) await mediaServer.stop();
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
