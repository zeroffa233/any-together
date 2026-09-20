import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveHostOptions, type ResolvedHostOptions } from './host-options.js';
import { SessionAuthority } from '../server/session-authority.js';
import { SessionApi } from '../server/session-api.js';
import { LocalMediaServer, type LocalShare } from '../server/local-media-server.js';
import { createLocalVideoResourceIdentity } from '../shared/local-resource.js';
import { createBilibiliResourceIdentity } from '../shared/resource.js';

let options: ResolvedHostOptions;
try {
  options = await resolveHostOptions(process.argv.slice(2));
} catch (error) {
  console.error(`host: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const {
  port,
  autoAccept,
  sessionName,
  fixedSessionId,
  sharePath,
  mediaPort,
  resourceUrl,
} = options;
if (options.configPath !== undefined) {
  console.log(`host: loaded configuration from ${options.configPath}`);
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
  ...(sessionName === undefined ? {} : { sessionName }),
  autoAcceptJoins: autoAccept,
  ...(resourceUrl === undefined ? {} : { resourceIdentity: createBilibiliResourceIdentity(resourceUrl) }),
  ...(mediaShare === null ? {} : { resourceIdentity: createLocalVideoResourceIdentity(mediaShare.url) }),
});

let address: { host: string; port: number; sessionId: string; sessionName?: string };
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
const shareLine = (host: string): string =>
  `anytogether://session?host=${encodeURIComponent(host)}&port=${address.port}&session=${encodeURIComponent(address.sessionId)}`;

console.log(JSON.stringify({
  type: 'session-ready',
  host: address.host,
  port: address.port,
  sessionId: address.sessionId,
  ...(address.sessionName === undefined ? {} : { sessionName: address.sessionName }),
  apiPort: apiAddress.port,
  resourceUrl: resourceUrl ?? mediaShare?.url ?? null,
  resourceIdentity: sessionState.resourceIdentity,
}));
console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  会话已就绪 — 把下面的分享串整段复制发给对方即可加入          ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
for (const lan of lanAddresses) {
  console.log(`║  ${shareLine(lan).padEnd(61)}║`);
}
if (lanAddresses.length === 0) {
  console.log(`║  ${shareLine('127.0.0.1').padEnd(61)}║  (仅本机可连)`);
}
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`会话名称: ${sessionName ?? '(未设置，仅可用 Session ID 加入)'}   Session ID: ${address.sessionId}`);
console.log(`监听: ws://0.0.0.0:${address.port}   会话 API: http://127.0.0.1:${apiAddress.port}/api/session`);
console.log(`状态: ${resourceUrl === undefined && mediaShare === null
  ? '未绑定资源——首次加入后由当前播放页自动绑定'
  : mediaShare !== null
    ? `本地视频广播 ${mediaShare.url}`
    : `资源 ${JSON.stringify(sessionState.resourceIdentity)}`}`);
if (autoAccept) {
  console.log('加入方式: 自动接受(--auto-accept)，仅建议自动冒烟使用');
} else {
  console.log('加入方式: 首位加入者自动成为会话成员并审批第二位');
}

// Best-effort public IP detection: a CLI deployed on a public server has only
// private NICs, so the outbound address from ifconfig.me is the shareable
// host. Never blocks the session; silently skipped when offline.
void (async () => {
  try {
    const child = spawn('curl', ['-4', '-s', '--max-time', '4', 'ifconfig.me'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString().trim(); });
    child.once('close', (code) => (code === 0 && out.length > 0 ? resolve(out) : reject(new Error('unavailable'))));
    child.once('error', reject);
    const publicIp = await Promise.race([promise, new Promise<never>((_, reject2) => setTimeout(() => reject2(new Error('timeout')), 5000))]);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(publicIp)) throw new Error('not an IPv4 literal');
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  检测到公网出口 IP — 以下分享串供跨网络（需端口转发）使用     ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  ${shareLine(publicIp).padEnd(61)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('跨网络加入需将本机/服务器的该端口在路由器或防火墙上映射到公网。');
  } catch {
    // Offline or curl missing: the LAN share strings above are the answer.
  }
})();

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
