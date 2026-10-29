# ContextMesh

[English](README.md) | 中文

**为 Coding Agent 提供远程会话持久化。**

ContextMesh 让 Agent 的会话不再局限于一台机器。它将对话历史、工具调用和执行事件保存在 PostgreSQL 中，让你在一台机器上关闭会话后，从另一台机器恢复并继续任务。

首个集成对象是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。长期目标是构建模型无关的上下文服务，支持跨机器交接、跨模型任务接力，以及不同 Coding Agent 之间的协作。

[快速开始](docs/getting-started.zh.md) · [插件接口](docs/api/deepseek-adapter.md) · [部署指南](docs/deployment.md) · [模型接力](docs/model-relay.zh.md)

[设备配对](docs/devices.zh.md)

## 开发者预览

ContextMesh 目前处于**开发者预览**阶段。M1/M2 为本仓库锁定的 DeepSeek Harness **0.2.1-rc.3** 提供远程 Session 存储、协调交接与模型接力，接口可能随开发调整。

支持将会话交接到另一台设备上的目录，共享标题并显示当前设备。普通目录无需 Git；代码工作区仍校验两端相同、干净的 Git 提交。M1 需要本仓库随附的显式 DSH 兼容补丁，可通过原生选择器换模型，或在跨设备接管时选择目标模型，见[模型接力指南](docs/model-relay.zh.md)。文件同步属于后续阶段。

## 核心能力

- **保留原生历史。** 保存消息、工具调用、工具结果及 Session 事件，不用摘要替代原文。
- **跨机器恢复。** 多个 Harness 连接同一服务，来源写者关闭后，可在另一台机器继续会话。
- **保持单一写者。** 通过租约和写入代次，避免多个客户端同时追加同一会话。
- **自主部署。** HTTP 服务配合 PostgreSQL，可通过本机连接、SSH 隧道或 HTTPS 访问。

```text
DeepSeek Harness A ─┐
                   ├── ContextMesh ── PostgreSQL
DeepSeek Harness B ─┘
```

M1 已加入同一 Harness 的跨机器交接、共享标题、远程会话面板和 CLI。使用本仓库锁定的运行时及显式兼容补丁，普通目录可直接接管；代码工作区需在两端准备相同、干净的 Git commit。见 [跨机器交接指南](docs/handoff.zh.md)。可通过原生选择器换模型，或在跨设备接管时选择目标模型，见[模型接力指南](docs/model-relay.zh.md)。文件同步属于后续阶段。

## 快速开始

需要 **Node.js 24.9+**、**pnpm 11.25.0** 和兼容的 DeepSeek Harness。项目附带本地开发数据库，也可以连接自行管理的 PostgreSQL。

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

API 默认地址为 `http://127.0.0.1:8787`。停止后，本地数据库文件仍保留在 `.contextmesh/postgres` 中。

### 3. 接入 DeepSeek Harness

使用上面构建的锁定补丁运行时，安装完整插件。远程持久化和交接界面只需一个安装项：

```sh
export CONTEXTMESH_ENDPOINT=http://127.0.0.1:8787
export CONTEXTMESH_TOKEN='your-token-from-.env'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh --profile web
```

设备名称、工作区映射和旧双插件配置的升级步骤见[交接指南](docs/handoff.zh.md)。服务端配置见[快速开始指南](docs/getting-started.zh.md)。

## 查看会话

```sh
pnpm cli list
pnpm cli stat SESSION_ID
pnpm cli export SESSION_ID
```

export 将原生会话日志输出到标准输出。CLI 从仓库根目录的 `.env` 读取连接配置。

## 开发路线

| 能力                            | 状态      |
| ------------------------------- | --------- |
| 远程 Session 持久化与恢复       | 已支持    |
| 带工作区映射的受控交接          | M1 预览   |
| 同一 Harness 内的跨模型任务接力 | M2 预览   |
| 设备配对与向导配置              | M2.1 预览 |
| 更多 Coding Agent 集成          | 规划中    |

## 参与开发

```sh
pnpm check
```

执行格式检查、上游测试夹具完整性检查、类型检查、构建和测试。测试使用隔离的 PostgreSQL，不需要模型 API 凭据。

欢迎参与贡献，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。问题反馈和功能建议请提交到 [GitHub Issues](https://github.com/MarsZheng666/ContextMesh/issues)。
