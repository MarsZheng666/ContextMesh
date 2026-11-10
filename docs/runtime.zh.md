# 安装、连接与升级

[English](runtime.md)

0.8.0-dev.10 运行包包含 Node、固定版本的 DeepSeek Harness 和唯一的 `dsh-contextmesh-handoff` 插件，面向 macOS Apple Silicon 与 Linux x64。Linux 包会在清单中记录并检查最低 glibc 版本，发布 CI 使用 Ubuntu 22.04（glibc 2.35）。暂不支持 Windows 和其他架构。普通对话无需全局 Node、pnpm 或 Git；代码项目使用 Git 时仍需安装 Git。

运行包由 **Release packages** 工作流构建。工作流产物属于候选包，发布仍是维护者单独执行的步骤。从可信发布获取对应平台压缩包和校验值，核对 SHA-256 后解压。保留校验值与 `manifest.json`；其中记录平台、Node/DSH 版本、协议与数据库兼容范围、源码提交、锁文件和补丁哈希、文件校验值及第三方许可证信息。

## 第一台设备

先按下方说明部署带默认 HTTPS 入口的服务端，再在每台设备的解压目录执行：

```sh
./bin/contextmesh install "$PWD"
export PATH="$HOME/.contextmesh/bin:$PATH"
contextmesh setup
contextmesh dsh
contextmesh open
```

使用 `CONTEXTMESH_HOME` 可以选择其他管理目录。程序放在 `releases/<版本>`，配置、模型凭据、设备身份和本机文件导入记录保存在 `data/dsh`；会话历史与项目映射由服务端持久化。升级不会替换该数据目录；备份也应保持私有。用 `contextmesh dsh --port 3080` 指定本机 Web 端口，或用 `--port 0` 自动选择空闲端口。

设置向导支持配对码或私有的管理设备连接文件。**默认使用 HTTPS 直连：**填写服务地址，例如 `https://mesh.example.com`，所有设备使用该地址和各自的凭据连接，无需配置 SSH。模型登录仍在 DSH 完成。未配置设备可以直接打开 **远程会话 → 连接设置** 配对；服务离线时该入口仍可打开。断线期间阻止远程写入，不会偷偷切回本地存储，也不会自动重发消息或重新执行工具。

`contextmesh open` 打开当前实例的认证地址。无桌面的服务器可以用 `contextmesh open --print-url` 输出地址，并妥善保管。普通 `status` 输出不包含网页登录令牌。

## 新建服务

只有服务端需要 Docker Compose。在该主机上解压已验证的对应运行包，安装 CLI，再使用以摘要固定的已发布镜像：

```sh
./bin/contextmesh install "$PWD"
export PATH="$HOME/.contextmesh/bin:$PATH"
contextmesh server init --image ghcr.io/OWNER/IMAGE@sha256:DIGEST --endpoint https://mesh.example.com
contextmesh server start
```

将镜像和域名替换为真实值。初始化会生成互不相同的数据库密码与管理凭据，以私有文件保存，重启不会重新生成。首台管理设备在设置向导中导入 `~/.contextmesh/server/owner-connection.json`；不要将它分发给普通设备。

默认 HTTPS 配置包含 Caddy 和持久化证书目录。域名需要解析到该主机，并满足 80/443 端口的证书签发条件，也可用已有 HTTPS 代理提供入口。API 和数据库留在 Compose 内网，设备直接连接 HTTPS 地址。

同机本地开发或选择[可选 SSH 专用部署](#可选-ssh-隧道)时，可用明确的回环 HTTP 地址初始化，例如 `http://127.0.0.1:8787`，仅将 API 发布到回环地址。不要将数据库暴露到公网。

## 新增设备

1. 安装对应平台运行包。
2. 在已有管理设备的 **远程会话 → 服务连接 → 添加或撤销设备** 中创建邀请。
3. 新设备运行 `contextmesh setup`，或在 DSH 的 **连接设置** 页面填写与管理设备相同的 HTTPS 服务地址和一次性配对码；仅在可选 SSH 部署中改用本设备的本机转发地址。
4. 在 DSH 配置本机模型；需要时选择本机项目目录。接收端使用自己当前选择的模型。

每台设备使用独立凭据和身份，被撤销的凭据不能重新连接。环境变量或插件显式配置优先于连接文件；`doctor` 和页面会显示实际来源，不显示令牌。已经绑定的连接需要受控重启后才能更改；连接其他账号时使用独立管理目录。

## 导入已有 DSH 配置

先停止旧 DSH 及其工具，在空的管理目录中执行：

```sh
contextmesh adopt /absolute/path/to/old-dsh-home --confirm-stopped
contextmesh dsh
```

导入只复制配置并保留备份，不移动或删除原目录，跳过依赖和套接字。启动前检查自定义配置中的绝对路径和第三方插件；管理配置仅安装 ContextMesh。模型凭据仅在用户明确选择的本机配置导入时复制，不随跨设备交接传输。

## 连接诊断

```sh
contextmesh status
contextmesh doctor
```

`doctor` 区分缺失/错误配置、DNS、连接拒绝、TLS 验证、超时、凭据拒绝、数据库未就绪和协议版本不兼容。输出的 JSON 不包含凭据、模型密钥和会话正文。不要通过关闭证书校验解决 TLS 错误；会话执行权和故障写者恢复与网络状态分别处理。

`contextmesh autostart install` 生成当前用户的 launchd/systemd 配置并给出启用步骤。启用前停止手动启动的实例。Linux 用户服务通常在登录后启动；无人登录时开机运行需要管理员配置相应策略。

### 可选 SSH 隧道

仅在 API 绑定服务端回环地址的 SSH 专用部署中使用；默认 HTTPS 直连无需此配置。更改已有连接前，先完成活动任务并停止受管理的 DSH。

```sh
contextmesh tunnel configure --host my-ssh-alias --local-port 18793 --remote-port 8787
```

`my-ssh-alias` 使用系统 SSH 配置。先在终端完成首次登录，准备密钥、SSH Agent 和主机验证。管理进程使用批处理鉴权和严格主机校验，不保存 SSH 密码。只将本设备私有连接文件的 endpoint 改为 `http://127.0.0.1:18793`，保留设备凭据和身份，再启动受管理的 DSH。

隧道仅监听回环地址，自动保活；短暂断开采用有限退避，最多重试八次。鉴权失败、主机密钥异常或端口占用时停止重试。修复原因后重启实例。管理器只停止自己创建的进程。SSH 进程存在并不代表服务健康，`doctor` 还会检查服务和凭据。

如果 macOS 上的 DSH 和 Codex Desktop 共用一条转发，可以用独立的用户 LaunchAgent 管理端口。将 `RunAtLoad` 和 `KeepAlive` 设为 true，并把下列命令逐项填入 `ProgramArguments` 数组。

```sh
/usr/bin/ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=2 \
  -L 127.0.0.1:18793:127.0.0.1:8787 my-ssh-alias
```

使用已验证的主机密钥，并将专用 SSH 身份的转发权限限制在所需的回环地址和端口。两个客户端都指向同一个转发地址。网络中断时，SSH 在保活失败后退出，由 launchd 重新建立连接。Server 使用 TLS 时，客户端继续使用 HTTPS 地址和可信 CA。

## 客户端升级

先下载、校验并解压新运行包：

```sh
contextmesh upgrade /path/to/new-runtime --check
contextmesh upgrade /path/to/new-runtime
contextmesh rollback
```

升级先检查全部文件和兼容关系，再考虑停机。有运行任务、排队消息、交接、模型切换或文件操作时拒绝升级。空闲设备会冻结新写入申请、完成 flush、协作退出、备份私有数据、切换版本，再核对启动结果和设备身份，不强杀忙碌 DSH。

进度保存到 `upgrade.json`；中断后对同一个包重试即可继续。新版启动失败且兼容时尝试回退程序。`rollback` 保留当前数据，不会用旧备份覆盖新会话。若保存或启动检查失败，请先检查 `doctor`、私有日志和升级记录。数据库结构不兼容时会阻止客户端升级与回退。

## 服务维护、备份与恢复

```sh
contextmesh server maintenance on
# 停止参与设备，明确处理未完成的交接和故障写者。
contextmesh server backup
contextmesh server upgrade --image ghcr.io/OWNER/IMAGE@sha256:DIGEST
contextmesh server resume-upgrade
# 核对健康状态和客户端后：
contextmesh server maintenance off
```

维护模式在 API 和数据库写入申请处阻止新写者，已有写者仍可 append、flush 和 close。租约过期不能证明原进程已停止。备份要求没有活动或未解决的写者，以私有文件保存并通过 PostgreSQL 归档读取器校验。托管服务升级保持 PostgreSQL 18，并要求目标镜像与当前服务的数据库结构版本相同；结构变化会在开启维护或停机前被拒绝。备份记录实际结构版本（6、7、8 或 9），仍支持恢复已校验的 schema 6、7 备份；中断后维持维护状态，`resume-upgrade` 核对备份及写者状态后继续原来记录的镜像。

0.6.1 服务没有维护 API。首次升级它时，先停止并确认所有旧客户端、工具和 API 进程退出，再备份 PostgreSQL、替换 API。不能将租约过期视作停机证明。客户端可以导入已停止的 0.6.1 配置；服务升级命令会拒绝不具备维护接口的旧服务。schema 6/7 → 8 按下方停机迁移流程执行；PostgreSQL 大版本升级仍是独立的管理操作。

灾难恢复是单独操作。停止所有客户端和 API，保持 PostgreSQL 运行，然后执行：

```sh
contextmesh server restore --backup /path/to/verified-backup --confirm-stopped --confirm-data-loss
```

该命令以选定备份替换数据库，使用单个事务恢复，并恢复对应部署设置。有其他数据库连接时拒绝操作。恢复后 API 保持停止、维护模式保持开启，检查数据后再启动和开放写入。不能在新数据已经写入后自动恢复旧备份。

## 从 schema 6 迁移到 7

前一版原生存储引入数据库结构 **7**。DSH 原生 Session 格式不变；新的版本边界防止旧 Server 将其他 Agent 的原生日志当成 DSH 数据读取。

1. 开启维护前，先构建已审核的目标版本或准备校验过的镜像与运行包。
2. 在 schema 6 服务上开启维护，停止所有客户端和工具，明确处理未完成的交接、模型切换与异常写者。租约过期不能证明进程停止。
3. 使用旧部署创建并校验 PostgreSQL 18 备份，保留私有配置和旧镜像。旧服务仍能使用这份备份。
4. 停止 API，保留现有数据库卷，仅将 API 镜像或程序替换为已审核的 schema 7 版本，再单独启动 API；启动时在事务内迁移。不能同时运行两个版本的 Server。
5. 确认带认证的 `/health/ready` 返回 `schemaVersion: 7`，维护仍开启，已有会话 header 和事件数量完整。将托管客户端更新为清单允许 schema 7 的运行包，再关闭维护、恢复设备。

旧 Server 会拒绝 schema 7。需要回退时，停止所有设备和 API，明确恢复校验过的 schema 6 备份及对应部署；这会丢弃备份之后的新写入，仅替换程序不够。`server upgrade` 和 `resume-upgrade` 不自动执行这次迁移。

## 从 schema 6 或 7 迁移到 8

本源码预览使用数据库结构 **8**。保留原生 header 和事件，增加后继会话关联、设备下独立 Agent 端点和确认式续跑记录。DSH 原生 Session 格式不变，不重写上下文，也不迁移模型凭据。

1. 停机前准备已审核的 schema 8 Server 和匹配客户端。
2. 在旧 Server 开启维护。停止所有客户端、Codex 进程、工具和后台命令，处理未完成的交接、模型切换、文件传输和异常写者，并核实进程已停止。
3. 使用原部署生成并验证 PostgreSQL 18 备份，保留旧镜像和私有配置。
4. 停止旧 API，保留数据库卷，替换为已审核的 schema 8 API 并单独启动。启动时在事务锁内迁移，不能同时运行新旧 API。
5. 确认带认证的 `/health/ready` 返回 `schemaVersion: 8` 和 `cross-agent-takeover-v1`，核对原始 header、事件、维护状态及设备运行包后再开放写入。

旧 Server 拒绝 schema 8。回退需停止客户端和 API，明确恢复旧备份与匹配部署；这会丢失备份后的写入。托管 `server upgrade` 和 `resume-upgrade` 仍要求相同结构版本，不自动执行本次迁移。

## 从 schema 8 迁移到 9

schema **9** 新增分块归档目录、记录索引和数据块表，已有 Session 和旧归档沿用原格式。匹配的新客户端可在 schema 8 上使用旧功能，在 schema 9 上使用分块归档。

1. 准备审核通过的 schema 9 API 和客户端包。在 schema 8 Server 上开启维护，停止运行中的客户端和工具，处理未完成的写入，并核实相关进程已退出。
2. 使用旧部署创建并校验 PostgreSQL 备份，保留与备份匹配的 API 镜像和私有配置。
3. 停止旧 API，保留现有数据库卷。只替换 API 镜像或程序并单独启动。启动时会在数据库事务中执行增量迁移。
4. 用带认证的 `/health/ready` 核对 `schemaVersion: 9` 和 `chunked-archives-v2`。维持维护模式，检查已有会话、旧归档和客户端兼容性，再开放写入。
5. 用测试会话验证分块发布和按预算导入，再用于日常会话。

schema 8 程序无法打开 schema 9 数据库。恢复已验证的 schema 8 备份会丢失备份之后的写入。托管的同版本结构升级命令仍会要求通过迁移流程处理结构变化。

每个命名空间的原始块存储默认配额为 20 GiB，包含未完成上传已预留的空间。可通过 API 环境变量 `CONTEXTMESH_ARCHIVE_QUOTA_BYTES` 调整。暂存上传连续 24 小时无进度后过期并定期清理。已提交的归档纳入 PostgreSQL 备份。
