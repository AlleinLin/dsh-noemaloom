# 2026-10-24 上游审查与 DSH rc.3 适配

本轮宿主目标为 **DeepSeek Harness Desktop 0.2.1-rc.3**，不是开发分支
`master`。原来的 rc.2 安装包不会被改称为 rc.3 兼容包；新交付的
manifest、安装器、构建、来源锁及运行诊断均使用 rc.3。

发布依据：

- [官方发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)，
  2026-10-23 23:26:39 北京时间，包含预发布标记。
- 固定发布 commit：`1f81c047fc48fa190a683e469daa699857e9afe8`。
- 原基线：`687f282e8625c6b8d11ff58211a90524be2e4317`，rc.2。
- 官方 Windows nightly feed 的版本也是 rc.3。桌面程序按 feed 的
  289,415,960 字节及完整 SHA-512 校验后解包；使用真实 Electron
  可执行程序和独立测试 profile 验收。
- 实测该官方包内置 Electron 44.7.0 / Node 24.21.0 / ABI 149。
  仓库构建和依赖审计使用 Node 24.22.1；这两个运行环境分别记录。
  npm 无已知依赖漏洞不代表 Electron 或其内置 Node 已完成安全升级，
  插件也不替换宿主的 Node 二进制。
- 完整机器清单：[upstream-audit-2026-10-24.json](upstream-audit-2026-10-24.json)。
  固定来源和观察值分别存放在 `sources.lock.json`、`upstreams.json`。

## 宿主变更及处理

直接比较两个固定 commit 得到 **640 个变更文件**。GitHub compare API
只返回前 300 项，不能将它当成完整变更清单。本轮使用本地完整 Git diff，
并逐一比较 20 个关键源码边界的 Git 对象。

| 边界 | 上游实际变化 | 本轮处理 |
| --- | --- | --- |
| 草稿和新会话 | `whenDraftExists` 新增 replace/append/keep；新会话复用当前工作区的空白草稿 | 补齐本地类型，继续使用原生输入 facade 和准确 binding；保留 `clearPreviousDraft:false` 的保留草稿语义 |
| 会话、左栏、右栏更多菜单 | 新增区域入口、自定义固定状态与宽度折叠；header 增加 entryPins、entryActions、setPinned | 保留官方 header 和菜单所有权；原分栏适配透传原始 props，不增加第二套全局固定列表 |
| 右侧自由分栏 | service/store/tab-domain/persistence/session-view 源码对象未变 | 保留现有分栏兼容层，重新验证真实 rc.3 的打开、拖动、浮窗和收起恢复 |
| Menu/Tooltip | 定位、最小宽度和当前条目等变化 | 重新验证弹层定位、长菜单滚动、遮罩释放和焦点，不依赖旧 DOM 尺寸 |
| 模型目录 | API Key 和账号登录共用动态模型目录；声明 system/tool 更新能力 | 继续由官方 `resolveModelInfo`、`prepareCall` 提供实时模型事实，不覆盖其能力判定 |
| DeepSeek 窗口 | 内置大窗口从 1,000,000 改为 1,048,576 | 上下文和压缩从当前模型元数据取得窗口；不把 1M 常量写成所有模型上限 |
| 核心生命周期 | Agent、AgentLoop、Session、Tools、Subagent、Compaction、LLM/retry、连接与会话投影源码对象未变 | 保留原取消归因、64 次退避、通信收据和压缩事务逻辑，并在 rc.3 依赖上重新回归 |
| 规则/子代理/压缩原生源码 | rc.3 发布包的入口字节与已适配来源一致 | 按实际 rc.3 tarball 更新来源身份；保留规则优先级、模型代号/effort 和原生压缩函数 |
| 安装和救援脚本 | 原安装/审计严格锁定 rc.2 | 正式包只安装到 rc.3；旧会话救援工具仍识别 rc.2 和 rc.3，防止救援旧包时误拒绝 |

新增三个官方菜单槽为 `sidebar.panellist.actions`、
`conversation.session.header.views.actions`、
`sidebar.right.tab.guide.actions`。rc.3 自带的
`dsh-client-ui-entry-customization` 由宿主组合加载，无需再复制一套。

## 新增插件

| 来源 | 固定版本 | 接入方式 |
| --- | --- | --- |
| Scorp1o117/dsh-motion-ui | 0.8.8 | 原生工具、技能和消息节点；保留原渲染器，与既有 Reader 的 assistant-step 接入并存；主题和减少动画适配 |
| zsjs110110-cpu/dsh-cross-session-approval | 0.3.10 | 保留原 10 个工具、审批桥和权限夹紧；消息进入现有通信底座，防止代理消息被伪装为用户操作 |
| LJL454/dsh-computer-use | 1.40.2 | 保留完整 Windows backend/browser/internal 运行闭包及会话开关；默认关闭；HTTP 控制入口接入宿主认证连接 |
| Yu-tao-Li/dsh-computer-use-win | 0.5.1 | 比较和持续跟踪来源，不重复注册另一套桌面输入工具 |

选择 LJL454 实现的依据是其 UIA、截图、SendInput、剪贴板、批处理、
紧急停止、输入释放、桌面独占租约以及浏览器 CDP 通道更加完整。
两个项目分别登记 commit，不能用其中一个的版本号代表另一个。
原始源码、适配器和生成的运行输出分离，后续更新仍按来源摘要核对。

跨会话代理不能伪造主/子代理谱系，也不能因审批通知而清除用户停止标记。
会话级的桌面开关不被替换成全局授权；不公开未认证的 grant POST 接口。

## 本轮实际升级

下表均已重基和构建，已执行的验证范围见文末和完整 JSON。发行包 SHA-512、逐文件摘要、适配说明均保留在来源报告中。

| 包 | 原版本 | 本轮固定版本 | 适配 |
| --- | --- | --- | --- |
| dsh-context | 0.74.0 | 0.75.1 | Rebased the 0.75.1 dynamic placement registration to the single native conversation view; preserve original Context/Fleet analytics and native session navigation. Suppress the reviewed update hooks. |
| dsh-thoughtdag | 0.5.22 | 0.5.24 | Rebased the exact 0.5.24 host, HTML and Vite entry hashes and local symbol mapping. Preserve new own-provider cancellation/quiet-fallback behavior, graph algorithms and lazy chunk closure; retain native live mirror, graph compile bridge and viewport controls. |
| dsh-synapse | 0.4.2 | 0.5.0 | Preserve 0.5.0 v5 preview-only persistence, migration backup, visible-card hydration, native archive filtering and 0.2 minimum zoom. Full bodies use the native scoped archive reader plus the original bodiesFromEvents projector. |
| @michengai/dsh-agency-agents | 1.2.9 | 1.2.11 | Preserve the 1.2.11 host/remote/client, roster, sidebar option, locale fallback and authenticated base-URI endpoints. Lock its official updater=false option and suppress only the standalone update dialog. |
| dsh-skin-market | 0.1.66 | 0.1.67 | Refresh the actual offline catalog from 0.1.67 data/catalog.json. Preserve the unified resource market, host-owned plugin installation and independent asset licenses; do not mount a duplicate upstream shell. |
| @fission-ai/openspec | 1.14.3 | 1.15.0 | Use the packaged 1.15.0 CLI through the original 0.4.0 skill provider and Windows-safe absolute command quoting. Rebase the command inventory, including install/version/templates/change/experimental. |
| dsh-motion-ui | 0.8.7 | 0.8.8 | Upgrade to 0.8.8. Published host source is byte-identical to 0.8.7; the generated client changes only BUILD_INFO. Retain the bounded CSS/reduced-motion adaptation and all original tool/media behavior. |
| dsh-codinput | 0.3.5 | 0.3.5 | 完整来源重基，保留原左右输入座位和会话隔离 |
| @furongjun1999/dsh-memory | 0.9.8 | 0.9.13 | 完整 Python 来源及独立工作区桥接，824 文件编译、31 模块回归 |
| acp-kernel / billion-context | 0.0.147 | 0.0.161 / npm 容器 0.1.206 | 三方重基保留归档扩展，执行上游新增压缩回归 |

剩余三个 npm 版本差异属于参考来源：@fooxe/dsh-memory 使用独立事务存储；Veyra 的已复制 discovery/redaction 字节未变；code-review 受限许可实现未被复制。这些差异逐项记录，不代表仍有待升级的运行时 npm 插件。

DSH-agent-procedures 以用户归档摘要固定；Karpathy npm 发行包已核验，但公开 Git 访问不可用；archify-repository 的 npm 查询返回 404。OpenSpec 的首次 TLS 失败和独立重试结果同时保留。外部 Hindsight/OpenViking 等服务不随插件自动升级。

## 检查脚本维护

`scripts/check-upstreams.mjs` 已改为：

1. 读取官方发布列表，包括 RC；分页获取并解析精确 tag。
2. 区分 release commit 与开发 HEAD，拒绝把 master 当作发布身份。
3. 同源 DSH 包查询发布版本的精确 npm 元数据；Cordis、Schemastery
   和第三方插件分别按自身版本观察，避免旧 latest 标签误报。
4. 从 dependencies、peers、devDependencies 及客户端 inject 补齐宿主边界。
5. 正确比较预发布编号，保留网络/404/缺少远程引用的原因。
6. 分开记录相对上次观察和相对固定来源的变化；并发缓存重复查询，
   任何 worker 异常都不能生成貌似完整的报告。

```powershell
node scripts/check-upstreams.mjs --output upstream-report.json
node scripts/review-host-source.mjs --repo <公开上游检出目录> --base <旧发布commit> --target <新发布commit> --output host-source-review.json
```

两条命令均不改变固定版本、安装状态或用户会话。周度升级继续按照
[上游维护流程](upstream-maintenance.md)，先实现，再统一测试、集中修复。

## 界面与更新检查

原生“开始”页采用紧凑工具入口；开始、文件、终端等工具共用原生布局状态，默认取可用空间的 30% 并限制在 300–360px。窗口和左栏变化时自动调整，手动拖动后保留用户宽度，双击分隔线恢复自动；网格、面板和拖动边界使用同一原生宽度，没有额外空占位。全屏右栏使用独立层级与不透明原生主题底色，进入后完整覆盖对话内容，退出后恢复原宽度。输入框上方的空闲辅助、规划状态合并为一行，实际建议和展开内容仍完整显示。配色、Logo、字体及原生按钮和菜单保持既有身份。
Agency 的独立更新引导、DOM 观察器和启动 GET 一并停用；宿主 updater:false 继续生效。

## 验证依据

源码摘要：`bde566a15300e70a5a67babd08c4cfe32919e39a28386a4836df740d5c76bcca`。整批期间 sourceUnchangedDuringRun=true。

| 检查 | 实际结果 |
| --- | --- |
| 构建、类型、产物与实际归档审计 | 通过 |
| JavaScript / TypeScript | 2339 通过、0 失败、0 跳过；252 个文件 |
| npm audit | 0 已知漏洞 |
| Windows 后端 | 独立 WinForms 窗口的枚举、中文写入回读和截图通过 |
| Cognition | 824 个 Python 文件编译；31 个回归模块均 exit 0 |
| 官方 rc.3 Desktop | 7 项原生入口/主题/菜单检查、11 项分栏检查通过 |

Cognition 中 test_conformance 和 test_mr_m1 的两个可选私人库基线因缺少作者数据而 SKIP，不计作通过。桌面验收使用隔离配置和离线样例，没有发送真实模型请求，也不把独立外部服务视为已验收。

旧轮次的资源不足、Windows 隐藏测试窗口、旧圆角断言、空白会话头误判以及 Agency 更新 GET 均保留原始记录；最终报告只引用当前源码对应的有效结果。

完整 150 条来源查询、640 个宿主变更路径、20 个核心边界比较及本轮检查记录均保留在 JSON 中。安装包另附验证日志、原始测试结果和截图。
