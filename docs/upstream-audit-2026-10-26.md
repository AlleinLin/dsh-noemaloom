# 2026-10-26 周维护

本批逐项核对 151 个来源，宿主最新已发布版本仍为 Desktop 0.2.1-rc.3。
完整版本、commit、npm integrity、许可证摘要、保留决定和不可达条目在同名 JSON。

更新 14 个运行插件包、9 个支持依赖，以及 Cognition 0.9.14、ACP kernel 0.0.163、
dshell 0.1.15、Windows Computer Use 1.40.3、Aegis 2.14.2。
ThoughtDAG 0.5.26、Context 0.77.0、Synapse 0.5.4、Agency 1.2.14
按新发布代码重新审查原生导航、会话隔离和独立升级提示适配。
Synapse 保留原生 DOM morph，关闭新增的全局历史扫描，只用本插件的范围校验读取。
Computer Use 的正常和降级诊断都走 owner-only Connection；故障保持503，不注册动作工具。

Superpowers、Ponytail 原始上游、OpenSpec、Karpathy 原始技能与 DSH 移植均核对。
Ponytail DSH 包更新到5.6.2，其余已发布版本保持。Karpathy 移植 Git 不可达，npm可查；
用户归档没有提供远程来源，Archify npm404是已知状态，均不能当成“检查成功且无变化”。
Archify 当前上游改用 Apache-2.0并保留历史MIT，本地保留原取得版本及MIT许可。

React保持与宿主共享的19.2；TypeScript、esbuild、marked、ignore跨主版本候选已记录，
本轮保留当前无审计漏洞的API契约。DSH同源包只随正式桌面发布升级。
大规模开发分支的GitHub compare存在300文件上限，本次未采用它们的未发布代码；
实际重基的kernel使用完整base和目标源码三方合并。

所有实现完成后统一构建、检查并集中修复；结果见本批release-r39-verification.json。
未自动重启用户DSH、停止代理或改写用户会话数据库。
