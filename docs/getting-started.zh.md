# 快速开始

只需安装一个完整插件，即可使用远程持久化、跨机器交接和确认接管。

本指南介绍如何把 DeepSeek Harness profile 接入自行部署的 ContextMesh 服务。需要 Node.js 24.9+、pnpm 11.25.0 和 DeepSeek Harness 0.2.1-rc.3。

## 构建与配置

```sh
git clone https://github.com/MarsZheng666/ContextMesh.git
cd ContextMesh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
```

将 `.env` 中的示例 `CONTEXTMESH_TOKEN` 替换为随机 Token：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

| 服务端参数              | 用途                        | 默认值                                  |
| ----------------------- | --------------------------- | --------------------------------------- |
| `DATABASE_URL`          | PostgreSQL 连接字符串       | 必填；`.env.example` 指向本地开发数据库 |
| `CONTEXTMESH_TOKEN`     | 与客户端共用的 Bearer Token | 必填                                    |
| `CONTEXTMESH_NAMESPACE` | 当前实例提供的会话命名空间  | `personal`                              |
| `CONTEXTMESH_HOST`      | API 监听地址                | `127.0.0.1`                             |
| `CONTEXTMESH_PORT`      | API 端口                    | `8787`                                  |

服务启动时会初始化数据库表，并检查同步持久化配置。

## 启动 PostgreSQL 与 API

本地开发可以使用附带的数据库启动器。请用普通用户运行，并保持终端开启：

```sh
pnpm db:local
```

开发数据库监听 `127.0.0.1:55432`，数据保存在 `.contextmesh/postgres`。正式部署时使用独立管理的 PostgreSQL。

在另一个终端进入仓库根目录：

```sh
pnpm start
```

API 默认地址为 `http://127.0.0.1:8787`。`GET /health/ready` 需要配置的 Bearer Token，并返回数据库就绪状态。

## 安装 Harness 插件

使用本仓库已经构建的锁定运行时，在仓库根目录安装唯一的完整插件：

```sh
export DSH_HOME="$HOME/.dsh-contextmesh"
export CONTEXTMESH_ENDPOINT=http://127.0.0.1:8787
export CONTEXTMESH_TOKEN='your-token-from-.env'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh --profile web
```

完整插件自动加载持久化组件，安装列表只有一个 ContextMesh 条目。设备命名、项目目录映射、主动交接和发送时确认接管见[会话交接指南](handoff.zh.md)。Harness 从启动环境读取服务令牌，不会自动读取本仓库的 `.env`。

### sdk-minimal profile

`sdk-minimal` 的默认存储条目 ID 不同，请使用[专用 overlay](../examples/deepseek/sdk-minimal.patch.yml)，不要直接使用 base profile 的 bundle。确保该 profile 能解析 `dsh-contextmesh`，在启动 `dsh --profile sdk-minimal` 时通过 `--patch` 传入 overlay。

base bundle 和 SDK overlay 用于不同的 profile 组合，不应叠加安装。

## 查询与导出

CLI 从仓库根目录的 `.env` 读取配置：

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
pnpm cli operation OPERATION_ID
```

连接远程服务时，在 `.env` 中补充 `CONTEXTMESH_ENDPOINT`，指向 HTTPS 地址或本机 SSH 隧道入口。export 将完整原生日志输出到标准输出。

## 从另一台机器恢复

1. 两端 Harness 使用同一服务地址和 Token。
2. 单独准备目标机器的代码工作区。
3. 停止来源 Harness 运行进程，或显式释放其 Agent，等待持久化关闭流程释放写入权。
4. 在目标 Harness 的正常恢复入口打开同一个 Session ID。

仅关闭浏览器标签页，不会释放仍在运行的 Harness 服务所持有的写入权。同一 Session 只有一个写者。已有写者运行时，仍可通过只读句柄查看历史。当前版本尚不提供自动目录映射和交接协调。

工作区分组和标题缓存由各个 Harness 实例管理。对于尚未建立本地标题投影的远程 Session，界面可能暂时显示目录名；原始事件历史仍保存在 ContextMesh 中。

## 写者异常中断后的恢复

先确认旧 Harness 进程及其工具已经停止，等待租约到期，再执行：

```sh
pnpm cli recover SESSION_ID --confirm-stopped
```

之后通过 Harness 恢复会话。租约只保护日志写入权，不会停止 shell 命令或撤销外部 API 操作；仅重启数据库也不会释放 Session 写入权。

配置项和存储语义见[插件接口](api/deepseek-adapter.md)，Docker 与 SSH 连接见[部署指南](deployment.md)。
