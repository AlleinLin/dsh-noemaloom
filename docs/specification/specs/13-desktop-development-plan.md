# 13 DSH Desktop 完整开发方案与连续执行合同

版本：1.1.0-draft.2。基准：2026-10-19；目标 Windows 11 x64、官方 Desktop `0.2.1-rc.2`、官方 SHA `687f282e8625c6b8d11ff58211a90524be2e4317`。本章把前十二章变成可以连续实施、遇故障修复并从检查点接续的工程方案。**当前是方案交付，没有实现、安装或运行新插件。**

本版按用户进一步要求修订为**8个直接复用源码的执行包**。原62项转换为检查清单，不再作为62个独立开发任务或排期门槛。全部功能、效果要求及原769项验收定义保留；合并的是重复实施、接线、验证和交付工作，不能减少产品内容。

“一步到位、一把梭”的工程含义是：范围一次冻结、依赖一次理清、按可验证纵向切片持续开发、失败修复后接续，最终交付全部功能。它不表示第一次构建必然成功、不表示未经实测的适配已被证明，也不允许用模拟成功跨过门禁。Metis 的现有 DeepSeek production controller 中有写死 PASS 的路径，必须排除，详见第12章及对应研究证据。

## 1. 最终交付与执行边界

交付物是一个用户安装的 Nexus npm 包：原33目录、两个qiudeng工程方法仓库及Metis，共36研究单元、dsh-web的19个子包能力全部有归属；去重、适配和可选Provider按第10章执行。插件外观全面参照Claude桌面客户端，真实功能使用DSH原生React slots，不能以概念HTML完成产品交付。论文支持的自治、可逆、增量T1/T2/T3压缩是核心；多模型编排共用一个TaskPlan/Run调度器；全部收费调用入账，缓存以Provider上报和配对任务成本验收。

实施范围包括Host/Client、存储、权限、全部adapter、图谱与恢复、开发工作台、远程/SSH、完整界面、测试、打包与升级回滚资料。可选外部服务在未配置时可以不可用，但其连接器、设置、探测、错误处理、取消与集成fixture必须实现。没有真实账户的在线能力保留为明确的“待账户实测”证据，不能标为已通过；正式宣称支持的能力须完成相应真实验证。

后续收到“按此方案开发”后，可在 `D:\dshplugin\plugin` 持续工作并产出本地构件。当前方案本身不授权收费API、外部消息、公开发布或修改用户实际Desktop profile。开发执行时沿用用户后续明确授权，不重复索取已有授权；可逆代码、临时fixture、读取与本地修复按授权持续完成。

## 2. 一次确定的技术路线

### 2.1 默认直接复用，按实际接缝补齐

这是有现成源码的DSH插件整合工程，应按源码组合与适配估算，不能按从零开发36个系统估算。第10章已经选好每个重合簇的主基底，实施时直接选用其模块/内核/资产，改Host接缝和统一UI；对照已有用例确认原行为。现有服务足够用就接入，不为符合目录图另造一套同等服务。第一版研究中的重建路线是实际失败后的备选，不是所有备选都必须先写一遍。

具体节省来自以下实施合并：

1. 一个HostAdapter处理当前DSH的session、模型、权限、Connection和生命周期，所有旧插件共享适配成果；不逐来源重写整套宿主桥。
2. 存储/receipt、ExecutionBroker、固定dispatcher、usage账本、组件库和TaskPlan/Run各有一个实现。成熟代码能承担时直接复用，不先搭第二个“新架构”再迁回。
3. 同一功能的后端、工具入口、页面和必要检查在一次接入中完成；不用四张独立任务单重复交接、重复装包。
4. 记忆Provider、账户adapter、SSH/远程、方法资产等保留现成实现，批量适配公共接口与配置；不能按每家都重新研发估算。
5. 压缩直接使用billion内核，Metis抽取有效policy/资产，恢复直接使用turn-rewind核心；改的是已确认不兼容或冲突的部分。Claude视觉是必须新增的统一设计/组件工作，业务能力复用原实现。
6. 使用已有fixture与可验证证据；同一真实安装/故障/用户旅程可覆盖多个断言。不同必要场景仍全部验证，不为每个检查点再复制同一运行。

只有实际编译/合同/许可证/行为证据表明某个模块不能直接使用，才为该模块执行局部替换，并证明等效或更好的效果。不得仅因命名、个人风格或抽象偏好重写成熟逻辑。没有首次实际构建数据前不填“复用百分比”或保证工期，但开发难度应按集成适配工程判断；静态规格的字数和检查点数不是新代码量或工期。

### 2.2 共用技术约定

| 领域 | 默认实现选择 | 触发替代方案的证据 |
|---|---|---|
| 开发工具链 | TypeScript strict、ESM；官方仓库使用pnpm 11.28.5，开发Node 24系列固定补丁版；提交精确packageManager与lockfile | 首次工具链探针发现官方依赖不支持该补丁版时记录并调整；Node版本不等于Desktop内置运行时 |
| Host构建 | 独立Node平台bundle，官方Host库保持external；Host导出 `apply`，不混入无用default导出 | 官方实际模板/版本改变，更新第01章与合同fixture |
| Client构建 | React由宿主共享；遵循官方 `window.__ModuleLoader__.load` 装载格式，slots/connection由宿主注入 | 只有正式装载路径的真实Desktop失败证据可触发精确兼容桥 |
| UI | Claude桌面布局、颜色/排版/密度/导航/Artifacts交互；Nexus品牌、中文优先，zh/en完整 | Host窗口壳不在第三方slot控制范围内时，以已验证slot实现插件内一致性并记录宿主边界 |
| 连接 | Host正式Connection Fetch注册exact POST `/api/nexus/rpc`，处理官方RPC信封；Client使用Connection RPC call；二进制另注册exact资源路由；Typert生成是可选类型增强 | 共享`/api`的唯一interceptor已由Gateway占有，Nexus不可抢占；不启用未认证裸HTTP/固定端口 |
| 本地真源 | Markdown记忆/技能正文、内容寻址不可变blob、版本化journal与receipt；SQLite存放事务元数据、任务和可重建索引 | 不把索引数据库当原文唯一副本 |
| SQLite | 独立storage worker优先探测宿主实际 `node:sqlite` 能力；与Node主版本隔离 | 若宿主无可用内置SQLite，候选纯WASM SQLite须先通过目标运行时/事务持久性fixture，再采用持久快照单写者；若性能不达标，再提交明确原生构件/ABI方案。选择写入runtime lock，不运行中偷偷换引擎 |
| PTY / Shell | 宿主正式执行器与终端服务；集中ExecutionBroker/Codec；复用OPS成熟内核 | 缺少Host接口的兼容桥精确锁版本；不得把通用child_process当自动等价PTY |
| Agent | DSH正式subagent spawn、显式AgentOptions角色路由；同一Run账本控制层级、并发、预算与取消 | 外部CLI是显式单独引擎，拥有独立job/effect/usage，不自动冒充原生会话 |
| 上下文 | 复用锁定billion/acp-kernel；Nexus包围事务、权限、wire审计、收益与缓存计划 | 不能换为一次性普通摘要或让宿主basic与Nexus双自动压缩 |
| 后台任务 | Node worker处理解析/索引；Python/Rust/外部服务只按所需adapter启动 | 无外部运行时仍可用本地核心；依赖下载/构建行为公开 |
| 测试 | 领域fixture、真实Host合同、临时Desktop profile、wire golden、浏览器/原生界面验收、配对在线实验 | 不用截图、类型检查或install成功替代真实动作 |

具体包补丁版本须在实施首次联网解析后写入锁文件；本规格不会捏造未解析的依赖版本。纯WASM数据库替代方案仍必须做到原子落盘、单写者、带校验快照、journal重放、并发读快照和崩溃恢复，不能以“无原生依赖”为由取消事务。首次性能探针包含10万记录、任务/usage连续追加、压缩提交及突然中止；门禁未过不推进依赖它的切片。

全新工程没有lockfile时，A01中的检查点P02先按审查后的依赖解析生成并复核lock，再执行冻结安装；`--frozen-lockfile`不是生成首份锁的命令。不能以已有开发Node版本推断Desktop的实际Node/ABI，后者由检查点P04真实探针取得。

## 3. 目标工程与所有权

```text
plugin/
  package.json / pnpm-lock.yaml / cordis.patch.yml
  src/
    host/
      index.ts                  apply/inject/config，generation资源所有权
      adapter-rc2/              当前官方服务适配，禁止领域直接读宿主内部对象
      connection/              RPC/Fetch、Peer授权、输入校验、取消、DTO
      tools/                   固定nexus工具注册、Native/PTC同源协议
    ports/                     schema、identity、error、Host与Provider ports
    domain/
      storage/                 journal、blob、transaction、migration
      memory/                  Source×Strategy×Provider、trust、capture、审核
      context/                 单压缩控制器、ContextPlan、wire、cache planner
      workflow/                TaskPlan/Run、leases、预算、claim、checkpoint
      orchestration/           Metis角色/路由/层级策略、brief、gate、independent review
      quality/                 lint plan/runner、finding、fix、工程流程编译
      review/                  Git/SVN capture、coverage、evidence
      runtime/                 shell、codec、preset、jobs
      recovery/                file ledger、rescue、fork协调与补偿
      graph/                   conversation canvas / workflow / memory / diagram投影
      resources/               skills、persona、主题、方法、市场与版本
      usage/                   physical attempts、价格、账户、实时投影
      extensions/              stage、inject、watch、generation、promote
      integrations/            SSH、远程设备、GitHub、渠道、CLI
    adapters/
      memory/ vcs/ models/ upstream/ platforms/ cli/
    client/
      entry.ts / routes.tsx / connection.ts
      theme/                   Claude视觉映射、Host tokens、亮暗与高对比
      shell/                   Sidebar、Main、Composer、ArtifactPane
      views/                   会话/工程/记忆/编排/质量/图谱/资源/用量/设置
      components/ projections/ accessibility/
    workers/                   storage、index、parser、isolated-extension
  vendor/                      实际选用源码与补丁，不复制整个研究归档
  assets/ locale/ notices/ schemas/ migrations/
  tests/
    fixtures/ domain/ host/ integration/ desktop/ wire/ cost/
  tools/
    build/ pack/ doctor/ migrations/ evidence/ coverage/
  evidence/                    实施期具名执行记录；不得加入用户数据或secret
  artifacts/                   本地构件、hash、sbom、发布说明与复现包
  docs/
    decisions/ compatibility-ledger.md execution-ledger.md
```

Host负责人拥有 `src/host/adapter-rc2` 与连接合同；存储负责人拥有事务与schema；领域负责人各自拥有对应domain/adapter；UI负责人拥有client和视觉基线；验证负责人拥有跨域fixture和证据装配。公共schema由集成负责人review。多人或多个agent不可同时无协调修改公共协议、lockfile、总路由、迁移版本。

owner是责任角色，未来可映射实际人或代理；不是伪造已经分配的员工。每个执行包有一个集成所有者；并行修改按模块分配，公共协议/锁文件/路由有唯一写入者。原62检查点不是要求再拆出62个开发会话、PR或独立报告；能在同一变更/测试里完成就一次完成。仅在实际代码冲突或可恢复工作量需要时再细分，不机械套用固定小时数。

## 4. 首个必须打通的真实纵向切片

首切片不是展示全套空页面，而是在临时profile中完成以下可复现实链：

1. 先用官方纯JS factory格式生成无需数据库/业务依赖的单包探针：`engines.dsh=0.2.1-rc.2`、bundle patch、正式Host `apply` 和Client module loader入口；先隔离装载/slot/RPC问题，再用同一fixture切换正式TypeScript builder，不把官方monorepo的源码helper当作已发布外部SDK。
2. Host用正式Connection Fetch注册exact POST `/api/nexus/rpc`，校验官方 `ClientRequest`，返回同rpcId的 `ServerResponse`；Host exact dispatcher实施owner-only认证，Nexus另核验业务权限，保留request.signal。不能另注册共享`/api` interceptor。
3. Client从官方slot打开一个Claude式Nexus主视图；调用 `ctx.connection.rpc.call('/api', 'nexus/rpc', {protocolVersion:1,method:'host.probe',scope:{},payload:{action:'probe',requestId:'probe-intent-001',params:{}}}, signal)`，显示Host/Client build hash、OS/运行时、schema、generation、已验证slot和transport。内层payload及返回值使用第09章唯一公共包络，不能另造parameters或字符串revision。
4. 用一个正式Nexus查询工具读取同一无秘密DTO；工具、UI和未来远程共用输入schema、授权与命令/查询服务。
5. 创建临时本地MemoryRecord、读回、CAS修改、重放同requestId；观察只有一次提交；后台投影更新和Client断线重连正常。
6. 停用插件后检查slot、route、工具、worker、watcher全部卸载，持久record仍在；再次启用能读回且无重复注册。
7. 重打包更改build hash并正式更新，确认Host和Client新代一致，不用旧UI缓存冒充更新成功。

Connection exact route与RPC信封接法有源码支持，**本项目尚未在真实Desktop执行上述链**。最小接法的精确返回结构、服务inject和effect注册须复制第01章补充合同与 `research/10-host-development-recheck.md`，不要凭示意代码猜类型。carrier错误由Connection reject，业务错误保留Nexus包络，二者不能吞并。该链不要求先完成Typert generator；若后续使用generated Remote挂载，单独执行GATE-REMOTE-001。

如果这一步失败，先记录失败窗口、release identity、slot树、实际错误与官方源码位置，修复接缝并重测；不并行编写十几个尚无数据连接的页面。确认可挂载的根slot之后再冻结导航组件，减少返工。A01内的检查顺序为：P02只准备开发工具与Host runtime探针，P03先装无需数据库的最小包，P04取得真实Node/ABI与连接结果，P05才选择数据库；不能把“安装后才能取得的探针结果”作为首次安装本身的前置条件。

## 5. 八个完整执行包与并行依赖

默认机器计划见 [development-plan.json](development-plan.json)，可读表见 [development-plan.csv](development-plan.csv)。原P01–P62全部保留在 [检查清单](development-checkpoints.json)，仅承担功能/效果追踪，原dependsOn保存为legacyDependsOn历史参考，不继续驱动62任务排期。两份计划由同一生成器生成，每个检查点必须恰好归一个执行包，不能遗失或重复计算完成。

| 执行包 | 直接复用与合并工作 | 原检查点 | 启动依赖 / 完成前联合条件 |
|---|---|---|---|
| A01 单包底座与Claude骨架 | 正式DSH入口和一套公共Host适配、存储/收据/usage/工具/执行器，直接复用OPS及现成基础模块 | P01–P14、P27、P41，16项 | 无；先验证一次真实Desktop链，开放共用接口 |
| A02 统一记忆与工程接手 | 各现成记忆引擎/Provider整合、MEMORY.md/MEMORY文件源、审核/同步/记忆UI | P21–P26、P28，7项 | A01；独立完整验收 |
| A03 论文压缩与缓存 | billion完整内核接入，增量折叠/解压、cache planner、观测与界面一并完成 | P15–P20，6项 | A01；独立完整验收 |
| A04 工作流与Metis | 任务板/专家/CLI与Metis有效policy/资产，统一Run、选模、门禁、蓝图/适应性和UI | P29–P36，8项 | A01可开工；跨模型handoff与A03联合通过后完成 |
| A05 工程质量与产物 | 两qiudeng仓、Aegis/Superpowers/J-Space、Git/SVN审查、Archify/文档产物与UI | P37–P40、P47，5项 | A01可开工；接A04统一运行和门禁后完成 |
| A06 运行恢复/图谱/开发台 | 正式preset、turn-rewind、ThoughtDAG/Synapse、super-injector直接适配 | P42–P46，5项 | A01可开工；关联A02记忆及A04任务后的图谱联合通过 |
| A07 全桌面与连接 | 复用sidebar/dsh-web各子包，完整接文件/Git/终端、阅读/统计、市场、SSH/远程/渠道、账户/搜索 | P48–P55，8项 | A01可开工；随A02–A06完成逐块接线，全部到齐才完成 |
| A08 联合验收与交付 | 一次整合迁移、复活、故障、长程/cache费用、Claude视觉、打包/回滚资料 | P56–P62，7项 | A02–A07完成；所有功能/效果要求共同放行 |

`dependsOn`表示开工前必须完成；`completionRequires`表示可以同时开发，但不能在所列实际集成与证据齐备前宣称本包完成。两类边一起校验无环。A01后A02–A07可按模块并行，尤其界面随功能接入持续完成，不把全部UI留到最后，也不允许空壳先结项。最终A08的完整依赖闭包必须含A01–A07，每个包再覆盖其全部检查点。

原细项中真实的接缝顺序仍然执行：统一ExecutionBroker在A01完成后，A04/A05才执行真实验证命令；A05内部先有共享产物服务再接完整文档流程；图谱操作按实际memory/workflow ports就绪情况连接。不把“全部图谱做完”设为普通文档产物的无关前置，不为等待整个远程/市场模块阻塞独立记忆或压缩开发。

### 5.1 内容和效果保持不变的校验

原769条验收定义已逐条记录ID和原文SHA-256，基线见 [acceptance-baseline.json](../research/acceptance-baseline.json)。校验器要求合并后ID集合和每条原文hash一致，不允许通过少几条检查、放宽标准或修改成功口径加速。36来源、19子包、全部复活任务、文件记忆与Claude视觉仍按原领域合同验收。

合并可以让一次真实测试运行覆盖多个检查点，只要该次输出确实证明了各断言，并指向相同适用build/Host/输入。纯逻辑源码未改且来源证据可验证时复用相关用例；Nexus新增接缝、集成相互作用、恢复、真实Desktop和实际缓存效果仍必须证明。减少重复启动、重复报告和无理由重测，不减少必要场景。

### 5.2 合并后的完成凭证

执行记录至少含 `packageId/checkpointIds/owner/inputHashes/sourceLockHash/hostVersion/buildHash/startedAt/endedAt/changedPaths/checkCommands/results/evidenceRefs/remainingIssues`。一份记录可以对应多个原检查点，不强制62份独立报告。完成仍需满足definitionOfDone及全部对应领域验收，不能只勾选某个文件存在。

任务状态：`planned → ready → running → verifying → completed`；异常进入 `repairing`、`blocked_dependency` 或 `needs_authorized_resource`。最后两者要记录具体依赖/账户/授权及不依赖它们的可继续任务。重新执行保持business request身份，模型重试新attempt，不伪造已完成receipt。`completed`后若公共合同变更影响它，标 `revalidation_required`，不静默沿用旧证据。

## 6. 多模型路线如何具体落地

Nexus保留Metis的层级编排、按角色配置模型、可视化harness、性能门、独立审查和适应性，但以第12章真实生效合同为准：T0不派子任务，T1主实现加审查/验证，T2多surface依赖串行，T3仅在文件/目录所有权真正不重叠时并行。高级L0–L4模板按显式策略启用，与普通专家不可递归的默认隔离。图谱配置不直接启动第二个Metis调度器。

实现顺序：

1. `ModelRoute`从Host Provider目录解析，角色仅存provider/model/reasoning/maxTokens、可见能力与CredentialRef关联元数据；credential在Host映射到正式provider route。不得把自造credentialRef塞入AgentOptions。
2. `RolePolicy + HarnessSnapshot + ModelRouteSnapshot`编译为TaskPlan节点、边、claim、预算和gate；运行快照不可被编辑器/自学习改变。
3. 由Host subagent service为每个受控子节点spawn，向正式AgentOptions传该角色模型。保存接受的activation/session身份及当前generation的正式handle，再消费结果；UI超时先对账，不新起第二份任务。发布前signal可取消启动，发布后取消必须dispose该exact activation handle并等待其拥有的后代和result停稳；不能假定仅abort原signal就已终止，也不能捏造不存在的JobService.cancel。
4. 主会话模型保持sticky；角色lane按provider/model/账户/系统与工具epoch固定，复用lane还要核验能力与剩余授权。角色更换模型产生明确新lane/缓存冷启动，不调用全局setModel来回切主会话。
5. 子任务接收有界Brief和不可变ArtifactRef/ContextRef；按需精确读取。无需向每个角色复制全部主会话。跨模型thinking/tool id的vendor自动改写不用于主历史，原始证据不可变。
6. Reviewer、Verifier、Juror的独立性来自不同actor、证据和实际执行，不单靠不同名称或模型。验收测试真正运行；测试不可用返回具名未验证结果，不写PASS。
7. 原Metis plugin的DeepSeek生产路径只允许研究其接线，不能带入写死PASS、把controller文件检查当模型执行的代码。
8. 适应性候选离线汇总，展示差异并在未来run使用新revision；不改变当前prompt/tools/harness快照，不让成绩反向修改原始receipt。

首个真实多模型fixture是“实现一个有可判定行为的小改动→第二actor审查→第三actor运行已有测试→主任务合并证据”。随后验证T2串行依赖、T3 disjoint工作区、重叠降级、预算停止、父取消、子已成功但响应丢失、Provider失败与显式fallback、未知价格、inherit/fork不重复计费。三次真实调用必须有三份call+attempt账本，各自标reported、unreported或invalid；缺usage不能填0，也不能用外层Run费用填充所有角色。

## 7. 压缩、省token与缓存一体实施

先固定未修改上游内核与fixture，再围绕其事务、anchor、renderer和Host接缝适配，逐项比较；不可先自写摘要再事后贴上“billion兼容”。`directMessageIds`决定新摘要的呈现锚点，effective lineage只解释来源；已呈现块不因祖先重算移动。层级再折叠做成有收益、受预算的明确操作，不每轮更新所有摘要。

每次生成实际wire记录去秘密化的结构、片段hash、token估计方法与最早差异位置；真实请求结果另存reported usage。用于供应商缓存的身份包括provider、实际模型、账户/route、系统/tools/消息前缀等，不能凭相同文本假设跨模型共享KV。每角色lane的缓存和主会话分开统计。

默认策略是稳定主会话+稳定角色lane+小Brief+按需读取+增量折叠。在估计有效窗口、token减少、缓存重算与输出/检索成本之后再决定压缩时机，不为cache无期限拖延必要压缩。fallback、review、summary、capture、标题、外部工具与重试成本全进入总费用。未知usage/价格保持unknown。

A03接入后先跑不收费wire/fixture回放；实际缓存/费用对照由A08统一安排，在获得相应API与预算授权后执行。实验至少比较上游内核、Nexus整合基线、cache planner候选，以及可完成任务范围内的无压缩对照；多模型另比较单模型与按角色固定lane路线。任务完成/准确性优先，报告命中率须同时报告覆盖率和成本，不能只展示最高hit样本。

## 8. Claude桌面外观的实现顺序与真实限制

外观主合同见第03章及 [Claude参照证据](../research/12-claude-desktop-reference.md)。左导航、主会话阅读宽度、居中输入、暖色背景、衬线展示标题、字体层级、极少分隔线、圆角控件、Artifact右栏、模型/运行选择、设置、亮暗色、收起/展开和快捷键都必须落实为真实组件与tokens，不只做一张首页图。

产品保留Nexus身份、所有功能名与能力；Claude商标/头像/未授权资产不打包。用户要求的“完全参照”落实到布局、排版、色彩和交互，不能据此声称Nexus已获得Claude服务或官方身份。字体采用已授权或系统字体fallback，示意字体必须记录真实渲染结果。

技术实施：

1. 首切片读取真实slot树，记录可挂载的workspace/main/sidebar/toolbar/settings接口。对插件拥有的区域应用根class与scoped tokens，不做无边界DOM/CSS monkey patch。
2. 尽早完成Claude基础shell，所有后续纵向切片使用同一shell；临时页同样有loading/empty/error/cancelled/offline/reconnecting/conflict/needs-configuration状态。
3. 只有Nexus当前视图生效时接管自己的导航/面板；会话文字与工具block必须保真，未知block使用Host安全fallback。阅读投影和原始会话分别管理。
4. 编排不是另造复杂监控门户：主对话简洁，模型路线、角色树、门禁和证据放右侧详情/Artifacts；advanced harness canvas按需全屏。
5. 每个按钮注册对应action及可达后端；不能把功能只藏在catalog而没有对应用户入口，也不能让概念稿中的示例数值进入真实界面。
6. Host标题栏/原生系统菜单/窗口按钮若无正式扩展接口，不属于普通slot可控制面。记录视觉差异、官方扩展点与实机证据；插件内部仍完整达到Claude式布局，禁止捏造已替换Electron窗口壳。

视觉验收使用同一OS/缩放/窗口尺寸的官方参考和实际Nexus截图，以区域布局/间距/字体/状态及交互复核；不能只比较某个像素差阈值。必须测试125%/150%缩放、窄屏、键盘、中文长标题、20k行报告、长会话虚拟化、屏幕阅读顺序和减弱动画。

## 9. 全来源接管、旧功能复活与许可处理

每个来源先生成联合action manifest：源码注册表、schema、UI事件、CLI、README、迁移格式一并检查。复用前锁定选用文件/hash/license，编译其核心为内部adapter；不要直接激活整个旧插件造成重复system贡献、压缩、工具或HTTP服务。来源不兼容先迁移Host接缝，其功能验收保留。

复活的阻断顺序是实际受影响依赖，而不是把所有旧功能留到末尾：正式preset在runtime切片实现；Synapse随graph切片；reading/live-stats随会话与usage；super-injector随generation机制；memory-evolve各功能按所属域分别接入。第10章REV-01–11必须全部有当前Desktop证据。

未知/受限许可不等于删功能。默认先采用合法可用基底；需要非商业code-review源码时保留许可并按实际使用范围判断，商业分发未获授权则实现相同capture/review/evidence合同的合规替代。SVG素材许可未知时使用自有SVG实现同样能力。billion署名在About/文档等产品表面落实；Metis及pi vendor分组件记录，不能只保留根MIT而丢来源作者。

旧数据迁移先只读发现、预览与备份，再checkpoint导入、逐项验证、按能力激活。一个能力同一时间只由一方注入/写入/压缩；shadow比较不得双写或悄悄收费。保留退回旧插件的映射、原配置与可独立读取备份。删除旧数据另算具名操作。

### 9.1 文件即记忆与Claude Code工程直接接手

用户新增的文件记忆由主方案直接纳入，不另派子代理研究。A02一次完成项目根 `MEMORY.md` 与 `MEMORY/`（包括嵌套文本/Markdown）原文件Source、Claude Code遗留格式兼容、有界ProjectHandoffPacket及全部相关界面（原检查点P21/P26/P28）。A08统一验证Claude工程fixture及文件更新/多模型读取的缓存效果（P56/P59）。详细对象、更新/权限/编码/去重/恢复与MEM-079–096验收见第02章§16。

实现顺序是只读发现→绑定/工作区边界核验→入口快速索引→相关片段召回→冻结接手快照→其余后台增量索引。默认不改原文件、不写Nexus frontmatter、不先迁入私有数据库、不扫描主目录全部Claude项目，也不把文件夹全文注入每个模型。项目外记忆由用户授权具体路径后绑定。watcher只推进store revision，已发送前缀保持；写回源文件是独立授权/CAS操作，敏感撤回及时阻断未来发送。该需求在机器计划登记USER-R01，不改变36研究来源计数。

## 10. 实施命令合同与构建/安装流程

以下是**未来工程必须提供的脚本接口**，不是本次已经实现的命令。现在可执行的文档脚本只有 `tools/build-development-plan.mjs`、`tools/build-spec-book.mjs`、`tools/validate-specs.mjs` 与预览工具；不存在的产品脚本不得被记录为通过。

| 未来命令 | 必须做的事 | 非零退出条件 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 使用已提交精确依赖；明确构建脚本策略，复核pending builds | 锁不一致、依赖无法解析、未允许的lifecycle |
| `pnpm check` | 类型、lint、schema/locale/资源与固定工具清单一致 | 任一合同漂移或类型错误 |
| `pnpm test:domain` | 所有领域关键不变量，临时数据 | 幂等/权限/事务/恢复/压缩精度失败 |
| `pnpm test:host` | 锁定Host合同、dispose、AgentOptions、Connection、projection | 版本不符、私有接缝漂移、结果只模拟 |
| `pnpm test:wire` | canonical serialization、direct anchor、所有epoch和role lane golden | 主题/时间/轮询改变前缀、工具漂移 |
| `pnpm build` | Host/Client独立构建，资源/notice/patch/manifest核验 | external错误、未生成loader、混入Node到Client |
| `pnpm pack:verify` | 临时目录执行npm pack --json并核对正向file清单/hash、secret与研究目录排除 | 路径丢失、manifest指向不存在文件、秘密/整仓/非运行材料入包 |
| `pnpm doctor:desktop -- --profile <test-profile>` | 只读探测指定测试环境，输出JSON与人可读诊断 | 未识别环境/认证失效/运行时或slot不符 |
| `pnpm test:desktop -- --profile <test-profile>` | 临时profile真实安装/启停/升级、UI到Host、复活/多模型fixture | 未实际执行、需要账号却跳过后仍报告全通过 |
| `pnpm test:faults` | 持久边界/网络/worker/扩展故障、journal重放和补偿 | 丢原文、覆盖外部编辑、重复effect/fork |
| `pnpm test:coverage` | 来源action→内部capability→UI/工具→fixture→运行receipt双向对账 | 任何强制功能无去向、无证据或实现假空壳 |
| `pnpm benchmark:cache -- --plan <authorized-plan>` | 已授权的配对在线协议、金额上限、全部attempt | 未获资源/超预算/数据缺失却冒充hit或免费 |
| `pnpm evidence:release` | 汇总精确构件/来源/兼容/测试/成本/限制/回滚复现包 | 未通过门、缺hash、测试状态造假 |

首安装优先使用真实Desktop内部Plugin Manager的正式流程；本地tarball或本地路径支持须先用该版本的官方CLI/Manager帮助与fixture确认。如果测试必须使用CLI管理desktop profile，则完整退出Desktop，**只用该Desktop安装自带的打包CLI**（其 `resources/runtime/cli/bin/dsh.cmd`，先确认实际安装路径），执行公开的 `dsh plugin --profile desktop` 子命令，再重开。npm全局/独立安装的dsh即使版本相同也不等价，不能用于修改Desktop profile。子命令和参数以实际 `--help` 输出固定到证据，不猜 `install`/`add` 语法。

临时profile环境必须独立数据根、端口由Host管理，不复用用户profile或history。若Desktop不支持可用隔离启动开关，使用独立系统用户/测试机器进行验收；不得用“临时”名义强行改用户真实配置。公开发布是构件验证之后的独立动作，先交可审查包与报告，再使用用户已有或新增授权。

## 11. 连续开发、修复与接续算法

```text
读取来源锁、规格版本、任务DAG、上次execution ledger
对账代码/数据/Host版本与尚未确认的外部effect
按A01-A08的启动依赖选择包，completionRequires只阻止提前结项
为可并行模块建立唯一owner、文件边界、输入快照、共享证据目录
先直接接入已锁源码/资产，再按真实失败修接缝，持续保持可构建
运行与变更相关的领域/合同检查
失败 -> 归因到实现/接缝/环境/授权/来源；修复并重跑相关检查
通过 -> 同次接好UI/工具/持久化，对应多个检查点共享真实证据
提交包进度与checkpoint映射，继续可就绪模块，不逐项重开62个任务
公共合同改变 -> 明确列受影响任务并做必要重新验证
全任务通过 -> 打包/迁移/长程/故障/视觉联合验收
生成精确本地构件、来源/测试/费用/限制与回退资料，交付审阅
```

不存在通过“重复尝试直到模型说成功”推进的循环。修复必须由可复现失败与具体证据驱动。未知外部effect先对账，测试坏了不能仅修改断言迎合输出，验收失败不能把强制需求改成可选。一次运行因上下文长度或进程结束中断时，恢复读execution ledger、receipt和hash，不依赖聊天摘要猜测已写入状态。

每完成一个可审阅切片保存构建与关键证据；有Git时小步提交，不回退他人修改。工程目录非Git时可初始化独立本地仓库，但不能无授权推送远端。不要在末尾才一次性集成全部worker/adapter。昂贵基准前先完成相应确定性检查；通过后不无理由反复付费跑同一组。

## 12. 高风险接缝的确定决策树

| 风险 | 首选处理 | 仍失败时 | 不能做的事 |
|---|---|---|---|
| Client能加载但slot不显示 | 真实Slots树、依赖、release/generation对账 | exact rc.2最小兼容贡献，增加合同/停用测试 | 捏造不存在slot或全页iframe冒充原生 |
| Typert外包生成受工作区布局限制 | 首切片采用exact Fetch route承接正式Connection RPC信封 | 将typed adapter作为后续增强单独验证 | 抢Gateway的共享interceptor或因Typert未打通取消全部Desktop接线 |
| 内置SQLite缺失/ABI不同 | 候选纯WASM worker先通过目标运行时/持久性探针，再采用单写持久化 | 明确原生构件方案、性能与权限验证 | 开启新格式后静默重置数据库 |
| Metis表述与实际路径矛盾 | 用生效runtime/contracts锁定、保留高级模板 | 实现Nexus适配并补真实模型gate | 引入写死PASS或只投影skill宣称完整runtime |
| 子任务超时但可能已创建 | 记录activation intent与接受ID、查询Host | 无法判定保持effect unknown供协调 | 切Provider再造一份写任务 |
| 重叠文件并行修改 | claim预检、降T2串行或独立worktree | 冲突预览与有证据合并 | 声称fork自动隔离文件 |
| Prompt cache低于预期 | 检查最早wire差异、实际route/账户/TTL、reported覆盖 | 按费用/质量比较调整epoch/时机，保留压缩 | 填无意义token或报本地hash为供应商hit |
| 供应商/账户不可得 | 先合成协议fixture与可用真实Provider | 明确待资源实测，继续无依赖任务 | unknown填0、模拟余额或使用私人key |
| 旧包/许可不完整 | 取回实际原件并锁定，分析可复用路径 | 等价功能实现，保留来源/差异 | 删除独特功能或把所有来源写成MIT |
| Host升级 | 当前支持版继续，复制只读探针到候选版 | 修订Adapter/ledger并跑关键合同 | 自动放宽engines、热改长会话kernel |

## 13. 完整完成判据与验收

最终交付同时满足第11章REL门与所有领域强制验收；任务DAG全部completed只是组织条件，必须由真实证据支撑。外部服务的配置态和完整支持态分开，未配置不等于代码缺失；没有账号测试就准确列未测范围，不把全包标为“一把梭成功”。

| ID | 本章专项验收 |
|---|---|
| DEV-001 | 计划依赖无循环/缺失，所有任务有owner、ownedPaths、交付、完成判据、验证、领域合同，36来源均被至少一个实现任务覆盖 |
| DEV-002 | 临时Desktop profile完成单包安装、真实slot↔RPC↔工具↔存储、更新build identity、停用清理与重启读回 |
| DEV-003 | 开发Node、pnpm、Host/Client包、Desktop实际Node/ABI、原生/纯WASM存储选择均有锁定与探针结果 |
| DEV-004 | 未配置外部Provider时LOCAL/压缩/工具目录/界面/历史仍可用，未实现adapter不能冒充“未配置” |
| DEV-005 | Metis在同一Run账本真实执行实现/独立审查/实际验证；没有第二调度器或写死成功路径 |
| DEV-006 | 每角色路由正确、主会话配置不被setModel切换，权限/预算向子级单调收紧，真实物理attempt全部入账 |
| DEV-007 | 论文压缩完整保留，direct锚点/wire/精确恢复/故障golden通过，cache对照比较总费用及质量 |
| DEV-008 | 第10章全部REV与19子包、两qiudeng仓和Metis都有工具/UI/数据/迁移/真实证据去向 |
| DEV-009 | 所有产品页面遵循Claude视觉/交互合同，关键控件连接真实backend，Host壳限制准确记录 |
| DEV-010 | 中断后可只依来源锁、execution ledger、receipt与检查点恢复，未知effect先对账，不重复收费/写入/fork |
| DEV-011 | 未来命令脚本逐项实现并记录实际结果，未执行/跳过/待账号与通过状态严格区分 |
| DEV-012 | 本地tarball/manifest/exports/patch/loader/资源/hash与notice一致，无research整仓、用户数据或secret入包 |
| DEV-013 | 打包前后均能备份/迁移/回滚/卸载，活跃会话epochs和原文完整；不存在后台擅改profile |
| DEV-014 | 只有满足全部实际完成判据才交付“完整”；缺失账户、接口或证据列具体待办，不改验收为免做 |

本章引用的所有命令、阈值与目录都是实施合同。当前交付可验证的是文档、依赖DAG、来源覆盖、引用和概念预览；产品运行与费用数据必须在实施期另取。
