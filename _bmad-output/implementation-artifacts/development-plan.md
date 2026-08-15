# AnyTogether 首版开发计划

日期：2026-08-15
基线：`_bmad-output/planning-artifacts/any-together-requirements-spec.md`
实现规格：`_bmad-output/implementation-artifacts/spec-lan-bilibili-sync.md`

## 1. 技术与产品形态决策

### 1.1 当前技术栈

首版采用 **TypeScript + Node.js + WebSocket (`ws`) + Manifest V3 浏览器扩展**。

选择理由：

- 当前需求的核心难点是网页 DOM 控制和局域网同步，不是桌面壳；扩展是浏览器访问页面 DOM 的官方路径。
- Node.js 伴随进程可以监听局域网 TCP 端口，扩展不能直接监听端口。
- TypeScript 适合先快速固定跨端协议、状态机和适配器契约；当前仓库已有 Node/TypeScript 草稿，可直接修正而不是重建。
- `ws` 依赖少，真实 socket 集成测试容易在无第二台设备时复现。
- 未来 Rust+Tauri 重构只替换伴随进程和界面桥接；`protocol`、状态语义、`ResourceAdapter` 契约和验收场景不变。

### 1.2 首版界面边界

首版只实现一套用户入口：**MV3 扩展 + 本地 Node 伴随进程**。

- 扩展 popup：创建/加入会话、输入 IP、查看连接和同步状态、发送播放控制。
- 扩展 service worker：连接本地 Node 进程，转发会话消息，接收主机共享资源并打开 Bilibili URL。
- content script：在 `bilibili.com` 页面绑定 `BilibiliAdapter`，读取媒体状态、执行权威状态、报告原生事件。
- Node 进程：会话权威、命令顺序、状态版本、快照恢复、诊断和局域网监听。

不同时实现独立桌面 UI。核心模块不得依赖 `chrome.*`、DOM 或 popup；独立桌面应用和 Rust+Tauri 是后续替换界面/进程的兼容目标。

## 2. 现有基线与必须先修复的问题

- `tests/` 不存在，当前 `npm test` 必须补齐后才有意义。
- `tsconfig.json` 的输出根目录与 `package.json` 的 `dist/src/cli/*.js` 脚本路径必须统一。
- 现有 `SessionAuthority`、`SessionClient`、播放状态机是可复用草稿，但必须补齐快照间隙、实际状态报告、资源推送和诊断调用链。
- `BilibiliAdapter` 目前默认读取浏览器全局，单测必须通过注入页面对象，不能在 Node 环境隐式访问 `document`。
- 当前 `smoke-lan` 是同一进程内两个客户端；保留它作为 L1，新增独立进程 CLI smoke 作为 L2。

## 3. 对象与模块边界

### 核心层

- `SessionAuthority`：唯一权威状态、参与者上限、资源绑定、命令排序和广播。
- `CommandSequencer`：commandId 去重、单调 sequence/revision、确定性并发顺序。
- `SharedStateStore`：版本化共享状态和快照。
- `SyncCoordinator`：权威状态到本地适配器执行、位置校正和执行结果回报。
- `ConsistencyMonitor`：离散状态、资源身份、版本和播放漂移诊断。
- `SessionClient`：独立运行时连接、状态接受、版本间隙快照恢复。
- `SessionTransport`：只传控制/状态/诊断，不传媒体内容。

### 适配器层

- `ResourceAdapter`：资源身份、目标对象选择、状态读取、状态执行、原生事件和错误的语义契约。
- `BilibiliAdapter`：只负责 Bilibili 页面和 `HTMLMediaElement`；不排序命令、不保存会话权威状态。

### 界面桥

- `extension/background.js`：扩展与 localhost WebSocket 连接、tab 路由、资源 URL 打开。
- `extension/content.js`：页面媒体事件与控制执行；通过 runtime message 与 service worker 通信。
- `extension/popup.*`：用户操作和诊断展示；不直接操作媒体或协议状态。

## 4. 实施顺序

### Phase A：工程基线

1. 修正 `package.json`、`tsconfig.json`、输出路径和 Node engine 约束。
2. 增加公共协议验证和资源身份规范化测试。
3. 保持旧设计文档不变。

### Phase B：可证明的同步核心

1. 补齐纯播放状态机：播放、暂停、跳转、倍速、重播、位置投影和边界拒绝。
2. 修正权威服务器：资源校验、两人上限、命令去重、唯一顺序、快照、断开和错误。
3. 修正客户端：版本间隙恢复、旧状态拒绝、实际状态回报、诊断订阅。
4. 增加 Bilibili 适配器的页面注入 seam，保证 Node 单测可以注入 fake media。

### Phase C：浏览器扩展纵切

1. 添加 MV3 manifest，限制 Bilibili host 权限和 localhost 连接。
2. 实现 background/service worker 到 Node 伴随进程的 WebSocket 桥。
3. 实现 content script 到 background 的消息桥和 Bilibili 视频控制。
4. 实现 popup 的创建/加入、IP 输入、状态显示和核心控制。
5. 主机状态中的规范化 Bilibili URL 由从机扩展接收后打开/引导打开；资源身份校验通过后才进入同步态。

### Phase D：分层验证

- L0：纯状态单元测试，覆盖初始态、位置投影、操作边界和身份规范化。
- L1：同机真实 TCP/WebSocket 双客户端集成测试，覆盖加入、顺序、重复、版本间隙、资源不一致、第三人和断开。
- L2：两个独立 Node 进程运行 host/client CLI，输出可比较的最终 revision/state。
- L3：可选第二台设备通过本机 LAN IP 连接；记录真实防火墙/网络结果。没有第二台设备时不伪造该结论。
- L4：实际 Bilibili 页面验证目标视频、播放/暂停、currentTime、倍速、事件和失败报告。

## 5. 验收命令

```sh
npm run build
npm test
npm run smoke:lan
npm run smoke:process
```

每条命令必须退出码为 0。`npm test` 必须包含 L0/L1；`smoke:lan` 必须使用真实 socket；`smoke:process` 必须启动两个独立客户端进程。浏览器验证结果写入实现验证记录，不得用自动化单测冒充真实 Bilibili 页面验证。

## 6. 迭代上限与风险

每轮实现—验证迭代必须包含代码变更、构建/测试/冒烟验证和结果记录，最多 6 轮。真实第二设备不可用不阻塞 L0-L2/L4；无法验证的 L3 必须明确标记为未覆盖。登录、验证码、CSP、macOS 防火墙或 Bilibili 页面结构变化属于外部边界，不能伪造成功。
