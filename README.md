# AnyTogether

在局域网内把两台浏览器上的媒体播放状态同步起来。AnyTogether 由一个轻量的 Node.js 会话伴随进程和一个 Chromium 浏览器扩展组成：主机负责维护权威状态，浏览器负责驱动当前页面的播放器。

项目目前聚焦于“稳定同步 + 易于接入”，外围工具负责环境配置、扩展准备和启动流程，不改变现有会话协议、同步器或播放器控制逻辑。

## 功能

- 局域网 WebSocket 会话：主机创建会话，其他浏览器加入会话并等待批准。
- 权威播放状态：播放、暂停、跳转、倍速和重新播放等意图由主机统一处理。
- 浏览器扩展：在支持的资源页中接管原生媒体元素并上报实际播放状态。
- 本地视频广播：主机可把本地视频以带令牌的 HTTP 地址共享给局域网设备。
- 多站点同步器：Bilibili、YouTube、MissAV、Pornhub、XVideos；扩展侧还支持本地视频和 arXiv PDF 资源。
- 易用性工具：一键配置、环境诊断、扩展准备、独立浏览器配置启动。

## 环境要求

- Node.js 22 或更高版本
- npm
- Chrome、Chromium 或 Brave（使用扩展时）
- 主机和参与者位于可互相访问的局域网中；防火墙需要允许 WebSocket 端口

## 快速开始

```bash
git clone <your-repository-url>
cd any-together
npm run setup
```

`setup` 会检查并安装 npm 依赖、生成未纳入版本控制的 `any-together.config.json`、编译 TypeScript，并准备 `.any-together/extension`。

然后启动主机和浏览器扩展：

```bash
npm run start
npm run extension:install
```

`extension:install` 会创建一个项目专用的浏览器配置目录，并通过 `--load-extension` 自动加载扩展，不会修改你平时使用的浏览器配置。若系统没有自动检测到浏览器，命令会打印扩展目录和手动安装步骤。

在扩展弹窗中选择“主机”并连接；另一台设备加载扩展后，填入主机输出的局域网 WebSocket 地址、Session ID 和参与者 ID，选择“从机”加入。

## 外围工具

| 命令 | 用途 |
| --- | --- |
| `npm run setup` | 一键安装依赖、生成配置、构建项目、准备扩展 |
| `npm run config` | 创建或校验本地配置 |
| `npm run doctor` | 检查 Node、依赖、构建入口、扩展和配置 |
| `npm run start` | 按本地配置启动现有 host CLI |
| `npm run extension:prepare` | 将扩展复制到 `.any-together/extension` |
| `npm run extension:install` | 启动带有扩展的独立 Chrome/Chromium/Brave 配置 |
| `npm run extension:install -- --dry-run` | 只查看扩展安装动作，不启动浏览器 |

若需要指定浏览器，可以使用浏览器别名或可执行文件路径：

```bash
npm run extension:install -- --browser chrome
npm run extension:install -- --browser /path/to/chrome --dry-run
```

## 配置

运行 `npm run config` 后，项目根目录会生成 `any-together.config.json`。该文件已被 `.gitignore` 忽略，适合保存本机路径和个人偏好；字段说明如下：

```json
{
  "$schema": "./config/any-together.config.schema.json",
  "host": {
    "port": 8765,
    "autoAccept": false,
    "sessionId": "",
    "resourceUrl": "",
    "share": "",
    "mediaPort": null
  },
  "extension": {
    "browser": "auto",
    "profileDir": ".any-together/browser-profile"
  }
}
```

- `host.resourceUrl`：用一个 Bilibili 视频 URL 预绑定会话资源；其他站点可由浏览器扩展在加入后完成资源绑定。
- `host.share`：共享本地视频文件；路径可以相对项目目录填写，启动时会转换为绝对路径。
- `host.resourceUrl` 与 `host.share` 不能同时填写。
- `host.autoAccept`：自动批准加入请求，适合自动化测试或可信的临时局域网环境。
- `extension.profileDir`：扩展安装工具使用的独立浏览器用户目录。

也可以在启动时临时覆盖配置：

```bash
npm run start -- --port 9000
npm run start -- --resource https://www.bilibili.com/video/BVxxxx
npm run start -- --share ./media/demo.mp4
```

底层命令仍然可以直接使用：

```bash
npm run start:host -- 8765
npm run start:client -- ws://127.0.0.1:8765 <session-id> <participant-id>
```

## 开发

```bash
npm run build
npm test
npm run smoke:process
npm run smoke:lan
npm run doctor
```

核心代码位于 `src/`：

```text
src/core/       播放状态、同步项和一致性监控
src/server/     WebSocket 权威会话、本地 Session API、本地媒体服务
src/client/     Node 会话客户端
src/adapters/   站点同步器和适配器注册表
src/cli/        host、client 和冒烟入口
extension/      Manifest V3 扩展、后台路由、页面驱动和弹窗
scripts/        不参与核心协议的外围工具
config/         配置示例和 JSON Schema
docs/           协议、同步器编写和设计文档
```

新增站点同步器时，需要同时更新 Node 侧注册表、扩展侧 `identity.js` 和 `manifest.json`，并为适配器添加测试；详见 [`docs/syncers/authoring.md`](docs/syncers/authoring.md)。

## 安全与边界

- 当前模型面向可信局域网，不提供公网部署所需的身份认证、TLS 或复杂权限控制。
- Session API 默认只监听 `127.0.0.1`，用于扩展读取本机 Session 信息。
- 本地视频服务使用随机令牌路径，并支持浏览器视频所需的 Range 请求。
- 自动批准加入只建议在可信环境或自动化场景使用。
- 扩展安装工具使用独立浏览器配置目录，避免污染日常浏览器配置；生成目录均已忽略，不应提交到仓库。

## 交接说明

现有核心功能保持原样。后续可以围绕外围层继续扩展：例如桌面快捷方式、系统托盘、跨平台安装包、更多浏览器检测，以及可选的图形化 Session 启动器。新增外围功能时，建议继续通过 `scripts/any-together.mjs` 和 `config/` 接入，不把操作系统或安装流程耦合进同步协议。
