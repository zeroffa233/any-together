#!/usr/bin/env sh
# AnyTogether 主机 CLI 启动器。
# 优先级：命令行参数 > 当前目录唯一的 .yml > 内置默认值。
# 用法:
#   ./any-together.sh
#   ./any-together.sh --port 9000 --name movie-night
#   ./any-together.sh --config /path/to/session.yml
set -eu
cd "$(dirname "$0")"

echo "AnyTogether 主机 CLI"

# Explicit arguments are forwarded byte-for-byte. The host resolves omitted
# fields from YAML and then built-in defaults.
if [ "$#" -gt 0 ]; then
  echo "正在构建并启动…"
  npm run build --silent
  exec node dist/src/cli/host.js "$@"
fi

# With no arguments, let the host auto-discover the sole root-level .yml.
# Multiple files are rejected by the host instead of choosing unpredictably.
set -- ./*.yml
if [ -f "$1" ]; then
  echo "检测到 .yml 运行配置，正在构建并启动…"
  npm run build --silent
  exec node dist/src/cli/host.js
fi

# Preserve the original interactive experience when no YAML exists.
printf '监听端口 [8765]: '
read -r PORT || PORT=""
PORT=${PORT:-8765}
case "$PORT" in
  ''|*[!0-9]*) echo "any-together: 端口必须是数字: $PORT" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "any-together: 端口需在 1-65535 之间: $PORT" >&2
  exit 2
fi

printf '会话名称（可选，不含空格，直接回车跳过）: '
read -r NAME || NAME=""
case "$NAME" in
  *[[:space:]]*) echo "any-together: 会话名称不允许包含空格: $NAME" >&2; exit 2 ;;
esac

set -- "$PORT"
if [ -n "$NAME" ]; then
  set -- "$@" --name "$NAME"
fi

echo "正在构建并启动…"
npm run build --silent
exec node dist/src/cli/host.js "$@"
