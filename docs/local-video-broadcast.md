# 本地视频局域网广播（Phase 2）实现/设计文档

> 本文档是 Phase 2「本地视频快速广播为局域网资源」的实现与交接文档：先交付**服务器基础（server foundation）**，再在下一阶段补齐浏览器扩展的运行时权限/注入。PDF 标量协议（Phase 3）不在本文档范围内，只记录复用边界。
>
> 状态标记：`[本波次]` 本波次（服务器基础）交付；`[未实现]` 明确未实现，属于下一阶段或后续阶段。
>
> 上位文档：`docs/roadmap.md` §6（路线图，含 R7 评审项）、`docs/syncers/protocol.md` §7（资源身份协议视角，本文档的身份约定必须与之一致）。

## 1. 目标与范围

### 1.1 目标

本地文件是"网页资源"的一个特例：伴随进程把用户明确指定的**单个本地视频文件**以带令牌的局域网 HTTP URL 暴露出来，该 URL 作为普通 `ResourceIdentity` 走现有 `resource-bind` 流程，播放/暂停/拖动/倍速完全复用网页同步语义。用户无需上传，资源不离开局域网。

### 1.2 本波次交付（服务器基础，Node 侧闭环）

- `LocalMediaServer`（`src/server/local-media-server.ts`）：tokenized 单文件共享，GET/HEAD + HTTP Range 流式服务，安全 MIME 映射，与路径无关的 token 查表，普通文件校验，方法/状态码/响应头语义，start/stop 生命周期。
- 资源身份辅助（`src/shared/local-resource.ts`）：`local-video` 身份构造/校验 + share URL 构造。
- 主机 CLI（`src/cli/host.ts` 修改）：`--share <绝对路径>` 与可选 `--media-port <port>`；未给 `--share` 时不创建任何媒体监听（现有行为不变）。
- 自动化测试：`tests/server/local-media-server.test.ts`（Range/鉴权/流式/生命周期）、`tests/integration/local-video-resource.test.ts`（身份契约）。

### 1.3 明确不在本波次（防止误读为已实现）

- **[未实现]** 浏览器扩展对任意局域网 IP 的运行时权限与内容脚本注入（manifest/identity.js/background.js 改动）——见 §10。
- **[未实现]** 本地视频的端到端浏览器播放（从机扩展打开共享 URL → 内容脚本接管 → 通用媒体适配器同步）——依赖 §10 的权限闸口，本波次**不声称**已支持。
- **[未实现]** PDF/标量同步（Phase 3 的 sync-item 协议）——见 §11 复用边界。

## 2. 用户流程

### 2.1 目标形态（完整流程）

1. 主机启动伴随进程并共享一个本地视频：`--share /path/to/video.mp4`；进程在局域网地址提供带令牌的 HTTP URL。
2. 主机把该 URL 绑定为会话资源（与网页资源同一 `resource-bind` 流程，见 §6）。
3. 从机收到 URL，扩展打开该 URL；内容脚本在该源上运行（权限闸口见 §10），通用媒体适配器接管播放。
4. 播放/暂停/拖动/倍速复用网页同步语义；拖动依赖服务端 Range 请求。

### 2.2 本波次可验证范围

第 1–2 步在 Node 侧闭环（CLI 打印 URL → 身份构造 → 绑定进 `SessionAuthority`）；第 3–4 步的浏览器侧 `[未实现]`。自动化测试只验证服务端语义与身份契约，**不以单测冒充端到端浏览器支持**。

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

## 10. 浏览器扩展权限闸口（下一阶段，`[未实现]`）

服务器基础不依赖以下任何一项；本波次**不声称**本地视频端到端浏览器支持。下一阶段必须解决：

### 10.1 问题本质

- manifest 的 `content_scripts.matches` / `host_permissions` 是**安装期静态**站点清单（当前仅 Bilibili/YouTube 的 https 条目），无法静态覆盖未知的局域网 IP:port。
- `extension/identity.js` 注册模型按域名注册、按 hostname 精确/子域匹配，任意 LAN IP 无法静态注册。
- 注：`<video>` 播放本身不需要 CORS/host 权限——**内容脚本注入是唯一闸口**。

### 10.2 候选方案（需用户拍板，roadmap R7）

1. `<all_urls>` 宽注入：简单但权限过宽，与最小权限原则冲突。
2. 精确注入：`optional_host_permissions` + `chrome.permissions.request({ origins: ['http://<ip>:<port>/*'] })` + `chrome.scripting.registerContentScripts`（需 `scripting` 权限 + 用户手势）。
3. identity.js 需新增运行时多 host 注册 API（同一 `local-video` adapterId 挂多个 IP 字面量 host），background 收到会话 URL 后先注册再路由。

### 10.3 已确认的复用面（服务端合入后即成立）

- `background.js` 的 `routeCanonical`/apply/report 链路是 URL 无关的：一旦 `IDENTITY.isSupportedUrl(canonicalUrl)` 通过，现有路由与状态应用原样复用。
- `content.js` 本就是与站点无关的 HTMLMediaElement 驱动（对应 roadmap 6.4「复用 generic-media」）。
- 遗留待实机确认：background fetch `http://127.0.0.1` 本机 API 是否需要补 `host_permissions`（真实 Chrome 行为）。

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
| 主机共享本地 mp4，从机经局域网 URL 播放（play/pause/seek/rate 收敛基线） | 服务器侧闭环 `[本波次]`；浏览器端到端 `[未实现]`，待 §10 |
| Range 请求验证（seek 秒级开始、不整文件下载） | `tests/server/local-media-server.test.ts`（200/206/416/HEAD/If-Range/并发） |
| 无令牌请求被拒绝；未共享时不监听局域网媒体端口 | 坏 token/未知路径统一 404（roadmap 验收原文写 403，实现取 404 以不区分资源存在性，语义一致）；CLI 无 `--share` 行为不变 |
| 两端编解码器不一致显式报错而非黑屏挂起 | 服务器侧不可测（浏览器行为）；`'error'` 相位路径协议已有，实机验证项 |
| 既有测试全绿 + 媒体服务/身份测试 | 本波次测试 + 主验证全量回归 |

文件地图：`src/server/local-media-server.ts`（新建）、`src/shared/local-resource.ts`（新建）、`src/cli/host.ts`（修改）、`tests/server/local-media-server.test.ts`（新建）、`tests/integration/local-video-resource.test.ts`（新建）、本文档（新建）。

## 13. 交接给下一阶段

下一阶段（扩展权限/注入 + 端到端验证）开始前需要：

1. **用户拍板注入方案**（§10.2：`<all_urls>` vs 运行时权限请求），评审产出决定 + 记录（roadmap R7）。
2. identity.js 运行时多 host 注册 API + background 路由接线（§10.2-3）。
3. manifest 作用域/权限修改 + 真实 Chrome 加载验证（含 127.0.0.1 fetch 权限确认）。
4. 真实双机共享验证：play/pause/seek（拖动到未缓冲区间）/rate 收敛基线、防火墙引导记录、编解码器矩阵显式报错记录。
5. 共享 URL 的 popup 展示（SessionInfo 的 mediaUrl/mediaPort 可选字段，随实现波次决定）。

本波次服务器基础合入时，以上 1–4 项**保持未实现状态**，文档与代码均不得声称已支持本地视频端到端浏览器同步。
