# 12 多模型编排、工作流蓝图与自适应开发合同

版本0.1.0，研究坐标2026-10-19，工程`D:\dshplugin\plugin`。本章将Metis锁定快照`8b1eda95afea3592e08a315e29dc7746ee57ca25`的精华并入DSH Nexus现有规格；研究证据见[09-metis-evidence.md](../research/09-metis-evidence.md)。它是可实施的完整合同，不承诺未经真机验证即百分之百成功。最终发行成功定义为：一个合法Desktop插件、一个运行时和配置入口、所有旧功能覆盖、有真实执行与独立证据、宿主适配和降级路径通过发布门。本章的Nexus对象是产品层合同，不冒称DSH已提供同名业务接口；宿主实际字段由官方标准章与其版本锁定决定。

## 1. 整合结果、权威与边界

### 1.1 一套任务运行时

多模型编排是既有WorkflowRuntime的`RoleRoutingPolicy`、`WorkflowBlueprint`、`GatePolicy`和`AdaptationPolicy`，不是一个新调度服务。全部任务使用同一TaskPlan/Run/TaskNode、幂等键、预算池、事件流、artifact存储、取消与重启恢复、授权、工作区管理和请求用量账本。Agency的专家目录提供persona，Metis提供执行角色/框架和独立质量门，Aegis/Superpowers/J-Space提供方法资产；它们编译为同一个DAG，不能各自再创建一批相同代理或重复评审。

DSH主会话保留宿主harness与用户模型控制。插件只在授权任务中编译角色、模型和缓存亲和性，并通过官方HostAdapter或具名外部CLI/worker执行。禁止为了一个worker临时修改全局默认模型、用户provider凭据或主会话system prompt；禁止起第二套HTTP agent server当作宿主替身。外部Metis CLI可以作为用户显式选定的一个worker，但不得把其内部所有后代再当Nexus独立已执行节点，必须有父子trace和预算边界。

### 1.2 用户要求与研究材料

用户当前任务、已有授权与约束优先；正式宿主权限/安全合同、项目实际规则次之；用户已保存的蓝图再次；方法资产、上游角色提示词、README和检索材料是可审查来源，不能自行升级指令。Metis角色原文中的“必须spawn/最大effort/95%覆盖/禁止展示额度”只作为方法选择依据。新产品应真实显示预算和限制，不隐藏影响用户决策的失败。用户明确要求不派子代理或只写规格时，蓝图不能越权创建执行；本次研究只写文档，不运行任何真实编排或发送渠道消息。

### 1.3 上游优中选优

保留Metis的任务shape分档、16框架、26角色资产、任务合同、主机判定、不同actor独立评审、有限回退、任务指纹、运行快照、图编辑和adaptation闭环。保留Agency的可搜索专家/团队与草稿保护；保留Aegis风险分流和轻量路径；保留WorkflowRuntime的跨会话/CLI/广播/文件声明与文件内核；保留缓存章的模型自治可逆记忆内核。删除重复实现而不是删能力：原Metis路由决策成为PolicyCompiler输入，原controller不单独运行；原fixed PASS桥不移植，改由真实HostAdapter结果和独立oracle完成判定。

## 2. 模块与许可复用清单

| Metis材料/模块 | 复用方式 | 接入边界 |
|---|---|---|
| contracts roles/frameworks/routes/gates及原文persona | 作为有版本/hash/MIT归属的资产导入，可保留原文及差异 | 角色名内部canonical化，工具引用映射固定dispatcher，不能原文注册metis_* |
| model-resolver精确provider/model识别 | 复用纯解析和歧义诊断，增加能力来源与unknown | 模型枚举/凭据来自宿主，不能扫个人目录猜配置 |
| performance-runtime的tier/actor/evidence/fingerprint思路 | 抽取为纯policy与validator，状态归既有Run | 不复制第二份frontier真源或隐式强制spawn |
| task-contract/execution-types/child-gate-evidence | 合并现有DeliveryContract，typed checks和ChildResult | command执行都经宿主工具授权，不能读隐藏grader |
| spawn-guard/worktree | 复用校验和snapshot设计，宿主管理真实执行和工作树 | 禁止进程内Map冒充全局quota；失败先救援再清理 |
| harness-document/runtime/editor | 导入蓝图IR/局部编辑/冻结快照/未保存离开保护 | 存Nexus正式storage，不写DSH主harness或安装Metis桌面 |
| adaptation activation/store/ledger/learner | 接记忆/技能提案域，保留开关/CAS/journal/去重/回滚/评估 | 不自动安装hook/tool；不默认无限预算；不改变活跃run |
| trace-collector | 复用字段与父子trace结构，重写请求级去重/增量聚合 | 共享请求账本，未知费用不置0，父子summary不双计 |

原许可证必须同时保留2026 Wholiver与2025 Mario Zechner。每份复用文件记录完整commit、sourcePath、contentHash、licenseRef、noticeRef、修改摘要和验证来源。第三方vendor/字体/媒体/打包依赖分项审查。允许合法源码组合和原文提示词复用，不要求隔离开发者或无意义重写；许可不确定的素材保持隔离并用等效自有内容覆盖功能。不会把代码下载和静态研究当作用户同意安装运行。

## 3. 对象、schema和配置

### 3.1 模型身份与能力

所有持久对象含schemaVersion/id/revision/ownerScope/createdAt/updatedAt/provenance。模型主键是`ModelRef{providerRouteId,modelId,revision?,endpointIdentity,protocol}`，区分模型ID、provider名称、请求协议和外部CLI执行器。`credentialScopeId`只是宿主提供的非秘密身份，不是key本身，也不进AgentOptions。canonical引用必须精确；裸modelId若匹配多个provider返回歧义，UI给候选而不选第一个。一个provider多endpoint、同名代理模型、地域和credential范围必须可区分。

`ModelCapability`至少含text/image/audio/toolCalling/structuredOutput/streaming/cancellation/contextWindow/maxOutputTokens/reasoningEffort/cacheModes/dataResidency，每项有`state=verified|declared|unknown|unsupported`、source、checkedAt、expiresAt和protocolAdapterVersion。未知不等同支持；上游缺省image/256k窗口或cost0不能升级为verified。宿主可继承effort时标inherited-only，未公开控制时标unsupported/unknown；不得按模型名含R1/reasoner猜为最大reasoning。

`PriceQuote`含currency、input/output/cacheRead/cacheWrite、unit、effectiveAt、source、knownMask。未知任一费用项保留null；UI显示已知小计+未知项，不能把缺失标免费。历史账单按请求时价格版本冻结，后更新价格只影响新估算。

### 3.2 编排对象

```ts
interface RoleBinding {
  roleId: string; personaRef?: VersionedRef;
  modelPolicy: { mode:'inherit'|'pinned'|'ordered'|'scored';
    candidates: ModelRef[]; strictPool:boolean; minCapabilities: CapabilityRule[];
    effort: {requested?:string; mode:'exact'|'at-least'|'best-supported'|'inherit'};
    fallbackPolicyId:string; independenceGroup?:string; };
  executorPolicy: {preferred:'host-spawn'|'host-fork'|'external';
    allowedExecutorIds:string[]; allowRecursive:boolean; maxDepth:number;};
  allowedCapabilityIds:string[]; ownedPathRules:PathRule[];
}
interface RouteDecision {
  id:string; nodeId:string; nodeAttempt:number; policyHash:string;
  requestedRole:string; selectedModel:ModelRef; selectedExecutorId:string;
  candidateFacts:CandidateEvaluation[]; effortRequested?:string;
  effortResolved?:string; effortStatus:'selectable'|'inherited-only'|'unsupported'|'unknown';
  capabilitySnapshotRef:string; priceQuoteRef?:string;
  cachePartitionRef:string; cacheAffinityLeaseId:string;
  reasonCodes:string[]; excludedCandidates:ExcludedCandidate[];
  authorizationRef:string; expiresAt:string; decisionHash:string;
}
interface WorkflowBlueprint {
  id:string; revision:number; scope:Scope; sourceRefs:VersionedRef[];
  tiers:TierPolicy[]; frameworks:FrameworkPolicy[]; roles:RoleBinding[];
  gates:GatePolicy[]; edges:BlueprintEdge[]; protectedInvariants:string[];
  budgets:Budget; adaptationPolicyRef?:string;
}
interface GateVerdict {
  gateId:string; nodeId:string; actorId:string; contextLineageId:string;
  routeDecisionId:string; verdict:'pass'|'fail'|'blocked'|'inconclusive';
  evidenceRefs:string[]; commandReceipts:string[]; artifactHashes:string[];
  candidateSnapshotHash:string; contractHash:string;
  findings:FindingRef[]; createdAt:string; judgeVersion:string;
}
```

这些对象是现有TaskNode/DeliveryContract附属字段或引用。遵循第09章与第07章的唯一身份：`requestId`表示业务意图幂等ID（可称intentRequestId），`nodeId/nodeAttempt`表示逻辑节点及其重试，`logicalCallId`表示独立模型调用，`attemptId`表示该call的实际发送，`providerRequestId/providerResponseId`仅作外部关联；用量主键是logicalCallId+attemptId，不能混用。`runId/rootRunId/parentNodeId/actorId/contextLineageId`贯穿后代，不把文件名或显示persona当实例身份。每次更新要求expectedRevision，未知字段拒绝或放显式extension，不靠宽松any驱动执行。

### 3.3 配置示例和层级

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "defaultMode": "balanced",
  "routing": {"strictPool":true,"poolRef":"project-approved-models",
    "switchBoundary":"node","preferAffinity":true,"priceUnknown":"penalize"},
  "roleBindings": {"implementer":{"mode":"inherit"},
    "reviewer":{"mode":"ordered","candidateRefs":["reasoning-reviewed","host-current"]}},
  "budgets": {"maxConcurrent":4,"maxNodes":24,"maxDepth":4,
    "maxModelCalls":60,"maxRetries":2,"maxRepairRounds":2},
  "independence": {"distinctActor":true,"excludePriorVerdicts":true,
    "requireDifferentModel":false},
  "adaptation": {"enabled":false,"dailyCallBudget":8,"maxTokensPerCall":6000,
    "maxLearnedSkillsPerScope":30,"trialHoldoutPercent":15}
}
```

以上数值为产品可配置默认，不是Metis或DSH事实；model ref别名必须解析为完整ModelRef后冻结。层级为宿主策略上限→用户配置→可信项目→会话→任务显式选择。后层可以缩小权限和预算，不能越过宿主上限。用户手选pinned优先于自适应评分；项目未受信任时只看其静态数据，不加载脚本、hook或命令。禁用多模型只停止新route decision，活动节点保留已接受快照并可取消；不开关读磁盘与不改prefix基线应可验证。

## 4. 任务shape、tier和框架编译

### 4.1 可执行分档算法

编译先由主会话按用户要求提出`TaskContractDraft`：目标、交付物、可编辑根、只读根、ownership surfaces、共享可变资源、依赖边、风险、验证方式和用户限制。主机基于真实路径/资源与授权验证，不依赖“前端/做一个”单关键词决定。空目录不能伪装现存lane；允许用户计划创建的新目录，但标planned并在启动前安全创建/验证。路径大小写、junction、symlink按宿主规范化，对目录祖先关系做overlap检查；共享数据库、同一lockfile、生成目录、端口和schema迁移也视作共享资源。

```text
if no execution requested: FAST_PATH (保留用户明确要求的必要检索)
else if change fully specified and no design fork and low impact: T0
else if validated ownership surfaces == 1: T1
else if surfaces >= 2 and has overlap/shared mutable state/ordered dependencies: T2
else if surfaces >= 2 and all mutating paths/resources disjoint and ready in parallel: T3
else: T1 or blocked-for-contract-facts
if defect investigation: add debug overlay G0/G1/G3.5 only where justified
if user restricts agents: compile same contract with root-owned steps;
  mark independent assurance unavailable when actor independence cannot be met
if required capabilities/budget missing: stop plan before effects, explain alternatives
```

步骤数、文件数、主观难度、希望“多叫几个模型”都不是T2/T3充分条件。`tokensaver/balanced/wide/custom`改变允许并发和证据策略，不制造lane、不放宽独立性。T3若在运行发现交集，暂停尚未执行的冲突节点，保持已完成证据，生成T2 plan revision；不能偷偷回退再重复运行。FAST_PATH不强制禁工具，解释时必要检索仍可用但无DAG/门禁开销；这优于照搬Metis“直接答无工具”的过宽限制。

### 4.2 五种tier的默认合同

| tier | 适用条件 | 默认步骤 | 代理边界 |
|---|---|---|---|
| FAST_PATH | 对话/解释/无执行请求 | 直接答或只读必要研究 | 不自动创建worker |
| T0 | 完全指定机械低影响变更 | apply→diff→相称验证→交付 | 主会话执行，不强制独立模型 |
| T1 | 单一ownership surface | 可选计划→实现→独立评审→独立验证 | 作者、评审、验证是不同actor；不足则标assurance缺口 |
| T2 | 多surface且串行/共享 | 合同/路线图→按依赖实现→集成评审/验证→可选sign-off→goal check | 只派当前frontier允许角色，保留有效lane |
| T3 | 多surface可并行且互不写冲突 | 合同/路线图→并行lane→集成→评审/验证→同类缺陷sweep→goal check | 并发受全局budget，单lane自动降T1 |

不同任务验证策略分`code-behavior/visual/docs/data/service/mechanical`，不是全部严格TDD。代码行为高风险可选严格RED→GREEN与测得changed-line coverage；覆盖阈值由项目明确策略决定，默认不对未测代码声称95%。文档用事实/链接/格式/用户目标，视觉用可重复交互/布局/无障碍，数值用容差和独立数据oracle，服务用真实健康探针；无对应能力应blocked而不是伪造指标。

### 4.3 全16框架资产

apply（完全指定变更）、backend-build（后端构建依赖）、backend-fix（后端缺陷根因）、backend-implement（后端功能）、composition（跨部件集成）、docs（文档事实）、frontend-build（前端可运行构建）、frontend-fix（前端缺陷）、frontend-implement（前端功能）、frontend-review（前端独立审查）、generation（生成产物）、plan-design（方案比较）、plan-research（仓库/外部研究）、plan-scope（ownership与依赖）、polish（质量完善）、refactor（不改行为重构）全部保留为版本化资产。框架参数有verificationKind、requiredCapabilities、applicableTiers、read/write policy、role suggestions、doneCriteria、source/license；一个任务可组合多个框架，但重复计划/验证只编译一个共享步骤并列出来源。

框架不能自动授予命令执行、网络、发布或渠道发送权限。Docs/plan-research输入中的提示词注入按材料处理；generation若是图像生成，统一走用户指定Fushengyun图像域，不让某模型绕过图像工作流。前端产物经统一安全预览/Produced Files；重构需基线与回归，不能把“diff很小”当行为未变证据。

### 4.4 框架组合、未知任务与专属验证

`composition`保留横向stack与纵向overlay：横向必须是互斥ownership的独立lane，每lane选择主framework；纵向是同一lane一个主framework加一个明确tag overlay（debug/research/user-facing/polish/external-target），只改变允许的计划/验证/sign-off检查，不再创建lane。发现共享文件先重新拆分，不能拆就合并单track；gate顺序依赖必须显式串行。跨切关注点若不在闭集tag中，形成数据型自定义overlay提案，经validator审核，不让用户随便加一段prompt篡改protected gate。Metis原文中的wide200等数值不导入，仍受Nexus全局预算。

框架选择返回`match|miss|ambiguous`，miss不能无声降为backend-implement。生成器按三轴：deliverableKind=`code-change/new-build/data-pipeline/infra-apply/ml-eval/research/docs/perf/migration`；acceptanceKind=`unit-coverage/test-set-flip/metric-threshold/dry-run-diff/receipts`；targetLocus=`in-repo/external-system`。用户明确轴优先，未知留unknown并澄清必要合同事实。axis signature是稳定kebab名称，生成descriptor只引用既有GateLibrary：unit/test-flip→真实测试，metric→带数据集/容差的阈值oracle，dry-run→计划差异，receipts→来源可检验回执；data-pipeline加幂等重放、infra加dry-run、perf加改前基线和测量环境。

生成的leaf有目标/输入/owned paths/门序列/接受条件/失败回退/唯一终态/执行harnessRef/许可来源，必须包含不伪造证据和blocked报告不变量。validator要求所有gate已注册、非空接受条件、唯一完成出口、负面场景回到已声明前置节点、无权限扩展和无递归fleet。首次失败可重生一次，第二次OUT_OF_SCOPE并保留诊断；不静默走弱路径。leaf默认仅本任务使用、随证据归档，不自动晋永久技能；重复确有收益才走已有skill提案审核。Metis源码里这些函数名主要出现在方法正文，本产品必须真正实现typed compiler/validator，不能把文字算法当可执行运行时。

专属行为完整保留：backend-build/implement要求跨接口输入输出、错误、auth和幂等，显式wire seams与端到端测试；fix先确认真实测试环境、未改基线RED、根因和对抗复现，不只修表象；frontend系列必须真实渲染、输入/路由/状态流和无障碍；frontend-review按用户persona与journey实际访问、截图/DOM/控制台证据，没浏览器可做明确标记的静态walkthrough而不伪造截图；docs发现对象未知转plan-research，代码例子在授权环境实际验证；refactor保留原characterization tests，不为让绿灯修改oracle；polish依据渲染表面、文案和交互清单，G7只在策略需要时加；plan-design列真实方案/取舍和默认失败的新鲜核验；plan-research先最多三个互斥主题，产可用表格/目录/决策而非无限搜索；plan-scope只保留一个可执行路线图，增加scout须证明现有事实不足，不额外再叫同义synthesizer。

旧框架正文的tier标注和当前typed routes可能不同，导入器以来源保存正文，执行由本章shape/tier及全局质量合同裁决；例如docs原文“每tier新worker”不会让T0偷偷spawn。界面显示方法原文与最终编译差异/理由，用户可以选严格模式，但不能误以为逐字执行了互相矛盾的上游规定。

## 5. 角色、L0–L4递归与专家融合

L0表示用户主会话；L1协调/拆解；L2可选多lane管理；L3执行/综合；L4终端评审/验证。逻辑层级是角色拓扑而不是必须启动五层代理，Host实际depth和本产品depth分别记录。普通Agency专家只是persona overlay，默认终端、不具备派生能力；高级Metis协调role只有蓝图、任务shape、宿主和用户都允许时才可递归，覆盖工作流章对普通专家的禁止递归而不放宽普通专家。每一层必须继承rootRunId、parentNodeId、authorizationRef、budgetReservation、route snapshot及claim边界。

26角色内容完整入资产目录：coordinator、planner、implementer、reviewer、verifier、scope-coordinator、feature-coordinator、depth-prober、fresh-verifier、goal-checker、arbiter、framework-generator、framework-validator、execharness-resolver、researcher、scoper、scribe、sweep-coordinator、sweeper、synthesizer、janitor、juror、manager、preflight-probe、re-anchor、intake。默认tier allowlist以本章分档为准；兼容角色intake只迁移旧状态，preflight-probe仅诊断能力，不每次重复空跑；framework-generator/validator生成和审核方法资产，不能修改活跃门禁；janitor只清理当前run明确拥有且已救援的临时物。

普通任务不额外消耗“团长”代理，主会话负责综合和用户沟通。可并行的ready group先按预算原子预留，再批量派出，然后收集；存在真实依赖才串行。审批/问题等待释放计算并发位但保留任务和预算状态；parked resumable worker是否仍计宿主并发以Host实际状态为准，不能通过UI隐藏规避额度。子节点完成后显式collect并确认stop/release，DONE时不存在未收集任务、未知副作用或仍运行后代。

独立评审可选相同模型不同上下文；想用不同模型时由`independence.requireDifferentModel`约束。角色名不同、模型厂商不同、persona措辞不同都不能代替上下文隔离。角色工具白名单由能力ID编译，执行时再次校验，不只在prompt中写“只读”。只读评审可以运行已授权测试的隔离沙箱，但不可改生产文件；测试生成的临时产物和缓存限定在测试输出根。
## 6. 可执行的逐角色模型路由

### 6.1 过滤与排序算法

路由只在新节点或显式handoff边界运行。输入是固定蓝图/任务合同、角色、宿主能力快照、模型目录、用户策略、剩余预算、当前CacheAffinityLease、健康状态和独立性需求。输出是可审计RouteDecision。实现不得在每个token、工具结果或并发位改变时重新评分，否则破坏稳定prefix和可复现性。

```text
1. resolve exact binding: task override > pinned role > project role > user role > inherit
2. expand candidate refs from frozen approved pool; dedupe full ModelRef
3. reject expired/unauthorized endpoint, unavailable credentials, data-region conflict
4. reject missing hard capabilities and context budget incl output reservation/tool schemas
5. reject incompatible executor, role tool policy, independence/context lineage collision
6. reserve worst-known usage; unknown costs require configured bounded exposure policy
7. if pinned exact binding remains feasible: select it; never silently change pinned model
8. if ordered mode: select first feasible candidate (record all exclusions)
9. if scored mode: use versioned normalized features and stable score below
10. keep valid current affinity if score improvement < hysteresis threshold
11. stable tie break by user candidate order then canonical ModelRef
12. acquire route/cache/commit leases; freeze decision; dispatch through HostAdapter
```

评分采用可配置可解释权重，不用模型自报“我是最强”：`score = qualityLowerBound*Wq + capabilityFit*Wf + cacheReuseEstimate*Wh - knownCostUpperBound*Wc - latencyP95*Wl - uncertainty*Wu - switchPenalty*Ws - failureRisk*Wr`。quality来自本项目同类任务离线fixture/近期有样本的真实结果，带数据集版本、样本数、下置信界；cold start质量unknown取保守基线、uncertainty罚分。thinking级别只说明可控推理预算，不作为quality代理。所有特征先映射固定范围并裁剪异常值，缺失值显式处理，不把null转0。评分仅排序通过硬过滤的模型，不能用缓存命中/便宜抵消权限、质量门或上下文不足。

预算估算以实际provider协议的输入token估计、最大输出、重试预留、冷cache费用和工具费用计算；缓存命中只用于软估算，不保证折扣。用户pinned模型能力未知且任务必需该能力时blocked，提供验证能力或换model的具体选项；不凭名字猜。Host只支持inherit时路由结果为inherit、状态inherited-only，并显示多模型尚未具备；允许同模型多角色编排，不能伪称切模成功。

### 6.2 冷启动和fallback

第一次启动先读取宿主正式模型/provider目录和capabilities，禁止扫描用户HOME猜key或导入陌生配置。可选无副作用探针只能在用户授权范围、有限token和预算内执行，结果绑定endpoint/protocol/model revision。无探针时保留declared/unknown，不阻塞纯文字同模型路径。模型目录为空且主会话可用时允许inherit；连主会话都不可执行时只提供可保存计划，不输出执行成功。

fallback区分`before_acceptance`与`after_acceptance`。启动前认证/能力失败可按用户已选ordered fallback换候选；一旦provider接受请求、有工具副作用或远端ID已返回，先query/reconcile原attempt，不启动第二执行器。429/暂时不可用可在预算内退避；401/权限拒绝不自动换更宽凭据；结构化输出错只按有界协议修复；超出上下文先按缓存/记忆合同可逆卸载与显式handoff，不能丢原证据或截断当成功。用户pinned配置只有其fallback策略明确允许才可切换，并写route_change事件。

熔断以endpoint+model+credentialScope分桶，失败窗口、阈值、冷却和half-open探针均配置化；一个账户429不应封锁所有同名provider。多模型hedge默认关；仅只读、无副作用、预算明确且允许重复请求的任务可启用。每真实请求都计费，winner只影响结果采纳，不能删除loser成本；写操作只给唯一commit lease，其他候选只能产patch artifact。

## 7. 正式DSH HostAdapter与具名外部执行

### 7.1 官方宿主映射（锁版本证据）

本章采用官方标准重查SHA`687f282e8625c6b8d11ff58211a90524be2e4317`原件，位于`research/host-upstream/recheck-20261019/`。AgentOptions正式支持`provider/model/reasoningEffort/maxTokens`（`packages/core/agent/src/runtime-types.ts:26–35`）。`SubagentActivationSpec`含provider（这里是spawn/fork后端）、label、childId、request、signal、delivery（`packages/subagent/subagent/src/types.ts:31–43`）；其request含cwd/agentPreset/prompt/parent/agentOptions/outputSchema/maxDepth等（`:136–181`）。spawn capabilities支持agentOptions与agentPreset（`packages/subagent/subagent-spawn-in-process/src/index.ts:39`），fork支持agentOptions但不支持agentPreset（`packages/subagent/subagent-fork-in-process/src/index.ts:61`）。**执行后端provider和模型providerRoute不是同一个字段**，实现与UI必须分开命名。

HostAdapter将RouteDecision映射到`startActivation({provider: executionBackend, label, request:{parent: exactParentAgent,prompt:ContentBlock[],cwd,agentOptions:{provider:modelRouteId,model:modelId,reasoningEffort,maxTokens},...},signal,delivery:'caller'})`。此处是概念映射，精确import/service注入点由Host标准章提供，不能从字符串凭空造service。outputSchema在宿主明确支持时传正式schema；不能把本产品全部私有对象塞AgentOptions。`parent`必须是当前真实Agent对象，不用sessionId假装。`delivery:'caller'`确保结果归调度器统一收集，避免宿主默认parent消息和插件再次发消息导致双注入。

宿主child-agent实现优先requestHeader路由（`packages/subagent/subagent/src/child-agent.ts:68`），覆盖route时清reasoningEffort再合并（同文件`:98`），保存原cwd/parentSession/depth（`:140`），只捕获父显式sandbox override与approval never，**不继承one-shot grant**（`:248`）。插件因此必须把每个child授权缺口作为真实宿主请求处理，不能宣称父一次性许可自动覆盖全部后代。fork如果无agentPreset capability，不传该字段；需要persona时以宿主允许的正式输入/预设方式实现，不能偷偷改主Agent。

### 7.2 凭据与账户

模型provider是llm-pi-ai providers字典key，账户隔离用不同route ID，即使baseURL相同也不共享credential scope。route配置的`apiKeyEnv`是credentials引用映射（`packages/llm/llm-pi-ai/README.zh.md:28/38/77`）；credentials公开resolve/describe/set/unset（`packages/credentials/credentials/README.zh.md:50–58`）。本产品只持久非秘密providerRouteId/credentialScopeId，设置页调用宿主secret管理，不把key保存blueprint、prompt、argv、artifact或日志。`CredentialRef`不属于AgentOptions；执行时由HostAdapter把route ID映射宿主已配凭据。adapter必须检测未配置、过期或撤销，而非从另一账户环境偷偷兜底。宿主原生keyless route可能采用provider环境发现；需要多账户严格隔离的Nexus route必须显式配置凭据引用，不能依赖这一隐式路径。

### 7.3 执行生命周期

统一WorkflowRuntime先原子预留并发/预算/ownership，再获取route/cache lease，再调用正式startActivation。`SubagentActivationSpec.signal`只负责发布前取消，不能声称它天然取消已发布任务。返回的是exact activation handle（`types.ts:47–58`），包含childId、messageId?、result Promise和dispose()；控制器保存该handle及其对应activation/run身份，childId只作子会话关联，不能把后来resume误作原activation。发布后取消调用这一handle.dispose()并等待清理已拥有后代，result与dispose失败分别记录；不要额外假定存在JobService.cancel。领域任务取消先撤回新dispatch准入，再逐一dispose已发布activation，全部确认后才cancelled。本地超时不重复spawn；重启后按宿主可用的正式恢复/中断权限核对精确活动run，未能取回控制权则interrupted/effectUnknown，不擅自复建。宿主卸载插件时移除listeners、拒绝新任务并保存检查点，已运行任务依Host正式关闭合同停止/移交，不留下后台HTTP服务。

启动后先记录真实`ExecutionReceipt{executorId,hostVersion,childId,requestedRoute,observedRoute?,requestedOptions,acceptedAt,status}`。observedRoute未公开时填unknown，不根据请求参数声称实际用了该模型。模型声明“我是X”不构成观测；可用provider metadata/宿主路由回执核验。缺字段不会自动失败普通任务，但凡用户要求严格多模型验证，必须达到observed route门槛。

### 7.4 外部worker

具名外部CLI/worker保留现有Kimi/Codex/Grok/Hermes/custom及可选Metis CLI。每个adapter声明版本、认证owner、prompt传输、画像输入、可控effort、取消/查询/resume能力、日志schema、是否含内部后代和usage覆盖范围。外部程序只在用户安装和授权后启用，不研究时安装。长prompt用受控文件/stdin，密钥由宿主安全环境或凭据port，不进命令行；工作根、环境白名单、进程树关闭、输出上限与保留期遵工作流章。

Metis完整CLI作为external worker时关闭其自主外发/自学习写执行配置，或把它们列为独立权限和预算；worker内部可能派生后代，父预算须通过可验证参数限制，否则不允许unattended。若无法报告内部requests，usage标incomplete，不能给精确总费用。外部executor失败后不自动用Host“再做一遍”；先确认原副作用、回收commit lease并审核状态。

## 8. 质量门、独立审查与收敛判定

### 8.1 任务合同编译

用户目标编译为现有DeliveryContract：requiredArtifacts、forbiddenArtifacts、constraints/oracles、checks、environment、unresolved、contractHash、evidenceLevel、verificationKind。所有主张必须可追到原用户文字、明确接受的决定或公开工作区事实。模型提出check是候选，不直接变可信oracle；现有脚本只发现不运行，执行仍由宿主授权。不能读取隐藏grader/私人测试来迎合结果。合同有未解析必需约束时blocked，用户明确允许部分交付则记录partial范围，不改约束假装通过。

命令check为结构化argv/cwd/envRef/timeout/expectedExit/artifactRules，不默认shell:true。必须shell的命令明确shell与风险，经宿主正式执行端口，输出存受控artifact。empty checks表示`not_applicable/unverified`而非PASS；artifact存在只达structural evidence，内容hash/格式/非空/oracle另判。测试进程exit0但无ChildResult、无测试采样、产物缺失或结构无效不能盖门通过。

### 8.2 门与frontier

默认门语义：G0描述未改基线；G1计划；G2多surface路线图与ownership；G3.5深层根因/对抗复现；G4实现；G5独立diff评审；G6独立真实验证；G7可选sign-off；sweep同类缺陷；goal-check核对全量用户目标；complete仅是所有必需后置条件已满足。前后门必须与tier、verificationKind和实际证据一致，不能把G7原文“综合交付”与“独立jury”混用，导入时保留来源、映射成明确产品gateKind。

`GatePolicy{gateId,kind,scope:node|lane|run,requiredRoles,checks,rubric,requiredEvidenceLevels,onFail,maxLoops,protected}`。run级G2/sweep/goal-check不能绑定单lane；lane级G4/5/6对特定snapshot有效。onFail可block或loop-to已声明前置节点，回退边另表示，不允许把工作DAG做成任意循环。每次回退新attempt并使受影响后续证据stale；未受影响lane保留，不重跑整波。总修复次数、总模型调用、总成本和墙钟均受budget，多层不能各自重置次数。

### 8.3 独立性的机器校验

作者、G5 reviewer、G6 verifier、G7 juror必须使用不同actor实例；juror之间也不同。记录contextLineage和所有输入refs：盲评允许用户原目标、candidate diff、原始证据、实际代码和测试，不允许作者成功宣称、先前verdict、另一评审推理或投票结果。为debug提供失败trace不算泄漏结论，但需标trace来源。Host fork若继承全部原会话，就不能默认称fresh；要创建干净spawn并只传raw refs，或明确降低independence等级。

不同模型不是必需但可选增强；同模型新上下文可以actor-independent，不能称cross-model independent。若只有一个模型可用而要求不同模型，返回缺口并可在用户接受后降为actor-only；不能暗中改变标准。评审工具能力只读由宿主执行拦截，验证运行的命令也不能修改生产路径。独立性的判定由主机validator决定，模型只提供证据和候选结论。

### 8.4 最终聚合与不一致

结果聚合按contract clause和snapshot对齐，重复finding按path/side/evidence/trigger合并，保留来源、不投票冲掉P0/P1。任一未解决高危finding、必需oracle失败、效应未知、未收集child或目标缺项都阻止complete。多个模型结论不一致时展示各自原始证据和反证，安排有限仲裁或目标性验证；arbiter无权凭多数改写可复现失败，不能把FAIL直接改PASS。

failure fingerprint包含contractHash、candidate snapshotHash、失败code/checkId和关键证据hash；修复后同指纹且无真实变化立即NO_PROGRESS，保留产物并停止盲循环。文件有变化但同一真实失败也计repair budget；不得用改日志/时间戳绕过指纹。最终输出success/partial/blocked/failed/cancelled/outdated与coverage独立呈现，零finding不能证明无缺陷。

## 9. 缓存亲和性、上下文handoff与请求用量

### 9.1 单一缓存合同

直接引用[07-cache-economics.md](07-cache-economics.md)第23–27节MMR-CACHE与CCH-051–080，RouteDecision的cachePartitionRef无损映射其`partitionId`，cacheAffinityLeaseId映射`leaseId`；不创建第二套缓存计数或epoch。分区考虑endpoint、协议、model与revision、credentialScope非秘密ID、region、promptEpoch、toolSurfaceEpoch、renderer和cache-context namespace。缓存命中是provider回执事实，绝不由同prefix的本地hash直接证明；本地指纹只能表示可复用资格。

每个task/role/session取得固定route lease，在节点执行和当前上下文生命周期内保持模型、serializer、工具表与header策略稳定。稳定公共工具只有nexus_agents/nexus_workflow/nexus_quality/nexus_review/nexus_files/nexus_artifact等全局注册表项；角色变化或框架/技能目录变化不新增工具、不重新排序、不重写固定description。能力说明按需作为后缀数据取得，模型可见权限并不因工具名固定而放宽，dispatch时强制检查角色/授权。时间戳、预算进度、选路分数、nonce、presence、轮次计数都不进入长期固定prefix。

### 9.2 切模与可逆记忆

主模型自治内核按记忆章与缓存章保留T1–T3结构化状态、分层摘要、精确原文恢复和可逆压缩，路由不能以“节约token”覆盖原证据。模型切换前产生`HandoffManifest{fromPartition,toPartition,missionRef,contractRef,checkpointRef,artifactRefs,unresolved,authorizationRefs,excludedContent,hash}`。跨provider只发送经验证的最小语义摘要和artifact引用，不把全量历史signature/thought/reasoning转普通text；签名思考块、加密/redacted内容不跨协议透传。相同provider/协议需要原样连续历史时按其正式协议保留，不做无谓格式化。

切换是显式事件并记录为什么、从哪个snapshot、哪个授权、哪些上下文未迁移、预算如何变化；用户可回看旧分区并恢复原路由，但不会自动把新模型产物合并回旧上下文。fork继承的cache/上下文只在宿主可验证同namespace时计eligible；新actor独立评审不能为命中率继承作者结论。cache affinity是性能偏好，独立性和最小权限是硬条件。context降载后原文仍能精确按版本取回，不能只保留不可逆自述。

### 9.3 账本、聚合与计费

业务requestId幂等不等于只发一次模型请求。每次独立调用logicalCallId，重发attemptId，新provider关联另存；路由修复、JSON纠正、学习器、盲评、hedge loser、被取消但已收费请求都入同一UsageLedger。每项有status、usageSource、input/output/reasoning/cacheRead/cacheWrite、价格版本、currency、knownMask、estimated/observed和rawReceiptRef。reasoning为output已含细分，不能额外加总计费；各provider输入/cache重叠语义按第07章adapter归一化。provider不能返回usage时标unknown/incomplete，不能归零或借同类请求补成observed。

按真实call+attempt去重重放；progress事件用单调revision覆盖最新累计值或明确delta，不能像Metisfirst-observation策略丢后续用量。子树summary带includedLedgerKeys（每项logicalCallId+attemptId及revision/hash）和includedSubtreeHash，根只统计未包含项；同call不同attempt不能因只看callId而漏记。不把child汇总再和其grandchild逐条相加。并行墙钟取run时间跨度，模型执行时长之和另列compute time。不同币种不直接相加，没有汇率版本就分币种展示。预留预算和实际消耗独立，终止后退回可证明未用部分，但已发请求未知费用仍保留exposure，不把预算全部归还。

## 10. 自适应学习、快照、回归和回滚

### 10.1 开关与可信边界

自学习默认off。显式off优先，benchmark/可重复回归默认off；off时不扫描adaptation目录、不注入额外文本、不变工具schema/顺序/角色、不消耗模型call，与无学习目录基线在允许的动态后缀之外字节一致。打开只允许当前用户scope和已信任project scope，项目内容不能改用户全局偏好。用户可以逐项查看“为何学到、何时使用、帮助/伤害样本、当前版本、回滚与删除”，不开一个不透明后台agent。

adaptation类别分skill、profile、architecture guideline、role、workflow proposal、tool、hook。前五种可形成数据提案，但发布规则仍走已有技能/记忆审核策略；tool/hook带执行代码，必须显式review diff、签名/来源、沙箱和权限。自动学习绝不改变固定公共dispatcher、授权、预算、幂等、取消、凭据、protected gates、证据判定或DSH主harness。与硬规则冲突的提案直接拒绝并给原因，不让“经验”优先于用户当前命令。

### 10.2 触发、预算和结果归因

事件触发来自用户明确纠正、同类重复失败、成功恢复对、经过门禁的任务完成、用户主动保存经验；普通工具报错不自动当用户纠正。先用零token本地信号过滤，再按日预算和闲置窗口运行；单次默认最多6000token、日默认8次可配置，所有请求都在同一账本并显示其成本。用户正在输入或有高优先任务时暂停后台学习，不阻塞会话启动；print/headless/nonpersistent默认不运行，不从其他私有会话偷读样本。

五阶段为observe→review→guard→propose/write→evaluate。输入先脱敏凭据、个人信息、绝对一次性路径和第三方受限长文。输出必须有sourceEvidenceRefs、适用/不适用触发、预期收益、风险、回归案例与替代对象。重复经验原地更新，skill按canonical name与命令signature匹配，profile同维度合并证据，architecture guideline按稳定ID/trigger匹配，workflow checks按command signature去重。语义相似只是建议，含否定、范围改变或不同工具参数必须人类可看diff，不能错合并。

应用时记录`AdaptationApplication{adaptationId,revision,runId,nodeId,appliedAt,inputSnapshotHash,holdout,decisionRef}`。成功/伤害统计由已完成任务证据和用户纠正映射，一次application只记一次；后续迟到回执用revision修正而非加一。恢复过工具错误但最后真实通过可计成功，不自动把所有共现adaptation都归功。评估零样本显示待评估，非100%成功；样本、信号与可能混杂可见，不把helped计数宣传因果提升。

### 10.3 trial、holdout和容量

可配置15%确定性holdout用于trial/tentative数据经验，按session/turn稳定分配；用户明示偏好、项目安全/许可规则、已active稳定约束不进入holdout。holdout不是完整随机对照实验，报告不能声称统计显著。候选达到至少3 helped、0 hurt且通过回归后可晋active；2 hurt触发停用/回滚建议，执行类tool/hook立即隔离。用户可手动保留并给理由，审计不能删除负样本。

每scope默认30 learned skills，更新已有条目优先；容量满先展示replace/retire计划，不自动删除用户手写资产。退役移archive并保留history/journal/原hash，默认发现和prompt不载入，恢复时再次验证依赖/许可证/权限。保护命令flag与nonce等关键token的回归：新文缩短若丢必要参数则拒绝，不把“更简洁”当更好。无效JSON不应计成功写入；已发生模型成本仍计费，不能因为解析失败退款token账本。

### 10.4 运行快照与原子更新

admit时冻结蓝图、route policy、role/persona、workflow、适用adaptation refs和授权scope为`ExecutionSnapshot`。活跃run只读该快照；用户中途编辑、启停学习、改模型价格或更新skill均只影响新run。紧急撤销权限/credentials是安全例外：可立即阻止后续effect并中断节点，不能因快照而继续使用被撤销权限。文件mtime仅作快速缓存提示，最终校验content hash/revision；相同mtime内容变化必须被发现。

store更新采用expectedRevision、临时写+hash校验+原子rename、journal append与可重放receipt；崩溃中途要恢复旧有效状态或新完整状态，不出现正文新/索引旧。回滚先创建救援版本，再恢复指定revision、失效相关索引与未来snapshot，保留过去run的原refs。禁止直接修改活跃run的GateVerdict、证据文件或用户目标原文。适配器升级也要走版本化schema迁移，不能默认重学全部旧历史。

## 11. 工作流蓝图编辑器与桌面交互

整体视觉服从统一UI章与用户最新Claude桌面方向：左侧导航/项目，中心任务与对话，右侧上下文详情；这里定义状态、字段与流程，不另设一套视觉token。默认展示可理解的“任务→实现→评审→验证→交付”，高级模式再展开tier/framework/gate/role四类节点、回退边、依赖和模型绑定。设计图不是正在运行Task DAG：明确“草稿蓝图/本次快照/运行实况”，切换有标签与时间，不能用户拖线后误以为正在执行的run已改变。

模型设置是role×model矩阵，显示模型完整route、账户别名、能力已验证/未知、effort可控状态、预算估算、cache affinity与fallback原因。支持inherit/pinned/ordered/scored，pinned带锁图标；不可用候选灰显具体原因，费用未知不写¥0。仅保存配置不自动启动任务或发送probe。执行前可审阅计划展示ownership、实际spawn/fork/external后端、每角色模型、上下文handoff、权限缺口、预算上限、独立性等级和预期产物。

运行时中心显示frontier与lane，卡片有排队/启动/运行/等待/取消中/已取消/失败/效应未知；不会把accepted当完成。右侧详情按需展开route decision的输入版本、候选排除、实际模型回执、call ledger、gate evidence与日志。多模型比较只展示各自可见结论和证据，不展示隐藏思考；盲评期间不泄漏另一模型投票。取消按钮可达且明确作用当前节点/整run/所有后代，暂停只停止后续dispatch还是中断执行要分开文案。

图编辑允许新增/删改非保护role/framework/gate、精确模型绑定、检查命令、rubric、onFail回退、资源预算和source provenance；保存前validate schema/引用/边类型/循环/权限/受保护不变量。自定义gate不能删全局安全门，蓝图删除G6时若当前策略要求独立验证则拒绝保存或明确降为非发行模板；不能只因结构JSON合法就执行。未保存离开提供继续编辑/放弃/保存，保存CAS冲突显示三方diff。恢复内置先备份当前版本，不删除用户整个项目文件。

移动窄屏可用分步列表代替大图，节点详情抽屉可键盘操作，图谱提供等价文本顺序和状态；颜色不是唯一信号。网络中断/宿主断连时保持最后已知状态并标时间，重连按事件seq和snapshot对齐，不回退已完成状态、不重复用户消息/工具回执。SSE/事件只传必要元数据与artifact refs，不把多MB图片base64广播全部客户端。

## 12. 错误、并发、恢复与安全资源

本章错误进入第09章统一envelope，内部reason包括MODEL_BINDING_AMBIGUOUS、CAPABILITY_UNKNOWN、ROUTE_POOL_EMPTY、PINNED_MODEL_UNAVAILABLE、EFFORT_UNSUPPORTED、INDEPENDENCE_VIOLATION、CONTEXT_LINEAGE_LEAK、GATE_EVIDENCE_MISSING、NO_PROGRESS_FINGERPRINT、USAGE_INCOMPLETE、HOST_AGENT_OPTIONS_UNAVAILABLE。每项返回可操作nextAction与retry分类，敏感detail单独artifact受ACL，不把endpoint credentials或prompt全文塞message。模型协议无效、provider不可达、权限拒绝和业务oracle失败分开，不把所有问题统称“模型不好”。

SpawnGuard只是纯validator；并发与预算在根WorkflowRuntime的持久事务预留，跨session/进程共享，所有L0–L4后代计入同树。maxDepth4默认指逻辑L0→L4，宿主depth另从Host回执取，二者不比较错位。累计maxNodes默认24，maxConcurrent4，maxModelCalls60，repairRounds2，retry2，deadline按任务配置；0表示什么在schema显式unlimited/null表达，不能把0误解释禁用或无限。宿主硬限额优先，UI如实显示，不隐藏quota错误。

父取消时封锁新lease，由统一取消域逐项处理activation：发布前触发request signal；发布后只通过该次activation持有的exact handle调用`dispose()`，等待其owned descendants清理，分别收集result与teardown错误，再结算effect/usage/产物和终态。不得假定`JobService.cancel`存在，也不得以仅触发AbortSignal替代发布后清理；cancel ACK缺失标effectUnknown，UI允许查询，不重启重复任务。进程崩溃后恢复当前frontier、已完成证据、remote child ID和预算reservation，先reconcile；若无法恢复exact handle控制权或宿主没有正式恢复能力，就标interrupted/effectUnknown，不再次spawn。权限安全撤销、provider账户撤销立即生效；普通蓝图编辑不影响快照。重试保留原失败证据，新attempt不能覆盖原日志或复用旧PASS。

工作区隔离通过已有WorktreeManager：源snapshot包含tracked、未提交、明确纳入的untracked及环境manifest；gitignored依赖不一定复制，应共享只读依赖/重新获准安装或标环境缺失。不得把秘密、.env、私钥默认拷贝给所有模型。每lane有base tree/content hash、claim与commit lease；合并前检查parent drift、覆盖路径、测试与冲突，不能自动checkout/reset/stash用户主工作区。失败/取消工作树先创建救援点和diff artifact，确认无用户新改动才清理；成功保留可审阅产物直到用户/保留期处理。

独立worker对同文件的patch方案可以并行生成，但应用只有唯一提交者；shadow/hedge不得直接写共享目录。端口/服务/生成目录也纳入资源claim。外部通知/发布/删除不因“门已通过”自动获得授权，单独走现有外部effect合同。模型路由允许网络provider时需披露目标和数据范围，跨区域限制不可由fallback绕过。

## 13. 迁移、实现顺序与发行验收门

迁移从已有Nexus配置增加版本化roleBindings/blueprint refs，而不重建旧Run ID。旧Agency专家映射personaRef，旧team职责映射role assignment，旧Aegis/Superpowers方法映射framework/module，旧Metis skill只导入文本与来源，不能相信其历史PASS/coverage。导入Metis harness支持四类节点和模型字段，未知字段保留legacy但不执行；metis_*工具映射公共capability ID，protected门冲突列出，不自动删除。迁移前备份、dry-run报告、hash/计数核对、原子切换和rollback receipt齐备。

实现遵一个垂直切片逐步验证：先锁Host与公开schema，做单个真实spawn指定模型并返回caller；再接既有Run/DAG/预算/取消；接role路由和同模型独立评审；接多模型和handoff/usage；接16框架与蓝图编辑；接adaptation提案/回归/回滚；最后所有原项目功能和Windows Desktop打包。任何切片都不能用fixed PASS或mock coverage假装集成成功。mock只用于离线故障注入，真实adapter smoke必须另列且标环境。

宿主接缝验收门包括：正式注入service和dispose生命周期；provider route多账户隔离；spawn/fork agentOptions实际生效；agentPreset capability差异；reasoningEffort未知和覆盖清理；delivery caller无双注入；原父Agent、cwd/session/depth正确；one-shot grant不扩散；取消、重启和effect unknown；file/artifact/preview ACL；renderer限制与正式Produced Files。缺少某门的adapter显示experimental/blocked，不可发行声称完整多模型支持。所有门通过后才生成release证据包、SBOM/NOTICE、覆盖总账和单包卸载回滚报告。

验收使用fixture模型provider、临时仓库、伪secret ID、故障注入时钟，避免真实个人会话；外部可收费smoke单列授权与费用，不混为离线测试。测试分纯schema/路由、状态/账本/property、Host contract、真实provider smoke、Desktop交互与可视化、长任务/升级/崩溃、原项目回归。报告须区分已运行/静态看见/未具备环境，超时不是通过；不以测试数量代替用户任务完成。
## 14. MMR验收条件

### 14.1 模型身份、能力与路由

- **MMR-001** Given 同名model存在两个provider route，When 输入裸modelId，Then 返回歧义和完整候选，不取数组第一项。
- **MMR-002** Given 宿主目录缺失但当前Agent可继承执行，When 冷启动，Then 可选inherit并标inherited-only，不猜deepseek-chat等默认。
- **MMR-003** Given 图片能力unknown且任务必需图片，When 编译route，Then 拒绝该候选或要求受控能力验证，不据模型名猜支持。
- **MMR-004** Given 自定义模型cost字段缺失，When 估算，Then 费用项为unknown，UI不能显示免费或费用总计0。
- **MMR-005** Given 用户pinned模型不可用，When dispatch，Then 按明确fallback策略处理；没有策略就blocked且不偷偷换模型。
- **MMR-006** Given 严格候选池不含父model，When scored排序，Then 父model不能作为reduce初值留在结果。
- **MMR-007** Given 两个模型thinking等级相同但fixture质量不同，When 评分，Then 使用版本化质量证据而非thinking枚举断言质量。
- **MMR-008** Given 所有候选均缺数据地域许可，When route，Then pool empty并显示排除原因，不能用便宜或命中率抵消。
- **MMR-009** Given 候选分数平局，When 重复运行相同快照，Then 按用户顺序/canonical key稳定选同结果。
- **MMR-010** Given 现有affinity有效且新分差低于阈值，When 新节点编译，Then 保持lease并记录hysteresis原因。
- **MMR-011** Given 模型不支持requested effort，When exact策略，Then 拒绝；best-supported策略可降级但回执显示真实状态。
- **MMR-012** Given 401错误，When fallback检查，Then 不自动用另一宽权限凭据；429才按同授权分桶退避。

### 14.2 宿主执行与凭据

- **MMR-013** Given spawn capability支持agentOptions/agentPreset，When 派reviewer，Then 逐child传provider/model/reasoningEffort/maxTokens与正确preset，不修改主Agent。
- **MMR-014** Given fork不支持agentPreset，When 编译fork请求，Then 不发送该字段并给合法persona路径，不伪称成功继承。
- **MMR-015** Given startActivation，When dispatch，Then parent是真实Agent对象，delivery=caller，结果只被统一收集一次。
- **MMR-016** Given 同endpoint两个账户route，When 切角色，Then 用独立route IDs和credentialScope，绝不把CredentialRef塞AgentOptions。
- **MMR-017** Given 密钥已配置，When 执行或导出，Then argv/prompt/日志/blueprint均不含密钥，凭据只经Host安全映射。
- **MMR-018** Given 父有一次性写授权，When child写文件，Then 宿主重新验证缺口，不继承one-shot grant。
- **MMR-019** Given 请求route与Host observed route不同，When 收集，Then 记录两者并阻止严格多模型验收，不以模型自述证明。
- **MMR-020** Given Host无observed route回执，When 展示，Then actual model显示unknown，不能照requested字段伪装observed。
- **MMR-021** Given 远端child已接受但本地响应丢失，When 恢复，Then 按原IDreconcile，不新建第二child。
- **MMR-022** Given DeepSeek兼容桥只ls/find/写receipt，When gate判定，Then 失败为证据不足，绝不接受固定PASS/VERIFIED。
- **MMR-023** Given 外部CLI exit0但无ChildResult，When 收集，Then CHILD_RESULT_INVALID或相应统一错误，不进completed。
- **MMR-024** Given 外部worker有未可测后代用量，When 总账，Then 标usage incomplete并阻止精确费用承诺。

### 14.3 tier、递归、并发与工作区

- **MMR-025** Given 单ownership surface有很多步骤，When 分档，Then 仍T1，不因文件数量升级T3。
- **MMR-026** Given 两个lane共享lockfile或数据库，When 计划并行，Then 识别共享资源并编译T2或串行边。
- **MMR-027** Given 至少两组真实disjoint资源且ready，When T3编译，Then 可批量预留并发；wide不会凭空增加lane。
- **MMR-028** Given T3执行中发现overlap，When 后续dispatch，Then 暂停冲突节点并产生plan revision，保留已通过无关证据。
- **MMR-029** Given 用户不允许子代理，When 套用Metis方法，Then 不spawn，独立性缺口如实呈现。
- **MMR-030** Given 普通Agency专家尝试递归，When 校验，Then 拒绝；只有显式高级协调role才可按蓝图派生。
- **MMR-031** Given L4 terminal role，When 请求spawn，Then 主机策略拦截，不只靠prompt约束。
- **MMR-032** Given 多进程后代同时占最后并发位，When 预留，Then 全局事务只允许一个成功，无进程内Map超卖。
- **MMR-033** Given 预算不足以覆盖冷cache和一次允许重试，When 提交，Then 停止或明确减少范围，不先跑后隐瞒超额。
- **MMR-034** Given 隔离snapshot未复制gitignored虚拟环境，When 运行，Then 环境manifest显示缺失，不把测试无法启动当模型失败。
- **MMR-035** Given 工作树失败后仍有改动，When cleanup，Then 先救援diff并校验owner，不force删除用户新改动。
- **MMR-036** Given 主工作区在child运行中漂移，When merge，Then 检验base hash并返回冲突，不checkout/reset/stash用户状态。

### 14.4 质量门与独立性

- **MMR-037** Given checks为空，When 评gate，Then not_applicable/unverified，不自动passed=true。
- **MMR-038** Given artifact只有空文件，When required nonEmpty规则，Then 失败，不能以文件存在当语义完成。
- **MMR-039** Given G5 actor等于实现作者，When 记录verdict，Then 独立性validator拒绝。
- **MMR-040** Given G6 actor等于G5 reviewer，When 记录，Then 拒绝，即使模型名不同。
- **MMR-041** Given fresh verifier继承作者完整fork历史，When independence检查，Then 标泄漏并要求干净spawn或明确降级。
- **MMR-042** Given 盲评输入含前位reviewer verdict，When dispatch，Then context filter拒绝而非只要求模型忽略。
- **MMR-043** Given 只有一个模型但不同actor可用，When requireDifferentModel=false，Then 允许actor-independent且不称cross-model independent。
- **MMR-044** Given P1有可复现失败且另两模型PASS，When 聚合，Then 保持失败待修复，不能多数票覆盖。
- **MMR-045** Given G6真实测试失败，When 作者最终文本写已完成，Then host判定failed/blocked并引用真实退出码。
- **MMR-046** Given 修复后fingerprint及证据均不变，When 重评，Then NO_PROGRESS停止，不无限回退。
- **MMR-047** Given 只有laneA失败，When 回退，Then 只使受影响后续门stale，laneB有效证据保留。
- **MMR-048** Given 所有表面门通过但仍有运行后代或effect unknown，When complete，Then 拒绝终态成功。

### 14.5 缓存、用量与handoff

- **MMR-049** Given 同任务切角色，When 工具表快照，Then nexus_*名称/schema/顺序字节稳定，不新添metis_*工具。
- **MMR-050** Given 不同credentialScope或model revision，When cache partition，Then 生成不同partitionId，不共用lease。
- **MMR-051** Given 跨provider切模，When handoff，Then 仅传版本化最小summary+artifact refs，签名thinking不转text。
- **MMR-052** Given 相同provider需连续上下文，When 发送，Then 按正式协议原样保留适用块，不任意重格式化。
- **MMR-053** Given 本地prefix hash相同但provider未报cache hit，When 指标，Then 只标eligible，不声称实际命中或节省金额。
- **MMR-054** Given header含每请求UUID，When prefix构建，Then UUID只在header/ledger，不进入长期固定头。
- **MMR-055** Given 一个logicalCall重发两次，When 计费，Then 两个attemptId均入账，业务requestId幂等不吞第二次费用。
- **MMR-056** Given child summary含grandchild已统计call及其attempt集合，When 根聚合，Then includedLedgerKeys按call+attempt/revision去重，不父子双计也不漏重试。
- **MMR-057** Given trace累计先10token后20token，When 重放revision，Then 最终20而非只取首次10或相加30。
- **MMR-058** Given hedge loser已调用付费provider，When 选winner，Then loser费用保留且无commit lease。
- **MMR-059** Given 并发两worker各耗时10秒，When run统计，Then 墙钟约10秒，compute约20秒，字段不混用。
- **MMR-060** Given 记忆降载后需原文，When 精确恢复，Then 按原hash/version取回，不能仅返回不完整摘要。

### 14.6 蓝图、学习、迁移和发行

- **MMR-061** Given 蓝图损坏，When 新run admit，Then 明确路径/schema错误并停止，不静默用builtin。
- **MMR-062** Given 没有用户蓝图，When 新run，Then 使用验证过builtin并保留现有行为，不要求先创建文件。
- **MMR-063** Given 活跃run时保存新role model，When 当前child继续，Then 仍旧快照；新run才用新绑定。
- **MMR-064** Given credentials被撤销，When 旧snapshot下次effect，Then 立即拒绝，快照不能保留已撤销权限。
- **MMR-065** Given 同mtime文件内容变化，When 加载蓝图，Then hash/revision发现变化，不误用mtime cache。
- **MMR-066** Given 图上删除protected gate，When 保存，Then 拒绝或明确变成不可发行模板，不只校验JSON结构。
- **MMR-067** Given 有未保存图改动，When 离开，Then 可继续/放弃/保存，CAS冲突有三方diff。
- **MMR-068** Given 学习off但磁盘有大量adaptation，When 构造baseline，Then 不扫描不注入不改工具表且不消耗model call。
- **MMR-069** Given 学习候选想隐藏nexus_workflow或改授权门，When guard，Then 拒绝并保留审计。
- **MMR-070** Given skill更新丢命令必需flag，When 发布，Then 回归检测拒绝，不把缩短当提升。
- **MMR-071** Given 用户明示偏好或安全规则，When 15%holdout，Then 不屏蔽；零评估不显示100%成功。
- **MMR-072** Given trial3 helped且0hurt并回归通过，When promotion，Then 只一次晋active；2hurt隔离/回滚，负样本不删除。
- **MMR-073** Given 满30 learned skills且用户手写资产存在，When 新候选，Then 提replace/retire计划，保留用户文件与history。
- **MMR-074** Given adaptation原子写中崩溃，When 恢复，Then 旧完整或新完整版本可用，journal可重放，无正文/索引分裂。
- **MMR-075** Given 旧Metis receipt声称98.2覆盖，When 导入，Then 作为未经核实材料，不作为本Run真实验收。
- **MMR-076** Given activation已发布且收到cancel，When 清理，Then 通过该次exact handle的dispose等待owned descendants结束，并分记result/teardown错误；不得假定JobService.cancel或只触发AbortSignal。Host未ACK或重启丢失控制权时显示取消中/效应未知并可reconcile，不重复spawn同任务。
- **MMR-077** Given 重启丢本地流但remote child存在，When 恢复，Then reconcile原child并恢复预算，不重发源码。
- **MMR-078** Given 多MB图片和大量事件，When Desktop收流，Then 传refs/分页并保持seq去重，主消息不重复。
- **MMR-079** Given 仅键盘/屏幕阅读器，When 蓝图和运行详情，Then 有等价文本结构、可见焦点、状态语义和取消操作。
- **MMR-080** Given 发布候选，When 总验收，Then 交付单包安装/卸载/回滚、Host真实smoke、全量旧功能coverage、SBOM/NOTICE与费用/缓存/独立性证据，未通过项显式blocked。

### 14.7 框架精华与生成器回归

- **MMR-081** Given 两个framework写同一文件，When composition，Then 重拆或合并单track，绝不并行写相同资源。
- **MMR-082** Given 单lane加polish overlay，When 编译，Then 保持一个lane，只增加策略允许的视觉/sign-off检查。
- **MMR-083** Given 选择器返回MISS，When 编译，Then 按三轴生成受控leaf，不默认backend-implement。
- **MMR-084** Given ML-eval目标F1达到阈值，When generation，Then 生成metric oracle及数据集引用，不用无意义代码覆盖率替代。
- **MMR-085** Given 生成leaf含未注册gate或两个DONE出口，When validator，Then 拒绝；最多重生一次，二次失败OUT_OF_SCOPE。
- **MMR-086** Given frontend-review没有浏览器，When 评审，Then 标静态降级和未验证journey，不编造截图/真实访问。
- **MMR-087** Given refactor为通过测试拟改characterization oracle，When 审查，Then 标行为契约改变，不能按零行为变化通过。
- **MMR-088** Given 性能优化任务，When 验证，Then 保留修改前基线、测量环境/样本和修改后指标，不只写“更快”。
- **MMR-089** Given 数据流水线任务，When 完成门，Then 验证幂等重放与重复输入，不只有单次happy path。
- **MMR-090** Given 框架正文要求与当前T0无spawn冲突，When 导入，Then 保存原文但最终计划不spawn，并展示编译差异。

## 15. 需求追踪与各章责任

`MMR-Rxx`表示本章功能需求，`MMR-xxx`为验收，`MMR-CACHE`属于缓存章合同，不能混用编号。下表由总账引用并保留上游来源。

| 需求 | 功能与来源 | 本章位置 | 验收 |
|---|---|---|---|
| MMR-R01 | 单一WorkflowRuntime、固定dispatcher、角色和persona分离；既有Nexus+Metis | §1、§5、§9 | 025–032、049 |
| MMR-R02 | 精确model/provider/endpoint/account身份和能力/价格unknown；Metis registry择优 | §3、§6 | 001–012、016–020 |
| MMR-R03 | 可执行filter/score/tie/hysteresis/pinned/strict pool/cold start/fallback | §6 | 002–012、050–054 |
| MMR-R04 | 正式Host spawn/fork逐child AgentOptions与caller delivery；官方DSH | §7 | 013–024、076–077 |
| MMR-R05 | shape tiers/16frameworks/26roles/L0–L4逻辑拓扑、stack/overlay与三轴生成器；Metis+Aegis+Agency | §4–5 | 025–036、061–067、081–090 |
| MMR-R06 | DeliveryContract/typed oracle/host gate/独立actor与上下文/有限回退 | §8 | 022–023、037–048 |
| MMR-R07 | route/cache lease、handoff、模型自治可逆记忆和精确恢复；缓存/记忆章 | §9 | 049–060 |
| MMR-R08 | request/call/attempt总账、父子增量去重、unknown费/hedge成本 | §3.2、§9.3 | 024、055–059 |
| MMR-R09 | adaptation开关/提案/去重/预算/holdout/归因/快照/回滚 | §10 | 063–074 |
| MMR-R10 | 蓝图编辑器/模型矩阵/透明route/运行态/无障碍；Metis UI+统一Claude方向 | §11 | 061–067、078–079 |
| MMR-R11 | 全局并发/递归/授权/取消/恢复/工作区救援/commit lease | §5、§7、§12 | 018、021、030–036、048、076–077 |
| MMR-R12 | 旧Metis/Agency/Aegis资产迁移、MIT源码组合、真实发行证据 | §2、§13 | 075、080 |

联合责任：本章负责PolicyCompiler、模型绑定和质量门约束；第04章负责统一任务DAG/资产/专家/CLI/文件服务；第07章负责缓存和上下文/费用计量语义；第02/05章负责记忆真源和可逆恢复；第06章负责救援点/回退/运行恢复；第08章负责工程质量策略；第09章裁决公共schema/错误/工具名；第01章锁官方宿主服务/依赖/权限/载入；第03章裁决Claude桌面视觉/导航/交互。任何冲突先更新唯一合同与引用映射，不能保留两份同名对象不同含义。

本章实现完成的必要证据是：一个用户目标进入同一Run，主会话按真实shape编译任务，至少两个独立角色可在明确选定的模型上经正式DSH执行，真实产物/命令/oracle被验证并去重入账，取消/重启/失败路径可恢复，蓝图和学习不会改变活跃快照或绕过权限，所有旧功能仍有覆盖和可用入口。缺少其中任一项应交付明确partial/blocked报告及可继续的检查点，不能以“流程已经走完”代替用户目标完成。
