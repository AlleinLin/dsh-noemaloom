# 2026-10-31 上游与 rc.5 适配审查（R42）

当前桌面目标为官方 **0.2.1-rc.5**，对应 commit `b830ec950faba0a46dda564be3e2d854afed94f1`。已验证官方 nightly feed、安装器 SHA512 与 DeepSeek 签名，并更新本机宿主。0.2.2-alpha.2 是另一个候选渠道，没有混入任何同源 SDK。rc.3→rc.5 的 388 个文件和 20 项边界审查见 `host-source-review-rc3-rc5.json`。

本轮清单覆盖 153 行（原有 152 行及新增官方 Schedule SDK），保留 npm、Git、归档、原项目与 DSH 适配包之间的独立身份。完整逐项观察、差异文件、许可证与处理决定见同名 JSON；真实验收见 `release-r42-verification.json`，历史收据不能证明本轮通过。

采用 Agency 1.2.20、Context 0.78.2、Mnemon 0.5.37、memory-spaces 0.5.24、skills source 0.5.4、Skin Market 0.1.72、Synapse 0.5.6、OpenSpec CLI 1.16.0、Motion UI 0.8.9、Codinput 0.3.8 与 Cognition 0.9.18。Context 和 Agency 的压缩符号改变，重新审查原生导航及集中升级入口的精确补丁；Synapse 原始 host/app 字节未变。Codinput 保留新增用户 Markdown 和统计弹窗，九处本地补丁全部按精确源码摘要重放。Cognition 保留独立范围桥接，新增写闸、会话归因等上游回归。

Forge 没有可核实的独立远程上游。原创 0.1.6 同步 engines、SDK、官方 standard 组合、构建元数据、安装器和 AI 说明，独立官方 rc.5 Host 与 GUI 已完成真实工具及卸载恢复验收。

新增会话冻结 0–168 小时、主/子代理页面设置及官方一次性 Schedule 联动。较长 Retry-After 优先，取消清理任务；完成的工具不会重放。官方 Schedule 拒绝子代理绑定，子代理按可取消进程计时器等待。关闭宿主后不能通过公开 API 复活未完成回合，不宣称能唤醒关机电脑或重置服务商额度。

保留 R40 子代理压缩接缝、上下文缓存、持久重试链、三级范围隔离、原生入口和 Claude 主题。billion-context 发布仍为 0.1.209，所取 MIT kernel 0.0.169 保留已审查的本地持久化合并；移动 Git HEAD 的其他宿主代理不自动挂载。Ponytail 原项目 5.3.3 为经典终端 hook 修复；DSH 适配包 5.6.2 未更新。Superpowers 原项目 7.0.1 的提示/压缩调整单独追踪，DSH provider 8.0.0 仍使用自己的原生生命周期。Nexus-Terminal 新提交只调整宿主范围与 CI，终端实现保留。

不可达项逐渠道记录：用户归档 procedures 无远程地址；Karpathy 移植包 Git 未取到；Aegis Git TLS 失败；Archify npm 404 但 Git 可达。代码审查源及 adaptive preset 的 Git 差异复取遇到 TLS 中断，保留明确未完成的源比较范围。外部 OpenViking/Hindsight 服务器不由此桌面包升级。旧 npm tag 不触发降级。

Cognition 的移动 Git HEAD 包含尚未进入 npm 0.9.18 的 aliases/repeat-guard 工作；本轮运行身份固定为已发布的 npm 完整性，回归选择按 0.9.16→0.9.18 发布包的实际差异（六个新增或修改模块），没有把未发布模块混称本次运行代码。

本轮另修复窄窗口及委派子面板的布局：工具组、消息操作按钮和自动计划条按各自可用宽度换行，覆盖上游模型触发器按 viewport 计算的 inline `45cqw` 上限。未修改 Codinput 原始 vendor 样式字节。独立桌面验证 800/960/1279px 窗口、245px 子输入面板、长模型名及权限/模型/压缩菜单；最终验证范围见 R42 记录。
