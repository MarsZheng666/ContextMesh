# ContextMesh

[English](README.md) | 中文

**跨设备、跨模型，继续同一个 Agent 会话。**

ContextMesh 将原生对话历史、工具调用、工具结果和执行事件保存在共享的 PostgreSQL 服务中。在笔记本上开始任务，再将会话交接到另一台设备，从相同的历史继续——同一时间由一台设备负责执行。

首个集成对象是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。长期目标是构建模型无关的上下文服务，逐步连接不同 Coding Agent。

[快速开始](docs/getting-started.zh.md) · [设备配对](docs/devices.zh.md) · [会话交接](docs/handoff.zh.md) · [模型接力](docs/model-relay.zh.md) · [文件传输](docs/files.zh.md) · [部署指南](docs/deployment.md)

## 你可以做什么

- **保留原始对话。** 持久化原生 Session 事件，不用摘要替代历史，也不重新执行已经完成的工具调用。
- **换台设备继续。** 主动交接，或在远程会话中发送消息时确认接管。DSH 中保留共享标题、历史和当前所属设备。
- **在同一会话中切换模型。** 使用 DSH 原生模型选择器切换到另一条已配置的模型路由，切换前可检查历史兼容性和上下文容量。
- **接入新设备。** 创建一次性配对码，在新设备运行配置向导，必要时撤销它的凭据。
- **带上选定的文件。** 预览工作区改动和受支持的文件附件，再确认传输，并在接收设备上确认应用。
- **只安装一个插件。** `dsh-contextmesh-handoff` 同时提供持久化和界面，内部组件自动加载。
- **自主部署服务。** 使用 PostgreSQL，通过本机连接、SSH 隧道或 HTTPS 访问。租约和写入代次保证同一会话只有一个活动写者。

```text
DeepSeek Harness · laptop ─┐
                          ├── ContextMesh ── PostgreSQL
DeepSeek Harness · server ─┘
```

## 当前预览版

当前插件版本为 **0.6.1**，处于**开发者预览**阶段。需要使用本仓库锁定的 **DeepSeek Harness 0.2.1-rc.3** 及兼容补丁，普通全局安装的 DSH 不包含这些扩展。接口可能随开发调整。

设备交接沿用会话**当前的提供方、模型和推理设置**，不再单独选择交接模型。需要换模型时，单独使用 DSH 原生模型选择器。接收设备须提前配置当前模型及其凭据；API Key 不随会话传输，缺少模型时也不会悄悄换成其他模型。

普通对话可在非 Git 目录之间接续。代码工作区要求两端具有相同的 Git 基准提交，未提交改动可通过确认式文件传输带过去。ContextMesh 不会自动克隆仓库、切换分支或同步整个目录。

模型接力目前支持文本及已完成的工具历史。文件传输支持原生**文件**附件，暂不支持图片、spill 资源和运行中的进程。兼容条件、传输限制和恢复方式见[模型接力](docs/model-relay.zh.md)与[文件传输](docs/files.zh.md)指南。

## 快速开始

需要 **Node.js 24.9+** 和 **pnpm 11.25.0**。以下步骤从源码构建兼容的 DSH 运行时与唯一插件。项目附带本地开发 PostgreSQL 启动器，也可以连接自行管理的 PostgreSQL。

### 1. 从源码构建

```sh
git clone https://github.com/MarsZheng666/ContextMesh.git
cd ContextMesh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
```

将 `.env` 中的 `CONTEXTMESH_TOKEN` 设置为较长的随机值。可以用下面的命令生成：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 2. 启动服务

在一个终端启动本地 PostgreSQL：

```sh
pnpm db:local
```

在另一个终端进入仓库根目录，启动服务：

```sh
pnpm start
```

API 默认地址为 `http://127.0.0.1:8787`。停止后，本地数据库文件仍保留在 `.contextmesh/postgres` 中。服务启动时自动执行数据库迁移。

### 3. 安装插件并启动 DSH

在准备运行 DSH 的终端中，进入仓库根目录：

```sh
export DSH_HOME="$HOME/.dsh-contextmesh"
export CONTEXTMESH_NODE_NAME='My laptop'
export CONTEXTMESH_ENDPOINT='http://127.0.0.1:8787'
export CONTEXTMESH_TOKEN='your-token-from-.env'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

打开 DSH 打印的带认证信息的地址。后续也使用本仓库的 `pnpm exec dsh`，以加载兼容补丁。在 DSH 中单独配置模型提供方；ContextMesh 服务令牌不能代替模型提供方登录。

### 4. 接入另一台设备并继续

在新设备上安装相同的运行时与唯一插件，使用该设备自己的 DSH 主目录。在已有的所有者设备打开 **Remote sessions → Service connection → Add or revoke a device**，生成配对码。在新设备上使用与其 DSH 一致的 `DSH_HOME` 运行 `pnpm cli setup`，输入该设备可访问的服务地址和配对码，再重启 DSH。所有者令牌和所有者 `.env` 留在所有者设备，显式凭据会覆盖配对连接。连接文件和凭据优先级见[设备配对指南](docs/devices.zh.md)。

打开 **Remote sessions**，将同一项目映射到两端各自的目录，路径可以不同。在会话中选择在线目标设备并点击 **Hand off**，随后在接收设备打开会话继续。也可以在远程会话中发送消息，确认 **Take over here** 后接管。项目设置和恢复步骤见[交接指南](docs/handoff.zh.md)。

## 查看会话

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
```

export 将原生会话日志输出到标准输出。CLI 从仓库根目录的 `.env` 或已配对设备的连接文件读取配置，显式环境凭据优先。[插件接口文档](docs/api/deepseek-adapter.md)介绍了持久化接口。

## 部署与升级

所有已配对设备共享服务配置的所有者命名空间及其中的会话，设备配对与 DSH 浏览器登录相互独立。远程连接使用 HTTPS，或通过 SSH 隧道访问回环地址。回环地址始终指使用它的设备自身。

当前数据库结构版本为 **6**。升级现有实例前，备份 PostgreSQL 并停止旧写者，再一起升级服务端和参与接续的设备。旧版服务端不能使用结构版本 6，回退需要恢复备份。详见[部署指南](docs/deployment.md)、[设备配对](docs/devices.zh.md)与[文件传输升级说明](docs/files.zh.md#升级)。

## 开发路线

| 能力                           | 状态         |
| ------------------------------ | ------------ |
| 原生 Session 持久化与恢复      | 预览版已支持 |
| 跨设备交接、接管与工作区映射   | 预览版已支持 |
| 模型切换、兼容检查与容量预检   | 预览版已支持 |
| 设备配对与可撤销凭据           | 预览版已支持 |
| 确认式工作区改动与文件附件传输 | 预览版已支持 |
| 更多 Coding Agent 集成         | 规划中       |

## 参与开发

```sh
pnpm check
```

执行格式检查、上游测试夹具完整性检查、类型检查、构建和测试。测试使用隔离的 PostgreSQL，不需要模型 API 凭据。

欢迎参与贡献，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。问题反馈和功能建议请提交到 [GitHub Issues](https://github.com/MarsZheng666/ContextMesh/issues)。
