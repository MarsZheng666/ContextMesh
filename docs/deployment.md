# 双机器部署与接续验证

2026-10-26 的部署把 ContextMesh API 与 PostgreSQL 放在服务器，两台机器的 DSH 连接同一份 Session 存储。部署基于源码提交 `6db621a`，不是 M1 主动 Handoff 控制器。验收数据见 [结构化记录](deployment-validation.json)。

## 运行布局

| 组件               | 位置                                    | 监听或访问方式                         |
| ------------------ | --------------------------------------- | -------------------------------------- |
| PostgreSQL 18.4    | 服务器 Docker 容器 contextmesh-postgres | 127.0.0.1:55432                        |
| ContextMesh API    | 服务器 systemd 服务 contextmesh-server  | 127.0.0.1:8787                         |
| DSH rc.3 Web       | 服务器 systemd 服务 dsh-contextmesh     | 127.0.0.1:3082                         |
| 本机 DSH Web       | macOS 独立 DSH_HOME/profile             | 127.0.0.1:3080                         |
| 本机访问远程 API   | SSH 本地转发                            | 127.0.0.1:8788 → 服务器 127.0.0.1:8787 |
| 本机访问服务器 Web | SSH 本地转发                            | localhost:3082 → 服务器 127.0.0.1:3082 |

服务器 API 与 DSH 都只绑定回环地址。此次使用已有 SSH 入口，没有配置公网 Web 地址。原服务器 DSH rc.2 实例与新 rc.3 实例独立，原实例配置和数据未被替换。

API 与 DSH 系统服务已启用开机启动；PostgreSQL 容器配置 unless-stopped 重启策略，数据保存在 contextmesh-postgres-data 持久卷中。检查时 fsync、full_page_writes、synchronous_commit 均为 on。

## 路径与凭证

| 路径                                 | 内容                                       |
| ------------------------------------ | ------------------------------------------ |
| /opt/contextmesh/server              | 已构建 API 与运行依赖                      |
| /opt/contextmesh/dsh-runtime         | 固定 rc.3 的独立 DSH 运行时                |
| /opt/contextmesh/dsh-contextmesh.tgz | 插件安装包                                 |
| /etc/contextmesh/server.env          | 数据库连接、API Token 和监听配置           |
| /etc/contextmesh/dsh.env             | 服务器 DSH 的 endpoint、Token 和模型凭证   |
| /etc/contextmesh/client.env          | 远程 API 的客户端连接配置                  |
| /var/lib/contextmesh/dsh             | 服务器 DSH_HOME，含 profile 和本地派生缓存 |
| /var/lib/contextmesh/workspace       | 服务器 DSH 系统服务工作目录                |

Token、模型密钥、数据库口令和 SSH 凭证不保存在仓库。实际本机启动器、连接配置和一次性诊断插件放在 gitignored 的 `.contextmesh/` 中；本机旧数据库与旧 API 没有迁移或删除。运行示例中的环境变量应由部署者在本机配置。

## SSH 转发与 Web 登录

设置 CONTEXTMESH_SSH_HOST 为目标 SSH 地址，例如 deploy@example.com，然后保持转发进程运行：

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8788:127.0.0.1:8787 \
  -L 127.0.0.1:3082:127.0.0.1:3082 \
  "$CONTEXTMESH_SSH_HOST"
```

本机插件使用 `CONTEXTMESH_ENDPOINT=http://127.0.0.1:8788` 和远程 API Token；服务器插件使用 `http://127.0.0.1:8787`。公网远端直连应按客户端要求使用 HTTPS；回环 HTTP 在此由 SSH 隧道转发。

本机页面使用 http://127.0.0.1:3080/，服务器页面使用 http://localhost:3082/。浏览器将 localhost 与 127.0.0.1 作为不同主机，从而隔离两套 DSH 的登录 Cookie；Cookie 不按端口隔离。

第一次登录使用相应 DSH 启动日志打印的带 token URL。服务器 URL 通过隧道打开时，将日志中的 127.0.0.1 替换成 localhost，保留端口和查询参数。登录链接是认证信息，不应写入 Git 或公共文档。页面提示 authentication required 时重新获取当前实例打印的登录链接。

## 插件与常用运维检查

插件通过官方命令安装到指定 profile。两端插件管理器均确认 `dsh-contextmesh@0.1.0` 已安装、启用，实际 SessionPersistence 实现为 RemoteSessionPersistence。

在服务器检查服务与数据库：

```sh
systemctl status contextmesh-server dsh-contextmesh
systemctl is-enabled contextmesh-server dsh-contextmesh
docker inspect --format '{{.State.Health.Status}}' contextmesh-postgres
journalctl -u contextmesh-server -n 100 --no-pager
journalctl -u dsh-contextmesh -n 100 --no-pager
```

需要重启 API 时，等待其就绪后检查并启动依赖的 DSH 服务：

```sh
systemctl restart contextmesh-server
systemctl restart dsh-contextmesh
```

修改 API Token 时，同步更新服务器的 server.env、dsh.env、client.env 和本机连接配置，再受控重启对应进程。停止容器不会删除持久卷；本次没有执行持久卷删除、备份恢复或磁盘故障演练。

## 已验证的接续过程

1. 本机官方 sdk-minimal profile 创建 Session 并完成真实模型对话，等待保存后正常关闭。
2. 服务器以同一 Session ID 恢复，模型根据已有历史回答检查问题，正常关闭。
3. 重启 ContextMesh API。
4. 本机再次恢复同一 Session，模型继续正确回答检查问题。

验收时累计事件数为 14、25、36；每次序号连续，前次事件前缀 SHA-256 不变。后续打开会话可能继续产生原生事件，这些数值是验收切点，不是当前数据量。Git 中仅保留验证元数据和哈希，不包含会话正文或模型凭证。

两端 Web 完成了认证交换、HTML 页面响应与插件状态检查；这些 HTTP 检查不等于完整浏览器交互或视觉验收。

## 工作区与标题的已知限制

测试会话创建目录为 /tmp。macOS 的 /tmp 解析为 /private/tmp，Linux 的 /tmp 保持 /tmp；路径字符串一致不意味着两台机器的文件相同。工作区注册、会话分组和标题投影缓存仍分别保存在每个 DSH_HOME。

本机缺少测试会话的标题缓存时，会话列表接口仍返回它，但页面使用目录名 tmp 作为名称并归入未分组。通过 DSH 官方投影缓存接口从远端原始事件补建该条会话的本地摘要后，列表接口返回了已有标题。该修复只写本地派生缓存，未改写原始历史；自动同步与跨端发现尚未实现。

此次运行验证顺序关闭与恢复、共享会话事件和模型上下文。未验证自动交接、代码目录映射、文件复制、未提交改动、附件字节或终端进程迁移。M1 的目录映射、同仓库和同 commit 预检仍按 [MVP 规划](design/mvp.md) 实现，首期代码准备沿用用户已有 Git 流程。
