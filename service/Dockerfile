# 构建上下文请放在 service/ 目录内（含本文件）
#   docker build -t summeretto:latest .
FROM node:22-slim

# ffmpeg：媒体渡桥（media shim，默认开启）把音频转 16x16 占位视频需要它。
# 缺 ffmpeg 不会崩，只是单条静默回退为纯音频（档位退让换听觉）。
# 若你确定不用媒体渡桥，可删掉本段并启动设 ROBIN_MEDIA_SHIM=0 进一步瘦身。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 零依赖项目：无需 npm install，直接拷 service 目录即可。
# 注意：.dockerignore 已排除 test/ tools/ docs/ .env 等非运行必需物，缩小镜像。
COPY . .

# 启动入口：按 CREDENTIAL_PERSIST 决定是否加载持久化凭证后启动 node。
RUN chmod +x docker-entrypoint.sh

# 服务默认监听 0.0.0.0:3000（HOST 留空即监听全部网卡，容器外可访问）。
ENV PORT=3000 \
    HOST= \
    # 多模态大包建议 32MB；默认仅 4.4MB，音频/视频易触发 413。
    MAX_BODY_BYTES=33554432

EXPOSE 3000

# 用 Node 自带 fetch 做健康检查（slim 镜像默认无 curl）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 凭证持久化目录（仅 CREDENTIAL_PERSIST=1 时由 /login 写入，见 docker-compose.yml）。
# 即便关闭持久化，挂一个空卷也无害。
VOLUME ["/app/env"]

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
