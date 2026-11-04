# 安装和配置设备端插件

[English](getting-started.md) · [服务端安装](deployment.zh.md) · [设备配对](devices.zh.md)

本指南在**每台运行 DSH 的设备上**使用。先部署一个 [ContextMesh Server](deployment.zh.md)，设备只需配置服务地址和凭据，无需安装 PostgreSQL 或启动本地 ContextMesh API。

## 选择安装方式

- **源码安装：** 按下方步骤操作，需要 Git、Node.js 24.9+ 和 pnpm 11.25.0。
- **独立运行包：** 包含 Node、兼容的 DSH 和同一个完整插件。候选包获取、支持平台、配置与升级方式见[运行包指南](runtime.zh.md)。

两种方式均使用锁定的 DSH 0.2.1-rc.3 和本仓库的兼容补丁，不能用任意全局安装的 DSH 替代。

## 安装 Harness 插件

使用独立的客户端源码目录；即使 Server 和 DSH 在同一台机器，也不要共用服务端目录：

```sh
git clone https://github.com/MarsZheng666/ContextMesh.git contextmesh-client
cd contextmesh-client
corepack enable
pnpm install --frozen-lockfile
pnpm build

export DSH_HOME="$HOME/.dsh-contextmesh"
export CONTEXTMESH_NODE_NAME='My laptop'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
```

安装列表只显示 `dsh-contextmesh-handoff`，持久化组件在内部加载。配置和启动时保持相同的 `DSH_HOME`。每个 DSH 实例使用自己的主目录，不要复制其他设备的主目录或 `node.json`。

不要在客户端源码目录创建服务端 `.env`。源码 CLI 会加载仓库中的 `.env`，而 `pnpm exec dsh` 不会自动加载它；遗留的所有者 Token 可能覆盖配对设备保存的凭据。

## 配置服务连接

| 设备端配置           | 在哪里设置                                                     |
| -------------------- | -------------------------------------------------------------- |
| 服务地址             | 私有连接文件的 `endpoint`，或 `CONTEXTMESH_ENDPOINT`           |
| 设备凭据             | 配对自动写入 `token`；仅首台所有者设备使用服务端的所有者 Token |
| 设备身份与名称       | 配对自动写入 `nodeId` 和 `name`；所有者配置方式见下文          |
| DSH 数据目录         | `DSH_HOME`，本指南使用 `$HOME/.dsh-contextmesh`                |
| 模型提供方与 API Key | 在本机 DSH 中配置，与 ContextMesh 独立                         |

**默认使用 HTTPS 直连**，例如 `https://mesh.example.com`，实际使用时替换为已部署的服务地址。各设备用自己的凭据连接同一个地址，无需配置 SSH。配对前先完成服务端的 [HTTPS 配置](deployment.zh.md#https-直连默认)。

选择可选的 SSH 专用部署时，使用 [SSH 指南](deployment.zh.md#可选-ssh-隧道)中的本机转发地址。同机本地开发可使用 `http://127.0.0.1:8787`。

### 首台所有者设备：先验证连接

在客户端目录中，保持前面的 `DSH_HOME` 已设置：

```sh
export CONTEXTMESH_ENDPOINT='https://mesh.example.com'
export CONTEXTMESH_TOKEN='your-server-owner-token'
pnpm cli doctor
```

Token 来自服务端的 `CONTEXTMESH_TOKEN`，仅保存在所有者设备上。这些环境变量只对当前终端生效，后续启动需要相同环境，或使用保存的连接文件。

### 保存所有者连接

如果 DSH 已在运行，先完成任务并停止它，再更改连接配置。需要持久配置时，在 `$DSH_HOME/contextmesh/connection.json` 创建私有文件。如果文件已存在，应保留并检查现有配置，不要直接覆盖。

```sh
mkdir -p "$DSH_HOME/contextmesh"
chmod 700 "$DSH_HOME/contextmesh"
node -e "console.log(require('node:crypto').randomUUID())"
```

用文本编辑器创建以下 JSON，将服务地址、Token 和 UUID 替换为实际值。全新设备使用上一步生成的 UUID；如果此 DSH 主目录已有 `contextmesh/node.json`，则复用其中的 `nodeId`，之后保持身份不变：

```json
{
  "version": 1,
  "endpoint": "https://mesh.example.com",
  "token": "REPLACE_WITH_SERVER_OWNER_TOKEN",
  "nodeId": "REPLACE_WITH_GENERATED_UUID",
  "name": "My laptop"
}
```

设置私有文件权限，并切换为读取保存的连接：

```sh
chmod 600 "$DSH_HOME/contextmesh/connection.json"
unset CONTEXTMESH_TOKEN CONTEXTMESH_ENDPOINT
pnpm cli doctor
```

如果 Server 由 `contextmesh server init` 创建，它已经生成私有 `owner-connection.json`。将该文件安全传到首台所有者设备，保持权限 600，运行 `pnpm cli setup` 并选择 **private owner connection file** 导入，无需再手工创建文件。默认 HTTPS 部署保留文件中的服务 HTTPS 地址，各设备使用同一个地址。仅选择可选 SSH 部署时，才在导入前将该副本的 endpoint 改为本设备的本机隧道地址。

### 其他设备：通过配对加入

1. 在所有者设备打开 **Remote sessions → Service connection → Add or revoke a device**，为新设备生成配对码。
2. 在新设备上设置好自己的 `DSH_HOME`，然后执行：

   ```sh
   unset CONTEXTMESH_TOKEN CONTEXTMESH_ENDPOINT
   pnpm cli setup
   ```

3. 选择 **pairing code**，输入与所有者设备相同的 HTTPS 服务地址和配对码。向导会将独立凭据和稳定身份保存到 `$DSH_HOME/contextmesh/connection.json`。
4. 运行 `pnpm cli doctor` 检查连接，再按下文启动 DSH。

配对码只能使用一次，最长十分钟过期。重试与撤销见[设备权限](devices.zh.md)。插件显式配置和环境凭据优先于保存的连接，`doctor` 会显示配置来源而不输出凭据。可用 `CONTEXTMESH_CONFIG` 指定其他私有连接文件。

## 启动 DSH 并配置模型

在客户端目录中，使用相同的 DSH 主目录与连接配置：

```sh
pnpm exec dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

打开 DSH 打印的带认证信息的地址。后续也使用本仓库的 `pnpm exec dsh`，确保兼容补丁有效。同一台机器还有其他 DSH 时，选择不同的网页端口。

在每台设备的 DSH 中配置模型提供方。ContextMesh 不提供模型账号访问权限，也不传输 API Key。接收端可以使用与来源不同的模型，本机选择由 DSH 原生模型选择器控制。

网页登录地址属于当前 DSH 实例，不是 ContextMesh 服务地址，不要把它填入配对向导。

## 检查安装并接续任务

- **Plugins：** 只有一个启用的 `dsh-contextmesh-handoff`，内部持久化和交接组件均在运行。
- **Remote sessions：** 服务已连接，两台参与设备均在线。
- **模型：** 原生选择器中有已在本机配置的可用模型。

按提示将同一项目映射到两端各自的本地目录。来源设备使用 **Hand off**，或在接收端选择 **Take over here**。接管执行中的任务时，先预检接收端，再停止来源，激活后自动继续未完成任务。详见[交接与恢复](handoff.zh.md)、[模型兼容性](model-relay.zh.md)和[文件传输](files.zh.md)。

## 查询与导出

配置好本设备的连接文件或所有者环境后：

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
pnpm cli operation OPERATION_ID
```

export 将原生会话日志输出到标准输出。关闭浏览器标签页不会停止 DSH 进程，也不会释放会话写入权。

## 写者异常中断后的恢复

先确认旧 DSH 进程及其工具已经停止，等待租约到期，再执行：

```sh
pnpm cli recover SESSION_ID --confirm-stopped
```

随后通过 DSH 恢复会话。租约不会停止 shell 命令或撤销外部副作用，重启数据库也不会释放逻辑所有权。日常设备切换应使用[协调式交接](handoff.zh.md)。

## SDK 集成

自定义 `sdk-minimal` 集成使用[专用 overlay](../examples/deepseek/sdk-minimal.patch.yml)，其持久化条目与 Web/base profile 不同。确保该 profile 能解析 `dsh-contextmesh`，并在启动 `dsh --profile sdk-minimal` 时通过 `--patch` 传入 overlay；不要与完整 Web 插件的 bundle 叠加。这是 SDK 集成方式，不是普通 DSH 用户需要额外安装的插件。
