# 06 运行时与可靠恢复规格

文档状态：可交给未接触上游代码的实现团队独立实现的行为规格。范围包括 Windows shell、字节编码、持久终端、预设、自适应工具目录、外部插件运行与开发工作台、会话分支、文件检查点与恢复。规则标识 `RUN-*`、`EXT-*`、`REC-*` 在全工程唯一；本章字段、状态、端点与提示文案为新设计，不照搬上游实现。

## 1. 交付原则与完成条件

**RUN-001** 单一集成插件必须复活本章的全部用户能力。上游预设失效、npm 下架、接口废弃或 API 不再公开，均不能成为删减能力的依据。运行时适配器、隔离执行桥、当前 Desktop 正式 bundle 预设以及迁移器都是必交付软件的一部分。“仅展示不可用卡片”“仅内置模块开关”“仅生成旧目录文件”不算完成。

**RUN-002** 一份安装包安装到 Desktop profile 后必须具备：Windows PowerShell 7 持久编码、Windows Git Bash 极简、标准自适应三套可选预设；两种 shell 均可运行前台/后台任务；外部插件临时试运行和永久管理；所有 shell 诊断；用户消息旁三模式回退；检查点管理与中断恢复。web/headless 按宿主能力提供同等后端语义，缺 UI 的 headless 通过模型工具与 CLI/API 操作。

**RUN-003** 与宿主交互集中于 HostAdapter。正式公开 API 优先，必须按锁定宿主版本做 feature detection 与契约测试，不能以版本字符串猜测服务。需要内部兼容桥时，将桥作为独立、固定适用版本和表面范围的模块；桥访问的内部结构在开发证据中列明，出现未知结构必须阻止该次操作而不是尝试写未知对象。宿主核心无需修改。官方 API 空白不移除要求，需先交付桥再完成验收。

**RUN-004** 安装、运行、变更权限、发布外部构件各有实际授权上下文。模型说“我已获批”不能生成授权证据。用户已为具体范围授权时不得重复询问；需要宿主批准但宿主渠道不可用时，返回可理解的阻断原因和可复审计划，不自动提权。规格开发阶段不修改用户现有 DSH 配置。

**RUN-005** 所有平台例外必须列出 `capabilityId/platform/hostVersion/reason/evidence/remedy`。例如 Windows 受限 sandbox 不允许 ConPTY 命名管道，可走同权限 one-shot；UI 必须明确“此调用不持久”。在已有授权的受支持模式下持久终端仍须真实可用，不能长期用降级替代验收。

## 2. 模块与宿主依赖合同

部署模块按职责划分为 RuntimeCatalog、ExecutionBroker、ShellSessionManager、StreamCodec、CommandDiagnostics、PresetRegistry、ToolSurfacePolicy、ExtensionWorkbench、RecoveryLedger、RecoveryCoordinator。模块间通过显式接口通信，领域与各上游模块不得各自替换全局shell.resolve，不扫描任意服务私有字段，不由UI直接访问磁盘。优先正式执行能力；确无可验收路径时，仅HostExecutionAdapter可拥有一个精确版本锁定的兼容wrapper，记录目标scope、原句柄、包装次序、owner/generation、卸载冲突与降级，合同测试证明沙箱与审批不被绕过。09章集中包装许可只适用于该具名边界，不是任意全局patch授权。

HostAdapter 至少提供以下语义，实际宿主名字由总规格锁定：

| 能力 | 输入 / 输出责任 | 不可违反的约束 |
|---|---|---|
| resolveExecutionPolicy | actor/session/workspace/request → 不可变 policy snapshot | 分别记录宿主文件 sandbox policy、本 suite 能力授权与运行器实际约束；不能把文件 SandboxMode 扩写为官方网络/进程沙箱 |
| requestCapabilityGrant | 原因、精确资源范围、命令摘要 → grant/denied/unavailable | 单次授权只对该 call 生效，不能悄改会话模式 |
| spawnProcess / spawnTerminal | executable/argv/cwd/env/limits/policy → owner handle | 通过宿主 confinement；取消与输出边界由 adapter 兑现 |
| registerResources | owner+generation 的 tools/routes/slots/listeners | 返回可逐项回收的 disposer，不许跨 owner 清理 |
| declarePreset | 包内相对入口与元数据 → declaration handle | 用当前 bundle 声明机制，从已安装包解析 |
| sessionSnapshot | session ID → 生命周期与只读事件投影 | 使用宿主接口，不绕过压缩格式去直接改日志 |
| forkSession / createSession | 原 workspace ID、边界 → 子会话 ID | 原会话不可变，关联与附件依赖按宿主语义保留 |
| enumerateActiveWorkspaceAgents | workspace identity → 活动 actor 列表 | 文件恢复前与 apply 锁内再次校验 |

Desktop、web、headless adapter 要共用 domain 服务；renderer 只消费 DTO。宿主 API 或插件卸载改变依赖时，必须中断新操作并使已有 operation 可完成、补偿或恢复，不留下 dangling handler。

### 2.1 当前正式宿主契约的绑定

本章采用宿主研究章锁定的 rc.2 官方合同，证据入口为 `research/01-host-evidence.md` 的 H-E23、H-E28、H-E31、H-E35。必须把语义 HostAdapter 映射为真实 API，不能把本章英文接口名当官方已有方法：

1. `package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`。安装 patch 的正常插件行使用包名或包 subpath；匹配覆盖替换完整 config，并非深度合并。应用前构建完整目标 config、展示差异并按 revision/CAS 提交，不能只提交某个深层字段然后假定其余配置保留。
2. 三套预设均由 bundle 插入 `@deepseek-ai/dsh-agent-preset` 的正常插件行，`config.id` 分别采用第6节预设 ID，`config.plugins` 包含其完整组合。registry 不扫描预设目录、不接受 preset 路径、也没有 YAML 写回接口；预设查看器渲染出的 YAML 只供查看。新建、覆盖或永久安装均通过 bundle patch 与宿主 `plugin_manager` 合同完成。
3. 预设中的 service provider 与 consumer 必须在同一 `cordis:group` realm。既有 Agent、子 Agent、临时历史读取保留已绑定的精确 generation；旧代只在引用归零后销毁，不能为热换立即杀死仍被 Agent 引用的树。进程重启使用已保存 preset ID 的当前定义；缺定义必须明确拒绝恢复，不能悄换另一个预设。preset 不是权限沙箱。
4. 外部 Host 插件在可信 Node/Cordis 环境同进程运行。包选择 `apply(ctx, config)` 配合声明式 `inject/Config`，或默认 service class 等正式导出形态之一，不能叠加互相冲突的入口。所有注册与副作用归属 `ctx.effect` 等宿主生命周期清理；同包内部多模块可在正式 scope 中编排。
5. Desktop 共享 Web 前端，页面来自 `dsh-app://app/`。客户端只经认证 Connection/Gateway 及宿主注入的连接信息请求，不硬编码 Host 端口、`127.0.0.1:3080` 或把回环地址当授权。第13节路径是业务路由设计，实际通过正式 Remote 或经过认证的精确 Fetch 路由暴露。
6. Session 正式 fork 复制精确事件前缀，只在子会话闭合开放尾部；不重写父日志，不修复过去已关闭步骤的历史。adapter 在报告可持久成功前等待 `ctx.sessions.flush(session)` 的 durability barrier。活跃源会话用正式 Session fork；已持久化未加载源经 Host 观察/controller 合同装载，不直接读写压缩日志。
7. 官方文件 sandbox policy 不约束 Host 插件任意直接 `node:fs`，也不自动提供网络和进程 confinement。suite 的命令/工作区修改必须走有政策语义的宿主能力；suite 自己的 grants、worker allowlist 和审计属于本项目新增约束。`native-managed/compat-managed` 的可信确认不能标为“已在操作系统隔离”，更不能把 npm manifest 或 preset 当权限清单。
8. 本轮宿主证据尚未确认 shell/PTY 的原字节接口与每种输出通道。`spawnProcess/spawnTerminal` 是需求语义，不得杜撰 `executeBytes` 等官方方法。实现阶段要核验实际类型/运行输出；如没有满足 RUN-020–025 的正式输出 seam，独立受控 runner/兼容桥是必交付部分，仍遵守真实可提供的 policy，不能以“源码有文本输出”冒充字节保真。

## 3. Shell 发现、命令模型与执行结果

### 3.1 发现与身份

**RUN-010** shell 目录支持 `pwsh7`、`windows-powershell51`、`git-bash`、`posix-bash` 四种区分明确的身份。Git Bash 不得被 Windows System32/Sysnative/SysWOW64 的 bash.exe、Store WSL launcher 或别名代替。shell 发现优先序为用户显式路径、经验证的 runtime 配置、平台注册/常见路径、PATH；不得带作者本机路径。路径含空格、中文、`&`、括号必须按 argv 传递，禁止拼接为额外 shell 命令。

**RUN-011** 发现过程只验证存在、文件类型、最终 realpath 与可执行性；为识别版本运行的探测命令必须固定、只读、受限时限，输出不能当指令。可执行文件发生身份变化必须失效旧探测缓存。显示路径与真正执行路径一致。用户显式选 WSL 时可以单列 WSL runtime，不能悄把 Git Bash 预设变成 WSL。

### 3.2 规范命令请求

内部 `ExecutionRequest` 包含：

| 字段 | 类型 / 约束 |
|---|---|
| requestId / idempotencyKey | 不透明 ID；同 key 只能绑定同规范请求摘要 |
| actorId / sessionId / workspaceId | 必须能在宿主验证关联 |
| shellId | runtime catalog 中稳定标识，包含探测到的 dialect/version |
| command | UTF-8 文本，1–1 MiB，禁止 NUL；保留原换行与字面内容 |
| cwd | 工作区内明确目录，或 policy 明确授予的目录 |
| environment | 显式变更 map；秘密值使用 vault 引用，不进入日志 |
| stateMode | `ephemeral` 或 `persistent`；UI/结果必须反映真实路径 |
| ioMode | `text`、`bytes`、`terminal` |
| timeoutMs | 默认 120000，范围 100–3600000，可由 policy 进一步缩小 |
| outputBudget | 默认每流展示 64 KiB、总落盘 64 MiB；均有硬上界 |
| policyRef | 服务端签发的 policy snapshot ID，客户端不能伪造 |
| grantRef | 可选，绑定调用和权限范围的授权证据 |

工具接口可为简洁而省略 actor/policy 等服务端派生字段，但绝不能由模型传 actorId 冒充他人。参数不会自动把 Git Bash 的 `/usr` 解释为 C 盘。只有形如 `/c/...` 的盘符路径在 Windows 路径边界转换；字符串里的源码和命令参数不能全局替换。

### 3.3 执行生命周期、取消与幂等

**RUN-012** 状态为 `created → policy-checking → diagnosing → queued → starting → running → draining → completed`；可终止为 `rejected/cancelled/timed-out/spawn-failed/abnormal-exit`。退出非零是 command outcome，区别于工具参数错误和 broker 故障。每个状态携带递增 revision，客户端重连可取最新快照。

**RUN-013** 同一 persistent shell 串行执行；不同 actor 可并行，任何 actor 不得发送到别人的 shell。排队期间取消不启动命令；执行期间取消先请求温和中断，默认宽限 3000ms 后终止该命令所属进程树；Windows 使用宿主 Job Object/等价受控进程树能力，不能通过不限定范围的 taskkill 清理同名程序。终端自身不再可信时关闭并通知下次会重建。

**RUN-014** 截止超时与用户取消分别标注；取消后输出继续 drain 到明确上限，保留已生成数据与实际退出事实。绝不因为网络重试重新执行已经 starting/running 的请求。相同 idempotencyKey 在 24 小时内返回原 operation；不承诺命令本身在外部服务具有 exactly-once。未能确定是否启动时返回 `execution-uncertain` 并要求人工/只读核验，不自动重跑。

**RUN-015** 后台启动返回 operationId，轮询/事件流只返回增量和完成事实。后台限时与会话关闭策略明确；断线不等于取消，用户关闭聊天也不等于杀所有进程。插件卸载时，任务要么被宿主正式接管，要么在限定时间内取消、保留报告；不得孤儿运行。

### 3.4 结构化结果

`ExecutionResult` 返回 operationId、shell identity、stateMode 实际值、startedAt/finishedAt、exitCode（进程未正常退出可 null）、terminationReason、policySnapshotId、diagnostics、streamRefs、capturedBytes/spilledBytes/truncatedBytes、stateResetReason。stdout/stderr 独立；PTY 返回一个 terminal stream 并显式声明无法还原分流。结果中命令文本只按权限显示，不能把密钥环境值插到日志。

输出每个 chunk 含 stream、sequence、monotonic timestamp、raw byte offset、byteLength 与可选 decoded fragment。跨流排序是“broker 观察顺序”，不能声称还原内核真实全局顺序。文本呈现与证据字节分开，禁止在唯一原始文件中加 `[exit code]` 等标记。

## 4. 编码与原始输出契约

**RUN-020** 首选让宿主返回原始 Buffer；从边界开始保留 bytes。PowerShell 自身 Unicode、原生 UTF-8、GB18030/CP936、OEM 代码页和二进制必须能分别处理。新实现不能把所有字符 `≤U+00FF` 当原字节；不能把 `2>&1|Out-String` 全量聚合当常规执行路径。

**RUN-021** 通道策略为 `explicit(codec)`、`utf8-strict`、`auto-with-evidence`、`raw`。默认 PowerShell 控制消息使用严格 UTF-8；用户程序可按 executable identity 选代码页；auto 优先 BOM/明确协议，再流式严格 UTF-8，失败时使用显式配置的候选代码页并记录不确定性。候选匹配不能证明实际编码，UI 提供“重新解码”并可切换 CP936/GB18030/系统 OEM/UTF-8。bytes 为唯一回放真源。

**RUN-022** UTF-8 多字节、GB18030 四字节序列横跨 chunk 时 decoder 保留待续字节。只有 stream final 才结算不完整序列；无效数据可显示替代字符但原 bytes 不丢，标出 byteOffset 和 decode warning。二进制不做文本修复，不落入 Unicode normalization。CRLF 原始保留，展示可归一化但下载必须与原字节完全一致。

**RUN-023** PowerShell 的 success/error/warning/verbose/debug/information/host 输出要么通过可验证多通道桥采集，要么明确映射能力。Write-Host 中文、用户 `exit 7` 前的输出、native stderr、带 ANSI 的输出都必须可见。终端 ANSI 仅在 renderer 安全解释，禁止 HTML 注入；下载输出为 text/plain/octet-stream。

**RUN-024** 对宿主只给文本的旧执行器，兼容桥必须标记 `byteFidelity=unavailable`。不得声称已经“无损修复”。可通过独立受控 runner 取原字节，runner 仍须沿用宿主 policy；不能用 raw spawn 绕过 confinement。前台、后台、持久、受限 one-shot 共同满足同一 encoding contract。

**RUN-025** 展示缓冲有界，达到落盘限额停止捕获或取消任务的行为由配置明确：默认继续任务、记未捕获字节和截断原因；如果宿主无法保证管道不阻塞，则取消并报告。不能因为长输出把整个宿主占满内存。spill 文件由 actor 权限控制、可查看/导出/清理，默认七日保留；引用过期显示真实原因。

## 5. PowerShell 诊断与可审计策略例外

新规则 ID 使用 `RUN-PS01`–`RUN-PS17`，保留源问题覆盖，不复制源匹配代码。基于真实 dialect/version、解析器 AST 和外部命令身份判定；语言解析不可用时启用保守词法检查并报告 `analysisDepth=lexical`。规则输出含 id、severity、range、evidence、suggestion、confidence、dialect applicability。建议只给审查方案，不自动执行修复命令。

| ID | 必须覆盖的问题 | 新默认决策 |
|---|---|---|
| RUN-PS01 | 中文原生工具可能代码页不符 | warning；提示字节/代码页，不改全局编码 |
| RUN-PS02 | `$name:` 的错误作用域界定 | 解析确定无效则 error；合法 scope 放行 |
| RUN-PS03 | PS5.1 的三元语法 | 实际 PS5.1 error，PS7 放行 |
| RUN-PS04 | 双引号路径字面 `$` 被插值 | warning，可指明 intentional-expansion 豁免 |
| RUN-PS05 | Start-Process 参数引用、后台生命周期 | warning；明确 argv/生命周期不安全才阻断该风险 |
| RUN-PS06 | 可选功能 FeatureName 参数不接受数组 | 确定类型不符 error；动态值 warning |
| RUN-PS07 | DISM 无效动词 | 确定命令身份后 error |
| RUN-PS08 | 系统修复源版本不匹配风险 | warning，未知版本不推断错误 |
| RUN-PS09 | curl resume+redirect 的兼容/性能风险 | info，绝不强制改分段下载 |
| RUN-PS10 | npm/npx/pnpm 解析到受禁 ps1 shim | 在真实 resolution+policy 证明会失败时 error，否则 info |
| RUN-PS11 | PS5.1 的 `&&`/`||` | 实际 PS5.1 error，嵌套 cmd/bash 和 PS7 放行 |
| RUN-PS12 | JSON 深度截断 | warning；明确浅数据可例外 |
| RUN-PS13 | foreach 与 `$_` 的作用域混淆 | AST 证明未绑定 warning，合法嵌套管道放行 |
| RUN-PS14 | 条件赋值疑似当比较 | warning；语法错误另报 parser error |
| RUN-PS15 | PS7 专属参数/语法在旧运行时 | 按已探测版本 error，版本未知 warning |
| RUN-PS16 | cmd 方言参数/百分号变量 | warning；显式 cmd 上下文放行 |
| RUN-PS17 | Host/Information 流与普通管道混淆 | warning，解释实际采集通道 |

**RUN-030** 策略档位为 `enforce-errors`（默认）、`observe`、`strict-project`。observe 只影响诊断，不绕过宿主安全策略。strict-project 由用户/管理员配置升格规则，不能由模型自行修改。解析确定的语法错误默认拒绝；提醒不因“源码旧规则 blocking”一概拒绝。

**RUN-031** 例外对象含 exceptionId、ruleIds、normalizedCommandDigest、shellIdentity、workspaceScope、issuer、reason、createdAt、expiresAt、maxUses。默认只对当前命令一次有效；新命令/不同 shell/新 workspace/过期不沿用。UI 可审查命中证据和例外，审计保存摘要而不保存秘密值。例外不得取消路径 confinement、外发授权或文件恢复审批。

**RUN-032** PSScriptAnalyzer 为可选补充，检查脚本而不执行脚本。缺模块、崩溃、超时分别显示，默认降级 builtin 并记录；strict-project 可要求分析器不可用即拒绝，但必须说明。安装分析器是独立用户操作；不为探测运行 Set-ExecutionPolicy、不修改全局 profile、不联网安装。每次分析 5000ms 默认上限，不阻塞无限期。

## 6. 持久终端与当前预设复活

### 6.1 持久会话

**RUN-040** 持久终端键为 workspace identity + actor ID + preset generation + permission epoch。cwd、用户变量、函数、别名、环境和已激活虚拟环境跨正常调用与普通用户对话保留；终端屏幕滚动记录只对 owner 可见。不同子代理默认各自独立，明确共享必须是用户可见设置和 host policy 允许。

**RUN-041** 终端初始化固定脚本与用户 shell profile 分离；是否加载用户 profile 是显式选项，默认关闭以保证可重复。用户命令执行不污染控制通道。完成依据为认证 control channel/每请求高熵 nonce frame，与输出传输分离；普通 prompt、静默 N 毫秒、输出文本包含 end marker 均不能单独证明完成。命令输出伪造控制帧不能提前完成。

**RUN-042** 权限 epoch、workspace 根身份、shell executable identity 或 preset generation 变化时，关闭旧终端后重建；变宽变窄均如此。受限单次批准不得创建可长期复用的更宽权限终端。不能悄悄继承另一个代理更宽的环境。重建时通知丢失的状态类别，不自动重跑用户命令。

**RUN-043** 受限 Windows 无法创建 ConPTY 时使用宿主受限 one-shot，并显示“本次不保留 shell 状态”；UI 提供在已有授权范围内选择可用持久模式的入口。挂起交互提示必须支持用户输入/终止或明确返回需交互，不把等待输入误判成功。PTY 输出合并特性在结果中声明。

### 6.2 正式预设

| 新预设 ID | 必有体验 | 工具/策略 |
|---|---|---|
| `suite.windows-coding` | Windows 持久 PowerShell 7 + 编辑器的极简编码模式 | shell 与精确文本编辑，按需发现其余工具；上下文策略由当前宿主能力显式配置 |
| `suite.windows-gitbash` | 真 Git for Windows 的极简模式 | 新进程调用为默认语义并明确不持久；可选 Git Bash 持久终端必须另测，不能混淆 |
| `suite.adaptive-standard` | 六核心起步、按需解锁、模式切换、压缩后可继续工作 | shell/read/write/edit/glob/grep 为逻辑核心，实际工具 ID 由 adapter 绑定 |

**RUN-044** 每个预设有国际化名称/说明、platform capabilities、tool surface、context strategy、permission requirements、bundle entry、schemaVersion、presetRevision、minimumHostContract。除官方正常插件行支持的字段外，suite 元数据保存在自有配置/状态，不能捏造 registry 支持的 config 字段。声明行入口必须位于已安装包，按2.1节生成完整 bundle patch，不依赖 `.agent-presets`、postinstall 写用户目录或相对 node_modules 猜路径。离线安装包也应具备完整预设资源。

**RUN-045** 迁移向导只读取用户明确选择的旧预设目录，展示功能映射、已识别本地改动和目标差异；旧内容不被自动删除/覆盖。无法迁移的自定义提示词存为用户资源并等待用户明确导入，不当成宿主指令执行。原文案/官方 persona 不复制，采用独立撰写的作用等价说明。预设升级保留用户配置，配置修订使用 compare-and-swap，失败回旧 revision。

## 7. 自适应工具面与上下文纪律

**RUN-050** 自适应阶段为 `bootstrap`、`operational`、`compaction-recovery`、`degraded`。bootstrap 保留 shell/read/write/edit/glob/grep 六个逻辑核心的低成本价值，另有固定 discovery/action 入口保证从首轮可达所有功能；不得把“首轮窄工具面”误解为每轮重排发给模型的工具定义。默认采用**会话内固定 wire schema + 服务端 capability catalog + action dispatcher**：完整参数和权限描述按需发现，业务能力通过已固定的 action 工具调用，catalog 解锁不改变 wire schema。首次 durable tool completion 或 assistant completion 后转 operational。解锁目录与模式锁存入 suite 自有 durable ledger，以 actor/session/preset generation 关联，并经正式会话投影或异步订阅重建事件事实；外部插件不得调用 `appendPluginRecord()`、自行发明 SessionEventMap 记录或新增同步 `eventAt/snapshotEvents/ownEvents` 生产调用，不向 session 原始日志打补丁。suite fork 由恢复协调器按已验证父边界复制对应自有状态，普通官方 fork 的状态重建依已许可的观察合同完成，不能假定外部 ledger 自动随宿主 fork。

**RUN-051** discovery 输入 query、capability filters、可选 exact capability IDs；返回有界摘要、独立参数 schema、schemaDigest、权限要求、不可用原因与 catalogRevision。固定 action dispatcher 输入 `capabilityId/action/schemaDigest/arguments/idempotencyKey`，服务端按已发现版本二次校验结构和实际权限，发现不等于授权，外部包描述不变为权威指令。action 工具的外层 wire schema 不因 arguments 的具体内容而变。默认只把本任务需要的定义放入有界发现结果，用户可浏览完整目录。

**RUN-052** operational 保留固定核心入口、discovery/action 与已解锁 catalog 状态；compaction-recovery 缩减可选发现摘要并恢复持续任务已证实必需的 capability，不自动更改 wire schema。压缩清理可见性不删除业务状态、记忆、待办或计划。resume/reload 必须恢复已解锁/模式/catalogRevision/toolSurfaceEpoch。不同 actor 不共享隐式解锁。确需将能力晋升为独立 wire 工具时，必须生成可审查的 epoch change：给出旧/新 schema hash、顺序、定义 token 增量、受影响缓存前缀和按07章测量的预期成本；由当前任务策略或用户已授权选择后，在下一完整请求边界一次性切换。无测量数据只标未知，不能虚报命中率。稳定会话不因每轮工具使用、catalog 搜索、压缩或 UI 排序反复更改工具顺序。

**RUN-053** 工作方式设 `inspect-first`、`direct-build`、`adaptive`，另有 `auto` 清手动锁；标签用普通用户语言，模型分类依据可审计，用户可覆盖。仅影响可选工作流程提示与工具可见性，不能覆盖用户/开发者/工作区指令、宿主 plan mode 或权限模式。不会复制上游推理风格提示词，不要求展示隐藏思维。

**RUN-054** 用户提供与 workspace 指令不可为省 token 被静默移除。文件发现可用短目录提示+按需读取，但宿主要求自动注入的权威规范必须保留。提示必须标出来源；来自外部插件/技能/文件的内容保持数据身份，不因放在用户消息附近提升优先级。

**RUN-055** 每个模块故障单独计数，同一 epoch 连续 3 次异常熔断该优化，回到 policy 允许的完整 catalog；默认保留同一固定 wire schema，通过 discovery/action 访问该目录。若宿主故障使固定入口本身不可用，独立工具表回退也按 RUN-052 的明确 epoch 切换，不在后台逐轮抖动。保留宿主原请求和所有权威指令。UI/status 显示原因与重试操作。熔断不能导致暴露未获准的工具，更不能启用 disabled 插件。

## 8. 外部插件开发与运行工作台：强制复活

### 8.1 能力目标与执行模式

**EXT-001** 支持安装第三方插件、临时试运行本地包、包级热换、重启恢复、完整卸载、动态客户端 UI、staging 工具、目录 watch、开发骨架、构建打包、发布、链接修复、patch 诊断和故障演练。用户可从工作台完成闭环；不得把全部功能缩为开关 suite 自带模块。

**EXT-002** 三种运行模式并存：

| 模式 | 适用对象 | 必须兑现 |
|---|---|---|
| `native-managed` | 使用宿主正式插件扩展 API 的包 | 在宿主合法上下文完成进程内服务/工具/事件编排，host 与 client 同代生效 |
| `compat-managed` | 需要旧接口但可映射的可信包 | 版本锁定兼容桥适配 context、注册、生命周期、client；支持需要的同进程语义，限制内部访问范围 |
| `isolated-worker` | 可通过 RPC 提供工具/HTTP/UI 的包或开发片段 | worker/process 中运行，能力 token 按需要授权，代理注册到 suite owner 下；崩溃不拖垮宿主 |

隔离 Worker 不能假冒完全支持共享内存/同进程服务。包要求进程内能力时，必须提供 native/compat path 的真实实现与测试；明确可信运行确认可接受，简单标“不支持”不满足本次交付。任意未知内部 API 不承诺自动兼容，诊断中给出需实现的 adapter contract，并作为未完成交付项追踪。

**EXT-003** 首次安装/运行前生成 PluginExecutionPlan：包身份、来源、内容摘要、版本、许可、依赖、安装脚本、HostAdapter 需求、申请服务/文件/网络/进程/原生模块能力、运行模式、目标 profile、临时/持久、所有资源 namespace、预期磁盘变更。用户查看并授权范围；之后相同内容和授权 scope 可复用，不按每次热换重复问无关问题。

**EXT-004** 开发者模式可运行用户明确提交的代码片段，但默认放在 isolated-worker，作为有文件版本/hash 的开发单元；不提供无限权的 `new Function(args, ctx)` 宿主上下文穿透。需要同进程的开发单元必须包装为可审查包、列明服务合同并获可信同进程权限。由此保留动态试验价值，也使来源和变更可追溯。

### 8.2 生命周期、代际与失败保旧

**EXT-010** 每插件状态为 `discovered → inspected → authorized → preparing → staged → activating → active`，可转 `degraded/failed/disabled/disposed`；每次热换 generation 单调递增。插件所有注册资源绑定 packageId+generation+profile，禁止包名子串匹配清他人资源。管理只接受完整 plugin ID。

**EXT-011** 热换先解析新包、校验构建新鲜度、schema 与依赖，隔离 staging 构建资源集；通过健康检查后在请求边界原子切换 suite 路由指针，新请求只见新代，旧请求按策略 drain 后 dispose。新代失败保持旧代 active；旧代 dispose 失败标资源泄漏并提供精确 owner cleanup，不靠清内部全局路由表。无宿主代际事务时由兼容桥实现此可见性协议。

**EXT-012** host 与 client 使用同 generation；客户端加载失败不能显示 host/client 都成功，可回旧 client 或整代回旧，策略展示。浏览器模块与脚本由宿主支持的模块加载机制提供，不能任意拼 HTML/script injection。外部包 UI 主题跟随 suite，原功能面板全部可达。

**EXT-013** 临时运行不写永久 bundle，重启后默认不自动运行；用户可选择“恢复我的临时开发工作台”，此时 registry 保存显式意图和授权摘要。永久安装通过宿主管理 API 提交声明与依赖，冷启动与热运行相同状态。安装过程 journal，失败回滚 suite 自有变更，不覆盖用户并行编辑。更新 profile 以 revision/CAS 防丢变更。

**EXT-014** watch 只监视用户批准的源码/构建产物根；默认 debounce 1000ms，上限合并一次代际更新，构建中不重复重载，产物没更新只提示。源消失不清 registry、不循环重建错误链接；保留旧代、显示 dangling-source。自热换受独立管理器保护，不能卸掉正在执行恢复协调器；进程重启可从 journal 恢复。

### 8.3 开发能力映射

| 新功能 | 必交付行为 |
|---|---|
| Inspect/Run Temporary | 选目录/本地 tarball/明确 npm 来源，先 inspect 再 plan，再运行；同时验证 host tools/client UI |
| Install/Uninstall | 指定 profile 永久安装、幂等，卸载清资源和自有引用；数据保留/清除分开选择 |
| Runtime Inventory | 清单、版本、generation、进程/worker、服务/工具/routes/slots、health、错误、来源、权限 |
| Reload | 单包预检与热换，失败保旧，显示差异与变更摘要 |
| Staging Add/Call/List | 开发包或片段在后台试验区，可调用但不进入正式模型工具 schema |
| Promote/Demote | 转正从下一请求进入正式 catalog，默认仍通过固定 action dispatcher 调用；独立 wire 工具晋升走 RUN-052 的 epoch 与缓存成本预览；撤下停止新调用、排空旧请求后回收，保留试验定义可选 |
| Resource Cleanup | 仅清指定 owner/generation 遗留 routes/listeners/UI，先预览后应用 |
| Link Repair | 只修该包安装计划拥有的链接，验证 link 本身与 target，绝不递归删真实目标 |
| Bundle Repair | 解析/诊断合法配置，生成最小 patch diff，先备份、CAS、校验、失败恢复；不猜未知 YAML |
| Scaffold | host-only、client-only、host+client、provider/preset 四类独立模板，符合锁定当前标准 |
| Build/Pack | 读取任务定义，受策略执行构建，区分源码/产物摘要，检测陈旧 JS，产出可复验 tgz 与 SBOM |
| Release | 准备目标仓库、tag、构件 digest、说明与预览；明确用户外发授权后发布，失败保留本地成果 |
| Drill | 在临时受控 workspace/独立测试 profile 完成注入→调用→UI→热换失败保旧→撤下→清理，生成报告 |
| Internalize Folder | 创建用户可见开发任务，将所选资料作为数据生成插件草案；完成后 inspect/plan，不自动信任生成物 |

发布流程不得从已登录 gh/npm 状态推断用户同意外发。构件选择按 manifest 与 digest，不能简单取目录最后一个 tgz。Install scripts 默认禁用；必要脚本列出、获相应权限后在隔离 build 环境运行，不隐式执行任意依赖 lifecycle。

## 9. 恢复对象、检查点与存储

### 9.1 对象模型

新格式名`suite-recovery/1`是兼容存储codec名。ID是不透明随机标识；新公共DTO的createdAt/expiresAt均为ISO8601 UTC字符串，UI用宿主时区。复用原格式的epoch milliseconds时codec检查范围，明确`*Ms`内部字段并在边界转换，不透传数字createdAt。JSON用UTF-8，拒绝未知必需版本；blob用SHA-256并记byte length。Git另记object algorithm，不混用SHA1/SHA256。

| 对象 | 最低字段 |
|---|---|
| WorkspaceIdentity | id、canonicalRoot、platform、volumeIdentity、repository identity（可选）、worktree identity、bindingRevision |
| Checkpoint | id、format、kind=user/turn/rescue、workspaceId、createdAt、source session/turn boundary、entriesDigest、scope、captureStatus、limits、skips |
| Entry | canonical relative path、entryKind=file/link、linkKind=file-symlink/directory-symlink/windows-junction/unknown-reparse、raw size/contentDigest 或 originalLinkTarget、reparseTag、verifiedWorkspaceRelativeTarget、supported mode、origin provider |
| RestorePlan | id、workspaceId、checkpointId、sessionBoundary、selected paths、current fingerprints、repository fence、expiresAt、planDigest、required grants |
| RestoreOperation | id、planDigest、idempotencyKey、rescueId、phase、per-path steps、side effects、verification、fork outcome、last durable sequence |
| CleanupPlan | workspace/checkpoint selection、retained recovery refs、estimated reclaim bytes、current inventory revision |

Link条目保留原始目标表示、链接类别与reparseTag，另存已验证的workspace-relative目标，不用显示规范化值覆盖原表示。内部junction、目录/文件symlink分别round-trip；未知reparse类型只读保留、不apply。junction绝对目标须证明在当前工作区内，父层junction不得穿越，重绑定重新验证。

**REC-001** 存储根必须处于所有受管工作区之外，权限为当前用户私有或等价 ACL。配置路径变更需显式迁移事务；运行中不可改 storageRoot 后丢锁。工作区搬移通过验证 worktree/volume 身份与用户可审查 rebind 计划处理，不凭 cwd 字符串认定旧库存不存在。复制仓库不能继承原 worktree 所有权。

### 9.2 捕获

**REC-002** 在该回合首次可能发生副作用之前捕获隐藏 turn checkpoint。只对真实直接用户回合开头建立关联，记录宿主已验证 turn boundary；插件注入、工具输出、系统提醒不伪装为用户锚点。捕获失败/超限不吞用户任务，保存明确 skipped outcome 并显示无文件回退保证。

**REC-003** 默认捕获已跟踪文件与被 policy 允许的非忽略文件；Git ignore、suite exclude、隐私排除决定范围，范围及 revision 写进 checkpoint。默认不捕获 .git 元数据、凭据文件、socket/device/FIFO、node_modules 等体积目录；用户可明确调整可允许排除项。排除的原始秘密内容不为“扫描安全”而先读取；按路径与规则判断。

**REC-004** 默认最多 100000 文件、单文件 64 MiB、逻辑总量 2 GiB，自动捕获新增读取 256 MiB、时间 5000ms；可配置但需有硬上界。超大文件跳过并记录，不让整个检查点失效。超过总/文件上限标 `partial`，列出已观察范围、skip count 和原因。未观察路径恢复时不得推断为应删除。

**REC-005** Git 工作区可复用 Git object database 作为后端，但不得执行用户 hook，不 commit/stash/reset/checkout，不修改真实 index、HEAD、分支与 staged 状态。私有 ref 名称绑定 store/worktree ID 且有 publication journal；GC 只删自己拥有的 ref。目录工作区有独立原始字节 blob 后端，非 Git 不失去恢复功能。

**REC-006** 快速捕获可用持久 stat/path cache，必须记录 trust=`metadata-fenced`；严格模式 reread bytes，标 trust=`byte-verified`。stat 缓存不是最终恢复校验。文件读取前后比对 identity/size/mtime/ctime，变化则限次重读或 skip；不能把不一致切片作为稳定快照。

## 10. 路径、链接、二进制与重命名

**REC-010** 持久相对路径按 `/` 分隔，禁止空路径、空段、`.`、`..`、NUL、绝对路径、盘符路径、UNC、设备路径及跨根。非法记录拒绝，不正规化后接受。Windows 额外拒绝 ADS 冒号、保留设备名、尾空格/点导致的别名和大小写碰撞。合法 Unicode 文件名保留原字节/平台表示；UI NFC 显示不能改变实际身份。

**REC-011** apply 前与每个关键文件步骤再次检查父目录均为真实目录；symlink/junction/reparse point 不被穿越。工作区根本身的最终身份在 plan/apply 锁内核验。任何解析后越界拒绝。对不支持基于文件句柄相对操作的平台，必须明确 TOCTOU 剩余风险，以反复 identity 验证和最小可写范围降低风险，不能宣称完全 race-free。

**REC-012** 普通文件按原 bytes 恢复，保持编码、BOM、CRLF、NUL 与二进制。POSIX 仅恢复可支持 mode/executable 位，不恢复 ownership/setuid/设备能力；Windows 不把 POSIX mode 等同完整 ACL。ACL/xattr/hardlink topology 默认不恢复，显示 `metadata-not-captured`，不能暗示完整系统备份。

**REC-013** 符号链接保存 linkTarget 原文，不跟随目标读取。默认只允许创建解析后位于同 workspace 内的相对链接；检查点含指向外部的链接可展示但 apply 返回 `external-link-not-authorized`，用户通过专门可审查授权扩大范围后方可创建“链接本身”，仍不读写外部目标。Windows junction 作为 reparse point 单独识别，不当普通目录递归捕获；第一版必须支持安全还原已批准的内部 junction，缺 privilege 时给清楚原因并保留该路径未修改。

**REC-014** rename 在 UI 可用内容/identity 关联为一个意图，但持久计划以“源删除+目标创建”表达最终字节状态；大小写仅更名使用同目录中间名避免冲突。目录替换为文件前，未纳入计划的子文件/非空目录导致冲突；绝不递归删除用户目录。hardlink 被改写后可变为独立文件，事前提示 topology 不保留。

**REC-015** 恢复不触碰 scope 外、excluded、skipped、truncated 未观察路径。完整 checkpoint 下，恢复创建后的新增文件也必须先明确列入变更清单与用户选择，不能扫根递归删除。file→symlink→directory 类型变化均做冲突检查；不因 directory 不是空就强删。

## 11. 计划、预览、批准与 apply 状态机

### 11.1 三种用户意图

| 模式 | 用户结果 | 文件检查点是否必需 |
|---|---|---|
| `conversation` | 新建子会话回到所选用户请求之前，原问题作为草稿 | 否，不读项目文件内容 |
| `files` | 当前工作区按检查点恢复选中文件，会话继续保留 | 是 |
| `conversation-and-files` | 恢复文件后创建子会话，原请求放草稿 | 是 |

**REC-020** 第一条用户请求前没有完整回合边界，使用原 workspace association 创建空白子会话；后续锚点 fork 到前一个完整 turn/end。只接受宿主确认的直接用户 opening message。继承父会话消息必须验证 lineage、继承事件数、边界稳定和循环；不足以确认则不猜测。

**REC-021** 原日志 append-only；不截断、不直接写 zstd/JSONL、不修改来源标记、不将 UI 隐藏等同真正删除。fork 与草稿恢复都调用正式宿主会话 API；所有原 attachments/结构化段按宿主可用能力处理，未能迁移的附件列明，不能默默丢失。

### 11.2 计划与预览

**REC-022** 预览是只读，展示 checkpoint 时间、完整/部分状态、文件数/大小、当前分支/HEAD 与捕获时差异、活跃会话、拟修改/创建/删除/类型变化、无法恢复项、未受管冲突。文件详情按 cursor 分页，默认 100/页，最大 500；binary 只显示大小/hash/可下载对比，不强制文本 diff。

**REC-023** 用户选路径后生成计划，默认有效期 120000ms。plan 绑定 actor/session/workspace/checkpoint/路径集合、当前每路径 fingerprint、repository fence 和 namespace revision；planDigest 采用确定性序列化摘要。预览变化、选择变化、HEAD/operation/worktree identity 变化、过期均要求重新 plan，不提供“忽略所有漂移”按钮。

**REC-024** headChanged 默认阻断文件恢复，可在明确复审计划中允许恢复文件内容，但 merge/rebase/cherry-pick 等 repository operation 变化始终需重新检查；不调整 Git 状态。进行中的同 workspace 代理必须停止/进入 host 强制互斥 barrier 后才能文件 apply。用户手工文件变化无法全阻断，逐路径 freshness 保证仍然必须。

**REC-025** apply 需要服务端验证的 approvalRef，绑定 planDigest 和主体。UI 点击明确“恢复选中 N 文件并创建分支”可产生对应授权；API/模型调用不能仅回传随机 token冒充批准。已存在充分授权时直接复用，不重复提示。conversation-only 对文件不申请审批，但仍验证会话访问权限与分支意图。

### 11.3 操作状态

```text
planned -> authorized -> locking -> validating -> rescuing -> journaled
        -> applying -> verifying -> files-committed -> forking -> completed
applying/verifying明确失败 -> compensating -> rolled-back
forking已确认未产生child -> compensating -> rolled-back
forking已创建child -> fork-created -> flushing -> completed
forking/flush结果不确定 -> fork-durability-uncertain -> reconciling
reconciling -> completed / recovery-required / confirmed-no-child
confirmed-no-child -> compensating -> rolled-back
compensating 失败或进程中断 -> recovery-required
未写任何文件前取消 -> cancelled
已写文件后取消 -> compensating -> rolled-back / recovery-required
```

**REC-026** 同 workspace 独占锁覆盖 plan apply 与 cleanup；锁带 host identity、process identity、boot/session nonce、lease revision。不同 storage root 对同 Git worktree 也必须竞争同一 identity lock。不能凭本机 PID 不存在回收远端主机锁；stale reclaim 采用比较锁 nonce 的安全协议，不能隔离/删除已被替换的新锁。

**REC-027** 获锁后重新验证工作区、active agents、目标与期望 entries。先创建**覆盖全部将修改路径**的 rescue checkpoint，确保数据 durable 且 hash 可读取；写 operation journal 并 fsync 后才改文件。rescue 失败或 storage 不可写时，工作区零修改。不可为腾空间先删当前唯一救援点。

**REC-028** 文件步骤为：校验当前路径→准备同目录临时条目→写 bytes/metadata→fsync→再次检查目标 freshness→同卷替换→目录 flush（平台支持时）→记录步骤完成。删除只 unlink 单文件/链接或移除空目录。Windows 文件被占用/杀毒阻止、EXDEV、权限不足时不能绕过为危险复制后递归删除。

**REC-029** 多文件恢复是 journal+补偿事务，**不承诺操作系统提供整个工作区原子可见**。外部编辑器可能观察到中间态。suite 自己暂停对该 workspace 的写工具和索引，UI 显示恢复进行中；每个文件同目录替换尽可能原子。结果只有在全部选中路径 byte hash/type/支持 mode 验证通过后才标 files-committed。

**REC-030** 每步journal持久化preimage、预期postimage与实际写入结果。应用失败时，补偿前重新检查freshness，只对当前仍匹配本次可识别postimage的路径按rescue恢复。外部编辑已改变该路径或结果未知时保存当前版本与rescue，进入recovery-required，不覆盖新编辑。补偿不受普通取消打断，有独立有界期限。全部安全恢复才返回rolled-back并保留原错误，否则保留journal/rescue/临时材料、阻止后续mutation并给恢复计划。须测试第N文件失败而此前路径已被外部编辑。

**REC-031** 同一 apply idempotencyKey+planDigest 并发返回同 operation，不运行两次。不同 key 同 workspace 排队或返回 busy；同 key 不同 digest 409。成功计划消费，重复 apply 返回原成功 operation；已过期但曾完成的请求仍可查结果。网络超时不令客户端擅自执行第二次。

## 12. 分支事务、撤销与崩溃恢复

**REC-040** conversation-and-files文件验证完成后才调用host fork。调用前持久化fork-intent、request correlation与宿主支持时的预分配child ID；返回child后先持久化其关联，再验证workspace/parent boundary，调用正式`ctx.sessions.flush(child)`及所需元数据持久性屏障，最后提交UI导航。只复制选定精确前缀，允许正式fork在子会话补齐开放尾部；不能混入后来父回合。仅确认未产生child时按fork失败补偿文件。已创建、调用结果未知或flush不确定均进入`fork-durability-uncertain/reconciling`，保存child线索并只读核验，不能盲retry。成功后断线，重连查operation返回同child。宿主无幂等/预分配能力时adapter必须给出可检索的相关性协议；无法证明有无child时保持recovery-required，不能假装恰好一次。

**REC-041** 用户导航失败不回滚已成功的文件+fork：operation 已完成，展示可点击子会话链接与恢复摘要。草稿写入失败单列警告并保留原请求可复制，不把完成状态误判文件恢复失败。conversation-only 可在目标会话运行中依宿主能力创建分支，但不停止无关会话、不伪装已回退其文件。

**REC-042** “撤销本次恢复”通过原 operation 的 rescue 构建**新 plan**，先对比当前工作区；若恢复后又有编辑，列出差异并选择性撤销，不直接覆盖。撤销也先 rescue/journal/verify，可再次撤销，形成有界可审计链，不用 Git reset。

**REC-043** 启动扫描非终态 journal，在未启用写工具前对账。若全部文件已达到目标且 fork/提交记录可验证，则补全终态；若仍可安全补偿，则生成 recovery plan，由已记录授权与 policy 判断可否完成；不能确认已写内容或工作区有新的外部变化时，保持 recovery-required。不得仅因为旧进程 PID 消失就认定无需恢复。

**REC-044** 从 rescues 恢复的过程本身 journal，掉电后可以继续；损坏 journal、未知版本、blob missing/hash mismatch 隔离为 corrupt state，只读展示，不能以空对象继续。需要人工选择时预览已知状态，不在后台猜“用户更想要哪份”。备份策略支持导出单 workspace 的 manifest+blobs+完整性清单，导入只生成候选数据不自动 apply。

**REC-045** checkpoint GC 使用引用图：plan、running/recovery-required journal、undo chain、pinned checkpoint 都是根。只删除无人引用的 blobs 和本 store 拥有的 Git private refs；列出逻辑大小和实际独占可回收大小，不能把所有快照逻辑字节相加当磁盘节省。cleanup 自身 journal、锁与 CAS，任意崩溃不会删救援必需对象。

## 13. 公共工具与 HTTP 合同

### 13.1 工具

以下`suite_*`均为内部逻辑capability ID，不额外注册成第二套模型工具。`suite_tool_discover`映射`nexus_catalog`，runtime/command/operation/work_mode映射`nexus_runtime`，extension相关映射`nexus_extensions`，checkpoint/recovery映射`nexus_recovery`；`suite_action`是内部派发协议。对模型只使用09章固定公共表及统一包络。领域payload严格拒未知字段发生在09章别名归一化之后。混合动作工具不得整体标readOnly；宿主只有工具级权限标签时预先固定读/写投影，服务端仍按具体action、主体、目标、plan/grant校验，不因catalog解锁临时改变wire表。status/effectState等按09章无损保留，错误不泄露stack/秘密。

| 工具 | 核心输入 | 副作用与授权 |
|---|---|---|
| suite_runtime_status | 可选 shellId/session scope | 只读状态、真实权限、持久性、codec、诊断状态 |
| suite_command_check | command/shellId/analysisDepth | 只分析，不执行用户命令 |
| suite_command_run | command/shellId/stateMode/timeout/output options/idempotencyKey | 经 policy 执行，后台返回 operation |
| suite_operation_read | operationId/cursor | 只读 owner 可见增量 |
| suite_operation_cancel | operationId/reason | 取消自己任务，不清他人进程 |
| suite_tool_discover | query/capabilities/toolIds | 搜索/解锁不授予执行权限 |
| suite_action | capabilityId/action/schemaDigest/arguments/idempotencyKey | 固定会话 schema 的统一调用入口；按 catalog 定义再校验，不因通用入口绕过具体能力权限 |
| suite_work_mode | mode/optional expectedRevision | 修改当前 actor 的工作方式，不修改宿主权限 |
| suite_extension_inspect | source descriptor | 只读候选包与计划草案，不跑 install scripts |
| suite_extension_plan | inspectedArtifactId/action/runMode/profile | 生成外部扩展运行/安装/热换计划 |
| suite_extension_apply | planId/approvalRef/idempotencyKey | 安装/临时运行/热换/撤下的统一入口 |
| suite_extension_stage | action=add/call/list/promote/demote + unitId | staging 执行仍需对应能力授权 |
| suite_extension_build | projectId/taskName/idempotencyKey | 通过 ExecutionBroker 构建/打包 |
| suite_extension_release_plan | artifactId/repository/tag/notes | 产出可审查发布方案 |
| suite_extension_release_apply | planId/approvalRef/idempotencyKey | 仅有明确外发授权时发布 |
| suite_checkpoint | action=create/list/inspect + workspace/checkpoint | capture/list只按访问政策；不能凭 cwd 越权 |
| suite_recovery_plan | mode/anchor/checkpoint/selected paths | 返回预览和计划，不改文件 |
| suite_recovery_apply | planId/approvalRef/idempotencyKey | 恢复/分支事务 |
| suite_recovery_undo_plan | operationId/selected paths | 新 plan，不直接写 |
| suite_recovery_status | workspaceId/operationId | 查中断与恢复状态 |
| suite_recovery_cleanup_plan/apply | inventoryRevision/selection、planId/grant | GC 与保留逻辑单独授权 |

模型可发现 staging 管理工具，不代表每个 staging 测试工具都进入 schema。构建与发布不接受任意 shell 拼接式 repository/tag；参数以结构化 argv 给 CLI，notes 用 UTF-8 临时文件或正式 API 字段传递。

### 13.2 HTTP

下表`/api/suite/v1`仅是领域逻辑路由或可选兼容别名，不创建另一默认服务；正式调用经09章`nexus`认证桥及01章Desktop传输。不是照搬上游`/turn-rewind`。所有修改请求要求宿主认证/CSRF防护、JSON content-type、body上限；Origin缺失按宿主非浏览器客户端token合同处理，不能简单放开CORS。

| 方法与路径 | 语义 |
|---|---|
| GET `/runtime/catalog`、`/runtime/sessions` | shell 能力、版本、真实执行模式 |
| POST `/runtime/executions` | 建立执行 operation |
| GET `/operations/{id}`、`/operations/{id}/events?cursor=` | 有权主体取状态/增量，cursor 不透明 |
| POST `/operations/{id}/cancel` | 幂等取消 |
| GET `/extensions`、`/extensions/{id}/resources` | 外部插件清单与 owner 资源 |
| POST `/extension-plans`、`/extension-operations` | inspect/plan 与 apply 分离 |
| POST `/extension-staging`、`/extension-builds`、`/extension-release-plans` | 开发闭环 |
| GET `/checkpoints?workspaceId=&cursor=` | 列出 checkpoint |
| POST `/checkpoints` | 用户手动 checkpoint |
| POST `/recovery-plans` | 计划与初次预览 |
| GET `/recovery-plans/{id}/changes?cursor=&limit=` | 稳定分页、同 plan revision |
| POST `/recovery-operations` | apply，body 含 planId、approvalRef、idempotencyKey |
| POST `/recovery-operations/{id}/undo-plans` | 撤销预览 |
| GET `/recovery-inventory`、POST `/recovery-cleanup-plans` | 存储管理与清理 |

成功创建 201，已存在幂等 operation 200，异步操作 202。参数错误 400、权限不足 403、无对象/无权确认对象存在 404、busy/stale/conflict 409、expired 410、too-large 413、unsupported-runtime 422、限流 429、暂不可用 503。HTTP status 与内部 error code 分离，客户端不得靠英文 message 判断。

计划例子（标识为占位数据）：

```json
{
  "schemaVersion": 1,
  "mode": "conversation-and-files",
  "workspaceId": "ws_demo",
  "anchor": {"sessionId": "s_demo", "openingMessageSeq": 42},
  "checkpointId": "cp_demo",
  "paths": ["src/main.ts", "assets/logo.bin"],
  "expectedInventoryRevision": 7
}
```

不允许 body 传入 storageDir、raw journal 路径或任意 source session filename。浏览器不能通过注入绝对路径直接读文件，所有路径由授权 workspace ID 解析。API schema、工具 schema 与 UI DTO 从同一独立 domain schema 生成，但保留不同鉴权层。

## 14. 用户界面行为

运行环境页提供 Shell 卡片、预设卡片、终端会话列表、编码策略和命令诊断；每张卡显示实际能力、状态与简短原因。外部插件工作台沿用原“添加→列表→详情→操作结果”的认知顺序，升级为可筛选资源清单、代际差异、权限计划与开发任务流。插件名、来源、可信范围、运行模式和 host/client 状态可直接看到，危险/失败状态不只用颜色。

消息旁“从这里重来”使用宿主消息动作插槽，键盘可达，触发后默认展示三模式与实际可恢复文件数量；无 checkpoint 时仍可 conversation-only。预览对话框包含模式选择、摘要、搜索/分页差异、部分快照提示、选择路径、主操作和取消。若其他代理正在写入，显示具体会话与停止入口，不自动终止。

恢复过程中 dialog 可关闭但 operation banner 继续，操作锁状态明确；成功展示恢复路径数、子会话入口和“撤销本次恢复”。失败显示是否已经恢复到救援点、哪些路径需处理，提供只读诊断和 recovery plan。所有异步状态有 loading/empty/error/retry，焦点返回触发消息，屏幕阅读器播报完成/失败，长列表虚拟化。

原界面作信息架构参考，视觉 token、图标、间距、文案和组件独立设计。禁止为“更漂亮”遮蔽部分 checkpoint、权限降级、二进制/链接限制和运行中状态。

## 15. 验收矩阵与故障注入

以下是新实现必须执行的测试，研究阶段没有声称已通过。每项报告记录宿主/OS/Node/可执行版本、policy、产物 digest、实际步骤与结果。真实桌面验收必须使用临时测试 profile 与临时 workspace，不能拿用户生产会话练习。

| 编号 | 场景 | 必须观察的结果 |
|---|---|---|
| RUN-AT01 | Windows 11 + 当前 Desktop 安装新包 | 三预设卡片出现，来源是已安装 bundle 声明，未写旧目录 |
| RUN-AT02 | Git Bash 安装在中文含空格路径，PATH 有 System32 bash | 执行真正 Git Bash，WSL 不启动，cwd 转换正确 |
| RUN-AT03 | 持久 pwsh 连续设 cwd/env/变量/function/alias，再调用 | 全部保留；另一 actor 看不到 |
| RUN-AT04 | 权限先缩再放、切 workspace、更新 preset | 旧终端均关闭，新模式与实际 policy 一致，提示状态重置 |
| RUN-AT05 | 受限模式 ConPTY 不可用 | 同权限 one-shot 成功或明确拒绝，绝不 raw spawn full access |
| RUN-AT06 | 分别 UTF-8/CP936/GB18030 输出、中英混合、跨 chunk 多字节 | bytes 原样，文本按选择解码，不能恢复时明确不确定 |
| RUN-AT07 | Write-Host 中文、stderr、`exit 7`、NUL/binary | 退出前内容不丢，exit=7，通道事实与原 bytes正确 |
| RUN-AT08 | 100 MiB 输出、客户端重连、spill 达上限 | 内存有界，截断/落盘事实准确，不重复执行 |
| RUN-AT09 | 排队取消/运行取消/子进程树/超时 | 原因区分，精确清本任务树，无关进程存活 |
| RUN-AT10 | 17 类 PowerShell 问题在 PS5.1 与 PS7 | 按真实版本与 AST 判定，合法上下文不 blanket deny |
| RUN-AT11 | 例外过期、不同命令复用、缺分析器、PSSA 崩溃 | 摘要绑定，不越权；降级可解释、无 Set-ExecutionPolicy |
| RUN-AT12 | 首轮→发现能力→解锁→压缩→resume→三次异常→显式独立工具晋升 | 前六步 wire schema hash/order 不变，状态可恢复、权威指令保留；晋升有 epoch 与缓存成本预览且只在完整请求边界生效 |
| EXT-AT01 | 临时外部 host+client 包 | 无整机重启工具和 UI 均可用；不改永久 bundle |
| EXT-AT02 | 外部同进程服务被另一插件注入消费 | native/compat 路径真正可用，共享服务生命周期正确 |
| EXT-AT03 | 旧接口包经兼容桥运行并动态 UI | 需求合同映射可验证，不靠“不支持”隐藏缺口 |
| EXT-AT04 | 破坏新代构建/UI、热换中旧请求未完 | 失败保旧或整代回旧，旧请求不重复，资源无跨代泄漏 |
| EXT-AT05 | staging add/call/list/promote/demote | 未转正不污染正式 catalog，转正下一请求可发现且默认 schema 不变，独立 wire 晋升有 epoch，撤下无孤儿 |
| EXT-AT06 | 永久安装冷启动、卸载、registry恢复、源消失 | 热态冷态一致，临时策略尊重，缺源清楚诊断 |
| EXT-AT07 | junction 悬空、包目标为真实目录、patch 并行编辑 | 仅修拥有的链接，目标不删，CAS拒绝覆盖他人编辑 |
| EXT-AT08 | scaffold→build→pack→release plan→明确批准发布 | 当前标准可安装，构件新鲜、digest 一致，无授权不外发 |
| EXT-AT09 | 临时开发代码 worker 崩溃、自热换失败 | 宿主继续可用，明确失败报告，旧管理器可恢复 |
| REC-AT01 | 首消息/后续消息/父分支继承消息/注入消息 | 正确 create/fork 边界；原日志 hash 与字节不变 |
| REC-AT02 | conversation-only 无 checkpoint/项目无权限 | 可分支，完全不读项目文件内容 |
| REC-AT03 | files/both 在普通目录与 Git worktree | 计划→rescue→日志→恢复→验证；index/HEAD/branch 不变 |
| REC-AT04 | plan后编辑、切分支、merge状态变化、过期、换session | stale/expired/session mismatch，零工作区修改 |
| REC-AT05 | binary/BOM/CRLF/零字节/可执行位/重命名/大小写改名 | 原 bytes 与支持 metadata 匹配，限制事前可见 |
| REC-AT06 | symlink父目录/Windows junction/外部link/ADS/设备名 | 越界与别名拒绝，内部link按政策恢复，无跟随外部目标 |
| REC-AT07 | 目录→文件有未受管子文件、partial checkpoint | 冲突拒绝；skip/未观察路径不删除 |
| REC-AT08 | rescue磁盘满、blob损坏、journal写失败 | 修改前fail closed；已修改则补偿或recovery-required |
| REC-AT09 | 第N路径权限失败/占用/用户取消 | 自动补偿，已知路径全验证，不递归删目录 |
| REC-AT10 | 每个状态/文件步骤后强杀重启 | 对账到completed/rolled-back/recovery-required，数据可解释 |
| REC-AT11 | 文件成功fork失败、fork成功响应丢失、UI导航失败 | 前者文件补偿；后两者同child、不重复fork、不误撤成功 |
| REC-AT12 | undo前有新编辑、undo再undo | 新计划与差异，用户改动不被无预览覆盖 |
| REC-AT13 | 两storage root同worktree、stale lock并发、远端锁 | 单写者，nonce稳定，foreign host 不凭本机PID夺锁 |
| REC-AT14 | worktree移动/复制/身份丢失/存储迁移中断 | 安全rebind或明确阻断，不显示假空库 |
| REC-AT15 | GC并发恢复/未完成journal/undo引用/private refs | 必需救援不删，只删本store对象，崩溃可重试 |
| REC-AT16 | 20000文件/350MiB样本、快速与严格捕获 | 报告p50/p95与读写字节，时限/skip事实准确，无无界阻塞 |

性能验收需在公布硬件上测量：小项目预览 p95 ≤1000ms，20000 文件快速自动捕获 p95 ≤5000ms（超限应如实 skip），UI 50000 变更条目滚动不阻塞主线程；完整恢复吞吐报告实际数据，不把某台上游测量当新工程性能。可用性目标不是牺牲数据完整性以满足秒数。

## 16. 实现交接约束

实现人员以本章domain行为与总规格HostAdapter合同为输入，可按来源锁和组件许可直接复用、组合或修改上游命令包装器、预设、规则、loader适配、恢复引擎与UI组件。宿主接缝集中适配，已知输出/权限/恢复缺陷不得照搬；persona、图标、第三方引用和素材分别核验权利。形成SBOM/NOTICE与补丁记录。“净室级”仅是规格详细程度，不要求研究/开发团队隔离，也不要求把成熟模块一律重写。

本章强制能力一项未验收，即相应模块不完成。API 不足的隔离桥/兼容桥、外部同进程编排、持久终端和恢复崩溃一致性不能被挪到“未来增强”来满足首版完成声明。
