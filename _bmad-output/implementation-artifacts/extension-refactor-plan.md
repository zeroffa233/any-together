# AnyTogether 扩展与同步器重构计划

## 用户决策

1. popup 不再提供播放、暂停、跳转、倍速按钮；播放控制完全来自页面原生播放器事件。
2. popup 提供主机/从机模式切换；每种模式只展示必要字段。
3. 主机地址固定为 `127.0.0.1`，不要求手动输入本机 IP。
4. 主机通过本机 HTTP API 获取 Session ID，并提供复制会话信息入口。
5. 全链路移除手动视频 URL；适配器从当前支持页面读取 URL 和资源身份。
6. 同步器采用可注册、多态、域名规则匹配的统一抽象；增加同步器不得修改同步核心。

## 形态

首版仍为 MV3 扩展 + Node 伴随进程。Node 进程只负责会话和 API；扩展页面负责当前页面资源识别和原生媒体控制。独立应用/Rust+Tauri 将来复用相同协议、同步核心和同步器注册契约。

## 用户流程

### 主机

- 启动 Node 伴随进程。
- popup 默认模式为“主机”，服务器地址固定 `127.0.0.1`，端口默认 `8765`。
- popup 请求 `http://127.0.0.1:<apiPort>/api/session`，填入 Session ID 和可复制的连接串。
- 主机在当前支持页面连接；当前页面 URL/域名由同步器自动识别并绑定为会话资源。
- 主机收到第二参与者请求后，只在 popup 显示接受/拒绝，不提供媒体控制按钮。

### 从机

- 切换到“从机”模式。
- 只填写主机地址、端口和会话串/Session ID；不填写 URL。
- 连接后接收主机资源身份，扩展在当前或新 tab 打开目标页面。
- 页面同步器自动注册，报告资源和媒体就绪状态。

## 协议变更

- `ClientJoin` 增加 `roleHint: host | client`，仅表达用户意图；权威端仍决定实际角色。
- `SessionAuthority` 支持无初始资源；首个 host 页面通过 `resource-bind` 绑定当前资源。
- 新增 `ResourceBindMessage`，只有 host 参与者可发送；绑定新资源时重置播放状态、递增资源版本并广播。
- Session API 返回 `sessionId`、WebSocket 地址、端口、角色状态和当前资源（可为空）。
- popup 只消费连接状态、就绪状态、加入请求、诊断和只读播放状态。

## 同步器注册契约

```ts
export type SyncerRegistration = {
  adapterId: string;
  match: RegExp[];                 // URL/域名规则，注册时校验唯一性
  create(page: SyncerPage): ResourceAdapter;
  capabilities: readonly string[];
};

export interface AdapterRegistry {
  register(registration: SyncerRegistration): void;
  resolve(url: string): SyncerRegistration | undefined;
  assertNoOverlappingDomain(adapterId: string): void;
}
```

`ResourceAdapter` 继续负责当前页面的资源身份、目标媒体选择、状态读取、状态执行和原生事件订阅。注册表负责“哪个页面由哪个同步器处理”；SessionAuthority 不依赖 DOM 或具体网站。

Bilibili 首个注册项：匹配 `*.bilibili.com`，资源身份由当前页面 URL 派生，能力为 play/pause/seek/set-rate/replay/native-events。

## 文件级实施顺序

1. `src/shared/protocol.ts`：roleHint、resource-bind、可空初始资源的消息守卫。
2. `src/server/session-authority.ts`、`src/cli/host.ts`：动态资源绑定和 localhost Session API。
3. `src/adapters/adapter-registry.ts`、`src/adapters/resource-adapter.ts`、`src/adapters/bilibili-adapter.ts`：注册契约和 Bilibili 注册。
4. `extension/identity.js`：浏览器侧统一注册表/身份识别。
5. `extension/background.js`、`extension/content.js`：当前页面绑定、主机换资源、原生事件链路。
6. `extension/popup.html`、`extension/popup.js`：模式切换、最小配置、Session 复制、只读状态。
7. 更新测试：主从、无 URL、resource-bind、API、注册冲突、页面重开和原生事件。

## 明确不做

- popup 播放控制；
- 手动输入视频 URL；
- 为每个网站复制一套同步核心；
- 自动公网发现、NAT、账号、聊天、媒体代理；
- 本轮实现独立桌面壳。
