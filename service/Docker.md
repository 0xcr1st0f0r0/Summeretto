# Summeretto · Docker 自托管

零依赖 Node 22 服务，打包 Docker 异常省事：无需 `npm install`，纯 `node server.mjs` 起。

## 0. 启动前配置

`docker-compose.yml` 中以下两项默认为空，置空即可启动；留空行为如下：

| 变量 | 作用 | 留空行为 |
|---|---|---|
| `PROXY_API_KEY` | 下游调用密钥，调用方通过 `x-goog-api-key` 头或 `?key=` 参数传入 | 不校验调用方，任何人均可调用本服务 |
| `ADMIN_KEY` | 凭证管理端点（`/admin/gpsoauth`、`/admin/token`）的口令 | admin 端点整体禁用并返回 404；`/login` 页面内置提示告知绑定端点已禁用 |

```bash
docker compose up -d --build
```

> 两项留空不影响服务启动，缺项提示由服务自身给出。
> 服务对外暴露时应将两项设置为强随机值。

## 1. 构建镜像

```bash
cd service
docker build -t summeretto:latest .
```

镜像基于 `node:22-slim`，并安装了 `ffmpeg`（媒体渡桥默认开启所需）。
服务默认监听 `0.0.0.0:3000`，并已内置 `/healthz` 健康检查。

## 2. 运行

### 方式 A：docker compose（推荐）

```bash
docker compose up -d --build
```

### 方式 B：纯 docker run

```bash
docker run -d --name summeretto -p 3000:3000 \
  -e PROXY_API_KEY="<下游调用密钥>" \
  -e ADMIN_KEY="<admin 口令>" \
  -e GSA_EMAIL="you@gmail.com" \
  -e GSA_MASTER_TOKEN="oauth2rt_1/..." \
  summeretto:latest
```
> 不指定 `CREDENTIAL_PERSIST` 时默认即为 `1`（持久化开启）；
> 若只需环境变量注入、不需要落盘，显式指定 `-e CREDENTIAL_PERSIST=0`。
> `ADMIN_KEY` 亦可不通过 `-e` 传入，而写入挂载卷内的 `.env`（路径 `/app/env/.env`）；
> 入口脚本每次启动均会载入该文件，容器重建后口令仍然有效。

## 3. 凭证：环境变量注入 与 持久化（Docker 配置项 `CREDENTIAL_PERSIST`）

**默认开启持久化（`CREDENTIAL_PERSIST=1`）**——最贴近原作者的 `.env` 设计：
通过网页 `/login` 拿到的 master token 会写回挂载卷内的 `.env`，
并在每次启动时由 `docker-entrypoint.sh` 重新 source，凭证跨重启自动保留。

凭证有两种来源，可并存：

### 方式 A：网页登录持久化（默认，推荐自托管）

直接访问 http://127.0.0.1:3000/login 完成授权，
token 自动落盘到卷内 `.env`，无需手动维护任何文件。

```yaml
environment:
  CREDENTIAL_PERSIST: "1"   # 默认值；/login 把 master token 写回挂载卷内的 .env
volumes:
  - summeretto_env:/app/env # 持久化存储，跨重启保留
```

### 方式 B：环境变量注入

仍可直接通过 compose `environment:` 或 `docker run -e` 注入
`GSA_EMAIL` / `GSA_MASTER_TOKEN` / `PROXY_API_KEY` 等。
服务**只读环境变量**；当 `CREDENTIAL_PERSIST=1` 时这些变量与卷内 `.env` 并存，
`.env` 中的值仅在文件存在时追加/覆盖。

### 关闭持久化

把 `CREDENTIAL_PERSIST` 设为 `"0"`：`/login` 绑定成功后不落盘，
容器重启即需重新注入或重新登录。

> 安全提示：持久化卷内的 `.env` 含长期有效的 master token，权限 0600。
> 服务对外暴露时，`PROXY_API_KEY` / `ADMIN_KEY` 应设置为强随机值。

## 4. 验证

```bash
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool
# 然后开 http://127.0.0.1:3000/login 走网页登录拿 token
# （需已配置 ADMIN_KEY，否则绑定端点禁用，页面会给出提示）
```

## 5. 已知坑

| 项 | 说明 |
|---|---|
| ffmpeg | 媒体渡桥默认开，缺它会静默回退为纯音频（可用 `ROBIN_MEDIA_SHIM=0` 关掉） |
| 入站上限 | `MAX_BODY_BYTES` 默认 4.4MB，发音频/视频易 `413`；compose 已设 32MB |
| 重启纪律 | 重启前先 `curl .../healthz` 确认 `inflight==0`，否则在途请求被掐 + 上游已计费 + 客户端重发 = 重复扣费 |

## 6. 文件清单

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 基于 node:22-slim，装 ffmpeg，暴露 3000，内置健康检查 |
| `docker-entrypoint.sh` | 按 `CREDENTIAL_PERSIST` 加载持久化凭证后启动 node |
| `docker-compose.yml` | 一键编排 + 32MB 上限 + 健康检查 + 凭证持久化开关 |
| `.dockerignore` | 排除 test/tools/docs/.env 等非运行必需物 |
| `.env.example` | 环境变量模板（含 `CREDENTIAL_PERSIST` / `ROBIN_ENV_FILE` 说明） |
