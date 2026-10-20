#!/bin/sh
# service/docker-entrypoint.sh —— Summeretto 容器启动入口
#
# 唯一职责：按 Docker 配置项 CREDENTIAL_PERSIST 决定是否在启动前
# 加载持久化凭证文件（由 /login 落盘的 .env），随后把控制权交给 node。
#
# 关键：必须用 exec 移交，使 node 直接收到 SIGTERM，
# 否则优雅停机（lib/inflight.js 接管 SIGTERM 护送在途请求）会失效。
set -e

# ── 凭证持久化（Docker 配置项 CREDENTIAL_PERSIST）──────────────────────
#   1（默认）/ 未设：启用 .env 落盘——/login 把 master token 写回 ROBIN_ENV_FILE，
#     本入口在每次启动时 source 该文件，使凭证跨容器重启保留
#     （ROBIN_ENV_FILE 指向的路径需位于已挂载的 volume 内，见 docker-compose.yml）。
#     这是最符合原作者 .env 设计的方式。
#   0：凭证完全来自容器环境变量（compose environment 或 docker run -e）。
#     /login 绑定成功后不落盘，重启即需重新注入或重新登录。
if [ "${CREDENTIAL_PERSIST:-1}" = "1" ]; then
  ENV_FILE="${ROBIN_ENV_FILE:-/app/env/.env}"
  export ROBIN_ENV_FILE="$ENV_FILE"
  if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
    echo "[entrypoint] 已从 $ENV_FILE 加载持久化凭证"
  else
    echo "[entrypoint] CREDENTIAL_PERSIST=1，但 $ENV_FILE 尚不存在，将在首次 /login 绑定后创建"
  fi
fi

exec "$@"
