# 同步协议与状态语义（Wire Protocol & State Semantics）

> 配套：`overview.md`（边界与总览）、`authoring.md`（如何写同步器）。
> 标记：`[当前实现]` = 已实现；`[建议约定]` = 推荐规范；`[未来能力]` = 未实现。
> 类型与守卫定义在 `src/shared/protocol.ts`；所有类型 JSON 可序列化，所有守卫是纯函数。
> 权威状态机在 `src/core/playback-state.ts`；一致性判定在 `src/core/consistency-monitor.ts`。

## 1. 会话模型

- 一个会话最多 **2 名参与者**（host + client）。先加入者自动成为 host（创建者），后加入者成为 client；
  join 里的 `roleHint` 仅是建议，权威方最终裁决并通过 `join-accepted.role` 回显。
- 会话资源可**未绑定**（`PlaybackState.resourceIdentity === null`，直到首个 host join 携带身份或
  任一已加入参与者发送 `resource-bind`）。未绑定期间一切播放意图被拒（`resource-unbound`）。
- 第二个参与者需要 host 审批（`join-request` → `join-decision`），除非权威以 `autoAcceptJoins`
  启动（仅限 CLI 冒烟，禁止手工会话使用）。
- 服务端消息按到达顺序同步裁决——到达顺序即该会话的确定性命令顺序。

## 2. 线上消息

### 2.1 客户端 → 服务端（`ClientMessage`）

| `type` | 关键字段 | 语义与约束 |
|---|---|---|
| `join` | `participantId`；可选 `roleHint`（`'host'\|'client'`）；可选 `resourceIdentity` | 加入会话。身份可选：不知道资源的加入者在 `join-accepted` 中采纳被推资源；**提供且与会话已绑定资源不等** → 拒绝 `resource-mismatch`；未绑定会话则采纳首个 host join 的身份。`roleHint`/`resourceIdentity` 缺省保持与旧客户端线上兼容 |
| `resource-bind` | `participantId`；`resourceIdentity` | **任一已加入参与者**（host 或 client 均可）可绑定/切换会话媒体。幂等：绑定与会话**完全相同**的身份是 no-op（不 bump revision、不重置播放头，防两端并发绑定同资源的竞态）。不同身份 → 见 §3.3 |
| `join-decision` | `participantId`（决策者，即 host）；`accepted: boolean` | host 对唯一待定加入者的裁决；非 host/无待定者 → `error` |
| `intent` | `commandId`；`sessionId`；`participantId`；`clientObservedRevision`；`kind`；可选 `payload`；`createdAtMs` | 播放意图，见 §3。`commandId` 重复 → 权威回当前状态且**绝不重放**（幂等）；`sessionId` 不符 → `session-mismatch` |
| `snapshot-request` | `participantId`；`observedRevision` | 请求当前权威快照 → `snapshot` |
| `actual-state` | `sessionId`；`participantId`；`observedRevision`；`resourceIdentity`；`mediaPhase`；`positionSeconds`；`positionObservedAtMs`；`playbackRate`；`durationSeconds`；`adapterId`；`applyResult`；可选 `error` | 页面真实观测报告，见 §5。守卫要求所有字段齐全且结构合法 |

### 2.2 服务端 → 客户端（`ServerMessage`）

| `type` | 语义 |
|---|---|
| `join-accepted` | `{ role, participantId, state }`；被接受时推送完整权威状态（含资源身份，未绑定则 `state.resourceIdentity: null`） |
| `join-rejected` | `{ reason }`：`session-full`、`duplicate-or-empty-participant-id`、`resource-mismatch`、`host-declined`、`host-unavailable`、`no-host-available` |
| `join-request` | 通知 host 有第二个参与者待审批（含其可选身份） |
| `state` | 权威 `PlaybackState` 广播（每次成功意图/bind/终态提升都广播） |
| `snapshot` | `snapshot-request` 的应答，携带当前 `PlaybackState` |
| `session-status` | 可观察就绪度，见 §6；仅变化时广播（防稳态报告刷屏） |
| `diagnostic` | `code: 'desync'\|'participant-left'\|'actual-state-mismatch'`；含期望/实际对照与资源对比（未绑定会话无 `resource` 字段） |
| `error` | `{ code, message }`，见 §8 |

## 3. 权威状态机

### 3.1 `PlaybackState` 字段与不变量

| 字段 | 语义 / 不变量 |
|---|---|
| `sessionId` | 会话标识，非空 |
| `resourceIdentity` | **可空**：`null` = 未绑定；一旦绑定不再为 null |
| `stateRevision` / `lastSequence` | 每次成功施加意图、资源绑定或终态提升各 **+1**，严格单调；从未施加命令的消息不改动它们 |
| `mediaPhase` | `MediaPhase`（见 3.2） |
| `positionSeconds` / `positionAtMs` | 冻结位置锚点：意图应用时先把播放头投影到当前时钟再冻结 |
| `playbackRate` | `(0, 16]`（`MAX_PLAYBACK_RATE = 16`），服务端强制 |
| `durationSeconds` | 未知为 `null`；已知为非负有限数 |
| `lastCommandId` | 最近应用命令的 id，幂等去重用 |
| `updatedAtMs` | 状态变更时钟 |

### 3.2 `MediaPhase` 与意图

相位：`'loading' | 'ready' | 'playing' | 'paused' | 'seeking' | 'buffering' | 'ended' | 'error'`。
`'ready'` 是权威方的“新资源/预滚”相位；与媒体真实 `'paused'` 是同一可观测状态（一致性判定等价，见 §7）。

意图（`IntentKind`）与载荷约束：

| kind | payload | 状态效果 |
|---|---|---|
| `play` | 无 | → `'playing'` |
| `pause` | 无 | → `'paused'` |
| `seek` | `targetSeconds`：非负有限数 | 位置改为 `min(target, duration)`（超时长且超出 `SEEK_TOLERANCE_SECONDS = 0.001` → `invalid-seek`）；相位保持（播放中仍播放，否则暂停） |
| `set-rate` | `playbackRate`：`> 0` 且 `≤ 16` | 更新速率；越界 → `invalid-rate` |
| `replay` | 无 | → `'playing'` 且位置归 0 |

- `applyIntent` 是**纯函数**：同输入同输出，时钟注入不采样；每次应用先投影再冻结（意图永远不能用旧投影覆盖新位置）；位置四舍五入到毫秒精度（消除浮点噪声）。
- 非法意图抛 `StateTransitionError`（稳定 `code`）且**不触碰**输入状态：`invalid-intent`、`invalid-seek`、`invalid-rate`、`session-mismatch`、`resource-unbound`、`invalid-state`、`invalid-clock`。
- 位置投影（`projectPlaybackPosition`）：`'playing'` 时按 `positionSeconds + (now − positionAtMs)/1000 × playbackRate` 外推，不倒退、不超过时长；其他相位返回冻结位置。

### 3.3 绑定与切换（`resource-bind`）

绑定**不同**身份时（`[当前实现]`）：`stateRevision`/`lastSequence` 各 +1，`mediaPhase → 'ready'`，
位置归 0、速率 1、时长 `null`（新资源时长未知）、`lastCommandId → null`，清空全部已存 actual-state 报告
（旧页面报告既不能被判定也不能晋升进新资源），广播新状态 + session-status。绑定相同身份：完全 no-op。

### 3.4 终态提升（ended / error 晋升）

`[当前实现]` 报告若满足：当前 revision + 当前资源 + `applyResult === 'applied'` + 相位为 `'ended'` 或 `'error'`
且与权威相位不同 → 权威把该终态**晋升为新的权威 revision**（相位/位置/时钟对齐；`error` 同时带走报告 `error`，
记入 `errorCode`），清空报告并广播。这样两端同步到达同一终态。`'buffering'` **刻意不晋升**
（瞬时单端生命周期状态，按一致性判定兼容处理，避免抖动把另一端拖入 buffering）。
`'seeking'` 同理按瞬时状态处理。

## 4. 客户端行为契约（`SessionClient`）

- `connect()` 返回 `join-accepted`；加入失败（连接错误/close/拒绝）以显式错误拒绝。
- `submitIntent(kind, payload?, commandId?)`：默认 `commandId = '<participantId>-<n>'` 递增；
  `clientObservedRevision` 取本端最新 revision。返回 commandId。
- `reportActualState(report)`：身份按 **最新权威状态** 采纳（跟随 `resource-bind`；未绑定则落到客户端选项；
  两者都无 → 显式报错拒绝）。`adapterId` 缺省取身份的 `adapterId`。
- `sendResourceBind(identity)`：host 与 client 皆可（服务端裁决）。
- `sendJoinDecision(accepted)`：仅 host；服务端拒绝非 host。
- `requestSnapshot()` / `waitForRevision(revision)`：等待指定 revision 到达。

## 5. 实际状态报告与一致性

`actual-state` 报告的是**页面真实观测**：`positionObservedAtMs` 是观测时刻，服务端在
`'playing'` 权威相位下按该时刻投影期望位置再比较（见 3.2 投影）。

`evaluateActualState(authoritative, report)` 产出 `ConsistencyResult { consistent, issues[] }`：

| issue kind | 触发条件 |
|---|---|
| `stale-report` | `observedRevision < 当前 revision` |
| `revision-mismatch` | `observedRevision ≠ 当前 revision`（更大也算） |
| `resource-mismatch` | 已绑定会话：报告身份 ≠ 会话身份（未绑定会话跳过资源/适配器检查） |
| `adapter-mismatch` | 已绑定会话：`report.adapterId ≠ session.adapterId` |
| `phase-mismatch` | 相位不兼容（见 §7 相位兼容规则） |
| `unacceptable-phase` | 报告相位为 `'error'`（必须显式诊断，绝不静默当成功） |
| `position-drift` | 仅在相位等价且双方非瞬时相位时判定；漂移 `> POSITION_DRIFT_THRESHOLD_MS = 250ms` |
| `rate-mismatch` | `|report.rate − 权威rate| > 1e-9` |
| `duration-mismatch` | **双方都已知**时长且不等（权威未知时长时，报告携带时长是补全信息而非失配） |
| `apply-failure` | `applyResult ≠ 'applied'`（取报告 `error` 为详情） |

全部 10 种 issue 都在 `READINESS_BLOCKING_KINDS` 中（默认阻断就绪门）。
`consistent = true` 当且仅当无阻断 issue。

**相位兼容规则**（`arePhasesConsistencyCompatible`）：
- 相等，或 `'ready' ↔ 'paused'`（同一可观测预滚状态）；
- 任一方为瞬时相位 `'buffering'`/`'seeking'`，且另一方**不是**终态（`'ended'`/`'error'`）；
  瞬时对终态仍是真实分歧。

## 6. 会话就绪度（session-status）

```ts
type SessionStatusMessage = {
  type: 'session-status';
  sessionId: string;
  ready: boolean;      // 仅当双方都已上报且一致性干净才为 true
  reason?: string;     // 'awaiting-second-participant' | 'actual-state-desync' | 'awaiting-actual-state'
  stateRevision: number;
  participants: SessionParticipantStatus[]; // { participantId, role, reported, consistent }
};
```

判定优先级（`[当前实现]`）：参与者 < 2 → `awaiting-second-participant`；否则**已上报且不一致**优先于
缺上报（诊断出的失配不得被伪装成 awaiting-actual-state）→ `actual-state-desync`；缺上报 →
`awaiting-actual-state`。`reported = 报告针对当前 revision`；`consistent` 取该报告的一致性结果。
广播去重：内容未变不重发。

## 7. 资源身份（协议视角）

- `ResourceIdentity = { adapterId, canonicalUrl, resourceId? }`；`canonicalUrl = origin + 去尾斜杠 pathname`（去 query/hash）。
- 结构守卫 `isValidResourceIdentity` 只要求：非空 `adapterId`、http(s) `canonicalUrl`、可选非空 `resourceId`。
  **刻意与站点无关**——任何站点的适配器产出的身份都被共享核心接受。站点策略的落地方式两个内置同步器不同：
  Bilibili 有共享站点守卫（`isBilibiliResourceIdentity`，`src/shared/protocol.ts`）在入口强制执行；
  YouTube 目前没有共享站点守卫——域名 + `/watch` 带非空 `v=` 的规则内联在 `YoutubeAdapter.identifyResource()`
  与 identity.js 注册条目中（两处同构）。`[建议约定]` 新增站点任选其一，但入口规则必须与 identity.js 的匹配规则同构。
- 相等 = 三字段全等（`isResourceIdentityEqual`）；指纹 = `adapterId \0 canonicalUrl \0 resourceId`。
- 身份在线上出现的位置：`join`（可选）、`join-request`（可选）、`resource-bind`（必需）、
  `actual-state`（必需）、`join-accepted.state` / `state` / `snapshot`（随 `PlaybackState`）。
  报告身份与会话身份不符 → `resource-mismatch`（诊断码 `actual-state-mismatch`）。

## 8. 错误码速查

| 来源 | code | 含义 |
|---|---|---|
| 服务端 `error` | `invalid-json` / `invalid-message` / `unknown-message` | 线上消息不合法/未知类型 |
| 服务端 `error` | `invalid-intent` | 意图结构非法 |
| 服务端 `error` | `not-joined` / `session-mismatch` | 未加入 / 会话不符 |
| 服务端 `error` | `not-host` / `no-pending-join` | 非 host 裁决 / 无待定加入者 |
| 状态机 `StateTransitionError` | `invalid-seek` / `invalid-rate` / `resource-unbound` / `session-mismatch` / `invalid-state` / `invalid-clock` / `invalid-intent` / `invalid-duration` / `invalid-session` / `invalid-resource-identity` | 见 §3.2 |
| 诊断 `diagnostic` | `desync` / `participant-left` / `actual-state-mismatch` | 一致性失配 / 参与者离开 / 资源身份失配 |
| 适配器 `AdapterSiteError` | `invalid-url` / `not-bilibili` / `browser-required` / `no-media` | 见 authoring.md §2；该 code 联合站点无关，内置 Bilibili/YouTube 共用（消息点名实际站点） |
| 注册表 `AdapterRegistryError` | `duplicate-adapter` / `duplicate-domain` / `invalid-registration` / `invalid-rule` | 见 authoring.md §1 |

`[建议约定]`：错误消息保持英文、稳定、可断言；`code` 是唯一机器可读契约，UI 不得解析消息文本。

## 9. 版本兼容与演进

**稳定的**（`[当前实现]`，变更即破坏）：
- 全部消息 `type`、字段名、`MediaPhase`/`IntentKind`/`applyResult` 取值、`ResourceIdentity` 结构；
- 状态机不变量：revision/sequence 单调、`resource-unbound` 拒绝、seek/rate 边界（`0.001` 容差、`16` 上限）；
- 一致性判定阈值与相位兼容规则（`250ms`、`1e-9`、ready≡paused、瞬时相位、终态晋升条件）。

**兼容的扩展路径**：
- 新增站点同步器**不需要任何协议变更**：身份守卫与 `resource-bind` 本就泛化（`isValidResourceIdentity`
  与站点无关）；这是当前协议为多站点预留的兼容通道（`[当前实现]`）。该通道已被第二个内置同步器
  **YouTube** 验证：`src/shared/protocol.ts` 未因 YouTube 新增任何类型/守卫，`resource-bind` 与一致性判定
  原样服务两个站点。
- 新增可选字段是线上兼容方式，先例：`join.roleHint` / `join.resourceIdentity` 缺省即旧客户端行为；
  守卫对可选字段“缺省即合法”写死。
- 能力声明是注册表元数据，增补为加性变更；重命名/删除属于破坏性变更。

**未来能力（不在当前线上）**：
- 会话状态持久化/恢复（核心已有 `restorePlaybackState`，服务端不落盘）；
- 多资源会话与非媒体标量（滚动/PDF 等）——需要新的身份/状态/一致性扩展，当前协议是
  “单资源、媒体相位”设计，不得绕过守卫伪造；
- 快照协商（`snapshot-request`）之外的增量/协商同步机制；

**提交纪律**（`[建议约定]`）：新增同步器不得修改 `src/shared/protocol.ts` 现有类型与守卫；
不得修改 `docs/old_designs/`；不得把本节约定的未来能力写成已实现（见 overview.md §5）。
