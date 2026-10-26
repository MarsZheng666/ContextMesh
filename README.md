# ContextMesh

模型无关的分布式上下文服务。以 DeepSeek Harness 插件为首个集成对象，逐步支持远程 Session 持久化、跨机器 Handoff、跨模型任务接力，以及异构 Coding Agent。

当前阶段：源码预研与 MVP 设计，尚无可运行服务或插件。主仓库：[MarsZheng666/ContextMesh](https://github.com/MarsZheng666/ContextMesh)。

## 项目记录

- [方向、已确认决策与上下文恢复限制](docs/decisions.md)
- [DeepSeek Harness 源码预研](docs/research/deepseek-harness.md)
- [固定的上游版本与文件校验记录](docs/research/upstream-lock.json)
- [本轮验证与未执行事项](docs/research/validation.md)
- [MVP、接口与验收标准](docs/design/mvp.md)
- [项目结构与实施顺序](docs/design/project-structure.md)
- [Git 与 PR 工作流](CONTRIBUTING.md)
- [本地 PR 描述草稿](docs/pr-draft.md)

首个技术闭环：机器 A 保存并停止 Session，机器 B 从远端恢复同一 Session，在确认工作目录和代码版本后继续任务。跨模型先在同一 Harness 内验证；异构 Agent 通过明确的上下文交接格式逐步接入。

源码结论固定于 DeepSeek Harness commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，预研日期为 2026-10-26。接口仍处于预稳定阶段，升级前需要重新核对。
