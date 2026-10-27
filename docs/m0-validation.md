# M0 验证记录

日期：2026-10-26。平台：macOS arm64，Node 24.15.0，pnpm 11.25.0。真实数据库测试使用 embedded-postgres 18.4.0-beta.17 提供的独立 PostgreSQL 进程。

## 已通过

执行 `pnpm check`，结果为 6 个测试文件、50 项登记测试通过。该命令包含：

- Prettier 格式检查。
- 固定上游测试夹具的适配后 SHA-256 检查。
- TypeScript 严格类型检查。
- HTTP 服务、CLI、插件 JavaScript 和类型声明构建。
- 官方持久化和实时写入共享契约；测试输入、断言和故障注入保留。
- 请求响应丢失后的幂等重试、不同内容复用 operationId 的拒绝、序号缺口拒绝。
- 并发写权、过期 epoch、显式恢复、namespace 隔离和重用 ID 的 incarnation 隔离。
- 不改写嵌套 JSON 类型、NUL、未配对 Unicode 和 ignorable 记录。
- 数据库触发器模拟批次中途失败，确认整批回滚。
- 实际 PostgreSQL SIGQUIT 立即停止，再启动并恢复已确认事件。
- 构建后的 HTTP 服务在独立进程中停止/重启，构建插件在新进程重放并继续追加。
- 官方 npm Harness SDK profile 中，使用真实 agent-loop 创建、写入目录变化、正常关闭，然后在新进程恢复同一 Session。
- 官方 base 配置与安装 bundle 合成，原后端被停用，保留 checkpoint policy。

共享 helper 登记的 32 项中，物理文件 torn-tail 案例因 PostgreSQL 没有该文件注入能力而不执行该分支；不能将总数解释为该物理文件场景已验证。本后端使用数据库原子事务、批次中途失败和立即停止恢复测试验证其对应保证。

另外独立执行过官方安装冒烟：在临时 DSH_HOME 中运行 `dsh plugin --profile web add file:<本地插件目录> --ignore-scripts`，再用 `--dump-config` 确认安装 bundle 已生效；临时配置随后清理。该隔离安装检查不修改用户原有 profile，也不纳入常规无网络测试。后续联机部署使用独立 DSH_HOME 和 profile，见下节。

## 双机器真实模型与部署验证

2026-10-26 在 macOS arm64（Node 24.15.0）和 Ubuntu 22.04 x86_64（Node 24.22.1）之间执行了额外联机验证。服务端部署 PostgreSQL 18.4 与 ContextMesh API，两端使用 DSH 0.2.1-rc.3 和 dsh-contextmesh 0.1.0。本机通过 SSH 隧道访问远程存储；原有 DSH rc.2 服务未被覆盖。

- 使用官方 sdk-minimal profile，通过 JSON-RPC 驱动真实 agent-loop 与 deepseek-flash，顺序执行本机首次对话、服务器恢复、本机再次恢复。
- 目标模型仅从同一 Session 历史恢复测试约定；后两轮 prompt 不重新提供需回忆的内容。三轮校验全部通过，DSH 进程均正常退出。
- 验收时事件总数依次为 14、25、36；每阶段序号连续，上一阶段事件前缀的 SHA-256 保持不变。
- 在服务器恢复之后、本机再次恢复之前重启 ContextMesh API，接续仍通过。
- PostgreSQL 的 fsync、full_page_writes 和 synchronous_commit 均为 on；API 与服务器 DSH 配置为 systemd 自启动，数据库容器使用持久卷和 unless-stopped 策略。
- 两端插件管理器均确认 installed=true、enabled=true，提供者为 RemoteSessionPersistence。两端 Web 的登录交换返回 303，携带 Cookie 的页面请求返回 200。
- 随后核查本机 Session 列表接口，发现缺少本地标题缓存时会退回目录名；通过官方投影缓存接口补建该测试会话的本地摘要后，列表返回了历史中的标题。此为单条会话的缓存修复，不代表标题、工作区分组已自动跨端同步。

结构化验证元数据与部署产物 SHA-256 记录于 [deployment-validation.json](deployment-validation.json)，不包含会话正文、凭证或真实服务器地址。连接布局与运维入口见 [双机器部署说明](deployment.md)。该联机验证不替代 M1 的交接控制、目录映射和工具执行验收。

## 兼容证据

- 官方 npm 包：`@deepseek-ai/dsh`、`dsh-session`、`dsh-session-persistence` 等均固定 0.2.1-rc.3；Cordis 4.0.5。
- 插件加载前检查服务鉴权、协议版本与续期间隔。
- 源码研究和测试夹具固定到 commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`；原始 hash、适配 hash 与 MIT 许可保留在 tests/upstream。
- npm 包与源码 commit 不能仅因版本相同就视为完全一致；例如 sdk-minimal 与 base 的默认存储行 ID 不同，需要分别提供 overlay。

## 未执行及边界

- 本机无 Docker，ContextMesh Dockerfile、Compose 与 Linux CI 配置未执行；联机部署仅使用了独立 PostgreSQL 容器与 Node/systemd 服务，不能视为完整容器构建验收。
- 已做上述真实模型与 Web 接口验证；未做桌面/Web GUI 完整点击交互、所有个性化 profile 的兼容性验收。
- M1 主动 Handoff、M2 模型接力及异构 Agent 未实现。
- 未执行磁盘损坏、跨区域容灾、负载压测或备份恢复演练。
- 实时缓冲位于进程内，只有成功通过持久化屏障的前缀得到持久性保证；M0 不提供离线写入合并。
- 没有推送、发布 npm 包、创建远程 feature 分支或 GitHub PR。

M0 使用、部署入口与异常恢复操作见 [使用说明](m0.md)。
