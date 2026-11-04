# 服务端安装与配置

[English](deployment.md) · [设备端插件安装](getting-started.zh.md) · [独立运行包](runtime.zh.md)

为各设备部署**一个 ContextMesh Server**。它通过 PostgreSQL 保存会话历史、验证设备身份，并协调会话归属和交接。DSH 与 ContextMesh 插件分别运行在执行任务的设备上；服务端机器只有在自己也运行 DSH 时才需要插件。

## 方式 A：通过源码与 Docker Compose 部署

服务端需要 Git 和 Docker Compose。[Dockerfile](../Dockerfile) 在容器内构建 API，宿主机不需要安装 Node、pnpm 或 DSH。

```sh
git clone https://github.com/MarsZheng666/ContextMesh.git contextmesh-server
cd contextmesh-server
cp .env.example .env
chmod 600 .env
```

在**仅属于服务端**的 `.env` 中配置：

| 配置                | 必填内容                                     |
| ------------------- | -------------------------------------------- |
| `CONTEXTMESH_TOKEN` | 较长的随机所有者 Token，供首台所有者设备使用 |
| `POSTGRES_PASSWORD` | 另一个随机数据库密码，需要添加这一项         |

分别执行 `openssl rand -hex 32` 生成不同的值。使用十六进制密码可以避免 Compose 数据库 URL 的转义问题。

```sh
docker compose --env-file .env -f deploy/compose.yml up --build -d
docker compose --env-file .env -f deploy/compose.yml ps
docker compose --env-file .env -f deploy/compose.yml logs -f server
```

[Compose 文件](../deploy/compose.yml) 启动 PostgreSQL 18 和 API，提供容器内的 `DATABASE_URL`，采用镜像内的 `0.0.0.0` API 监听配置，并只将 API 发布到宿主机的 `127.0.0.1:8787`。示例 `.env` 中用于原生部署的 `DATABASE_URL`、`CONTEXTMESH_HOST`、`CONTEXTMESH_PORT`、`CONTEXTMESH_NAMESPACE` 不会被此 Compose 文件透传。默认命名空间为 `personal`；自定义这些设置时，需要明确修改 Compose 的环境配置和端口映射。

PostgreSQL 仅在 Compose 网络内访问，数据存放在 `postgres-data` 命名卷中。保留该卷并另行备份数据库，删除数据卷会删除其中的历史记录。

## 让设备能够访问 API

选择一种连接方式，给每台设备配置它实际能访问的地址：

| 连接方式                   | 设备端填写的地址                                       |
| -------------------------- | ------------------------------------------------------ |
| DSH 与 Server 在同一台机器 | `http://127.0.0.1:8787`                                |
| 其他设备通过 SSH 连接      | 该设备的转发地址，例如 `http://127.0.0.1:8788`         |
| 设备直接通过网络连接       | 自己配置的 HTTPS 地址，例如 `https://mesh.example.com` |

### 通过 HTTPS 连接

在 API 前配置 TLS 反向代理。例如，直接运行在同一宿主机上的 Caddy 可以使用：

```caddyfile
mesh.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

替换域名，将 DNS 指向该服务器，并开放证书签发及 HTTPS 所需的 80/443 端口。该示例用于**宿主机上的**代理；容器内的 `127.0.0.1` 指向该容器自身。容器化代理应加入 API 所在 Docker 网络，并将上游配置为 `server:8787`。

设备端填写 `https://mesh.example.com`。数据库保持私网访问，模型提供方凭据保存在各个 DSH 中，不需要交给代理或 ContextMesh Server。

### 通过 SSH 连接

在**每台需要连接的设备上**分别建立隧道：

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8788:127.0.0.1:8787 user@server
```

将 `user@server` 换成实际 SSH 目标。保持隧道运行，该设备的 ContextMesh 地址为 `http://127.0.0.1:8788`；本机 8788 已占用时换一个端口。

API 不提供 DSH 网页。如果需要访问远程 DSH，应单独转发它的网页端口，并使用该 DSH 打印的登录地址。同时查看两个 DSH 时，一个使用 `127.0.0.1`、另一个使用 `localhost`，避免认证 Cookie 共用同一主机名。

## 连接首台所有者设备，再配对其他设备

在首台所有者设备[安装插件](getting-started.zh.md)，配置可访问的 API 地址和服务端 `CONTEXTMESH_TOKEN`。其他设备通过所有者 DSH 创建的一次性配对码加入，不再分发所有者 Token。

所有配对设备共享该 Server 配置的会话命名空间，各自获得独立、可撤销的凭据。DSH 网页登录和模型提供方登录不会自动获得 ContextMesh 访问权，详见[设备权限](devices.zh.md)。

不要将服务端 `.env` 或数据库密码复制到客户端目录。一台机器同时承担两种角色时，也使用独立的服务端和客户端目录。

## 方式 B：使用已有 PostgreSQL

需要 Git、Node.js 24.9+、pnpm 11.25.0 和可访问的 PostgreSQL。使用 PostgreSQL 18，与当前受管理部署和升级工具保持一致。

在服务端源码目录中执行：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
chmod 600 .env
```

**原生 API 部署**从 `.env` 读取以下设置：

| 配置                    | 用途                        | 默认值      |
| ----------------------- | --------------------------- | ----------- |
| `DATABASE_URL`          | 自行管理的数据库连接字符串  | 必填        |
| `CONTEXTMESH_TOKEN`     | 所有者凭据                  | 必填        |
| `CONTEXTMESH_NAMESPACE` | 当前 API 提供的会话命名空间 | `personal`  |
| `CONTEXTMESH_HOST`      | API 监听地址                | `127.0.0.1` |
| `CONTEXTMESH_PORT`      | API 端口                    | `8787`      |

将 `DATABASE_URL` 改为实际数据库地址，替换示例 Token，然后启动：

```sh
pnpm start
```

使用进程管理器时，从服务端源码目录执行 `node --env-file=.env dist/server.js`。启动时初始化数据库结构，并要求开启 `fsync` 和同步提交。网络连接方式与前面的 HTTPS、SSH 配置相同。

`pnpm db:local` 仅是本地开发替代方案：由普通用户在另一终端运行，会在 `127.0.0.1:55432` 启动与 `.env.example` 匹配的 PostgreSQL，数据保存到 `.contextmesh/postgres`。客户端设备或 Docker Compose 部署无需运行它。

## 方式 C：通过运行包生成部署

已有验证过的运行包和按摘要固定的已发布服务镜像时，可用 `contextmesh server init` 生成部署文件、密钥、所有者连接文件及可选 HTTPS 代理，见[运行包指南](runtime.zh.md#新建服务)。CI 产物在单独发布前仍是候选包；上面的默认源码 Compose 方式无需预先发布镜像。

## 日常维护与升级

- `GET /health/live` 无需认证，用于检查 API 进程存活。
- `GET /health/ready` 需要所有者或配对设备的 Bearer 凭据，检查数据库就绪状态和协议能力。已配置的设备可通过 `pnpm cli doctor` 检查连接。
- 数据库与设备配置分别备份。会话历史保存在服务端数据库；模型凭据、本地设备状态和私有连接文件保存在各设备。
- 保持 Server 和客户端版本兼容。停止或替换 API 前，让客户端完成任务、刷写数据并关闭写入权。
- 源码安装应先备份数据，再构建确认过的目标版本，用该版本重启 API 与各端 DSH。链接到同一源码目录的插件在 DSH 下次启动时加载新构建，无需增加第二个 ContextMesh 插件。
- 运行包安装分别提供[客户端升级](runtime.zh.md#客户端升级)和[服务端维护、备份与恢复](runtime.zh.md#服务维护备份与恢复)命令。这些命令管理由运行工具初始化的部署，不会自动接管任意既有 Compose 或原生服务。

当前数据库结构版本为 **6**。旧 0.6.1 服务端尚无维护 API：先停止所有旧客户端、其工具与 API，确认进程退出后备份 PostgreSQL，再替换服务端。更早的数据库结构需要明确迁移。恢复旧备份会覆盖较新的写入，是独立的数据恢复操作，不等于自动回退二进制。

数据库重启或租约过期不能证明旧写者已停止，必要时按[异常写者恢复](getting-started.zh.md#写者异常中断后的恢复)操作。当前每个 API 实例使用一个权威数据库和一个命名空间，尚不提供跨地域复制与自动故障切换。
