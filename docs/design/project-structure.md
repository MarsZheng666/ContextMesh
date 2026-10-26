# 项目结构与实施顺序

状态：设计稿。当前仓库仅包含说明、预研和设计文档；下列实现目录将在相应 feature PR 中创建，不放置不能运行的占位服务。

## 建议目录

```text
ContextMesh/
├── README.md
├── CONTRIBUTING.md
├── docs/
│   ├── decisions.md
│   ├── research/
│   │   ├── deepseek-harness.md
│   │   └── upstream-lock.json
│   └── design/
│       ├── mvp.md
│       └── project-structure.md
├── apps/
│   ├── server/                 # HTTP、鉴权、服务启动和关闭
│   └── cli/                    # Session 观察与 Handoff 操作
├── packages/
│   ├── protocol/               # ContextMesh wire schemas、错误码、版本
│   ├── core/                   # 日志顺序、写权、交接状态机；无 DSH 依赖
│   ├── storage-postgres/       # 事务、序号、reservation、fencing、迁移
│   ├── client/                 # 远程调用、operationId、重试和取消
│   ├── adapter-deepseek/       # DSH SessionPersistence provider 与实时写入
│   ├── handoff-deepseek/       # Agent 生命周期、cwd/model 设置及交接驱动
│   └── bundle-deepseek/        # 安装元数据和替换默认 provider 的 patch
├── tests/
│   ├── conformance/            # 固定上游版本的契约集成入口
│   ├── integration/            # 服务、PostgreSQL、网络和竞争测试
│   └── e2e/                   # 双进程恢复、Handoff、模型路由
├── examples/
│   └── deepseek/              # 已验证的 profile 配置和演示步骤
└── deploy/
    └── compose.yml             # 开发环境，实际依赖版本在实现中固定
```

首期使用 pnpm workspace 管理 TypeScript ESM 包；工具版本、发布名称和依赖精确版本在构建验证后确定。暂不注册 npm scope、不发布包、不引入多语言核心。

## 依赖方向

`protocol` 不依赖 agent 运行时。`core` 依赖协议和存储抽象；`storage-postgres` 实现存储抽象；`server` 组装它们。`client` 只依赖协议。`adapter-deepseek` 依赖 client 和公共 DSH 包；`handoff-deepseek` 使用 DSH 的 agent、working-directory 和模型选择 API；bundle 负责最终装配。核心禁止反向导入 adapter，协议不暴露 DSH 类型作为所有 Agent 的公共类型。

存储 provider 与 Handoff 控制器分开，因为普通持久化不应擅自停止 Agent 或切换模型。CLI 只发起受鉴权操作，不直接改数据库或跳过写权。后续 `context` 包和其他 adapter 在有第二个实际集成时加入，避免过早抽象。

## Feature / PR 顺序

| PR | 分支建议 | 内容与退出条件 |
| --- | --- | --- |
| 0 | `feature/deepseek-persistence-research` | 本轮文档；固定来源、接口、MVP 与限制 |
| 1 | `feature/session-protocol-store` | workspace、协议 schema、PostgreSQL 迁移、顺序与原子写权；数据库集成测试通过 |
| 2 | `feature/remote-session-service` | HTTP + client、幂等/错误/取消、durable barrier；故障和并发测试通过 |
| 3 | `feature/deepseek-persistence` | provider、实时队列、bundle、版本兼容性；上游两组契约与打包加载验证通过，达到 M0 |
| 4 | `feature/deepseek-handoff` | intake gate、静止/关闭、manifest、目录映射和 claim 传递；双进程验收达到 M1 |
| 5 | `feature/deepseek-model-relay` | 显式 model.select、能力检查和模型接力验收，达到 M2 |

实现前先提供符合上游要求的 Node 环境，核对 npm 发布接口与用户安装版本。PR 3 的测试应接入固定 commit 的上游测试工作区；不要从 npm 假设存在 `tests` 公共导出。主仓库不直接复制 JSONL 实现。

这些 PR 是阶段规划，不是立即执行的实现清单。本轮到源码预研和设计完成为止；推送和创建真实 PR 依据 [贡献流程](../../CONTRIBUTING.md) 获得授权后进行。
