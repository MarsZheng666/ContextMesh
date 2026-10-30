# 跨机器会话交接

[English](handoff.md) · [开始使用](getting-started.zh.md)

ContextMesh 可以在两台机器的目录之间交接 DeepSeek Harness 会话。侧栏的“远程会话”展示共享标题、项目、当前设备、历史和交接进度，原生对话保留完整事件历史。

## 安装兼容运行时

要求 **Node.js 24.9+、pnpm 11.25.0，以及本仓库锁定的 DSH 0.2.1-rc.3 依赖图**。先执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。`patches/` 中的兼容补丁补充入口冻结、实际所有者关闭和本地沙箱目录绑定。普通全局安装的 DSH 没有这些扩展，交接插件会拒绝不兼容的运行时。升级 DSH 时需要重新评审补丁，上游代码继续遵循 MIT 许可证。

两端分别在仓库根目录执行，为每端使用不同的私有 DSH 数据目录：

```sh
export DSH_HOME="$HOME/.dsh-contextmesh-m1"
export CONTEXTMESH_NODE_NAME='我的电脑'
export CONTEXTMESH_ENDPOINT='http://127.0.0.1:8787'
export CONTEXTMESH_TOKEN='服务端令牌'
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh --profile web --host 127.0.0.1 --port 3080 --no-open
```

通过 DSH 打印的认证地址打开页面。只需安装这一个完整插件，安装列表显示 `dsh-contextmesh-handoff`；持久化组件作为内部依赖自动加载。之后继续使用本仓库的 `pnpm exec dsh`，确保生命周期补丁生效。令牌只放在主机环境，浏览器通过 DSH 现有认证连接控制。模型凭证和预设在每端独立配置，不通过交接传送 API Key。

### 从双插件安装升级

先完成当前任务并退出该设备的 DSH。在同一个 `DSH_HOME` 下更新安装，然后移除旧的独立存储安装项：

```sh
pnpm exec dsh plugin --profile web add "link:$PWD/packages/handoff-deepseek"
pnpm exec dsh plugin --profile web remove dsh-contextmesh
```

完整插件会继续使用原来的服务端会话和设备配置，不删除历史数据。两个插件条目不是需要并列安装的新旧版本。

## 准备和交接

1. 打开侧栏 ⇄“远程会话”，创建一个共享项目。
2. 每端选择同一个项目，保存各自的 **工作目录**（Git 项目须选择仓库根目录）。目录可以不同。不要跨设备复制 `node.json`，其中保存设备身份。
3. 普通目录无需准备 Git。Git 工作区需两端基准提交相同。先提交修改，或使用[确认式文件传输](files.zh.md)准备目标。不会自动拉取 Git，也不同步 ignored 文件。
4. 在项目目录内打开原生会话，完成当前执行和待处理输入，选择在线目标设备，点击“交接”。对话输入区也有交接控件。
5. 等待“已完成”，在目标打开对话并继续。下一次工具会使用目标映射目录。不可变的原始 header 保留最初路径，当前工作目录事件和本地沙箱绑定决定实际执行路径。

源端先冻结新任务并等待已获准活动，完成两端预检，flush 后等待实际 Agent 所有者 dispose。关闭作用域产生的最后事件也写入日志，然后服务端固定最终切点。指定目标原子领取新 epoch，在开放输入之前恢复原生 Agent、预设、模型选择、本地目录和沙箱权限。交出后会话仍保留在源端侧边栏，可只读查看历史；远程标记表示它已在另一台设备，悬停可查看当前设备名称。

ContextMesh 保留模型选择，目标沙箱策略更严格时拒绝交接。仅支持具有可移植文本和工具历史的根会话；先结束后台任务、关闭持久终端、删除计划任务、停止子 Agent。原生文件附件需[明确传输并由目标确认](files.zh.md)，图片、spill、Git submodule 会明确拒绝。ignored 文件、凭证、外部服务和工具副作用不能随日志迁移，需要自行准备。交接期间避免从其他终端修改工作区。

## 从当前设备接管

新会话尚未关联项目，或当前设备还没有对应目录时，直接发送消息会弹出项目配置。选择已有项目或新建项目，并点击“浏览选择目录”选择当前设备继续会话的工作目录；已有目录会直接显示。目录浏览器读取当前 DSH 所在的设备，服务器页面浏览服务器目录、本机页面浏览本机目录，支持逐级导航、显示隐藏目录和路径跳转，取消浏览会保留表单内容。保存后继续接管确认，取消则保留草稿、不发送。输入区也有“选择项目”入口，可提前配置。原设备会根据会话实际使用的工作目录准备首次映射，不会覆盖该项目已有的目录。普通目录不要求 Git，代码工作区仍需两端提交相同且干净；配置项目不会自动复制文件或提交代码。

在远程会话中直接发送消息，会先询问是否接管到当前设备。确认后，原设备自动停止当前任务、保存最后的上下文并释放执行权；接管完成后，原消息才会发送一次。无需到另一台设备手动点击交接。取消确认或接管失败时，草稿保留，不会自动发送。

也可以在对话输入区或远程会话列表点击“在此接管”，只转移会话，不发送消息。接管仍使用同一个完整插件。

两端都需要更新插件并准备好项目目录。原设备离线、执行状态不确定、仍有待处理消息或目标工作区未准备好时，不会强行取得执行权。页面会提示原因；保留草稿后可重试，必要时按下文的显式恢复流程处理。

## CLI

本地命令通过运行中的 DSH 私有控制 socket 工作，无需服务令牌。默认目录是 `$DSH_HOME/contextmesh`；自定义目录可加 `--state-dir`。

```sh
pnpm cli devices
pnpm cli projects
pnpm cli project-add '我的项目'
pnpm cli map PROJECT_ID /绝对路径/工作目录
pnpm cli remote-list
pnpm cli handoff SESSION_ID TARGET_NODE_ID
pnpm cli handoff-status HANDOFF_ID
pnpm cli history SESSION_ID
pnpm cli handoff-cancel HANDOFF_ID
pnpm cli resume SESSION_ID
```

`resume` 显式打开本设备符合条件的已完成、已取消或已失败交接，不抢占现有写入权。目标激活前可取消；源端已经开始关闭时不会悄悄重启来源。

## 中断与恢复

临时断网会保留冻结状态并重试或核对原操作。领取或完成响应丢失不会重复创建 Agent。目标预检失败且服务端确认失败后，源端仍可继续使用。写入权失效时会停止执行并关闭作用域。

`recovery_required` 表示无法确认关闭或所有权。确认旧 DSH **以及它启动的工具进程**均已停止，等待写入租约到期，再使用服务端凭证运行：

```sh
pnpm cli handoff-recover HANDOFF_ID --confirm-stopped
pnpm cli resume SESSION_ID
```

恢复清除交接占位并使旧写者失效，继续执行仍需显式 resume。进程重启后不会自动抢走别的设备的会话。显式恢复会保留本设备项目内有效的工作子目录；如果日志最后的绝对路径属于另一台设备，则按交接记录映射到本设备的目录，保留更严格的文件权限。租约只能阻止日志写入，不能撤销外部副作用。

## 升级与传输

当前服务端使用数据库 schema **6**。升级前备份 PostgreSQL 并停止旧客户端；启动时在事务内迁移 schema 1–5，保留已有会话，并加入持久化接管、模型接力、设备配对与文件传输记录。未参与交接时 M0 存储客户端仍可使用；交接中的普通 write open 和普通 recover 会被占位阻止。旧版服务不能使用 schema 6，回滚需要恢复备份。

跨网络使用 HTTPS，或通过 SSH 隧道连接回环地址。回环 HTTP 本身不提供加密。共享同一 namespace 令牌的设备属于同一信任域，设备 ID 负责路由，不是独立权限凭证。浏览器控制接口使用 DSH 的 Host/Origin 检查和所有者认证，本地 Unix socket 仅允许所属系统用户访问。

M1 实现同 Harness、保留模型路由的交接。M2 已提供[跨模型任务接力](model-relay.zh.md)，可通过原生选择器单独换模型；跨设备交接始终沿用当前模型；已提供[确认式工作区和文件附件传输](files.zh.md)，异构 Agent 和自动故障接管属于后续阶段。

普通目录交接在记录中明确声明目录模式，不附加 Git commit；Git 工作区保留提交检查，旧记录未声明类型时仍按 Git 处理。使用普通目录接管前需更新服务端和两端的同一个插件，数据库 schema 6 增加模型接力记录。普通目录不复制工作区内容；Git 工作区可另行确认传输改动文件，工具会在目标选定目录中继续运行。
