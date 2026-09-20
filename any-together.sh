#!/usr/bin/env sh
# AnyTogether 主机 CLI 交互式启动器。
# 用法:
#   ./any-together.sh                    # 交互式询问端口与会话名称
#   ./any-together.sh --port 9000 --name movie-night
#   ./any-together.sh --port 9000        # 跳过端口询问
# 其余参数原样透传给 host 进程（如 --share、--auto-accept）。
set -eu
cd "$(dirname "$0")"

PORT=""
NAME=""
PASSTHROUGH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { echo "any-together: --port 需要一个值" >&2; exit 2; }
      PORT="$2"; shift 2 ;;
    --port=*)
      PORT="${1#--port=}"; shift ;;
    --name)
      [ $# -ge 2 ] || { echo "any-together: --name 需要一个值" >&2; exit 2; }
      NAME="$2"; shift 2 ;;
    --name=*)
      NAME="${1#--name=}"; shift ;;
    *)
      PASSTHROUGH="$PASSTHROUGH $1"; shift ;;
  esac
done

echo "AnyTogether 主机 CLI"
if [ -z "$PORT" ]; then
  printf '监听端口 [8765]: '
  read -r PORT || PORT=""
fi
PORT=${PORT:-8765}
case "$PORT" in
  ''|*[!0-9]*) echo "any-together: 端口必须是数字: $PORT" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "any-together: 端口需在 1-65535 之间: $PORT" >&2
  exit 2
fi

if [ -z "$NAME" ]; then
  printf '会话名称（可选，不含空格，直接回车跳过）: '
  read -r NAME || NAME=""
fi
case "$NAME" in
  *[[:space:]]*) echo "any-together: 会话名称不允许包含空格: $NAME" >&2; exit 2 ;;
esac

echo "正在构建并启动…"
npm run build --silent

exec node dist/src/cli/host.js "$PORT" ${NAME:+--name "$NAME"} $PASSTHROUGH
