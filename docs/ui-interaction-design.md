# AnyTogether 扩展 Popup 交互与视觉规格

> **交付对象**：重写 `extension/popup.html` / `extension/popup.js` 的开发 Agent。本文只定义 popup 的可见交互与呈现，不改协议、不增加媒体控制。
>
> **状态来源**：连接生命周期来自 background 的 `status`（`disconnected | connecting | connected | error`）；会话就绪来自 `session-status`；资源/播放来自 `state`；异常来自 `diagnostic`。Popup 只读展示权威状态，不自行推断或修改播放状态。
>
> **诚实边界**：本文是实现规格，不代表已完成真实 Chrome 加载、双设备局域网或 Windows/macOS 实机验证。标为「未来能力」的内容不得在本轮伪装成已实现。

## 1. 产品边界与 HCI 不变量

- Popup 只有一个会话；主机/从机是**互斥**的单选模式，不能同时连接或在活动连接中切换角色。切换活动角色必须先断开。
- 选择的角色只作为 `join.roleHint`（用户意图），**实际角色永远以 `join-accepted.role` 为准**。界面必须显示实际分配结果，不得把选中的 radio 当作已获角色。
- 本次角色收敛规则：首位参与者带 `roleHint: client` 时拒绝；已有 host 时带 `roleHint: host` 的加入请求拒绝。旧客户端省略 `roleHint` 时保留“先到者为 host”的兼容行为。错误文案按稳定 `code/reason` 映射，不能解析服务端英文 `message`。
- Connect/加入、接受、拒绝均为不可重复提交操作：提交瞬间锁定按钮；响应或明确失败后才恢复。不能通过快速双击建立两个 socket 或发出两个审批。
- 不提供播放、暂停、跳转、倍速、重播或“控制播放器”按钮；不提供手动视频 URL 输入。播放操作只能发生在页面原生播放器，popup 只读显示其权威投影。
- 当前支持资源为 Bilibili 视频页（`/video`）和 YouTube 视频页（`/watch?v=...`）。页面通过同步器按当前 tab 自动识别；popup 不要求用户输入 URL。其它站点只可显示未支持/未绑定，不得声称可同步。
- 会话最多两名参与者（host + client）。资源身份可暂时为 `null`；收到 host/client 的 `resource-bind` 后，权威资源切换会覆盖双方当前/可复用的视频 tab，避免重复窗口和叠加声音。

## 2. 信息架构

Popup 首屏按“现在发生什么 → 下一步做什么 → 细节是什么”排列：

1. **Header**：AnyTogether、当前实际角色（未连接时不显示实际角色）、“更多/设置”按钮。
2. **模式与最小配置卡**：主机/从机单选及本模式必需字段。
3. **连接状态带**：状态图标、文字、辅助原因；唯一首要 CTA；断开为次要 CTA。
4. **加入审批卡（条件显示）**：仅 host 有待审批请求时出现。
5. **参与者列表**：最多两行，展示实际 `participantId`、实际 `role`、当前 revision 的回报/一致性。
6. **当前资源与播放只读卡**：站点/适配器、canonical URL、媒体 phase、位置/时长/速率、revision。
7. **通知区**：一次一个可恢复的 notice/error，使用 `aria-live`。
8. **更多/设置二级面板**：诊断抽屉、连接详情、分享串详情；不放连接首要 CTA，不放任何播放控制。

### 2.1 组件树

```text
popup
├─ header
│  ├─ brand
│  ├─ actual-role-badge (connected 后)
│  └─ more-button (aria-label="更多设置")
├─ config-card
│  ├─ role-radio-group (host / client，互斥)
│  ├─ host-fields (host 模式)
│  │  ├─ companion-address (readonly: 127.0.0.1)
│  │  ├─ websocket-port (默认 8765)
│  │  ├─ session-id (本机 API 读取后的 readonly 展示)
│  │  ├─ refresh-local-session (次要)
│  │  └─ copy-share (次要)
│  ├─ client-fields (client 模式)
│  │  ├─ host-address
│  │  ├─ websocket-port (默认 8765)
│  │  └─ session-id
│  └─ participant-id (optional；留空由 background 生成)
├─ connection-banner
│  ├─ status-icon + status-label + status-description
│  └─ primary-action / disconnect-action
├─ join-approval (host + pendingJoin 时)
│  ├─ requester-id
│  ├─ requester-resource (可选 canonical URL)
│  └─ accept / reject
├─ participants-card
│  ├─ participant-row (0..2)
│  └─ waiting-placeholder
├─ resource-card
│  ├─ resource-binding
│  ├─ media-phase
│  ├─ playback-readonly
│  └─ native-player-hint
├─ inline-feedback (notice/error)
└─ secondary-panel (closed by default)
   ├─ diagnostic-drawer
   ├─ connection-details
   └─ share-details
```

## 3. 视觉系统 Token

实现必须先定义 CSS custom properties，再由组件引用；禁止组件内散落颜色、任意间距或硬编码状态色。

```css
:root {
  --color-bg: #f4f7fa;
  --color-surface: #fffefa;
  --color-surface-muted: #edf2f5;
  --color-text: #1d2730;
  --color-text-muted: #5d6a75;
  --color-border: #d3dce3;
  --color-accent: #0b6e99;
  --color-accent-strong: #085a7e;
  --color-positive: #28764c;
  --color-warning: #8c611d;
  --color-danger: #a34242;
  --color-info: #356b8a;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --radius-control: 6px;
  --radius-panel: 8px;
  --radius-pill: 999px;
  --shadow-panel: 0 2px 10px rgb(29 39 48 / 8%);
  --focus-ring: 0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-accent);
}
```

- **尺寸**：标准 popup 宽 360px；可用范围 320–420px。基础间距只用 4/8/12/16/20/24px；面板内边距 16px，面板间距 12px。
- **排版**：沿用系统中文字体栈（`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`）；标题 16px/600，正文 13px/1.45，辅助 12px/1.4，标签 12px/600。时间、端口、revision 使用等宽数字或 `font-variant-numeric: tabular-nums`。
- **形状**：卡片 8px，输入/按钮 6px，状态徽章可用胶囊；边框 1px。只用轻微阴影区分层级，不使用渐变、玻璃效果或纯黑/纯白。
- **控件**：按钮最小高度 36px，按钮之间至少 8px；主按钮使用 accent，次按钮为表面色，危险断开使用文字/边框层级而非大面积红底。
- **图标**：图标容器统一 28×28px（项目标准），状态 glyph 16px；状态同时有 glyph、文字和辅助句，不得只靠颜色表达。示例：✓ 已就绪、⋯ 连接中、! 需要检查、× 连接失败。
- **焦点/禁用**：所有可操作元素有可见 `--focus-ring`；禁用态降低对比度但仍可读，不能仅用 `opacity: 0.4` 隐藏文字。

## 4. 最小配置与首要 CTA

### 4.1 主机模式

| 字段 | 展示与行为 |
|---|---|
| 模式 | “主机 / 从机” radio，默认主机；互斥。连接活动时锁定。 |
| 地址 | `127.0.0.1` 只读，文案“本机伴随进程”；不可让用户改成本机 IP。 |
| 端口 | 默认 `8765`；沿用当前 WS 端口，合法范围 1–65535。Session API 使用 WS 端口 + 1，由 background 查询。 |
| Session ID | 通过 `GET /api/session` 从本机伴随进程获取；为空时显示“正在读取本机 Session…”。不要求用户输入 URL。 |
| 参与者 ID | 可选；留空显示“自动生成”，不要阻塞连接。 |
| 首要 CTA | 未连接为“连接并创建会话”；输入合法性通过后立即锁定为“连接中…”。 |
| 分享 | Session ID 可见后显示“复制分享串”。成功提示“已复制，可发送给从机”；复制失败保留可选中的分享串和“请手动复制”。 |

分享串必须保持当前 background 生成的形态：

```text
anytogether://session?host=<host>&port=<wsPort>&session=<sessionId>
```

本轮 client 仍以 host、port、Session ID 三项加入；**解析整段 `anytogether://` 并自动填充字段属于未来能力**，除非实现了对应 parser，不得在 UI 宣称“粘贴分享串即可加入”。

主机当前 tab 不是支持的视频页时，连接仍可建立但资源可能为 `null`；资源卡明确显示“尚未绑定资源，请在支持的视频页打开/刷新”，不得在 popup 添加 URL 输入框。

### 4.2 从机模式

| 字段 | 展示与行为 |
|---|---|
| 模式 | 选择“从机”；实际加入成功后仍以 authority 回传 role 为准。 |
| 主机地址 | 必填；接受 hostname/IP，不偷偷改写为 localhost。 |
| 端口 | 默认 `8765`，范围 1–65535。 |
| Session ID | 必填；使用主机分享的 Session ID。保留 host/port/session 三项以匹配当前协议与 background。 |
| 参与者 ID | 可选；留空由 background 生成。 |
| 首要 CTA | 未连接为“加入会话”；提交后显示“正在连接主机…”，锁定重复提交。 |
| 本机获取/复制 | 隐藏；client 不读取本机 Session API，也不生成分享串。 |

从机 join 不携带视频 URL/资源身份；加入成功后接受权威 `state.resourceIdentity`，background 在当前或可复用 tab 打开目标页面。页面尚未就绪时显示等待状态，不提供“打开 URL”替代入口。

### 4.3 角色冲突与实际角色

- 空会话 + `roleHint=client`：显示错误“此会话需要先由主机创建，请在创建者设备选择主机”，保留填写内容，CTA 为“切换为主机”或“重试”；不自动把 client 改成 host。
- 已有 host + `roleHint=host`：显示“此会话已有主机，请切换为从机”，保留 Session ID；不自动降级为 client。
- `join-accepted.role` 与选择不同：显示一次确认性 notice“已按会话权威分配为主机/从机”，实际角色徽章和后续权限只使用回传 role。
- legacy join 缺少 `roleHint`：维持协议兼容；首位仍显示 host，第二位显示 client。Popup 自身的新请求总是发送当前选择的 hint。

## 5. 连接呈现状态机

这是**popup 展示状态**，不是新增 wire enum。状态计算按以下优先级：

1. `background.status === error` → `error`；
2. 未连接/连接中 → `disconnected` / `connecting`；
3. `session-status.reason === actual-state-desync`，或最新 `diagnostic.code` 为 `desync | actual-state-mismatch`，或权威 phase 为 `error` → `degraded`；
4. `session-status.ready === true` → `ready`；
5. 已连接但 `ready === false`（包括等待参与者/等待实际回报）→ `waiting`；
6. 已连接且尚未收到 `session-status` → `connected`。

| Popup 状态 | 进入条件 | 主文案与辅助文案 | 操作 |
|---|---|---|---|
| `disconnected` 未连接 | 明确断开、无活动 socket | “未连接” / “选择角色并填写必要信息” | 主按钮：主机“连接并创建会话”，从机“加入会话” |
| `connecting` 连接中 | API 读取、WS 建连、等待 join 结果 | “连接中…” / “请保持此窗口打开，正在完成加入” | 主按钮禁用；模式和配置锁定；不重复提交 |
| `connected` 已连接 | join accepted 后、尚未有就绪快照 | “已连接” / “正在读取会话状态” | 只显示“断开”次要按钮；自动进入 waiting/ready/degraded |
| `waiting` 等待就绪 | ready=false 且 reason 为 `awaiting-second-participant` 或 `awaiting-actual-state` | 按 reason 显示“等待第二位参与者加入”或“等待双方回报当前页面状态” | 不提供播放控制；参与者/资源卡解释缺什么 |
| `ready` 已就绪 | `session-status.ready === true` | “已就绪” / “双方状态一致；播放请使用视频页原生播放器” | 只读；“断开”为次要操作 |
| `degraded` 需要检查 | 诊断失配、资源/适配器不一致或权威 phase=error | “需要检查同步” / 展示具体诊断摘要，不用“正常”掩盖失配 | 保留连接；打开诊断抽屉查看 expected/actual；必要时按页面提示恢复 |
| `error` 连接失败 | 本机 API、WS、join reject 或不可恢复连接错误 | “连接失败” / 稳定 reason 的可操作中文说明 | 主按钮“重试连接”；保留字段；必要时另有“切换模式”；不能显示假装已连接 |

### 5.1 状态转移

```text
disconnected --连接/加入--> connecting
connecting --join accepted--> connected
connecting --API/WS/join 失败--> error
connected --ready=false--> waiting
connected --ready=true--> ready
waiting --ready=true--> ready
waiting --actual-state-desync/diagnostic--> degraded
ready --actual-state-desync/diagnostic/phase=error--> degraded
degraded --新的 ready=true--> ready
waiting|ready|degraded|connected --用户断开/明确 socket close--> disconnected
error --重试--> connecting
```

- “连接中”到“connected”必须以 join accepted 为界，不以按钮点击或 WS `open` 单独冒充成功。
- 断开是幂等操作；断开后清除只读状态展示，但保留可重试的配置字段。Popup 重开必须从 `get-status` 恢复 background 的真实状态、host、port、Session、participant 和资源字段。
- unexpected close 若 background 已保留 `error`，UI 显示 error；明确 `disconnect` 后显示 disconnected。不要在 popup 自己猜 socket 状态。

## 6. 条件区块与只读信息

### 6.1 参与者列表

- 标题“参与者（n/2）”；`n` 取 `session-status.participants.length`，不根据颜色或本地按钮推断。
- 每行：28px 状态图标、`participantId`（超长省略但可通过 title/可访问名称读取）、实际角色“主机/从机”、本机标记、当前 revision 的回报状态。
- `reported=false` 文案“等待页面回报”；`reported=true && consistent=true` 文案“已回报，一致”；`consistent=false` 文案“需要检查”。三者必须有文字/图标，不得只上色。
- 0/1 人时显示占位行“等待另一位参与者加入”；不将 pending joiner 伪装成已加入参与者。
- 参与者离开时从列表移除，诊断抽屉保留最新 `participant-left`；状态回到 waiting（等待第二位参与者），而不是显示 ready。

### 6.2 加入审批

仅 host 且收到 `join-request` 时显示在状态带下方，包含请求者 participantId；如果请求携带 resourceIdentity，显示站点和 canonical URL，否则显示“未提供视频”。

- 首句：“有人请求加入此会话”。不要把请求者称作已加入成员。
- “接受”为主按钮，“拒绝”为次按钮；点击任一按钮立即锁定两个按钮并显示“正在处理…”。
- 成功后卡片消失，列表等待 `session-status` 更新；失败显示可重试错误且不擅自清除请求。Popup 重开从 background 的 `pendingJoin` 恢复审批卡。
- client 不显示审批按钮；在 connecting 中显示“等待主机审批”。

### 6.3 当前资源与播放只读卡

卡片标题“当前资源”，无资源时显示空态：

> 尚未绑定资源。主机请在支持的 Bilibili/YouTube 视频页打开或刷新；从机将等待主机共享资源。

有资源时展示：

- 站点/适配器：由 `resourceIdentity.adapterId`（当前 `bilibili` / `youtube`）映射；未知 adapterId 显示其稳定 id，不宣称站点名称。
- canonical URL：可换行、可复制选择；不提供编辑和手动导航按钮。
- 播放快照：`mediaPhase`（加载中/就绪/播放中/已暂停/跳转中/缓冲中/已结束/错误）、投影位置 / 时长、倍速、`stateRevision`。
- `durationSeconds=null` 显示“时长未知”，不是 0；播放中位置按权威 `positionAtMs` 投影更新，不能冻结成旧值。
- 统一提示：“播放、暂停、拖动和倍速请在视频页原生播放器操作；popup 不控制播放器。”
- `error` phase 显示可读错误和“打开诊断”入口；`buffering`/`seeking` 是媒体瞬时 phase，不单独伪装成传输断线。

## 7. 诊断、设置与二级披露

Header 的“更多设置”打开同一 popup 内的面板（窄宽度时全宽覆盖），默认关闭；Escape 关闭并把焦点还给触发按钮。

### 7.1 诊断抽屉

抽屉只读展示 background 保存的**最新一条** `diagnostic`，没有历史列表的暗示。字段按人类可读顺序：

1. 严重性图标 + `code` 映射：`desync`（状态不同步）、`actual-state-mismatch`（资源/适配器或实际状态不匹配）、`participant-left`（参与者离开）。
2. 参与者、`stateRevision`、detail。
3. expected / actual：phase、位置、倍速；若有 `resource`，分别显示 expected/actual adapter 与 canonical URL。
4. 恢复建议：重新确认双方在正确资源页、等待页面回报；连接级错误使用“重试连接”。建议不能声称 popup 已替用户修复。

`session-status.reason` 显示为辅助诊断：`awaiting-second-participant`、`awaiting-actual-state`、`actual-state-desync`；不要把 machine code 丢失在泛化的“未知错误”中。

### 7.2 连接详情与设置

二级面板可展开“连接详情”：实际 role、Session ID、host、WS port、API 地址（host 模式为 `http://127.0.0.1:<port+1>/api/session`）、participantId。Session ID 和分享串使用只读可选中文本。设置不提供新的网络发现、账号、聊天、媒体代理或 URL 输入。

- **当前实现**：连接/断开、Session 获取与复制、参与者审批、只读状态/phase/position/diagnostic。
- **未来能力**：整段分享串一键解析、多于两名参与者、多资源会话、滚动/PDF 等非媒体同步、自动公网发现/NAT、账号和聊天。未有协议与实现前只可作为 disabled 的“未来”说明，不能出现在首要 CTA。

## 8. 空、加载、错误与恢复文案

| 场景 | 必须看到 | 可恢复动作 |
|---|---|---|
| Popup 初次打开 | 骨架或“正在读取会话状态…”；不闪现假的未连接配置 | 完成 `get-status` 后以 background 快照渲染 |
| Host 读取本机 Session | “正在读取本机 Session…” | “重试读取”；提示确认伴随进程与端口，不伪造 Session ID |
| Host API 不可用 | “无法读取本机 Session。请确认伴随进程已启动（本机 API 端口为 WS 端口 + 1）。” | 保留端口，重试；不要把 host 改成 client |
| Client 缺少必要字段 | 在对应字段下显示必填错误；焦点移到第一个错误 | 修正后再次加入 |
| Client 等待审批 | “已连接，等待主机审批” | 保持连接或断开重试；不显示接受/拒绝 |
| Session full / host declined / host unavailable | 显示协议 `reason` 的稳定中文映射，说明可切换角色或重试 | 重试、切换为从机、向 host 请求新 Session；不清空用户输入 |
| 不支持/未绑定资源 | resource 空态说明支持站点和当前页自动识别 | 在视频页打开/刷新；不输入 URL |
| 诊断失配 | “需要检查同步” + code/detail + expected/actual | 打开诊断；返回视频页确认资源和原生状态 |
| 明确断开 | “未连接”，清除旧资源/播放快照 | 重新连接/加入 |

错误与 notice 分开：错误使用 `role=alert`（需立即注意），一般复制成功/等待使用 `role=status`；文字包含下一步，不只显示“失败”。

## 9. 键盘、窄 popup 与可访问性

- DOM 焦点顺序固定：Header 更多 → 角色 radio → 当前模式字段 → 分享/本机获取 → 首要 CTA → 断开 → 审批 → 二级内容。隐藏区块不进入 tab 顺序。
- 所有 input 有可见 label；placeholder 不是唯一标签。radio 用原生 `fieldset/legend`；按钮用真实 `button`，不使用可点击 `div`。
- Enter 在配置表单中触发当前唯一首要 CTA；连接中/字段无效时不重复提交。Escape 关闭二级面板；关闭后焦点回到更多按钮。Tab 不得被抽屉困住。
- 状态带使用 `role=status`，状态变化文本可被屏幕阅读器读取；错误使用 `aria-live=assertive`；图标有 `aria-hidden=true`，语义在文字中。
- 色彩对比达到 WCAG AA；所有状态同时呈现 icon + label + 句子。焦点环不被 overflow 裁掉；禁用按钮仍能被读出原因（可用 adjacent hint）。
- 窄宽度（<340px）：单列布局，配置字段纵向堆叠；主/次按钮全宽上下排列；canonical URL 和诊断 detail 换行；参与者行允许两行；不产生横向滚动。首屏保留状态带、首要 CTA、参与者摘要，连接详情移入二级面板。
- 关闭动画或 `prefers-reduced-motion: reduce` 时，spinner 退化为静态“连接中…”；不使用依赖悬停才能发现的功能。

## 10. 开发验收清单

### 信息与协议一致性

- [ ] 组件树和首屏顺序与第 2 节一致；主机/从机字段没有互相泄漏。
- [ ] 主机地址固定 `127.0.0.1`，端口默认 8765；host 从本机 `/api/session` 获取 Session ID；client 不读取本机 API。
- [ ] 不存在手动视频 URL 输入；host 可从当前支持页面自动绑定，client 接收权威资源并沿用当前 tab/可复用 tab。
- [ ] 角色 radio 互斥；发送 `roleHint`，实际徽章使用 `join-accepted.role`；覆盖首位 client、已有 host 的 host hint 拒绝及 legacy 缺省 hint 兼容文案。
- [ ] 状态实现完整覆盖 disconnected、connecting、connected、waiting、ready、degraded、error，并按 `status/session-status/state/diagnostic` 的优先级渲染。
- [ ] Connect、断开、接受、拒绝均不可重复提交；popup 重开从 `get-status` 恢复真实连接与只读字段。

### 视觉与 HCI

- [ ] 所有颜色、间距、字号、圆角来自 token；无纯黑/纯白、渐变、魔法像素或组件内硬编码状态色。
- [ ] 每个状态同时有图标、文字和辅助说明；列表不以颜色单独表达 reported/consistent。
- [ ] 参与者最多两人，pending join 不冒充已加入；审批卡只对 host 显示。
- [ ] 资源/播放卡全程只读，显示 phase、投影位置、时长、速率、revision；明确播放控制在原生视频页完成。
- [ ] 诊断抽屉只展示最新 diagnostic 的 code/detail/expected/actual；未提供不存在的自动修复或真实 Chrome 验证结论。
- [ ] 空、加载、API/WS/join 失败、未绑定资源、等待审批、断开均有明确可恢复路径。
- [ ] 键盘顺序、focus ring、Enter/Escape、aria-live、窄 popup（320px 起）均可用且无横向滚动。

### 明确禁止

- [ ] popup 没有播放/暂停/跳转/倍速/重播/立即控制播放器按钮。
- [ ] popup 没有手动 URL 输入、自动公网发现、账号、聊天、媒体代理、多资源控制。
- [ ] 不把 `roleHint`、`session-status.ready`、颜色或本地按钮状态当作权威角色/播放状态。
