---
title: 'LAN Bilibili Sync Vertical Slice'
type: 'feature'
created: '2026-08-15'
status: 'ready-for-dev'
review_loop_iteration: 0
context:
  - '_bmad-output/planning-artifacts/any-together-requirements-spec.md'
---

<frozen-after-approval reason="user-authorized end-to-end development; implementation may refine internals without changing the contract">

## Intent

**Problem:** The repository has requirements but no executable foundation. The first implementation must prove the hardest reusable part: two independent runtimes exchange ordered playback intents over a real LAN-capable transport and converge on one authoritative state.

**Approach:** Build a dependency-light TypeScript/Node vertical slice with a WebSocket session authority, typed playback state, a browser-side `HTMLMediaElement` adapter contract, CLI host/client processes, and deterministic integration tests using two independent clients. Keep Bilibili DOM concerns behind the adapter; do not build non-core site features yet.

## Boundaries & Constraints

**Always:** creator is the authority; accepted intents receive deterministic sequence/revision; clients apply only newer authoritative state; duplicate commands are idempotent; resource identity must match before ready; execution and drift failures are explicit; transport carries control/state only, never media; code must remain testable without a second physical device.

**Ask First:** changing the shared-state semantics, adding a public relay/authentication service, changing the MVP from two participants, or committing to a browser/platform beyond the Node + browser-page adapter slice.

**Never:** modify `docs/old_designs/`; implement NAT traversal, accounts, media proxying, multi-resource product flows, or site-specific controls in the core; silently accept an unverified or divergent state.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Join | client connects with matching resource | host accepts; client receives snapshot | reject malformed or third participant |
| Play/pause | two clients submit intents close together | authority assigns one order; same final state reaches both | duplicate command ignored |
| Seek | valid target position | authoritative position broadcasts and clients converge | invalid range rejected |
| Version gap | client misses a revision | client requests full snapshot | unrecoverable gap marks desync |
| Resource mismatch | different resource identity | session stays unready | show resource mismatch |
| Adapter failure | media action cannot execute | actual-state report contains failure | session is not marked synchronized |

</frozen-after-approval>

## Code Map

- `package.json` -- Node scripts and runtime dependencies.
- `src/shared/protocol.ts` -- stable wire types and playback semantics.
- `src/core/playback-state.ts` -- pure authority state transitions and position projection.
- `src/server/session-authority.ts` -- WebSocket host, participant limit, ordering, snapshots, broadcasts.
- `src/client/session-client.ts` -- independent client runtime and version-gap recovery.
- `src/adapters/resource-adapter.ts` -- reusable page adapter contract.
- `src/adapters/bilibili-adapter.ts` -- HTMLMediaElement-backed Bilibili playback adapter.
- `src/cli/host.ts` / `src/cli/client.ts` -- manual two-process LAN smoke-test entrypoints.
- `tests/core/playback-state.test.ts` -- pure transition and ordering tests.
- `tests/integration/session-authority.test.ts` -- two independent WebSocket clients over a real local socket.

## Tasks & Acceptance

**Execution:**
- [ ] `package.json`, `tsconfig.json` -- add build, test, host, and client scripts with Node/WebSocket dependencies.
- [ ] `src/shared/protocol.ts`, `src/core/playback-state.ts` -- implement typed state, idempotent commands, deterministic revisions, position projection, and validation.
- [ ] `src/server/session-authority.ts`, `src/client/session-client.ts` -- implement two-party session, ordered authority, snapshot recovery, and desync reporting.
- [ ] `src/adapters/resource-adapter.ts`, `src/adapters/bilibili-adapter.ts` -- isolate HTMLMediaElement control, event mapping, resource identity, and observable apply results.
- [ ] `src/cli/*` -- provide host/client processes that can be run using a machine LAN IP.
- [ ] `tests/*` -- cover state edges and two independent clients over a real WebSocket server.

**Acceptance Criteria:**
- Given two clients connect to one host with the same resource, when both submit play/pause/seek intents, then both receive the same final `stateRevision` and shared state.
- Given a duplicate command, when the authority receives it twice, then it increments state only once.
- Given a client revision gap, when it requests a snapshot, then it recovers the latest state or reports desync.
- Given a Bilibili page video element, when the adapter applies pause, play, seek, and rate, then the observable media state reflects each operation.
- Given a third client, when it attempts to join, then the host rejects it explicitly.
- Given `npm test`, when the implementation is valid, then the command exits 0.

## Design Notes

The integration test uses two independent WebSocket clients and an ephemeral real TCP listener, not two calls into one in-memory object. The same host entrypoint binds to `0.0.0.0`, so the manual smoke test can substitute the machine's LAN address; a second physical device is not required to validate ordering, framing, duplicate handling, and snapshot recovery.

## Verification

**Commands:**
- `npm test` -- expected: build succeeds and all core/integration tests pass.
- `npm run build` -- expected: `dist/` contains compiled runtime and CLI entrypoints.
- `npm run smoke:lan` -- expected: host and two local processes complete a real socket exchange and report matching final revision/state.

**Manual checks:**
- Open a Bilibili video page, inject/use the adapter in the page context, and confirm `play`, `pause`, `currentTime`, `playbackRate`, and native event observations. If the page is blocked by login/captcha, record the external limitation rather than claiming success.
