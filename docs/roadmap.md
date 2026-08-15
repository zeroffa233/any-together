# AnyTogether 资源路线图（Phase 0–4）

> 本文档把用户确认的资源路线（Bilibili/video 稳定性 → URL/网页资源简单同步 → 本地视频局域网广播 → arXiv PDF 滚动/缩放 → RSSHub-like syncer 社区）细化为可执行路线。每阶段写明目标、用户流程、核心模型变化、适配器扩展、验收、风险、非目标和进入条件，并统一解释游标/标量/共享状态/在场态抽象。
>
> 状态标记：`[已落地]` 仓库当前已实现并通过验证；`[进行中]` 当前交付波次正在实现；`[未开始]` 尚未排期实现；`[需评审]` 需求或技术方案尚未定案，落地前必须评审。
>
> 本文档不承诺时间表。所有"完成状态"以仓库实际验证记录为准，不把未来能力写成当前已实现。

## 0. 文档间关系

| 文档 | 作用 |
|---|---|
| `_bmad-output/planning-artifacts/any-together-requirements-spec.md` | 首版需求基线（FR/NFR/AC），本路线图的语义权威 |
| `_bmad-output/implementation-artifacts/development-plan.md` | 首版开发计划与验证分层（L0–L4） |
| `_bmad-output/implementation-artifacts/spec-lan-bilibili-sync.md` | Bilibili 局域网同步实现规格 |
| `docs/syncers/overview.md`、`docs/syncers/authoring.md`、`docs/syncers/protocol.md` | 同步器规范（本波次交付）：边界、编写指南、线协议与一致性语义。当前规范只覆盖媒体（MediaPhase/playhead/playbackRate/duration，单资源每会话）；非媒体标量（滚动/PDF）在其中标记为未来能力，与本文档 Phase 3 对齐 |
| `docs/old_designs/1.md`、`docs/old_designs/2.md` | 仅用于反推需求边界，不是技术路线依据，禁止修改 |
| `docs/index.html` | 社区介绍首页（本波次交付），Phase 4 社区形态的种子 |

## 1. 现状基线（Phase 0 起点，全部 `[已落地]`）

- **核心**：TypeScript + Node.js + `ws`。`SessionAuthority`（创建者权威、双人上限、命令去重、单调 sequence/stateRevision、快照防回退、资源身份校验、host-only resource-bind、就绪判定、漂移诊断）；`SessionApi`（只读 `GET /api/session`、`/health`，仅监听 127.0.0.1）；`playback-state` 纯状态机（媒体状态机、位置投影 `projectPlaybackPosition`、`isPhaseAdvancing`）。
- **CLI**：`host.ts`（默认端口 8765、`--session-id` 固定会话 ID、无 URL 启动为未绑定、枚举局域网地址、`--auto-accept` 仅供自动冒烟）；`client.ts`（`ws://<address>:<port> <session-id> <participant-id> [bilibili-url]`）；`smoke-lan`（同机双客户端真实 socket）、`smoke-process`（两个独立进程）。
- **适配器层**：`ResourceAdapter` 语义契约（identifyResource/selectTarget/readState/applyState/subscribe；不存 session/revision/command）；`AdapterRegistry` + `SyncerRegistration`（adapterId/name/domain/urlRule/create/capabilities；同 adapterId/domain 冲突注册失败；未知 URL resolve 为 undefined；最长域名匹配优先）；`BilibiliAdapter`（仅 `/video` 页面，最大可见候选确定性选择，phase 映射，seek 收敛轮询，buffering 跟踪）、`YoutubeAdapter`（`youtube.com` 及任意子域 `/watch` 页面，`v=` 参数作为 resourceId，能力集与 Bilibili 相同）。
- **扩展**：MV3。`identity.js` 是浏览器侧唯一身份注册表（register/resolve/deriveIdentity/identityEqual/isSupportedUrl/list，内置 bilibili 与 youtube 注册项，BV 号 / watch `v=` 参数作为 resourceId）；`background.js` 服务worker（本机 API 取会话信息、tab 路由覆盖当前页、串行 apply 管线、客户端就绪后同 tab 自动刷新一次、keepalive、新窗口接管）；`content.js` 页面代理（SPA 安全 refresh 循环、700ms 意图回声抑制、实际状态回报、有界漂移上报）；`popup` 只做主从模式/连接/审批/只读状态，无播放控制按钮，无手动 URL 输入。
- **验证现状**：`npm test` 全绿（133 项 / 7 套件：playback-state、session-authority、dynamic-resource、bilibili-adapter、youtube-adapter 五套文件），`smoke:lan` 与 `smoke:process` 通过，扩展 JS/Manifest 静态检查通过；真实 Bilibili 页面（BV1mkgw6mEQt）已验证媒体元素可控性（记录于需求规格 §14）。YouTube 同步器源码已实现且自动化测试覆盖，但真实浏览器 / 跨设备实机验证尚未执行（见 5.5 未闭环项）。
- **未验证缺口**：真实双设备局域网端到端（L3）、Chrome 扩展真实加载端到端、macOS 防火墙/Windows 实机行为——这些在 Phase 0 验收中必须补齐或明确豁免记录。

## 2. 统一抽象：游标 / 标量 / 共享状态 / 在场态

AnyTogether 不是"视频同步框架"，而是"网页资源同步框架"。可同步项按两个正交轴分类，同步算法由分类决定，而不是由具体站点决定。

### 2.1 轴一：语义类型 —— 游标（playhead）vs 标量（scalar）

| | 游标 playhead | 标量 scalar |
|---|---|---|
| 本质 | 一个随时间自动推进的位置 + 是否自动前进 | 一个不随时间自动推进的值 |
| 例子 | 视频/音乐进度、网页滚动进度、电子书/PDF 页码、直播时移 | 滚动位置（不自动前进时）、缩放、音量、倍速 |
| 同步算法 | 必须延迟补偿 + 漂移检测 + 追赶：收到"3:05"时实际已是 3:05.2 | 直接设值即可，无需时间补偿 |
| 投影函数 | `f(t) = position + rate·(t − t0)` | `f(t) = position`（rate 恒为 0 的特例） |
| 当前代码落点 | `PlaybackState.positionSeconds + positionAtMs` 成对出现、`projectPlaybackPosition`、`isPhaseAdvancing`、ConsistencyMonitor 漂移阈值 | 尚无（Phase 3 首次落地） |

统一视角：**标量是 rate 恒为 0 的游标**。若协议把"是否自动推进"变成适配器声明的语义属性，排序/版本/快照/诊断机制可以原样复用，只有投影与收敛判定按语义分派。

### 2.2 轴二：收敛性 —— 共享状态 vs 在场态

| | 共享状态 shared | 在场态 presence |
|---|---|---|
| 本质 | 会话内必须收敛到同一值 | 每人一份，广播但不收敛 |
| 例子 | 视频 currentTime（权威状态唯一） | Google Docs 的多人光标、"某人正在看第 3 页"、个人标注位置 |
| 算法 | 权威裁决 → 广播 → 两端执行 → 漂移监测 | 只广播自己的值，不做收敛判定 |
| 当前代码落点 | 权威 `PlaybackState` + actual-state 报告 + 就绪判定 | 尚无；协议无 presence 通道 |

### 2.3 两轴合成与路线对应

| 语义 \ 收敛 | 共享（必须收敛） | 在场（广播不收敛） |
|---|---|---|
| 游标 playhead | **Phase 0–2**：Bilibili/YouTube/本地视频的播放进度（当前实现） | `[需评审]` 每人阅读位置覆盖层（Phase 3+ 可选） |
| 标量 scalar | **Phase 3**：PDF 滚动位置、缩放（未实现） | `[需评审]` 通知型状态（谁在看、谁在拖） |

- 适配器为每个可同步项声明语义类型 + 收敛轴；核心只理解这一小组标准类型，另保留一个 opaque 逃生舱（自定义语义，核心不理解，只透传）——逃生舱 `[需评审]`，避免它退化成旧设计的 GenericAction。
- 当前协议（`docs/syncers/protocol.md`）是"单资源、单媒体 playhead、shared"的实例化；向多 item 推广是 Phase 3 的协议变更点，不是当前能力。

## 3. 跨阶段不变量（任何阶段不得破坏）

1. `ResourceAdapter` 语义契约不变：不存 session/revision/command；applyState 必须可观察（返回执行后的真实状态）。
2. 注册表冲突规则不变：同 adapterId / 同 domain 冲突注册失败；未知 URL resolve 为 undefined（除非评审后引入显式 fallback 层，见 Phase 1）。
3. 浏览器侧身份逻辑只存在于 `extension/identity.js`；content/background 不重复域名匹配。
4. 资源不搬运：同步消息只含身份/语义操作/共享状态/诊断，不含媒体数据（Phase 2 的本地文件服务是用户自己的文件经局域网直达，不属于搬运第三方资源）。
5. 扩展隔离（NFR-005）：新增同步器不得修改会话排序、版本、快照和一致性监测核心。
6. 每会话单资源，直到评审决定 multi-resource（多游标会话是 brainstorm 中记录的能力方向，`[需评审]`）。
7. 权威状态唯一：本地事件只能形成意图或实际状态报告，不能直接覆盖权威状态。

## 4. Phase 0 —— Bilibili/video 稳定性（当前）

### 4.1 目标

把当前 Bilibili 双人局域网同步从"机制可证明"推进到"真实环境可用"：稳定性收口 + 补齐真实环境验证缺口。本阶段不增加资源类型。

### 4.2 用户流程（现状，`[已落地]`）

1. 主机启动 Node 伴随进程；popup 默认主机模式，固定 127.0.0.1，通过本机 API 获取 Session ID 并复制连接串。
2. 主机在 Bilibili 视频页连接；当前页面由同步器自动识别并绑定为会话资源（无手动 URL）。
3. 从机输入主机地址/端口/会话 ID 加入；主机 popup 接受/拒绝。
4. 从机收到资源身份，扩展在当前或新 tab 覆盖打开目标页面；页面同步器注册并报告就绪。
5. 双方用原生播放器控制播放/暂停/拖动/倍速；两端在 1 秒内进入同一状态，播放中漂移收敛在 250ms 基线内；缓冲/结束/错误显式报告。

### 4.3 核心模型变化

无。本阶段固化已有模型，不引入新抽象。

### 4.4 适配器扩展

无新适配器。Bilibili 适配器只做稳定性修补（见风险）。

### 4.5 验收

进入条件（已满足）：`npm test`、`smoke:lan`、`smoke:process` 全绿；扩展静态检查通过。

完成条件（缺口清单，逐项关闭或显式豁免）：

- [ ] 真实双设备局域网端到端：两台设备、host 扩展 + 从机扩展真实加载，完整跑一遍 4.2 流程（此前仅同机模拟与静态检查，未实机验证）。
- [ ] macOS 防火墙/网络提示行为记录；Windows 实机冒烟记录（`[需评审]`：Windows 未在任何环节验证过）。
- [ ] Chrome 版本差异（autoplay 策略、MV3 service worker 生命周期）下的稳定连接与恢复。
- [ ] 权威源断开/重启的 UX 收敛：当前 MVP 允许会话结束重来，确认 popup 能明确显示而非挂死。
- [ ] 稳定性回归全绿：重开 tab/新窗口接管、换资源、未知 duration、缓冲/seek 抖动、意图回声抑制、客户端自动恢复刷新（每个机制都有对应测试或 smoke 覆盖）。

### 4.6 风险

- Bilibili 页面结构变更（选择器、播放器 DOM）——适配器集中在单文件，变更面小，但需真实页面回归。
- 登录/验证码阻塞（记录为外部阻塞，不伪造可控性）。
- 站点反制 seek（把外部跳转改回去的状态机）——`[需评审]`，当前无检测。
- 跨源 iframe 中的视频（查询选择器穿不透）——`[需评审]`，当前未覆盖，见 Phase 1。
- 网络抖动下的诊断噪声——已有 700ms 回声抑制与短暂兼容状态，仍需真实网络样本。

### 4.7 非目标

- 不做新站点适配器（YouTube 属于 Phase 1，本波次作为 Phase 1 开头交付）。
- 不做播放控制 UI、手动 URL、公网/中继、账号体系、多于两人。
- 不做跨源 iframe / shadow DOM / WebAudio / canvas 覆盖（防御图谱中除已验证项外全部 `[需评审]`）。

### 4.8 建议 issue/PR 拆分

- issue：双设备实机验证执行与结果记录（含防火墙处理步骤文档）。
- issue：权威断开与重启后的 popup 状态与重连引导。
- issue：Windows/Chrome 版本矩阵冒烟记录（执行类，不引入代码承诺）。
- PR：以上验证暴露的稳定性修补（每个修补必须带回归测试）。

## 5. Phase 1 —— URL/网页资源简单同步

### 5.1 目标

把同步能力从 Bilibili 扩展到任意"URL 承载 HTML5 媒体"的网页：**通用媒体优先，站点适配器修长尾**。装上就能用，而不是每站写适配器（这是与 RSSHub 心智的关键区别，见 Phase 4）。

本波次交付：YouTube 同步器 `[已落地]`（`src/adapters/youtube-adapter.ts`、`extension/identity.js` 注册项、manifest 作用域、Node 注册表注册、自动化测试）；真实浏览器 / 跨设备实机验证与真实页面收敛基线仍待补（见 5.5 未闭环项）。

### 5.2 用户流程

与 4.2 完全相同，只是从机收到的资源 URL 可以是任意支持站点（如 YouTube）。主/从任一端切换视频，另一端覆盖自己当前页面。对用户无新概念。

### 5.3 核心模型变化

- **注册表 fallback 层** `[需评审]`：通用媒体适配器需要"无 domain 兜底"匹配，与当前"未知 URL → undefined"和"domain 必填、禁通配符"冲突。最小改动：`SyncerRegistration` 增加可选 `fallback: true`（仅在没有域名命中时尝试，按注册顺序取第一个声明兜底的注册项），resolve 语义从"无命中 → undefined"变为"无域名命中 → 兜底层"。注册冲突规则不变。
- **资源身份**：identity.js 的 `deriveIdentity` 钩子已支持任意站点；通用媒体身份 = adapterId + canonicalUrl。注意 canonicalUrl 丢弃 query/hash，同 URL 不同视频的站点（播放列表类）身份会歧义——`[需评审]`：是否允许 deriveIdentity 使用页面媒体元素的 src 做 resourceId 补充（Node 侧 CLI 无 DOM，身份派生天然只在页面侧，CLI 的 `[bilibili-url]` 规范化是 Bilibili 特例，不推广）。
- **扩展权限模型** `[需评审]`：manifest `host_permissions`/content_scripts `matches` 目前是显式站点清单（Bilibili 视频页 + YouTube `/watch` 页，已按站添加条目）。"任意站点都可用"需要 `<all_urls>`，与最小权限原则冲突，必须评审后决定（推荐：显式站点清单 + 长尾走社区包，见 Phase 4）。
- **会话模型**：不变，仍是单媒体资源 playhead/shared。

### 5.4 适配器扩展

- `generic-media` 适配器 `[需评审]`：`querySelector('video, audio')` + 标准 HTMLMediaElement API；目标选择沿用"最大可见候选、文档序决胜"；能力声明与 Bilibili 相同。与 `BilibiliAdapter` 的关系：Bilibili 保留为显式注册项（域名命中优先），generic 只兜底——同一站点永远只有一个注册项服务，不变量 2 保持。
- `youtube` 适配器 `[已落地]`：注册 `youtube.com` 及任意子域 + `/watch`（非空 `v=` 参数）URL 规则；identity 派生用 watch?v= 参数做 resourceId；能力声明与 Bilibili 相同。真实页面可控性与收敛实测待补——自动化测试使用 fake page 结构对象，不冒充真实浏览器验证。
- 防御矩阵补齐（逐项 `[需评审]`）：跨源 iframe（content_scripts `all_frames`）、closed shadow DOM 遍历、WebAudio（无元素，明确不支持并显式报错）、canvas 渲染视频（罕见，检测后报错）、站点 seek 反制（检测 + 诊断）。这些是"按结构"而非"按站点"的适配器，一个 iframe 适配器可覆盖大量站点。

### 5.5 验收

进入条件：Phase 0 完成（或缺口显式豁免并记录原因）。

完成条件：

- [x] YouTube 适配器在 Node 注册表、`extension/identity.js` 与 manifest 三端注册，冲突/未知 URL 语义不变；适配器自动化测试合入，既有基线全绿（133 项）。
- [ ] YouTube 真实页面双端收敛满足既有基线（1s 收敛 / 250ms 漂移），真实 Chrome 与 Mac + Windows 跨设备验证并记录。
- generic-media 适配器（若评审通过）覆盖一个非白名单站点冒烟（真实页面验证，不得以单测冒充）。
- [~] 扩展权限模型：manifest 已按显式站点清单落地（Bilibili + YouTube 条目）；`<all_urls>` 取舍与兜底结论仍待评审（见 R6）。
- [~] 既有测试全绿（133 项）+ 新增适配器测试已合入；注册表 fallback 测试随 R5 评审落地后补充。

### 5.6 风险

- 站点 autoplay 策略（从机页自动播放被拦）——当前机制已通过"权威状态 apply 强制暂停/就绪"部分规避，需真实站点验证。
- iframe 内视频（YouTube 嵌入等）——all_frames 方案涉及消息路由改造（content 脚本间通信），风险集中在 background 路由。
- DRM/EME 内容（Netflix 类）——媒体不可控，明确不支持，检测后显式失败，不伪装成功。
- 站点结构频繁变更的长尾成本——由 fallback 层兜底，显式适配器只留高价值站点。

### 5.7 非目标

- 不做滚动/缩放同步（Phase 3）。
- 不做 presence、多游标、多资源会话。
- 不做 DRM 内容、WebAudio、canvas 媒体支持（可检测可报错，不支持）。
- 不做站点特色体验同步（清晰度/字幕/弹幕等，未来作为适配器扩展能力声明，不进入核心一致性）。

### 5.8 建议 issue/PR 拆分

- issue：registry fallback 层设计评审（resolve 语义、注册顺序、冲突规则）——评审产出后再拆实现 PR。
- issue：YouTube 适配器实现（Node 注册表 + identity.js 注册 + manifest 作用域 + 适配器测试）已合入；剩余为验证执行类：真实页面验证与跨设备实机记录。
- issue：manifest 权限模型评审（站点清单 vs all_urls）。
- issue：跨源 iframe 覆盖设计（all_frames + 消息路由）。
- PR：每个适配器独立合入，带自身测试与验证记录，不触碰核心模块。

## 6. Phase 2 —— 本地视频快速广播为局域网资源

### 6.1 目标

本地文件与网页资源是包含关系（用户已确认的方向）：本地视频经伴随进程的简易媒体服务暴露为局域网 URL，变成框架负责的网页资源，完整复用网页同步。用户无需上传到任何服务，资源不离开局域网。

### 6.2 用户流程

1. 主机启动伴随进程并共享一个本地视频（如 `--share /path/to/video.mp4`）；进程在局域网地址上提供带令牌的 HTTP URL。
2. 主机把该 URL 绑定为会话资源（与网页资源同一 resource-bind 流程）。
3. 从机收到 URL，扩展打开该 URL；内容脚本在该源上运行（权限模型见 6.3），通用媒体适配器接管播放。
4. 播放/暂停/拖动/倍速全部复用网页同步语义；拖动依赖服务端 Range 请求。

### 6.3 核心模型变化

- **本地媒体服务** `[需评审]`：伴随进程新增静态文件服务，必须支持 HTTP Range（视频 seek 依赖）、正确 Content-Type、流式传输（不得整文件读入内存）。媒体元素播放不需要 CORS；内容脚本 fetch（若有）才需要。
- **安全模型** `[需评审]`（本阶段最大评审点）：服务绑定策略（仅共享时监听局域网接口）、URL 随机令牌防局域网任意访问、令牌轮换与会话解绑、manifest 对任意局域网 IP 的注入方式（`<all_urls>` 或运行时权限请求）。
- **资源身份**：新注册项（如 `local-video`，domain 为服务地址 hostname + urlRule 限定路径/令牌前缀），identity 派生自服务 URL；Node 侧可规范化，页面侧同源。
- **会话模型**：完全复用，零改动——这是本阶段的价值主张：服务是唯一新组件。

### 6.4 适配器扩展

`local-video` 注册项可以是一个极薄的包装（身份派生 + 复用 generic-media 的目标选择/状态/事件逻辑），也可以直接复用 generic-media 适配器 + 独立 urlRule。倾向后者，避免复制逻辑。

### 6.5 验收

进入条件：Phase 1 完成；6.3 安全模型评审通过。

完成条件：

- 主机共享本地 mp4，从机经局域网 URL 播放：play/pause/seek（含拖动到未缓冲区间）/rate 满足既有收敛基线。
- Range 请求验证（seek 后秒级开始播放，不整文件下载）。
- 无令牌请求被拒绝（403）；未共享时不监听局域网媒体端口。
- 两端编解码器不一致时（如从机缺编码）显式报错而非黑屏挂起。
- 既有测试全绿 + 媒体服务（Range/鉴权/流式）与端到端同步测试。

### 6.6 风险

- 编解码器矩阵（浏览器/OS 差异）——不做转码，显式失败。
- 大文件/弱网带宽——流式 + Range，不做 P2P 分发（`[需评审]` 是否未来需要）。
- 防火墙（macOS/Windows）首次监听提示打断流程——记录引导文案。
- 局域网内其他设备扫描到服务端口——令牌 + 仅共享期监听缓解。

### 6.7 非目标

- 不做转码、不做上传公网、不做 P2P、不做字幕/音轨同步。
- 不做文件目录浏览（一次共享一个明确文件）。
- 不做本地文件直连同步（不从播放器直接读本地文件；一切走 URL）。

### 6.8 建议 issue/PR 拆分

- issue：媒体服务安全模型评审（绑定、令牌、权限注入方案）——先行。
- issue：媒体服务实现（Range/Content-Type/流式/令牌）。
- issue：local-video 注册项 + 双端注册表 + manifest 作用域。
- issue：真实双机共享验证（含防火墙记录）。
- PR：服务独立合入（可单测），端到端验证单独 PR 记录。

## 7. Phase 3 —— arXiv PDF 滚动/缩放

### 7.1 目标

首次落地标量同步：两人共同阅读同一 arXiv PDF，滚动位置与缩放级别收敛。这是统一抽象从 playhead 推广到 scalar 的验证阶段，也是"一起读文章"资源类型的开端。

### 7.2 用户流程

1. 主/从任意一端打开 arXiv 论文页并绑定为共享资源（与视频完全同构的流程）。
2. 任一端滚动或缩放，另一端以有界延迟跟随到同一位置/缩放。
3. 两端阅读位置持续收敛（滚动为共享标量）；`[需评审]` 可选：双方各自阅读位置以在场态叠加显示（presence 首次落地）。

### 7.3 核心模型变化（本阶段最大协议变更，必须评审）

- **sync-item 模型** `[需评审]`：会话权威状态从"单一媒体 playhead"推广为"适配器声明的可同步项集合"。每项声明 `{ key, semantic: 'playhead' | 'scalar', convergence: 'shared' | 'presence' }`；媒体场景即 `[{ media, playhead, shared }]`，向后兼容（媒体同步器的现有消息不变或仅加包装）。
- **投影与收敛分派**：排序/版本/快照/诊断机制原样复用；按 semantic 分派投影（scalar = rate 0）与收敛判定（scalar 容差按单位，如滚动像素阈值；离散缩放按精确值）。
- **事件节流** `[需评审]`：滚动是高频事件，复用 seek-drag 模式（结算提交 / 有界抑制窗口，参照现有 700ms 意图回声抑制），不得产生无限命令流。
- **会话模型**：仍是单资源；PDF 会话与视频会话不同时共存（multi-resource `[需评审]` 独立立项）。

### 7.4 适配器扩展

- `arxiv-pdf` 适配器：注册 `arxiv.org` + `/pdf/` URL 规则；目标对象为 arXiv HTML5 PDF 阅读器（pdf.js 系）的滚动容器与缩放状态；identity 用论文 ID（`/pdf/<id>`）。必须真实浏览器验证注入可行性（`[需评审]`：浏览器内置 PDF 查看器页面不可注入，arXiv 自有阅读器页面可注入——落地前以真实页面记录为准，不假设）。
- 滚动位置用归一化值（scrollTop/scrollHeight，随缩放稳定）`[需评审]`。
- 缩放作为第二个标量项。

### 7.5 验收

进入条件：Phase 2 完成；sync-item 协议评审通过并同步更新 `docs/syncers/protocol.md`（当前为 media-only，需扩展或新增附录）。

完成条件：

- 双端滚动位置在容差内收敛（真实页面验证 + 自动化测试各一）。
- 缩放收敛为精确值。
- 标量项不破坏既有媒体同步回归（媒体场景消息兼容或一次性迁移）。
- 滚动节流有效：持续滚动不产生命令风暴（测试断言有界上报）。
- 阅读器结构变化（arXiv 升级）时适配器失败显式可诊断。

### 7.6 风险

- arXiv 阅读器 DOM 随版本变化——适配器单文件隔离，需真实页面回归。
- 浏览器内置 PDF 查看器不可注入——必须依赖站点自有阅读器，选型 arXiv 即为此。
- 滚动节流与收敛的交互（追赶 vs 本地滚动手感）——需要真实双机体验评审，这是首个非"秒级语义"的同步项。

### 7.7 非目标

- 不做批注/高亮同步（presence 类，`[需评审]` 独立立项）。
- 不做任意 PDF 站点通用支持（先 arXiv 单站验证标量机制）。
- 不做电子书/PPT/网页滚动通用化（机制验证后按同一 item 模型扩展）。
- 不做媒体 + 文档混合会话。

### 7.8 建议 issue/PR 拆分

- issue：sync-item 协议设计评审（向后兼容策略、投影分派、节流语义）——先行，与同步器规范同步。
- issue：arxiv-pdf 适配器 + 双端注册 + manifest 作用域。
- issue：滚动/缩放节流与收敛实现（核心一致性监测扩展）。
- issue：真实双机 PDF 阅读验证与手感评审。
- PR：协议推广（核心 + 协议守卫测试）与适配器（独立文件）分 PR 合入。

## 8. Phase 4 —— RSSHub-like syncer 社区

### 8.1 目标

把同步器变成可分发、可安装、可贡献的社区单元，同时保持"装上就能用"的默认覆盖率。RSSHub 的教训：不能把"自己写适配器"当主路径——通用层（Phase 1 的 generic-media + 结构型适配器）覆盖大多数站点，社区包只修长尾与特色体验。

### 8.2 用户流程

1. 用户在社区目录（或以 `docs/index.html` 为种子的社区站点）搜索站点/域名，找到同步器包。
2. 一键安装：扩展下载包 → 展示其声明的域名/能力/权限 → 用户确认 → 注册进 `identity.js` 注册表并生效。
3. 贡献者按 `docs/syncers/authoring.md` 编写同步器 → 提交到目录 → 目录校验（冲突规则、能力声明、版本兼容）后上架。

### 8.3 核心模型变化

- **同步器包格式** `[需评审]`：manifest（adapterId/name/domain/urlRule/capabilities/items 语义声明/所需核心协议版本）+ 代码 + 版本。注册冲突规则（同 adapterId/domain 失败）即目录上架校验规则。
- **动态注册**：Node `AdapterRegistry` 与 `identity.js` 目前都是启动时静态注册；社区安装需要运行时注册 + 卸载 + 冲突报告，注册表 API 需小扩展（`unregister` 等）`[需评审]`。
- **安全模型** `[需评审]`（本阶段最大评审点）：第三方代码在扩展上下文运行并携带 host 权限。方向候选：内容脚本隔离世界 + 权限最小化（域名级 host_permissions 按包授予）+ 包签名/哈希 + 目录审核流程。落地前必须评审，宁可不做也不能裸奔。
- **版本兼容**：同步器声明所需核心协议版本，核心升级不破坏既有包（semver 策略 `[需评审]`）。

### 8.4 适配器扩展

无新增内置适配器。长尾站点全部以社区包形式出现；内置只保留高价值站点（Bilibili、YouTube）与结构型适配器（generic-media、iframe）。

### 8.5 验收

进入条件：Phase 3 完成；8.3 安全模型评审通过。

完成条件：

- 一个样例社区包可安装、生效、卸载，核心模块零改动（NFR-005 在真实包上验证）。
- 冲突安装被拒绝并给出可读原因；协议版本不匹配显式报错。
- 目录校验服务（或等价离线流程）按注册冲突规则拒绝非法包。
- 安装包的权限范围可审计（用户可查看该包获得哪些域名权限）。

### 8.6 风险

- 第三方代码安全（最高风险）——评审不通过则本阶段推迟，社区目录只收录评审通过的包。
- 质量与维护（长尾适配器随站点变更腐烂）——目录标记维护状态/失效检测。
- RSSHub 式碎片化——以"通用优先"原则对抗：目录优先收录结构型适配器，单站适配器需要明确价值论证。
- 许可证与滥用（恶意 URL 规则、钓鱼域名）——目录审核 + 域名规则可见性。

### 8.7 非目标

- 不做付费/私有同步器体系。
- 不做云端状态同步（会话仍局域网）。
- 不做多资源会话（独立 `[需评审]` 立项）。
- 不做自动公网发现/中继/账号（沿用首版边界）。

### 8.8 建议 issue/PR 拆分

- issue：第三方代码安全模型评审——先行，结论决定整个阶段形态。
- issue：同步器包格式与 authoring 校验器（对齐 `docs/syncers/authoring.md`）。
- issue：注册表运行时注册/卸载 API + 测试。
- issue：扩展安装流程 UI（目录浏览 → 权限确认 → 安装/卸载）。
- issue：样例社区包（可选用 Phase 1–3 的某个结构型适配器拆出）。
- PR：包格式与注册表能力（核心）+ 安装 UI（扩展）分 PR；任何核心改动必须过 NFR-005 回归。

## 9. 需要重新评审的需求清单

以下项目在本路线图中被引用为 `[需评审]`，集中列于此。每一项都必须在对应阶段落地前给出明确决定（做/不做/怎么做），不得默认跳过：

| # | 项 | 关联阶段 | 为什么需要评审 |
|---|---|---|---|
| R1 | 真实双设备局域网端到端与 Chrome 扩展真实加载验证 | P0 | 从未实机验证；L3 明确未覆盖，不能默认视为完成 |
| R2 | macOS 防火墙 / Windows 实机行为 | P0 | 仅开发机（macOS）验证过，Windows 零验证 |
| R3 | 收敛基线（1s / 250ms / 60s）按原型测量修订 | P0+ | 需求规格 §16 明确是 ASSUMPTION，需测量证据，不能删除阈值 |
| R4 | 防御矩阵未验证项：跨源 iframe、shadow DOM、WebAudio、canvas、站点 seek 反制 | P1 | 其中多项在 brainstorm 中标记为"确定/较确定/猜测，待验" |
| R5 | 注册表 fallback 层与"未知 URL → undefined"语义 | P1 | 触碰核心 resolve 语义与不变量 2 |
| R6 | 扩展权限模型：站点清单 vs `<all_urls>` | P1 | 最小权限原则与"任意站点可用"冲突 |
| R7 | 本地媒体服务安全模型：绑定、令牌、manifest 注入 | P2 | 首次让伴随进程在局域网提供媒体内容，超出首版信任模型 |
| R8 | sync-item 协议推广（scalar/playhead 声明、presence 通道、opaque 逃生舱） | P3 | 协议级变更，需与 `docs/syncers/protocol.md` 同步修订 |
| R9 | 滚动节流与收敛手感（追赶 vs 本地操作） | P3 | 首个非秒级语义项，需真实双机体验数据 |
| R10 | 多资源/多游标会话（brainstorm 记录的方向） | P3+ | 当前明确每会话单资源；做不做、怎么做需独立立项 |
| R11 | presence（在场态）落地（阅读位置覆盖层等） | P3+ | 用户四阶段路线未包含，属于可选能力，需产品评审 |
| R12 | 第三方同步器代码安全模型与动态注册 | P4 | 最高风险项，决定社区阶段形态 |
| R13 | 站点特色体验同步（清晰度/字幕/弹幕等扩展能力） | 各阶段 | 需求规格明确延后，作为适配器扩展能力声明，需定义声明格式 |
| R14 | 权威角色转移 / 独立权威服务 / 会话持久化 | P0+ | 需求规格 §16 明确 DEFERRED；MVP 允许权威重启后会话结束 |

## 10. 路线图如何指导 issue/PR 拆分

- 每个 Phase 的 4.8/5.8/6.8/7.8/8.8 给出该阶段独立可拆的 issue；每个 issue 必须可归入一个模块边界（会话层/有序状态层/同步层/传输层/适配器层/页面代理层/控制面板/验证层，见需求规格 §15），无法归入的先回到需求确认。
- 评审项（R1–R14）作为独立 issue 先行：评审产出是决定 + 记录，不是代码。评审未通过的能力不得以"半实现"状态合入。
- PR 边界约定：核心模块（authority/state/consistency/protocol）任何改动必须带协议守卫测试与既有回归全绿；适配器一律独立文件 + 独立测试 + 真实页面验证记录，禁止借适配器改动核心。
- 每个适配器落地都是一个纵切 PR：Node 注册表注册 + `extension/identity.js` 注册 + manifest 作用域 + 适配器 + 测试 + 验证记录，一次合入，保持两端注册表同步（不变量 3）。
- 完成状态只以合入 + 测试/smoke/实机记录为准；本文档不设时间表，阶段推进以进入条件满足为准。
