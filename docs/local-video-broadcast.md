# 本地视频局域网广播（Phase 2）实现/设计文档

> 本文档记录 Phase 2「本地视频快速广播为局域网资源」的服务端、浏览器扩展接入和验证边界。PDF 标量协议（Phase 3）不在本文档范围内，只记录复用边界。
>
> 状态标记：`[本波次]` 已实现；`[未验证]` 需要真实 Chrome/双设备环境；`[未实现]` 不属于当前交付。
>
> 上位文档：`docs/roadmap.md` §6（路线图，含 R7 评审项）、`docs/syncers/protocol.md` §7（资源身份协议视角，本文档的身份约定必须与之一致）。

## 1. 目标与范围

### 1.1 目标

本地文件是"网页资源"的一个特例：伴随进程把用户明确指定的**单个本地视频文件**以带令牌的局域网 HTTP URL 暴露出来，该 URL 作为普通 `ResourceIdentity` 走现有 `resource-bind` 流程，播放/暂停/拖动/倍速完全复用网页同步语义。用户无需上传，资源不离开局域网。

### 1.2 本波次交付（服务器 + 扩展接入）

- `LocalMediaServer`（`src/server/local-media-server.ts`）：tokenized 单文件共享，GET/HEAD + HTTP Range 流式服务，安全 MIME 映射，与路径无关的 token 查表，普通文件校验，方法/状态码/响应头语义，start/stop 生命周期。
- 资源身份辅助（`src/shared/local-resource.ts`）：`local-video` 身份构造/校验 + share URL 构造。
- 主机 CLI（`src/cli/host.ts`）：`--share <绝对路径>` 与可选 `--media-port <port>`；未给 `--share` 时不创建媒体监听。
- 浏览器扩展接入：`identity.js` 注册动态 IPv4/localhost `local-video` URL；`manifest.json` 声明 `scripting` 与可选 HTTP host 权限；`background.js` 通过 popup 用户手势申请当前 origin 权限，随后动态注入 `identity.js + content.js`，并复用现有 tab 路由/播放同步链路；popup 显示授权卡片。
- 自动化测试：服务端、资源身份、Session 集成和 `tests/integration/local-video-extension.test.ts` 的浏览器注册/Manifest 行为测试。

### 1.3 当前未完成或未验证项

- **[未验证]** 真实 Chrome 加载扩展、权限弹窗和本地 `<video>` 播放端到端；当前已通过 Node 行为测试、扩展脚本语法检查、Manifest 解析、构建与本地 socket/进程冒烟。
- **[未验证]** 两台真实 Mac/Windows 设备的 play/pause/seek/rate 收敛、防火墙和编解码器矩阵。
- **[未实现]** PDF/标量同步（Phase 3 的 sync-item 协议）。

## 2. 用户流程

### 2.1 目标形态（完整流程）

1. 主机启动伴随进程并共享一个本地视频：`--share /path/to/video.mp4`；进程在局域网地址提供带令牌的 HTTP URL。
2. 主机把该 URL 绑定为会话资源（与网页资源同一 `resource-bind` 流程，见 §6）。
3. 从机收到 URL，扩展打开该 URL；内容脚本在该源上运行（权限闸口见 §10），通用媒体适配器接管播放。
4. 播放/暂停/拖动/倍速复用网页同步语义；拖动依赖服务端 Range 请求。

### 2.2 当前可验证范围

第 1–4 步已经在 Node/扩展代码层闭环：CLI 生成并绑定 token URL；双方收到权威 `local-video` identity；未授权时 popup 请求当前 `http://<lan-ip>:<port>/*` 权限；用户允许后 background 路由当前 tab，并动态注入通用 `identity.js + content.js`。真实 Chrome/双设备播放仍是 `[未验证]`，不得以 Node fake page 测试替代实机证据。

## 3. URL 与令牌契约

### 3.1 URL 形状（固定契约）

```
http://<lan-host>:<media-port>/local/<opaque-token>/video/<filename>
```

- `<lan-host>`：主机可达的 IPv4 字面量（如 `192.168.1.5`）或 `127.0.0.1`（同机）。
- `<media-port>`：媒体服务监听端口（默认 `wsPort + 2`，`--media-port 0` 为临时端口）。
- `<opaque-token>`：**令牌在 path，绝不在 query**——canonical identity 剥离 query/hash（`docs/syncers/protocol.md` §7），token 放 query 会导致双端身份派生不一致。
- `<filename>`：共享文件 basename 的 `encodeURIComponent` 结果，纯展示用途（浏览器下载名/诊断展示），服务端**只按 token 查表**，文件名不参与文件定位。
- 路径前缀 `/local/<token>/video/<filename>` 中 `video/` 段为资源类型标记（未来 PDF 复用同一字节服务时用 `/local/<token>/pdf/<filename>` 类前缀区分，见 §11）。

### 3.2 令牌

- 每次共享生成 `crypto.randomBytes(32).toString('base64url')`（43 字符，~256 bit 熵），服务启动时生成，不落盘、不可配置。
- **停止即吊销**：`stop()` 清空 token 表并关闭端口；再次共享必然生成新 token，旧 URL 永久失效（token 轮换语义）。
- 服务只认当前共享期内的 token；坏 token/未知 token 与不存在路径统一回 404（防资源存在性探测，见 §5）。

## 4. HTTP 语义（GET/HEAD + Range）

服务只实现 GET/HEAD；其余方法 → `405` + `Allow: GET, HEAD`。媒体元素播放不需要 CORS；内容脚本 fetch（若有）才需要，属 §10 权限闸口范围。

### 4.1 状态码矩阵

| 请求 | 状态码 | 说明 |
|---|---|---|
| GET/HEAD，无 Range | `200` | 整文件流式；`Accept-Ranges: bytes` + `Content-Type` + `Content-Length: <size>` + `ETag`/`Last-Modified` |
| GET/HEAD，单个合法 Range | `206` | `Content-Range: bytes <start>-<end>/<size>` + `Content-Length: <end-start+1>` + 与 200 相同的元数据头 |
| GET/HEAD，非法/多区间/不可满足 Range | `416` | `Content-Range: bytes */<size>`，空 body（固定契约：多区间不做 multipart，直接 416） |
| token 与文件不匹配 | `404`（坏 token 与非 `/local/` 路径统一 404） | 空 body，不泄露任何文件系统信息 |
| 其他方法 | `405` | `Allow: GET, HEAD` |

### 4.2 Range 细节（RFC 9110 语义）

- 单区间 `bytes=start-end`：`start ≤ end` 且 `start < size` 视为合法；`end` 超过 `size-1` 截断到 `size-1`。
- `bytes=start-`：开区间，到 EOF。
- `bytes=-N`：后缀区间，末 N 字节；`N ≥ size` 视为全文件。
- `start ≥ size` 或 `start > end`（不可满足）→ 416。
- 单位非 `bytes`、非数字、多区间 `a-b,c-d` → 416（固定契约的显式选择，不做 multipart/byteranges）。
- `If-Range`：校验器与 `ETag` 匹配 → 按 Range 回 206；不匹配 → 回 200 全量。
- `HEAD`：与对应 GET 相同响应头（含 206/`Content-Range`/`Content-Length`），零 body，不开流。

### 4.3 校验器与流式

- `ETag`：`"<sizeHex>-<mtimeMsHex>"` 强校验器；`Last-Modified`：共享期 `stat.mtime` 快照。
- 流式：`fs.createReadStream(filePath, { start, end })`（Node 默认 64KiB highWaterMark），**绝无整文件读入内存**；流的 `end` 含端点，`Content-Length` 必须为 `end - start + 1`。
- 清理：流 `error` → destroy 响应；客户端中断（请求 `close`）→ destroy 流。并发请求各自独立流，无共享可变状态。

## 5. 安全模型

本阶段最大评审点（roadmap R7）的服务器侧落地：

1. **单文件契约**：一次只共享一个明确指定的普通文件（构造时 `fs.realpath` + `stat`，必须 `isFile()`，否则启动即明确报错）；无目录浏览、无任意路径、无上传、无转码、无 P2P。
2. **URL 不派生出文件路径**：路由只按 token 查内存映射表，文件名段纯展示——目录穿越按构造消除（`..`/`%2e%2e` 变体要么命中共享文件字节、要么 404，绝不可能命中其他文件）。
3. **仅共享期监听**：未给 `--share` 不创建媒体服务（验收「未共享时不监听局域网媒体端口」）；媒体服务默认绑 `0.0.0.0`（局域网可达），而 Session API/health 保持仅 `127.0.0.1`。
4. **令牌防扫描**：43 字符 base64url 随机令牌防局域网任意访问；坏 token 与不存在路径统一回 404（不区分资源存在性，防探测），停止共享即吊销，轮换 = 重共享 = 新身份（§6.3）。
5. **错误不泄露**：错误响应一律空 body（媒体服务不是 API，不返回 JSON 信封），不暴露文件系统路径/目录结构。

## 6. 资源身份与注册

### 6.1 身份形状

`local-video` 是普通 `ResourceIdentity`，协议层**零改动**（`isValidResourceIdentity` 站点无关，`resource-bind` 原样服务）：

```ts
{ adapterId: 'local-video', canonicalUrl: 'http://<host>:<port>/local/<token>/video/<filename>', resourceId: '<filename>' }
```

- `canonicalUrl` = origin + 去尾斜杠 pathname（去 query/hash，与协议 §7 一致），即完整 token URL。
- `resourceId` = 文件 basename（URL 中解码后的文件名段，稳定 token/文件键，诊断展示用）；相等性由三字段全等（`isResourceIdentityEqual`）驱动，实际由 `canonicalUrl` 决定。
- 校验：http(s)；host 为 IPv4 字面量或 `127.0.0.1`/`localhost`（v1 拒绝域名）；path 匹配 `/local/<token>/video/<segment>`。错误走独立错误类型（稳定 code：`invalid-url` / `not-local-video` / `invalid-token-path`），不动 `src/shared/resource.ts` 的 Bilibili 守卫。

### 6.2 单 URL 共享规则（loopback vs LAN）

同一媒体文件有 loopback 与 LAN 两种 URL 形式，`canonicalUrl` 不同 ⇒ **两个不同身份**。规则：**全会话只绑定一个 URL 串**——从机可直达时绑 LAN 形式；同机场景绑 `127.0.0.1` 形式。CLI 打印两种形式，但只把其中一个绑定进会话；从机 actual-state 报告身份来自权威状态，天然跟随。双端打开不同 host 形式 = 身份失配（`resource-mismatch`），测试固化此规则。

### 6.3 绑定与轮换

- 绑定：与网页资源同一 `resource-bind` 流程；绑定相同身份是 no-op，不同身份触发资源切换（revision bump、playhead 归零）——协议已有语义。
- 轮换：重共享生成新 token → 新 canonicalUrl → 新身份 → 走既有 `resource-bind` 切换，**零协议改动**。

## 7. 主机 CLI

### 7.1 参数

- `--share <绝对路径>`：共享指定文件并启动媒体服务；缺失/非文件路径 → 启动时明确报错退出。
- `--media-port <port>`：媒体端口（默认 `wsPort + 2`，即默认 8765 → 8767；`0` = 临时端口）。
- 未给 `--share`：不创建媒体服务，现有 host/session 参数（端口、`--session-id`、`--auto-accept`、URL）行为完全不变。

### 7.2 示例

```bash
# 默认端口共享一个 mp4（媒体端口 8767）
node dist/src/cli/host.js 8765 --share /Users/me/Videos/movie.mp4

# 显式媒体端口 + 固定会话 ID（原有参数不受影响）
node dist/src/cli/host.js 8765 --session-id demo --share /Users/me/Videos/movie.mp4 --media-port 9123

# 不共享（原行为：无媒体监听）
node dist/src/cli/host.js 8765
```

### 7.3 启动/停止顺序

- 启动：解析参数 → 校验共享文件 → 创建并 `start()` 媒体服务 → 用 `createLocalVideoResourceIdentity` 构造身份 → 以该身份启动 `SessionAuthority`（绑定）→ 启动 SessionApi。
- 输出：打印 loopback + LAN 两个媒体 URL 与媒体端口、绑定进会话的身份 JSON。
- 停止（SIGINT/SIGTERM）：先 `mediaServer.stop()`（吊销 token、`closeAllConnections()` 强制终止在途流、释放端口）→ 再 `api.stop()` → `authority.stop()`；新一次共享必然是新 token。

## 8. 生命周期

| 事件 | 行为 |
|---|---|
| `start()` | 返回 `{ host, port, shared: { token, urlPath, size, contentType, etag, lastModified } }`；文件校验失败抛错 |
| `stop()` | 清 token 表 → `server.close()` + `closeAllConnections()`（防止客户端暂停在缓冲边界导致 close 挂起）→ 释放端口 → shared 置空 |
| stop 后在途流 | 客户端连接被终止；stop 后新请求 `ECONNREFUSED`；端口可立即重绑 |
| 再次 start | 生成**不同** token，旧 URL 死链 |
| 共享期文件被改动 | 以共享期 stat 快照为准（size/ETag/Last-Modified/流式边界不变），v1 不做 watch |

## 9. 失败与编解码器策略

- **编解码器不一致**：不做转码。从机缺编码时媒体元素触发 `error` → 适配器映射为 `'error'` 相位 → 显式诊断报错（协议 §3.4 终态提升），**绝不黑屏挂起或伪装成功**。编解码器矩阵（浏览器/OS 差异）记录为真实双机验证项。
- **共享文件不可用**：启动时缺失/非普通文件 → CLI 明确报错退出（不进入半启动状态）。
- **防火墙**：macOS/Windows 首次监听可能弹窗打断流程——CLI 打印引导文案（loopback 形式不受防火墙影响）；记录为实机验证项。
- **大文件/弱网**：流式 + Range 缓解，不做 P2P 分发（roadmap 6.6 记录，未来 `[需评审]`）。

## 10. 浏览器扩展权限闸口（已实现，实机待验证）

本阶段不使用 `<all_urls>` 静态注入。主机 CLI 仍是唯一需要运行的伴随进程；从机只需安装扩展，首次访问某个主机的本地视频 origin 时在 popup 明确授权。

### 10.1 运行流程

```text
权威状态携带 http://<lan-ip>:<media-port>/local/<token>/video/<file>
  -> identity.js 的 local-video 注册项解析动态 IPv4/localhost URL
  -> background 暂停路由并记录 origin + origin/* 权限请求
  -> popup 展示“本地视频访问授权”卡片
  -> 用户点击允许（chrome.permissions.request，保持用户手势）
  -> background 检查权限并 tabs.update 当前参与者 tab
  -> chrome.scripting.executeScript 注入 identity.js + content.js
  -> content-ready 触发现有权威状态 apply/report 链路
```

### 10.2 权限与匹配边界

- `manifest.json` 只增加 `scripting` 和 `optional_host_permissions: ["http://*/*"]`；运行时实际请求的是当前 `origin/*`，不是全站静态 host permission。
- `identity.js` 的 `local-video` 使用 wildcard URL 注册，但 URL rule 限制为 HTTP、localhost/合法 IPv4、`/local/<token>/video/<filename>`；公共域名、HTTPS、错误路径不会解析为本地资源。
- 本地视频不加入静态 `content_scripts.matches`，避免对任意 LAN 页面自动注入；动态注入前通过 `chrome.permissions.contains` 再检查，脚本重启后用 `content-ping` 防止重复 listener/timer。
- `routeCanonical` 继续复用现有单 tab 路由：权限未获批时不打开资源页；授权后覆盖当前 host/client tab，不创建重复播放窗口。

### 10.3 未验证边界

- 需要真实 Chrome 验证 MV3 权限请求、service worker 生命周期、HTTP 局域网媒体加载、autoplay 策略和跨设备防火墙。
- 本地服务使用高熵 token；权限只解决内容脚本注入，不替代 token 访问控制。媒体服务仍只绑定明确共享文件。

## 11. PDF 复用边界与非目标

### 11.1 复用边界（未来，非本波次）

未来 PDF 同步**复用本服务的字节能力**：同一 tokenized 单文件 Range 服务可服务 `/local/<token>/pdf/<filename>` 类路径（资源类型段区分），无需新服务组件。但 **PDF 标量协议（sync-item 模型、scalar 语义、滚动节流）属于 Phase 3**，本文档不实现、不设计其协议细节；本波次不编写任何 PDF 相关代码。

### 11.2 非目标（本波次及 Phase 2 整体）

- 不做转码、不做上传公网、不做 P2P、不做字幕/音轨同步。
- 不做文件目录浏览（一次共享一个明确文件）。
- 不做本地文件直连同步（不从播放器直接读本地文件；一切走 URL）。
- 不做多资源会话、不做 PDF/滚动/缩放同步。

## 12. 交付物与验收对照（本波次）

| 验收（roadmap 6.5 对应） | 落地 |
|---|---|
| 主机共享本地 mp4，从机经局域网 URL 播放（play/pause/seek/rate 收敛基线） | CLI/身份/路由/动态注入代码已落地 `[本波次]`；真实 Chrome/双设备播放 `[未验证]` |
| Range 请求验证（seek 秒级开始、不整文件下载） | `tests/server/local-media-server.test.ts`（200/206/416/HEAD/并发） |
| 无令牌请求被拒绝；未共享时不监听局域网媒体端口 | 坏 token/未知路径统一 404；CLI 无 `--share` 行为不变 |
| 两端编解码器不一致显式报错而非黑屏挂起 | 协议 `'error'` 相位已有；真实浏览器行为 `[未验证]` |
| 既有测试全绿 + 媒体服务/身份/扩展注册测试 | `npm test` 224/224；`smoke:lan`、`smoke:process` 通过；扩展脚本/Manifest 静态检查通过 |

文件地图：`src/server/local-media-server.ts`、`src/shared/local-resource.ts`、`src/cli/host.ts`、`extension/manifest.json`、`extension/identity.js`、`extension/background.js`、`extension/content.js`、`extension/popup.html`、`extension/popup.js`、`tests/integration/local-video-extension.test.ts`。

## 13. 交接与实机验证

服务器和扩展接入已完成，下一步只做真实环境验证与缺陷修复：

1. 在主机运行 `node dist/src/cli/host.js 8765 --share /绝对路径/video.mp4`。
2. 主机和从机都加载/重新加载 MV3 扩展；主机 popup 选择“主机”并连接本机 Session，从机 popup 选择“从机”并填写主机 LAN IP、WS 端口和 Session ID。
3. 从机收到本地 URL 后，在 popup 点击“允许并继续同步”；两端等待页面加载和就绪状态。
4. 在任一端原生播放器执行 play/pause/seek/rate，记录双方收敛、Range 请求、防火墙和编解码器结果。
5. 若实机发现问题，只修复对应扩展/媒体边界；不把真实 Chrome/双设备结果用 Node 测试替代。

未来 PDF 仍复用 tokenized 字节服务，但需要另行评审 `sync-item` 标量协议。
