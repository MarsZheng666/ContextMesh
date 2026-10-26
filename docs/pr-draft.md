# PR 草稿：docs: research DeepSeek persistence and define ContextMesh MVP

本文件为本地审查草稿，尚未推送或创建 GitHub PR。

ContextMesh 需要先确认 DeepSeek Harness 的持久化扩展点，才能设计远程 Session 与跨机器接续。本次固定官方源码 commit，梳理 SessionPersistence、实时事件写入、flush、恢复和插件卸载路径，并据此定义 M0 持久化、M1 主动 Handoff 与 M2 同 Harness 跨模型接力。

文档区分用户已确认方向、源码事实与本轮建议，记录旧会话正文无法完整恢复的限制，并说明空仓库的 PR 初始化问题。没有实现或发布运行时服务。

验证：静态阅读固定版本源码与两组契约测试；文档链接、来源路径/行号、文件 hash 和 JSON 记录由本地检查验证。上游运行时测试未执行：未安装依赖，当前默认 Node 不满足固定源码的根包要求。

风险与后续：DSH API 预稳定；插件安装与 profile patch、发布包兼容性、远程写权和双机器恢复仍需实现验证。租约 fencing 仅保护日志，不保证外部工具副作用自动停止；M1 限制为来源可协作停止的主动交接。
