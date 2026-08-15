# 编写一个新同步器（Syncer Authoring Guide）

> 配套：`overview.md`（边界与总览）、`protocol.md`（协议与状态语义）。
> 标记：`[当前实现]` = 已实现；`[建议约定]` = 推荐规范（当前不强制，内置同步器均遵守）；`[未来能力]` = 未实现。

读完本文即可交付一个新同步器。一个同步器 = **一份注册**（`SyncerRegistration` / identity.js 条目）+
**一个媒体驱动实现**。对于“站点页面里有一个标准 `HTMLMediaElement`（video/audio）”的情况，
浏览器侧驱动是**现成的通用实现**，你只需做注册；Node 侧的 `ResourceAdapter` 实现是规范参考，
必须实现并通过单元测试。

## 1. 注册（注册表契约）

### 1.1 `SyncerRegistration`（Node 侧，`src/adapters/adapter-registry.ts`）

```ts
type SyncerRegistration = {
  adapterId: string;          // 必填，非空；稳定、全小写、站点作用域
  name?: string;              // 人类可读站点名，缺省回退到 adapterId
  domain: string;             // 必填；可注册域（见 1.2）
  urlRule?: AdapterUrlRule;   // 可选；{ source, flags? } 序列化正则
  create(page: AdapterPage): ResourceAdapter; // 必填；工厂，一次调用返回全新实例
  capabilities: readonly AdapterCapability[]; // 必填；静态声明
};
```

注册期校验（违反即抛 `AdapterRegistryError`，且**不留下部分状态**）：
- `adapterId.trim()` 非空；否则 `'invalid-registration'`。
- `domain` 可规范化（见 1.2）；否则 `'invalid-registration'`。
- `create` 是函数；否则 `'invalid-registration'`。
- adapterId 已注册 → `'duplicate-adapter'`；域名已注册 → `'duplicate-domain'`（含规范化等价域名）。
- `urlRule` 非法（空 source、含 g/y 标志、编译失败）→ `'invalid-rule'`。

`AdapterPage` 是注册表保证提供给工厂的最小环境：`{ location: { href }, document?: unknown }`。
**工厂与适配器不得假设浏览器全局存在**（Node 测试显式注入 fake page）；`document` 缺省时站点操作须报
`browser-required`。

### 1.2 域名与 URL 正则规则

**域名（domain）规范化**：trim → 小写 → 去掉尾部点 → 拒绝含空白、`/`、`:`、`*`、`?` 的输入（非法返回 null）。
示例：`' Bilibili.COM. '` → `'bilibili.com'`；`'bilibili.com:8080'`、`'*.bilibili.com'` 非法。

**匹配是两层的**（`resolve(url)`）：
1. **域名层**：`hostname === domain` 或 `hostname.endsWith('.' + domain)`（子域名全部覆盖）；
2. **URL 规则层**（可选）：序列化正则 `{ source, flags? }` 编译后 `test(完整 URL)`。
   - source 非空；flags 不得含 `g`/`y`（`lastIndex` 有状态匹配被禁止，保证判定确定性）；编译失败即注册失败。
   - 规则匹配对象是**原始页面 href 全文**，与身份校验用的 canonical URL 是两回事（见 §4）。
3. **最长域名胜出**：多个注册命中时，`domain` 字符串最长者胜。
4. 无法解析、非 http(s)、无注册命中的 URL → `resolve` 返回 `undefined`（**resolve 永不抛错**）。

`[当前实现]` 两个内置同步器都这么做：Bilibili 的注册规则与身份守卫共享 `BILIBILI_VIDEO_PATH_PATTERN`，
YouTube 的注册 `urlRule` 与 `YoutubeAdapter.identifyResource` 共享 `YOUTUBE_WATCH_URL_PATTERN`，
规则与身份策略不可能漂移。`[建议约定]` 新同步器应同样把“哪些页面算资源页”定义在**一处**，
注册规则与身份派生引用同一来源。
`[建议约定]` 规则尽量窄：只匹配真正可同步的资源页（Bilibili 用 `/video(/|$|[?#])`，
YouTube 用 `/watch` 且 query 含非空 `v=` 参数），让 `resolve` 永不把非资源页（首页、搜索、Shorts、个人空间）交给同步器。

### 1.3 能力声明（capabilities）

`AdapterCapability = 'play' | 'pause' | 'seek' | 'set-rate' | 'replay' | 'native-events'`。

| 能力 | 运行时对应 | 声明条件 |
|---|---|---|
| `play` / `pause` | `applyState` 对相位 `playing`/`paused` 的操作 | 站点媒体可被启动/暂停 |
| `seek` | `applyState` 设置 `currentTime` | 站点媒体可跳转任意位置 |
| `set-rate` | `applyState` 设置 `playbackRate` | 站点媒体速率可改（默认 1 也要可写） |
| `replay` | `applyState` 处理相位 `playing`（配合位置 0） | 已结束资源可重播 |
| `native-events` | `subscribe` 上报 10 个 `AdapterEvent` | 你**完整**转述全部 10 个原生事件，而非子集 |

`[建议约定]` 能力是**诚实声明**：`native-events` 意味着 `subscribe` 确实覆盖全部 10 个事件；
只转述一部分就不要声明它。能力声明同时写入 Node 注册表与 identity.js 条目，二者必须一致。
`[未来能力]` 新能力类型需要核心层意图/状态机配合，属于破坏性变更；当前 6 个能力已覆盖媒体同步全部路径。

## 2. `ResourceAdapter` 方法契约

实现**对会话与命令无状态**：不存 sessionId、commandId、命令序列、stateRevision；每次调用都从
页面/媒体对象读真实状态。同一实例可被任意顺序复用（测试依赖这一点）。

```ts
interface ResourceAdapter {
  readonly adapterId: string;
  identifyResource(): ResourceIdentity;
  selectTarget(): void;
  readState(): LocalPlaybackState;
  applyState(target: AdapterTargetState): Promise<AdapterApplyResult>;
  subscribe(listener: (event: AdapterEvent) => void): () => void;
}
```

| 方法 | 输入 | 输出 | 失败语义（抛 `AdapterSiteError`） |
|---|---|---|---|
| `identifyResource()` | 无（用页面 location） | `ResourceIdentity`（canonical 化后的身份） | `'invalid-url'`（URL 不可解析/缺失 href）、`'not-bilibili'`（URL 可解析但不是本站资源页；该 code 是站点无关的共享集合，内置 Bilibili/YouTube 都用它，消息里点名实际站点）、`'browser-required'`（无 location） |
| `selectTarget()` | 无（用页面 document） | `void`；之后 `readState`/`applyState`/`subscribe` 作用于该目标 | `'no-media'`（无可播媒体）、`'browser-required'`（无 document）。**选择必须确定**：调用方永远不自己挑“第一个” |
| `readState()` | 无 | `LocalPlaybackState`（见 2.1） | 目标不可用（`'no-media'` 等） |
| `applyState(target)` | `AdapterTargetState` = `{ mediaPhase, positionSeconds, playbackRate }` | **总是 resolve** 的 `AdapterApplyResult`（见 2.2）；state 恒为执行后的真实快照 | 不抛错：站点级失败折叠为 `result: 'unsupported'`，操作失败折叠为 `'rejected'`（均带 `error`） |
| `subscribe(listener)` | 事件监听回调 | `() => void` 反订阅函数，**精确移除**本次绑定的所有处理器 | 目标不可用时抛 `AdapterSiteError`（先 `selectTarget`） |

### 2.1 `LocalPlaybackState`（真实观测，绝不合成）

```ts
type LocalPlaybackState = {
  resourceIdentity: ResourceIdentity; // 来自 identifyResource()
  mediaPhase: MediaPhase;
  positionSeconds: number;      // 媒体对象当前 currentTime
  playbackRate: number;         // 媒体对象当前 playbackRate
  durationSeconds: number | null; // 有限时长 → number；NaN/Infinity → null
};
```

规则：字段全部读自**活的媒体对象**（或测试中的 fake），绝不按“上次施加的命令”回填。

### 2.2 `AdapterApplyResult` 三态语义

| result | 含义 | state | error |
|---|---|---|---|
| `'applied'` | 操作全部执行 | 执行后**真实**快照（例如 seek 已安定后的状态，不是 'seeking'） | 无 |
| `'rejected'` | 尝试了但失败（浏览器拒绝 `play()`、非法速率等） | best-effort 真实快照 | 人类可读说明 |
| `'unsupported'` | 页面级不可操作（无媒体、站点错误） | **中性占位**：identity + `{ paused, 0, 1, null }` | 原因（如 “No playable …”） |

`[当前实现]` 参考实现（`BilibiliAdapter` 与 `YoutubeAdapter` 的 `applyState`，二者顺序与错误折叠完全一致）的执行顺序与错误折叠：
1. 获取目标失败 → `'unsupported'`；
2. 校验 `playbackRate`（必须有限且 > 0；否则 plain Error → `'rejected'`）；
3. 施加相位（见 §3 映射表）；
4. 位置：`|currentTime − positionSeconds| > 0.25` 才 seek，随后轮询等待 seek 安定（25ms × 最多 20 次），
   保证返回快照反映**安定后**位置而非 'seeking'；
5. 设置 `playbackRate`（浏览器钳制时以真实快照回读为准）；
6. 全程 catch：`AdapterSiteError` → `'unsupported'`；其他 → `'rejected'`。

**失败路径必须显式**：任何情况下都不得伪造 `'applied'`（测试对此有断言）。

### 2.3 `subscribe` 事件与反订阅

绑定全部 10 个 `AdapterEvent`（`MEDIA_EVENTS`），每个事件一个处理器；返回的反订阅函数移除
**恰好这些**处理器（测试断言 `listenerCount()` 归零）。监听器回调纯粹转述事件；相位合成在 `readState` 时进行。

## 3. HTMLMediaElement 参考实现（Bilibili 即模板）

以下规则是 `BilibiliAdapter`、`YoutubeAdapter` 与 `content.js` 共享的语义（`[当前实现]`，YouTube 是第二个照此模板落地的内置同步器），新站点若同样是
HTMLMediaElement，直接照抄并替换站点特定部分。

### 3.1 相位映射（原生信号 → `MediaPhase`）

优先级从高到低，一次判定：

| 条件（依次） | `MediaPhase` |
|---|---|
| `element.error` 非空 | `'error'` |
| `element.ended` | `'ended'` |
| `element.seeking` | `'seeking'` |
| `element.paused` | `'paused'` |
| `buffering` 标志（见下） | `'buffering'` |
| `readyState < 3`（`HAVE_FUTURE_DATA`） | `'loading'` |
| 其余 | `'playing'` |

`buffering` 标志由事件维护：`waiting` → true；`play`/`playing`/`pause`/`seeked`/`ended`/`error` → false。
**暂停的元素即使缓冲也保持 `'paused'`**；播放中卡顿经 `waiting` 报 `'buffering'`。

### 3.2 施加相位（目标相位 → 媒体操作）

| 目标相位 | 操作 |
|---|---|
| `'playing'` | `element.play()`（可能被浏览器自动播放策略拒绝 → 上层报 `'rejected'`） |
| `'paused'` / `'ended'` / `'ready'` | `element.pause()`（`'ready'` 是权威方“新资源”相位：保持暂停，防止页面自动播放把真实相位变成对权威状态的假失配） |
| `'seeking'` / `'buffering'` / `'loading'` / `'error'` | **观测专属相位，不可直接施加**；位置/速率仍照常应用 |

### 3.3 目标选择（确定性）

1. 候选 = `document.querySelectorAll('video')`（或站点选择器）中 `readyState > 0 || duration 有限` 者；
2. 按可见面积 `width × height`（`getBoundingClientRect`，异常/缺失计 0）**降序**；
3. 面积相同按文档顺序；取第一名。

调用方永不参与“挑哪个媒体”的决策——`selectTarget` 是唯一入口。

### 3.4 参考常量

| 常量 | 值 | 用途 |
|---|---|---|
| `HAVE_FUTURE_DATA` | `3` | `readyState` 阈值：低于视为 `'loading'` |
| seek 阈值 | `0.25` s | `|currentTime − target| > 0.25` 才 seek |
| `SEEK_SETTLE_POLL_MS` / `MAX_SEEK_SETTLE_POLLS` | `25` / `20` | seek 安定轮询（最多 500ms） |
| `[浏览器]` `TARGET_RETRY_MS` | `4000` | content.js 找目标视频的重试窗口 |
| `[浏览器]` `APPLY_SETTLE_MS` | `500` | 施加后抑制用户事件回声的安定窗口 |
| `[浏览器]` `TIMEUPDATE_REPORT_INTERVAL_MS` / `DRIFT` | `1000` / `0.5` | timeupdate 上报节流 |
| `[浏览器]` `REFRESH_INTERVAL_MS` | `1500` | SPA 安全的重注册循环 |
| `[浏览器]` `PENDING_INTENT_WINDOW_MS` | `700` | 用户意图回声抑制窗口 |

`YoutubeAdapter` 复用同一组 `HAVE_FUTURE_DATA`、seek 阈值与安定轮询常量；`[浏览器]` 常量对两个站点共用同一份 content.js。

## 4. 资源身份（Resource Identity）

### 4.1 派生规则

- **canonicalUrl** = `origin + pathname`，pathname 去尾部 `/`，**丢弃 query 与 hash**；
  同一资源的所有 URL 形式（`?p=2&t=30`、尾部斜杠）归一到同一身份。
- **resourceId（可选）**：站点内稳定资源键；没有就不出现该字段（不是 `null`）。
  内置 Bilibili：`/video/BV[0-9A-Za-z]+` → `resourceId: 'BV…'`。
  内置 YouTube：`/watch` 的 `v=` 参数 → `resourceId: '<videoId>'`。
- **内置 YouTube 的 canonicalUrl 例外**：不由 `origin + pathname` 派生，而是由视频 id 单独重建为
  `https://www.youtube.com/watch?v=<videoId>`——query 顺序、`list`/`t` 等额外参数、hash 以及
  `youtube.com`/`www`/`m`/`music` 等主机变体全部坍缩到同一身份（Node 适配器与 identity.js 归一规则一致）。
- 身份字段：`{ adapterId, canonicalUrl, resourceId? }`。共享守卫 `isValidResourceIdentity` 只做**结构校验**
  （非空 adapterId、http(s) canonicalUrl、可选非空 resourceId），与站点无关；站点级策略由站点守卫
  （如 `isBilibiliResourceIdentity`）在入口处强制——**核心绝不做站点判定**。
- 比较：`isResourceIdentityEqual` 比较三字段；`resourceIdentityFingerprint` 给出
  `adapterId \0 canonicalUrl \0 resourceId` 的碰撞安全字符串键（集合/字典用）。
- `[建议约定]` 派生必须**确定且版本稳定**：同一页面在任意版本、任意端（Node 注册表、identity.js、
  客户端/服务端）必须产生相同身份。新增规范化规则属于破坏性变更。

### 4.2 规范化失败（`ResourceIdentityError` / `AdapterSiteError`）

`createBilibiliResourceIdentity(location)` 与 `BilibiliAdapter.identifyResource()` 的失败码一致：
`'invalid-url'`（不可解析）、`'not-bilibili'`（非本站点或非资源页）。
`[当前实现]` `AdapterSiteErrorCode` 是站点无关的**共享闭合联合**（`src/adapters/resource-adapter.ts`），不可按站点扩展：
`YoutubeAdapter` 对“非 YouTube / 非 watch 页”同样抛 `'not-bilibili'`，错误消息点名实际站点
（如 `Page host x.com is not a YouTube site`）。`[建议约定]` 新站点沿用同一模式：复用共享 code、
消息英文且点名本站点，错误码字符串保持稳定。

## 5. 浏览器侧落地（扩展）

`[当前实现]` 浏览器侧对一个 HTMLMediaElement 站点**只需三处**，媒体驱动零改动：

1. **`extension/identity.js`** 注册条目：
   ```js
   register({
     adapterId: 'mysite',
     name: 'MySite',
     domain: 'mysite.com',
     urlRule: { source: '^https?://[^/]*/watch(/|$|[?#])', flags: '' },
     capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
     deriveIdentity(url) { /* 返回 { resourceId } 或 undefined */ },
   });
   ```
   - 匹配语义与 Node 注册表同构（域名/子域名 + 全 URL 规则、长域名优先、无 g/y、非 http(s) 不匹配）。
   - 无 `deriveIdentity` 时身份只含 `adapterId + canonicalUrl`（identity.js 先算 canonical 基础身份，再让钩子扩展）。

`[当前实现]` 第二个内置同步器 **YouTube** 即按此落地（identity.js 中的实际条目）：
   ```js
   register({
     adapterId: 'youtube',
     name: 'YouTube',
     domain: 'youtube.com',
     // /watch 且 query 含非空 v= 参数；与 Node 侧 YOUTUBE_WATCH_URL_PATTERN 同源
     urlRule: { source: '^https?://(?:[^/]+\\.)?youtube\\.com/watch\\?(?:[^#]*&)?v=[^&#]+', flags: '' },
     capabilities: ['play', 'pause', 'seek', 'set-rate', 'replay', 'native-events'],
     deriveIdentity(url) {
       const videoId = url.searchParams.get('v');
       if (!videoId) return undefined;
       // canonicalUrl 由 v= 单独重建（覆盖基础身份）：query 顺序/额外参数/hash/主机变体全部坍缩
       return { canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`, resourceId: videoId };
     },
   });
   ```
   注意钩子返回的 `canonicalUrl` 会**覆盖**通用基础身份：YouTube 的 canonical 不是 origin+pathname（见 §4.1）。
2. **`extension/manifest.json`**：`content_scripts.matches` 与 `host_permissions` 增加站点资源页模式
   （`"https://mysite.com/watch/*"`、`"https://*.mysite.com/watch/*"`；`identity.js` 必须排在 `content.js` 之前）。
   `[当前实现]` 内置 YouTube 对应的实际模式是 `"https://youtube.com/watch*"`、`"https://*.youtube.com/watch*"`。
3. **`extension/background.js`**：零改动（`deriveIdentity`/`isSupportedUrl`/`identityEqual` 全部委托
   `AnyTogetherIdentity`）。

content.js 已经为你处理（`[当前实现]`，新 HTMLMediaElement 站点自动受益）：
- 目标选择与相位映射（§3）、`apply-state` 执行、`apply-result` 回执；
- **身份守卫**：与当前页面身份不符的权威状态 → `'rejected'`（覆盖 SPA 导航离开）；
- **revision 守卫**：过期 apply 直接按 `'applied'` 回执但不执行；
- 用户原生事件 → 语义 intent 转述（`play`/`pause`/`seeked`→seek/`ratechange`→set-rate），
  首个权威施加前不上报、settle 窗口与 700ms 待定意图窗口抑制回声、`timeupdate` 节流；
- SPA 安全重注册（1.5s 循环）：URL 变、视频出现/被替换/脱离 DOM 都触发重新注册与重推。

`[未来能力]` 非 HTMLMediaElement 播放器（自绘 canvas、内嵌 iframe 播放器等）需要新的内容侧驱动；
请以 Node 侧 `ResourceAdapter` 契约为语义参考实现它，并保持上文 §2 的失败/确定性纪律。

## 6. 测试要求

`[当前实现]` 仓库约定（新同步器必须满足，`npm test` 执行 build + `node --test dist/tests/**/*.test.js`）：
现有两个内置同步器分别有 `tests/adapters/bilibili-adapter.test.ts` 与 `tests/adapters/youtube-adapter.test.ts`
（fake page 注入），默认注册表的双站点路由在两者及 `tests/integration/dynamic-resource.test.ts` 中都有断言：

1. **fake page 注入**：测试构造 fake `document`/`location`/媒体元素传入适配器；适配器与测试都
   **不得读浏览器全局**——至少一个测试显式把 `globalThis.document/location` 换成抛错的 spy 来证明隔离。
2. **失败路径显式断言**：`'rejected'`/`'unsupported'` 必须带消息被断言，绝不伪造 `'applied'`；
   `AdapterSiteError` 断言到 `code` 级别。
3. **逐方法覆盖**：
   - `identifyResource`：canonical 化（query/hash/尾斜杠）、`resourceId` 出现/缺省、非资源页/异站/不可解析 URL 的稳定错误码；
   - `selectTarget`：最大可见面积、面积平局取文档序、过滤无可播数据候选、无候选 → `'no-media'`；
   - `readState`：全部相位映射分支（error/ended/seeking/paused/buffering/loading/playing）与时长 null 规则；
   - `applyState`：pause/play/seek（阈值内不动、阈值外 seek 且回读安定状态）、速率、`play()` 拒绝 → `'rejected'`、
     非法速率 → `'rejected'`、无目标 → `'unsupported'`（占位状态仍是合法身份）；
   - `subscribe`：10 个事件全部绑定、回调逐一收到、unsubscribe 精确清除。
4. **注册表测试**：resolve 矩阵（apex/子域/非资源页/未知/非 http(s)/不可解析 → undefined）、
   长域名优先、`duplicate-domain`/`duplicate-adapter`/`invalid-rule`（空 source、g/y 标志、编译失败）、
   失败注册不留部分状态（`size` 不变）。
5. **集成测试**（`tests/integration/dynamic-resource.test.ts` 模式）：真实 `SessionAuthority` + `SessionClient`
   在 loopback 上跑加入/绑定/切换/报告/一致性全链路。
6. 测试确定性：不依赖真实时钟语义之外的状态（fake 媒体的 seek 安定用真实 `setTimeout`，勿用假时钟驱动源码定时器）。

## 7. 错误与调试约定

| 层 | 失败形态 | 约定 |
|---|---|---|
| 页面级 | `AdapterSiteError`（identify/select/read 抛出） | 错误消息用英文、稳定、可断言（如 `Cannot parse Bilibili page URL: …`）；`code` 机器可读 |
| 施加失败 | `AdapterApplyResult.error` | 人类可读；随报告上送权威方并进入 `apply-failure` 诊断 |
| 注册期 | `AdapterRegistryError` | 注册失败立即抛出、无部分状态；`resolve` 永不抛 |
| 会话级 | 服务端 `error` 消息（`invalid-intent`、`not-joined`、`resource-unbound` …） | 见 protocol.md §8 错误码表 |
| 诊断 | `diagnostic` 消息（`desync` / `participant-left` / `actual-state-mismatch`） | 含期望 vs 实际对照；`session-status` 给机器可读 `reason` |

调试路径：`npm run smoke:process`（单机自动冒烟）→ 单测 → 集成测试；CLI `client` 的
`report`/`snapshot`/`accept`/`decline` 命令可手工驱动会话；扩展侧看 background/content 的 console
与 `GET http://127.0.0.1:<wsPort+1>/api/session`。新同步器排查顺序：先单测断言适配器语义，
再注册表 resolve 矩阵，最后集成链路；真实浏览器手工验证（`[建议约定]`，见 §8）单独记录。

## 8. 社区提交规范（`[建议约定]` 与 `[未来能力]`）

> 当前仓库尚无公开的社区提交流程；以下是在此之前新同步器必须满足的**提交清单**，也是未来 PR 的门槛。

1. **双面注册一致**：Node `AdapterRegistry` 注册 + `extension/identity.js` 注册同时提交；
   `adapterId`、`domain`、`urlRule`、`capabilities` 两处逐字一致。
2. **manifest 范围收窄**：`content_scripts.matches`/`host_permissions` 只覆盖资源页；非资源页不得注入。
3. **测试齐全**（§6 全项），且 `npm test` 全绿（当前 133 个测试全部通过，含既有基线）。
4. **能力诚实**：只声明真实实现的能力；`native-events` 必须是完整 10 事件。
5. **身份稳定**：canonical 派生规则与 `adapterId` 一旦发布不再变更（指纹/持久化/历史会话依赖它）。
6. **验证声明诚实**：单元/集成测试是仓库内证据；真实 Chrome（macOS/Windows）手工验证结果随提交注明
   实际测过的平台，未测平台不得宣称。`[当前实现]` 两个内置同步器（含 YouTube）目前也只有 Node 测试与
   扩展静态检查证据——真实 Chrome 实机/跨设备验证尚未执行，提交与文档都不得把实机能力写成已实现。
7. **版本兼容**：新增同步器不得改动 `src/shared/protocol.ts` 的现有类型/守卫（身份与 `resource-bind`
   本就泛化）；不修改 `docs/old_designs/`；不把路线图能力写成已实现（见 overview.md §5）。
8. `[未来能力]` 非媒体标量（滚动/PDF/多资源会话）需要先扩展协议与一致性判定，社区提交应在设计文档中
   显式说明协议扩展，而不是绕过守卫。
