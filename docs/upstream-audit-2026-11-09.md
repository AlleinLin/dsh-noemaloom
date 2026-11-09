# 2026-11-09 上游审查 / R54

本轮核对 157 项元数据清单和 48 个固定源码单元，完成官方 Desktop 0.2.2-rc.1 整体迁移。宿主、全部同源 SDK、原生工具批次执行、异步 projection 生命周期和预设均按同一版本适配。独立签名官方副本与合成 profile 的实际通过范围见 [验收报告](release-r54-verification.md)及同名 JSON。交付不等于已安装，本机运行中的真实 profile 未变。

采用 Task Board/Usage 0.4.16、Better Sidebar 0.30.1、Context 0.83.0、Cross Session Approval 0.3.12、Mnemon 0.5.43 及变化组件、Motion 0.8.10、Ops 0.5.2、Skin Market 0.1.81、ThoughtDAG 0.5.28、OpenSpec 1.16.1、Turn Rewind 0.3.12、Cognition 0.9.23 和 billion-context 0.1.213 对应 ACP kernel 0.0.186。Codinput 0.3.9 及 Nexus-Terminal 0.1.17 取确认变化的完整 Git 树并重基现有接缝。Forge 0.1.7 为本地原创可选包，无虚构的独立上游。

只取得相对上次审查新增的包/源码，未全量克隆。Veyra 0.1.73 的选定脱敏模块与保留的 0.1.69 字节相同，真正 code bridge 0.1.6 未变，因此未换运行模块；Memsearch 的新 commit 不触及选定 Python 子集。SRC-43 的 Karpathy npm 适配仓库认证失败，真正技能上游 SRC-44 的 HEAD 未变；Archify npm 404 和 Procedures 未提供 remote 均如实记录，不能当成无更新。

保留 R40 子代理接缝、缓存与重试持久化、三级隔离、原生入口、Claude 主题、UTC 模型时间、冻结和延时文字能力，以及 R52 确定性维护错误的持久暂停和原步骤继续路径。Codinput 保留上游 portal/动态 anchor 生命周期，SOURCE.json 保持 LF；ThoughtDAG 精确 AST 与函数不变性检查未放宽。Ops 按上游统一 dsh-ops row 组合；Nexus-Terminal 退役 usage，正式包排除旧生成残留，新 WSL addon 保持关闭。

Cognition 的 364 个已有文件只有换行变化，另有 29 个已有文件包含语义变化；发布子集按来源字节保存。原 Rust 补充夹具维持历史身份；新增 UTF-8 回归所需的三个 Git 固定公开 Python 夹具只用于隔离测试，不进入运行包或启动服务。

构建、类型、产物、2,583 项回归和独立宿主验收通过；Cognition 100 条命令成功且保留可选跳过。初始失败、集中修复和重验详见报告。部分 Git compare 达 300 文件而截断，不能宣称整个 repository 已审完；采用的 ACP kernel 另核对完整前后树。没有 GUI、真实供应商、真实五小时或长时压力通过结论。

本轮临时目录与旧交付在最终回读后清理，旧 R53 被拒目标不重试或绕过；占用与实际清理限制另记，不宣称已低于 1GB。
