# R39：每周上游维护

逐项核对151个来源：52个源码/归档来源、37个npm插件、62个宿主依赖。
桌面本体最新发布仍为0.2.1-rc.3，本批不安装开发分支。

更新Context 0.77.0、ThoughtDAG 0.5.26、Synapse 0.5.4、Agency 1.2.14、
Ponytail 5.6.2、Mnemon 0.5.35及相关source/provider/strategy；
另更新9个支持依赖。Cognition 0.9.14、ACP kernel 0.0.163、
dshell 0.1.15、Windows Computer Use 1.40.3、Aegis 2.14.2按固定来源重基。
完整版本、许可证、commit、integrity及保留决定见上游审查JSON。

保留会话原生入口和Claude主题。Synapse使用上游DOM morph，历史读取仍受工作区边界控制。
Computer Use正常/故障诊断都使用宿主认证连接；故障保持503且不注册操作工具。
上游变更了电脑操作的注册ID，本版保留原ID，避免重复实例和设置丢失。
R38的retryId、64次退避、历史恢复修复保持，并通过完整回归。

统一构建、类型检查、2372项回归全部通过，0失败、0跳过；
另外78项dshell上游测试、37个Cognition模块及全Python编译通过，npm审计0漏洞。
使用独立官方桌面副本和临时profile验证原生会话、图谱、编队、记忆、专家、侧栏、
全屏和电脑开关；Windows worker只在自建窗口验证输入和截图。
本批修正了验收脚本的欢迎窗口时序和隐藏视图选择问题，原始失败记录保留。

验证边界：未发送真实模型请求、未连接真实SSH设备；
Cognition可选的上游私有历史语料缺失，明确记为未执行，不计通过。
Karpathy移植Git、Archify npm和缺远程地址的用户归档的限制见审查报告。
未自动安装本机插件，未影响用户运行中的DSH或改写用户会话数据库。

验证源码摘要：`d9150bac6f72c829b5a58632268813b54df8540892b8cc906060ffa4595c48d8`。
完整证据及范围见[release-r39-verification.json](release-r39-verification.json)。
