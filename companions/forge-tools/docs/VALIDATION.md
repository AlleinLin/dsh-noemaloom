# Forge 0.1.5 / rc.3（2026-10-29）

已复现0.1.4被官方rc.3以engines不匹配拒载；0.1.5同步引擎、所有DSH SDK、
官方standard预设、安装器与构建元数据至0.2.1-rc.3，不使用allow-version豁免。
Forge没有声明独立远程上游，本批是本地原创实现的正式兼容适配。

本批109项测试通过，0失败、0跳过。真实rc.3 ToolRuntime、本地文件和PowerShell
执行器用于回归。独立官方rc.3副本、合成profile通过安装前/离线安装后/卸载后
的实际Host生命周期检查；原有31项工具保留，完整Forge为36项。
原版Electron标准会话执行12次真实工具调用，经13次本地模拟模型请求完成：
文件读写/批量编辑/搜索、持久PowerShell及字面argv均验收；实际落盘gamma中文，
进程指标为1次启动、2次常驻调用。结果见host-validation.json和desktop-validation.json。
没有真实远端模型请求，也没有读取或改动用户profile、会话数据库或运行中进程。

YAML构建依赖更新至2.9.1，开发SDK的Zod固定4.6.7、Undici固定8.12.2，
保持DSH SDK全部为rc.3。首次CI发现companion锁文件中的旧Undici后补齐固定，
重新进行干净安装、109项回归、独立Host和真实桌面工具验收，项目npm审计0漏洞；
这不表示对整个官方Desktop二进制及其内置依赖重新作了安全认证。
历史性能和压力数据没有重新测量，不能作为本批的新性能承诺。

## 以下为rc.2版本的历史验证记录

# 验证记录

目标：Windows x64，DSH 0.2.1-rc.2，Node 24.19.0。

## 自动测试

Forge 0.1.4 的 `npm run check`：构建及 **109 项测试全部通过**，没有跳过项。
包含旧配置 `shellOnly: true` 仍提供完整文件、搜索和 PowerShell 操作的回归检查。
本轮原版 Desktop Host、Electron 窗口及最终 ZIP 安装验收均已通过。
RESILIENCE.md / resilience-results.json 保留 0.1.2 的扩展压力实测记录，
本轮没有将历史压力数据改写为 0.1.4 的重新测量。

覆盖真实 rc.2 ToolRuntime 的参数与输出流水线、真实本地文件后端和沙箱后端，
读缓存失效、新鲜读取、过期元数据校验、TTL=0、外部修改和监听、
旧版本编辑拒绝、并发原子写入、批量部分失败、CRLF 和中文路径。

真实 PowerShell 7 及 rc.2 managed subprocess 验证中文/emoji、
空格/单引号/双引号/反引号/美元符号/换行/空参数的 argv 往返、
变量函数保留、无末尾换行、非零退出码、cmdlet 错误、超时、
队列单独取消、进程取消后恢复和有界输出。
受限模式委托及后台 job 生命周期分别验证。

真实捆绑 ripgrep 验证 ignore、目录 glob、前导 ./ 路径、
全局匹配上限、中文文件名、无效正则、重复查询缓存与取消。
卸载等待搜索清理。正式预设的其他插件逐行与官方 composition 比较。

0.1.2 另外覆盖忽略取消的 cwd/resolve/stat/read/权限/intent、排队容量与取消、
关闭后禁止重入和缓存回填、stat 后文件增长、watcher 上限与迟到事件、
已经提交的变更在 SDK ABORTED 后保留上下文、批量提交进度及有界结果。
PowerShell 验证启动、总期限、排队、终止不确认、后代进程范围与旧回调清理；
搜索验证进程永不 close、巨大记录、解析中取消、路径解析不返回、
缓存全局预算和病理 glob 的独立进程隔离。

0.1.3 增加每次调用的实际会话权限、有效相同或较低目标的冗余请求、
空/空白理由与单独理由的兼容测试；未知目标和类型错误仍拒绝。
真正扩大权限仍要求非空理由和官方审批，审批返回后再次检查策略与取消；
还覆盖异步审批期间切换会话模式或工作区、批量逐项审批，
以及原生工具参数冻结后不修改输入。具体规则见 PERMISSIONS.md。

0.1.2 的 `node --expose-gc scripts/stress-resilience.mjs --wait-timeout-expiry`：
人工延迟 provider，测试原始 SDK 读取顺序超过期限与已热缓存读取；
重复独特文件和查询的 construct/churn/dispose，记录 GC 后堆及 RSS，
并在冷却与历史 30s 超时窗口后复测。
单独子进程阻塞事件循环，验证恢复调度后的取消分类与迟到结果处理；
真实 PowerShell 持续调用、取消恢复及销毁。
具体结果见 resilience-results.json；不把有限样本冒称绝对无泄漏。

## 原版桌面宿主验收

`npm run verify:host` 启动实际安装的 `dsh-desktop-host/lib/index.js`，
使用 Desktop 的 IPC 和启停流程，固定 `profile: desktop`。
完整 Tools 包使用临时 DSH_HOME，依次检查安装前、离线安装后、卸载后。
不读取或修改真实用户 profile、凭据或会话，也不调用模型。

- 0.1.4 完整 Tools tgz 已通过离线安装、真实 Desktop Host 启动、工具激活与正常退出。
- 官方默认预设始终为 `standard`，无需新增或切换 Forge 预设。
- 使用公开 `agentPresets.acquireScope()`、`tools.schemas()` 与 `tools.get()`，
  核对 standard 实际加载的新 read/write/edit/glob/grep/pwsh 实现。
- 已确认 Desktop 原本 31 项工具全部保留，完整包为 36 项。
- 卸载后，工具列表、实现描述、官方预设列表均恢复到安装前状态。

详细记录见 host-validation.json。

## 原生 Electron 窗口端到端验收

`npm run verify:desktop` 启动本机安装的原版 `DeepSeek Harness.exe`。
独立 DSH_HOME、Electron userData 和默认工作区全部位于一次性目录。
连接这个专用 Electron 调试端点操作窗口，页面来源为 `dsh-app://app`。
检查官方“标准模式”菜单，保持该预设，从桌面输入框提交验收任务。

此项使用仅监听 127.0.0.1 的确定性模型模拟器，经官方 DeepSeek provider 的
Anthropic Messages SSE 协议返回固定工具调用。模拟的是模型选择动作，
文件后端、Agent 循环、工具执行、结果回传、桌面会话与轨迹均为真实实现。
不访问外部模型 API；不宣称已证明 Electron 更新等其他基础设施零外连。

完整包实际执行并检查 12 次调用：
read、write、edit、read_many、batch_edit、glob、grep、list_directory、
两次 pwsh、pwsh_run、forge_status。
核对真实落盘文件为 `gamma 中文`，两次 pwsh 共享同一进程变量，
字面 argv 保留中文及 `$x`，计数器为 1 个常驻进程、2 次常驻调用。
为了验证常驻路径，仅在临时会话中通过桌面确认框选择完全权限；
插件安装不会自动改变用户的访问模式。

0.1.3 已在同一条原生桌面 Agent 执行链中附带截图问题对应的参数，
0.1.4 沿用同一组回归检查：
write 使用相同目标和空理由，edit 使用较低目标和空白理由，
batch_edit 使用单独空理由。文件字段必须真实暴露，否则验收失败。
PowerShell 的相同/较低目标及单独理由用例，仅在当前桌面 shell 能力实际暴露
相应字段时执行；未暴露时在机器记录中明确标记，不能冒称已经覆盖。
这项验证不扩展到官方 SDK 的顶层 run_code 校验。
0.1.4 实际 Desktop 的文件与 shell 字段全部暴露，上述 6 个参数兼容用例均已执行通过。
`forge_status` 真实返回版本为 0.1.4，完整 12 次调用均通过。

桌面轨迹显示真实工具结果；截图仅保存在源码目录 docs/desktop-evidence/，
用于开发验收查看，不进入 tgz、ZIP 或 build 安装交付目录。
机器可读结果见 desktop-validation.json。0.1.4 不再交付独立 PowerShell 包。

## 性能

见 BENCHMARK.md / benchmark.json。测试没有清除操作系统文件缓存，
也没有测量公司机器或安全软件内部 WMI/minifilter 调用数。
可控延迟实验与真实开发机数据分别列出，不混为工作机收益。

## 交付检查

完整 Tools npm 包有实际 pack 文件清单、正向资源白名单与 SHA-256。
`node scripts/verify-delivery.mjs` 验证最终 ZIP 解压、所有载荷校验和，
并检查 ZIP 仅含一份完整 tgz，tgz/ZIP 不携带截图或部分 PowerShell 入口/预设。
随后实际运行压缩包内的 Install-Example.ps1 / Install.ps1，
在两个临时 Desktop 产品目录分别通过 Tools 和兼容旧命令的 `-Variant PowerShell` 安装；
两种参数必须都安装并启用同一完整 `@local/dsh-forge-tools`，
都必须包含可执行的 rg，并检查文件、搜索、PowerShell 的替换配置。
0.1.4 上述两条安装入口均已通过；build 与 delivery 的 18 个文件逐一同哈希，
所有载荷校验和与 ZIP 旁附 SHA-256 均已核对。
若用户原有 Desktop 仍在运行，先用原脚本确认“必须退出”保护确实阻止安装且不创建目标目录；
随后仅在从未启动 Desktop 的全新临时 home，测试夹具局部模拟该单项进程查询为空，
继续执行未修改的 ZIP 安装脚本。校验和、版本检查、捆绑 CLI、离线安装和配置检查均实际运行。
该项会明确记录进程查询模拟，不冒称无模拟安装；原版 Desktop Host/GUI 另按上文真实验收。
安装器只面向 Desktop，不再携带 Web/CLI profile 选择或 CLI 覆盖补丁。
旧版独立 PowerShell 包已启用、或用户 profile 另有 `preset-standard` 定制时，
安装器保留配置并明确停止，避免静默覆盖或声称已经启用。
完整包携带已执行 `--version` 验证的 Windows x64 rg。
打包会清理 delivery/build 中已知的旧版生成 tgz、ZIP 和 desktop-evidence 截图，
build 中不属于这些生成命名规则的文件予以保留。
外部 SDK 由原版宿主解析，包管理器层标为 optional peer，
避免离线模式为宿主 SDK 另建副本。

仅声明 0.2.1-rc.2 兼容。工作机性能、企业脚本执行策略和未来宿主版本需在相应环境实测。
