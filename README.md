# AnyTogether

> LAN 内多人同步观看视频：一个 Node 伴随进程作为会话权威，浏览器扩展（MV3）在各自页面执行播放状态，所有参与者收敛到同一份权威播放状态。

AnyTogether 是一个**伴随进程 + 浏览器扩展**方案（当前**不是**独立桌面应用）：核心是 TypeScript/Node + WebSocket 的会话服务（host），参与者通过 CLI 客户端或 Chrome MV3 扩展加入，扩展在 Bilibili 视频页面上驱动 `HTMLMediaElement`，实现多人播放/暂停/跳转/倍速同步。

- 语言：TypeScript（Node >= 22），零框架依赖（仅 `ws`）
- 架构：`SessionAuthority`（权威状态机）+ `SessionClient`（独立客户端运行时）+ 页面 Adapter（站点播放器适配层）
- 状态：v0.1.0 垂直切片，LAN 双人同步可用

---

## 核心能力

- **权威状态机**：所有播放指令由 host 串行裁决，按序分配单调递增的 `stateRevision`，广播后全员收敛；重复指令幂等。
- **跨运行时同步**：CLI 客户端与浏览器扩展是同一套 wire protocol 的独立实现，行为一致。
- **页面适配器（Adapter）**：站点播放器逻辑隔离在 `ResourceAdapter` 契约之后，`identifyResource / selectTarget / readState / applyState / subscribe` 五个职责，不含任何 session/revision/command 语义。
- **动态 resource-bind**：会话可无资源启动（UNBOUND），首个 host join 或 `resource-bind` 消息动态绑定；客户端可在**不知道视频 URL** 的情况下加入，join 成功后自动采用会话资源并打开权威视频页。
- **无 URL 页面识别**：扩展侧有独立的浏览器 identity 注册表（`extension/identity.js`，全局 `AnyTogetherIdentity`），content/background 不重复任何站点域名逻辑。
- **一致性监控**：从机实际播放状态与权威状态持续比对，漂移（desync）显式诊断并上报，不静默接受未验证状态。
- **只传控制与状态，不代理媒体流**：每个参与者自己从视频站点拉流，网络中只交换控制消息。

## 当前支持范围

| 维度 | 现状 |
| --- | --- |
| 站点 | **Bilibili** 视频页（`/video`、`/video/BV…`）+ **YouTube** `/watch` 页（`youtube.com` 及子域，需非空 `v=` 参数）——内置两个 syncer（均完成 URL 注册与自动化测试，真实浏览器验证待补） |
| 浏览器 | Chrome / Chromium，Manifest V3（`extension/` 目录） |
| 平台 | macOS / Windows（Node 运行 host 与 CLI） |
| 会话规模 | 双参与者（MVP）：第一个加入者为 host participant，审批第二个加入者 |
| 网络 | 局域网（host 绑定 `0.0.0.0`）；无中继、无 NAT 穿透、无账号体系 |
| 命令能力 | `play` / `pause` / `replay` / `seek` / `set-rate`（`(0, 16]`）/ snapshot / 实际状态上报 |

> 注意：macOS / Windows 真实 Chrome 实机联调（Bilibili 与 YouTube）尚未完成验证，见[已知限制](#已知限制)。

## 工作原理

```
┌──────────────────────────── 一台机器（host） ────────────────────────────┐
│                                                                          │
│  node dist/src/cli/host.js                                               │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ SessionAuthority   (ws://0.0.0.0:8765)                             │  │
│  │  · 串行裁决 intents，维护权威 PlaybackState                        │  │
│  │  · stateRevision 单调递增，广播 / 快照恢复                          │  │
│  │  · 参与者审批、resource 绑定、一致性监控                            │  │
│  └───────────────┬────────────────────────────────────────────────────┘  │
│                  │                             Session API（只读）        │
│                  │                             http://127.0.0.1:8766      │
│                  │                             GET /api/session           │
│                  │                             GET /health                │
│                  └─────────────────────────── 本机扩展 host 模式自动获取    │
└──────────────────────────────────────────────────────────────────────────┘
        │ ws://<host-lan-ip>:8765 (sessionId, participantId)
        ▼
┌────────────────────┐        ┌────────────────────┐
│ 参与者 A（主机）     │        │ 参与者 B（从机）     │
│ CLI client 或扩展   │        │ CLI client 或扩展   │
│  - 页面 Adapter 驱动│        │  - 页面 Adapter 驱动│
│    站点播放器       │        │    站点播放器       │
│  - 提交 intents     │        │  - 应用权威状态      │
│  - 上报 actual state│        │  - 上报 actual state│
└────────────────────┘        └────────────────────┘
```

**数据流**：

1. host 启动 `SessionAuthority`（WebSocket 监听 `0.0.0.0:<port>`，默认 `8765`），并启动本机只读 Session API（默认 `127.0.0.1:8766`，`wsPort + 1`）。
2. 参与者在页面里自然播放/暂停/跳转/调速 → Adapter 观察原生 media 事件 → 客户端向 host 提交 `play / pause / seek / rate` 指令（intent），或上报从页面上读到的实际播放状态。
3. host 按到达顺序应用指令，`stateRevision + 1`，向所有参与者广播权威状态。
4. 客户端只应用比本地更新的 revision；发现 revision 缺口请求快照，无法恢复则显式报 desync。
5. 会话就绪（ready）需要双方加入、且双方回报的实际播放状态与当前权威状态一致（任一参与者未回报或诊断出 desync，会话即未就绪）；host 参与者的审批决定第二个参与者能否加入。

## 快速开始

### 前置要求

- **Node.js >= 22**（`package.json` `engines` 字段；运行时使用了 `Promise.withResolvers`）
- Chrome / Chromium（使用扩展时）
- 参与同步的机器需在同一局域网内

### 1. 安装

```bash
npm ci
npm run build   # 编译 TypeScript 到 dist/
```

### 2. 启动 host

```bash
npm run start:host                    # 默认端口 8765，无资源启动（UNBOUND）
npm run start:host -- 8765 https://www.bilibili.com/video/BV1xxxx/   # 指定端口 + 初始资源
```

`npm run start:host` 等价于 `node dist/src/cli/host.js`。支持的参数：

| 参数 | 说明 |
| --- | --- |
| `[port]` | WebSocket 监听端口，默认 `8765` |
| `[resource-url]` | 可选，Bilibili 视频 URL。省略时会话以 UNBOUND 启动，首个 host join 或 `resource-bind` 动态绑定 |
| `--session-id <id>` | 固定 session id（也支持 `--session-id=<id>`），省略时自动生成 UUID |
| `--auto-accept` | **仅限自动化 smoke 用**：第二参与者免审批加入。手动联调不要使用 |

启动后 host 会打印：

- `ws://127.0.0.1:<port>` 与本机局域网地址列表（`ws://<lan-ip>:<port>`）
- `sessionId`
- 本机 Session API：`http://127.0.0.1:<api-port>/api/session`（`GET /api/session` 返回 session 元信息，`GET /health` 返回健康检查）
- 供参与者复制的 join 命令：`node dist/src/cli/client.js ws://<address>:<port> <session-id> <participant-id> [bilibili-url]`

### 3. 加入会话（CLI 客户端）

在 host 之外的机器（或同机另一终端）：

```bash
node dist/src/cli/client.js ws://192.168.1.10:8765 <session-id> alice https://www.bilibili.com/video/BV1xxxx/
```

- 第 5 个参数（bilibili URL）**可选**：填 `-` 或不填表示无身份加入，join 成功后采用会话资源。
- 第一个加入的参与者自动成为 host participant；第二个加入者需要 host participant 在客户端输入 `accept` / `decline` 审批。
- 客户端是交互式 REPL，逐行输入命令（见[会话命令](#会话命令参考)），也可以一次性传多条命令（one-shot 模式，任何失败返回非零退出码）：

```bash
node dist/src/cli/client.js ws://192.168.1.10:8765 <session-id> alice https://www.bilibili.com/video/BV1xxxx/ play seek 30 rate 1.25 report
```

### 4. 使用浏览器扩展（MV3）

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录。
3. 打开一个支持的视频页（Bilibili 或 YouTube），点击工具栏的 **AnyTogether 播放同步** 图标：

   - **主机模式**：地址默认 `127.0.0.1`、端口 `8765`（与伴随进程一致），点击获取会自动从本机 Session API（`http://127.0.0.1:<port+1>/api/session`）读取 sessionId 并加入，当前标签页即被绑定为会话资源。host 进程打印的「Session 复制信息」可用于从机。
   - **从机模式**：填入主机分享的服务器地址（如 `192.168.1.10:8765`）、Session ID 与参与者名，加入后扩展自动打开权威视频页面并开始同步。

   扩展弹窗只显示连接状态与权威状态，**没有播放控制按钮**：原生播放器里的播放/暂停/跳转是唯一的指令来源（这是有意的设计）。

### 5. 一条命令自检

```bash
npm run smoke:process   # 拉起真实 host 进程 + 两个独立 CLI 客户端进程，驱动有序指令，验证收敛
npm run smoke:lan       # 进程内 authority + 两个独立 SessionClient，走真实 WebSocket 与局域网语义
```

## Mac / Windows LAN 使用

两台机器（或多终端）的完整流程：

1. **host 机器**：`npm ci && npm run build`，然后 `npm run start:host`。从打印的 `host: connect via ws://<lan-ip>:<port>` 里记下局域网 IP（如 `192.168.1.10`）与 `sessionId`。
2. **放行防火墙**：host 机器允许 Node 进程接受入站 TCP 连接（macOS 弹窗选择允许；Windows 首次运行在防火墙提示中允许专用网络）。客户端侧确认与 host 在同一子网。
3. **从机加入**：
   - 命令行：`node dist/src/cli/client.js ws://192.168.1.10:8765 <session-id> bob`（无 URL 加入，自动采用会话资源）。
   - 或浏览器扩展从机模式：填入 `192.168.1.10`、端口 `8765`、sessionId、参与者名。
4. **审批**：第二个参与者加入时，host participant 在客户端输入 `accept`（或扩展弹窗点「接受」）。
5. 双方就绪后，任一方在支持的视频页面（Bilibili / YouTube）播放/暂停/拖进度/调速，所有参与者同步。

注意：Session API（`8766`）只监听 `127.0.0.1`，是给本机扩展用的，不要也不会暴露到局域网；会话传输**没有加密与鉴权**，请只在可信局域网使用。

## 会话命令参考

CLI 客户端交互模式逐行输入：

| 命令 | 说明 |
| --- | --- |
| `play` / `pause` / `replay` | 提交播放/暂停/重播指令（不带参数） |
| `seek <seconds>` | 跳转到指定秒数（非负） |
| `rate <number>` | 设置倍速，`(0, 16]` |
| `snapshot` | 请求权威状态快照 |
| `report` | 将当前权威状态作为实际状态回报（CLI 无播放器，用于驱动会话就绪） |
| `accept` / `decline` | host participant 审批第二个加入者 |
| `quit` | 退出 |

## 同步器（Adapter）开发入口

新增站点同步器（syncer）不需要改 core：core 对站点一无所知，只通过 `AdapterRegistry` 路由。

| 文件 | 职责 |
| --- | --- |
| `src/adapters/resource-adapter.ts` | `ResourceAdapter` 契约：`identifyResource / selectTarget / readState / applyState / subscribe`，能力集 `AdapterCapability`，站点错误 `AdapterSiteError` |
| `src/adapters/adapter-registry.ts` | `AdapterRegistry`：`SyncerRegistration(adapterId, name, domain, urlRule, create, capabilities)`；同 `adapterId`/`domain` 冲突注册失败，未知 URL `resolve` 返回 `undefined` |
| `src/adapters/bilibili-adapter.ts` | 内置示例：`bilibili` syncer，`capabilities: ['play','pause','seek','set-rate','replay','native-events']` |
| `src/adapters/youtube-adapter.ts` | 内置 `youtube` syncer：注册 `youtube.com` 及任意子域（`www`/`m` 等）+ `/watch` URL 规则（需非空 `v=` 参数），identity 用 `watch?v=` 参数做 `resourceId`，能力集与 Bilibili 相同 |
| `extension/identity.js` | 浏览器侧 identity 注册表（全局 `AnyTogetherIdentity`）：新增 syncer 在这里注册域名 + URL 规则 + 身份推导 + 能力集，content/background 脚本无需改动 |
| `src/shared/resource.ts` / `src/shared/protocol.ts` | 资源身份（规范 URL = `origin + pathname`，BV id 作为 `resourceId`）与 wire 类型定义 |

开发一个新 syncer 的路径：在 `adapter-registry.ts` 里 `register` 一个新的 `SyncerRegistration`，实现 `ResourceAdapter`（可参考 `bilibili-adapter.ts`），并在 `extension/identity.js` 注册对应的浏览器侧条目。核心 session 语义、CLI 与扩展 UI 都不需要动。

## 测试

```bash
npm test
```

等价于 `npm run build && node --test dist/tests/core/*.test.js dist/tests/integration/*.test.js dist/tests/adapters/*.test.js`。当前基线 **133 项测试全绿（7 个套件）**，`smoke:lan` 与 `smoke:process` 通过，扩展 JS/Manifest 静态检查通过：

- `tests/core/`：播放状态纯函数——指令排序、幂等、position 投影、边界校验
- `tests/integration/`：两个独立 WebSocket 客户端连一个真实 socket 的权威会话、快照恢复、desync
- `tests/adapters/`：Adapter 契约与 Bilibili / YouTube 适配层（YouTube 使用 fake page 结构对象，不冒充真实浏览器验证）

集成测试全部走真实 TCP 端口与独立客户端实例，不依赖第二台物理设备。

## 已知限制

- **不是独立桌面应用**：当前必须依赖 Node 伴随进程 + 浏览器扩展；没有安装包、没有 GUI 壳。
- **站点覆盖**：内置 Bilibili 与 YouTube 两个同步器（源码实现 + 自动化测试覆盖）；其他站点按 syncer 注册表扩展（见上文「同步器（Adapter）开发入口」）。
- **真实环境验证**：macOS / Windows + 真实 Chrome 的跨机实机联调（Bilibili 与 YouTube）尚未完成；目前验证覆盖 Node 进程与自动化 smoke，页面侧依赖真实浏览器的部分请以实测为准。
- **会话规模**：MVP 固定双参与者；第三个参与者会被显式拒绝。
- **网络**：仅局域网直连；无中继/公网房间、无 NAT 穿透、无账号与鉴权，WebSocket 明文传输。
- **登录态**：Bilibili 可能对未登录页面有风控（如登录墙、验证码），影响页面侧实测；这是站点侧限制，不是协议问题。
- **弹窗无播放控制**：扩展只做状态同步与展示，播放操作在原生播放器里进行。

## 路线图

**已交付**：YouTube 同步器已随当前波次实现（`src/adapters/youtube-adapter.ts` + 扩展身份注册表 + manifest 作用域），自动化测试覆盖；真实 Chrome / 跨设备实机验证待补，见[已知限制](#已知限制)。

其余按优先级排序，均为**未来规划，尚未实现**：

1. **Rust + Tauri 桌面应用**：将伴随进程（host/CLI）编译为单一二进制，去掉 Node 依赖，提供原生托盘与设置界面——这是「独立桌面应用」的正式形态。
2. **更多社区平台**：基于同一 syncer 注册表扩展（扩展身份注册表与 Node 侧注册表同步演进）。
3. **公网房间与中继**：会话可发现、中继转发、可选鉴权——脱离 LAN 边界。
4. **多参与者**：突破双人 MVP，支持 N 人房间与分组权限。

## 贡献

欢迎 issue 与 PR。当前阶段建议先开 issue 讨论再提交大改动。规划与实现状态见仓库内文档（`docs/` 与 `_bmad-output/implementation-artifacts/`）。请勿修改 `docs/old_designs/`（历史设计归档）。

## License

许可证**尚未确定（TBD）**：项目当前为私有开发状态，发布前将补充开源许可证与对应的 LICENSE 文件。在此之前的代码使用请先联系维护者。
