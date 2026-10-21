# DSH Nexus（枢纽）：上下文、图谱、压缩、搜索与用量统一规格

版本：规格草案 1.1。日期：2026-10-19。产品为 DSH Nexus（枢纽），本地包占位 `@local/dsh-nexus`，统一命名空间 `nexus`。范围：合并 dsh-context、billion-context、ThoughtDAG、dsh-synapse、balanced-search、usage-stats 的完整能力。证据见 `../research/05-context-evidence.md`；缓存成本、缓存稳定性和计费经济性以 `07-cache-economics.md` 为统一规范。本规格中“净室级”表示可以据此独立实施与验收的详细程度；允许在许可条件满足时直接复用源码、内核、组件、解析器和测试资产，不要求真实净室隔离。

所有“必须”均是新工程的交付要求，不表示上游插件已经做到，也不把第三方内部接口叫作官方标准。最新桌面宿主的API、打包、权限与生命周期以平台章节核实的官方来源和锁定版本为准。此章定义统一领域接口；它们是本插件内部契约，并非冒称 DeepSeek Harness 已公开的SDK。

## 1. 产品边界与能力保全

新插件提供一个“上下文工作台”，让使用者同时回答五个具体问题：下一次模型会看见什么；这些内容从哪里来；复杂探索如何分支、汇聚和复用；原始细节是否仍可找回；这次工作消耗了多少实际token、预计成本和账户额度。工作台统一数据、预算和导航，但保留原项目的不同粒度：任务地图看会话与代理，思维画布看轮次和材料，请求浏览器看真正发给模型的组装结果，账户页看供应商的独立快照。

同一会话不允许同时运行多个互不了解的压缩器；同一实际请求的流式usage不能被多个统计器累加；同一材料不能因多个祖先路径重复包含。图中血缘、上下文、引用、审阅、任务依赖和代理通信必须是不同关系类型，不能因为都能画成线便共用一个语义。

billion-context 的论文路线是产品强制核心：模型根据当前任务自主决定何时压缩、压哪一段及保留多少；只处理已经消费的增量；按 T1/T2/T3 递归折叠；原文和层级血缘可恢复；通过 search→单块/范围解压按需找回精确信息；保留 prompt-cache 友好的稳定布局。产品必须把这一路线与07章缓存规划共同实现，不得以固定百分比触发的全会话摘要、只保留一份最新摘要或“以后再接入”的可选项替代。允许用户明确停用自动压缩或切换观察模式，这属于控制权，不改变交付时必须具备完整内核能力。

原插件依赖旧宿主接口的能力也属于本次范围。实施者必须通过当前公开接口、集中兼容adapter或可验证的替代服务恢复，不能以“版本过时”为删除理由。若正式API缺失，允许在隔离adapter中使用受控兼容hook；该路径必须有版本能力探测、冲突检测、卸载恢复、合成验收和可见健康状态。开发过程可先让某能力处于待适配，但最终验收不能用永久禁用代替完成。

源功能归并采用下表，未列的细项仍以研究文件覆盖表为范围：

| 领域 | 统一入口 | 保留的独特能力 |
|---|---|---|
| 上下文观测 | 工作台总览、会话上下文tab、侧栏、`/context` | DNA顺序、逐请求/逐turn趋势、实际schema/内容、技能归因、文件活动、时长拆分 |
| 会话任务地图 | “地图”中的任务层 | 原生聊天同步、会话fork与工作区分组、位置保存、子树折叠 |
| 思维图谱 | “地图”中的轮次层 | 连线即上下文、材料阅读、选文分支、引用、高光、Weave、Condense、多版本、依赖重放 |
| 压缩与恢复 | 请求预览、压缩面板、原生工具 | 多层可逆压缩、范围恢复、内容外置、原图恢复、缓存报告、诊断与外部客户端桥 |
| 历史发现 | Atlas、why、相关讨论、来源管理 | DSH/Claude Code/Codex/Pi历史、工具证据、逐条引用、跨会话检索、topic/dossier/决策器 |
| 搜索 | 原生搜索工具、材料链接入口、MCP投影 | Keenable/Exa/Tavily公平轮转、故障切换、正文抓取、时间筛选 |
| 用量账户 | 工作台“用量与账户” | actual usage、热图下钻、13 adapter、余额/多窗口额度、区域与中转面板 |

## 2. 统一架构与所有权

服务按责任拆分：`SessionReadPort`只读宿主事件与投影；`SessionWritePort`调用宿主fork/inject/prompt/approval，不写原始日志；`ContextPlanner`组装本次输入与来源；`GraphService`管理图和语义revision；`CompressionCoordinator`独占压缩状态；`HistoryIndex`管理授权来源和增量索引；`SearchGateway`调用外部搜索；`UsageLedger`记录请求、attempt和reported用量；`AccountGateway`读取供应商账户；`ArtifactVault`保存内容原件、摘要和导出；`BudgetService`给所有远端调用预留费用；`HostAdapterRegistry`处理版本差异和兼容hook。

这些服务只有一个实例归属于当前插件挂载生命周期。组件只能经服务访问，不直接遍历用户目录、抓全局fetch、解析凭据文件或重写会话。工具、HTTP/RPC、MCP、CLI和UI是同一服务的投影，不能各自维护一套轮转指针、压缩块和用量缓存。模型工具注册名应加统一命名空间；旧命令别名可以保留，但它们只能委托同一处理器，且工具描述中显示兼容别名的来源。

源码采用优先复用成熟纯模块。billion-context的kernel、wire校验和恢复逻辑进入压缩子模块，现有native安装/全局hook不原样散布；dsh-context的fold、归因、图表、浏览器和Fleet组件改接统一投影；ThoughtDAG的graph、context-builder、bundle、画布、材料阅读、Weave/Condense/why解析器改接统一会话与模型服务；Synapse的工作区/布局/迁移改接事务元数据；usage-stats的纯fold和账户adapter改接统一传输与计费normalizer；balanced-search保留provider映射，轮换/错误/预算在网关集中治理。导入时记录源SHA、路径、许可、改动摘要和上游测试映射。

跨领域最重要的接口是不可变 `ContextPlan`。图谱、记忆、技能、系统前后缀、材料、压缩都只向此计划贡献带来源的项；最后由一个builder渲染实际请求。预览和发送必须引用同一个计划快照，不能UI先算一份、发送再临时重取一份。缓存优化只能对计划施加已声明且可观察的变换，不能偷偷删除材料、改写用户工具参数或把未知估算显示成实际账单。

## 3. 公共类型、标识与验证规则

所有持久对象有 `schemaVersion`，所有时间以UTC ISO8601存储，以用户选定时区分桶展示；默认展示时区为宿主用户设置，本次用户为Asia/Shanghai。所有id是不透明字符串，不包含明文凭据、完整提示词和文件内容。外部会话标识带source namespace；不能因为两个产品都用相同session id就合并。宿主稳定session id优先，provider/model/credential切换不改变会话身份。原始路径保存于受权限保护的来源映射，浏览器默认取得相对显示名和不透明artifact id。

以下类型使用TypeScript记法定义数据结构，实际持久和传输为JSON；可选字段缺失表示未知，`0`表示真实零，`null`表示有意为空，两者不能混用。所有公开schema默认 `additionalProperties:false`，扩展放版本化 `extensions`，未知required语义返回版本错误，不能悄悄丢弃。

```ts
type EvidenceLevel = "host-reported" | "provider-reported" | "derived" | "estimated";
type SourceRef = {
  sourceId: string; kind: "session" | "file" | "url" | "skill" | "memory" | "tool" | "graph";
  sessionId?: string; eventSeq?: number; turnId?: string; requestId?: string;
  artifactId?: string; start?: number; end?: number; revision?: string;
  binding: "pinned" | "live"; immutableVersion?: string; contentHash?: string;
};
type Measure = {
  value?: number; unit: "tokens" | "bytes" | "ms" | "money" | "ratio";
  evidence: EvidenceLevel; source: SourceRef; method?: string; methodVersion?: string;
  currency?: string; observedAt: string; approximate: boolean;
};
type Operation = {
  id: string; kind: string; status: "queued" | "running" | "waiting-approval" |
    "cancelling" | "succeeded" | "failed" | "cancelled";
  idempotencyKey: string; expectedRevision?: string; attempt: number;
  startedAt?: string; finishedAt?: string; error?: DomainError;
};
type DomainError = {
  code: string; message: string; retryable: boolean; operationId: string;
  detailRef?: string; providerId?: string; retryAfterMs?: number;
};
```

`Measure`只允许有限非负数，增量另用有符号`delta`结构；金额用十进制字符串或整数最小货币单位避免浮点误差。占用率允许在诊断中超过100%以反映溢出，但图表绘制需clamp并另显溢出量。百分比原始含义必须标注used或remaining，不能猜测供应商缺失字段。未知币种不得默认USD；只有adapter正式文档约定币种时可填默认并记录来源。

```ts
type GraphNode = {
  id: string; graphId: string;
  kind: "conversation" | "material" | "note" | "summary" | "reviewer" | "session";
  source?: SourceRef; question?: string; answerVersionIds: string[];
  activeVersionId?: string; rolePolicyId?: string; attachmentIds: string[];
  archived: boolean; semanticRevision: string; x: number; y: number;
};
type GraphEdge = {
  id: string; graphId: string; from: string; to: string;
  kind: "conversation" | "explore" | "reference" | "review" |
    "session-lineage" | "task-dependency" | "agent-communication";
  contextMode: "none" | "quote" | "full"; order: number;
  quote?: { sourceVersionId: string; start: number; end: number; textHash: string };
};
type AnswerVersion = {
  id: string; nodeId: string; previousId?: string; textArtifactId: string;
  providerId: string; modelId: string; contextPlanId: string; inputHash: string;
  createdAt: string; status: "partial" | "complete" | "failed" | "cancelled";
  stale: boolean; staleCauses: SourceRef[]; usageRequestIds: string[];
};
```

图布局坐标、颜色、展开折叠和缩放不进入`semanticRevision`；问题、答案选定版本、角色、材料排除、引用内容、语义边及merge order进入。对原始宿主会话的映射只读；编辑问题/答案创建画布覆盖版本，不能伪装为改写宿主已发生的消息。

```ts
type ContextItem = {
  id: string; kind: "system" | "tool-schema" | "user" | "injection" |
    "assistant" | "tool-result" | "skill" | "material" | "reference" | "recall";
  contentRef: string; source: SourceRef; ordinal: number;
  estimatedTokens?: number; estimateMethod?: string;
  selected: boolean; protectedReason?: string; transformIds: string[];
};
type ContextPlan = {
  id: string; sessionId?: string; graphId?: string; targetNodeId?: string;
  graphRevision?: string; sourceRevisionSet: Record<string, string>;
  items: ContextItem[]; excluded: { source: SourceRef; reason: string }[];
  builderVersion: string; modelId: string; providerId: string;
  estimatedPromptTokens?: number; outputReserveTokens: number;
  hardWindowTokens?: number; budgetReservationId?: string;
  compressionControllerId: string; semanticHash: string; wireHash?: string;
  frozenAt: string;
};
```

`semanticHash`使用明确版本的canonical JSON和SHA-256，按模型可见语义计算；`wireHash`仅在实际序列化后计算，不假装语义hash等于传输字节hash。文件内容hash使用实际完整字节，不能把“名称+大小+开头”fingerprint称作内容SHA。预览的截图和分享结构图不含隐式密钥或远端资源自动加载。

```ts
type CompressionBlock = {
  id: string; sessionId: string; controllerEpoch: string;
  sourceSpans: { firstMessageId: string; lastMessageId: string;
    sourceRevision: string; contentHash: string }[];
  childBlockIds: string[]; summaryArtifactId: string; originalArtifactIds: string[];
  tier: number; status: "prepared" | "active" | "restored" | "superseded" | "invalid";
  createdByRequestId: string; originalEstimatedTokens?: number; summaryEstimatedTokens?: number;
};
type UsageRecord = {
  sessionId: string; intentRequestId: string; logicalCallId: string; attemptId: string;
  providerRequestId?: string; turnId?: string; stepId?: string;
  providerId: string; modelId: string; observedAt: string;
  uncachedInputTokens: number | null; cacheReadTokens: number | null;
  cacheWriteTokens: number | null; outputTokens: number | null;
  usageState: "valid" | "missing" | "ambiguous" | "invalid";
  rawUsageRef?: string; semanticsVersion: string; evidence: EvidenceLevel;
  completion: "interim" | "final"; includedInBill?: boolean;
};
type AccountSnapshot = {
  providerId: string; adapterId: string; mode: "balance" | "subscription" | "unsupported";
  state: "ready" | "unconfigured" | "unsupported" | "stale" | "rate-limited" |
    "unauthorized" | "blocked" | "invalid-response" | "unavailable";
  balance?: { remaining: string; used?: string; total?: string; currency?: string };
  windows?: { id: string; kind: string; remainingRatio?: number; used?: string;
    total?: string; unit?: string; resetsAt?: string }[];
  fetchedAt?: string; expiresAt?: string; error?: DomainError;
};
```

使用量记录与账户快照不能互相填空。余额没有响应时不从估计成本推算；无reported usage时不伪造精确账单；window未知时不以默认100k装成模型官方窗口。来源版本失效使相关派生物待重算，不能静默覆盖原文或跨会话套用旧块。

## 4. 宿主适配与兼容生命期

adapter启动先取得宿主版本/构建标识，再探测具体能力形状，产生`CapabilitySnapshot`。字段至少包括会话查询、实时事件、磁盘history、fork边界、inject source、prompt、agent stop、approval、projection、官方token计量、tool registry、slots、附件预览、credentials、模型middleware、官方compaction控制。版本范围只用于拒绝已知不兼容，不能代替形状/行为测试。

公开API路径优先；没有正式middleware而内核必须接模型流量时，集中`TransportAdapter`允许受控fetch wrapper。wrapper只处理已注册provider的已知模型端点和当前插件拥有的session，不拦截普通网页抓取、账户查询、npm更新或别的插件网络流量。传输层必须保留原函数引用、wrapper身份和安装epoch；卸载只在全局仍指向自己时恢复原函数，若别的插件后续包裹则执行协调卸载或报告冲突，不把别人的wrapper覆盖掉。重复挂载检测相同owner，不重复包装。

CompactionAdapter遵守01章公开provider/bundle/preset路线及GATE-COMP-001。旧内部禁用hook是迁移对象，不构成调用未导出函数或patch私有方法的许可。通过正式配置取得唯一所有权，不遗漏preset内层，不在停用后永久关掉宿主保护。项目自有acquire/release/inspect/recover语义保存可恢复配置与revision；唯一协调器选内核并在安全边界切换。需要兼容桥时逐项证明01章合同，不以笼统“内部hook”跳过门槛。

旧Synapse/ThoughtDAG/team/zstd能力经版本adapter恢复。产品页面必须用01章React slots；缺目标slot时用宿主允许的main/side panel或实施兼容slot，不退回整页Host HTML iframe。只有独立HTML/MCP App产物用受限预览，校验postMessage origin/source与nonce。主题/语言/session单向同步，遵守桌面标题栏与拖拽安全区。

磁盘读取是兼容导入。HistorySourceDescriptor含mode=`host-port|authorized-file-import|external-live-source`、formatVersion、owner与授权范围。当前运行中DSH用正式SessionPersistence/Projection port，不watch私有journal；zstd逐帧解析只处理显式旧文件/授权导出副本，有限字节/帧/行长，不写源。损坏报告可读前缀/位置，未知格式保留。所有adapter有fixture/矩阵/卸载测试；Desktop验收包含画布→历史turn→fork→上下文→带工具agent→审批→reported usage→停用。

## 5. 图谱与任务地图的完整行为

任务层按工作区显示会话、父子fork和代理任务。工作区identity由规范化项目根与宿主project id共同确定；Windows大小写、junction和UNC路径按统一文件服务处理，不能只用字符串前缀判权限。任务卡含标题、状态、最新用户目标摘要、完成时间、provider/model、上下文占用、reported token、估计成本和子任务数。卡片可以拖动、折叠子树、定位当前、查看完整记录、打开原生聊天；布局持久化，源会话隐藏后不得因下次扫描再出现。删除地图元数据不删DSH会话，清楚显示恢复入口。

轮次层每个conversation节点有问题、多个答案版本、模型来源、角色策略、高光、附件和上下文预览。用户能从回答选文创建explore节点，原文定位由版本id+range+hash绑定；选择来源变更时标“选文来源已更新”，不能把相同偏移错误套在新文本。继续同一路径、原位生成新版本、生成兄弟版本、复制、归档、删除、转便签、复制Markdown、CLI/外部agent续聊都必须存在。浮动面板支持阅读、版本切换、材料、高光、merge order、上下文树和followup。

普通conversation/explore边参与上下文祖先；reference边只根据quote/full模式贡献隔离引用，review边默认不成为被评审节点的输入，避免writer读到自己尚未完成的critic。session-lineage只表达宿主来源，不因存在父session而自动加载全部父历史。task-dependency影响任务看板，不等于内容包含。agent-communication取观测消息，不在“看图”时自动发送新消息。

创建、导入、转换边时都进行拓扑校验。对参与上下文的有向边新增`A→B`，若B已可达A则原子拒绝，返回`CTX-GRAPH-CYCLE`及一条可显示循环路径；自环、缺端点、跨graph未显式引用、重复semantic edge也拒绝。引用模式仍要防止递归full展开的环，不能只靠visited消除无限循环后悄悄接受错误图。纯审阅/血缘的环分别由相应模型约束：血缘环拒绝；review可有双向关系但执行波次有界。

祖先以确定拓扑顺序组装，共享祖先按稳定来源/版本只包含一次；多入边由用户明确order，order相同用稳定id兜底，不随拖动位置/边创建时机改变。材料按显式继承规则先加入，引用后加入，主链按轮次加入，本次问题最后；系统/工具schema使用统一builder位置。用户可查看“因为哪条边/哪次召回而包含”，以及被排除的归档节点、材料和超预算项。断开边立即改变下一次计划，不删原节点和已发生回答。

所有画布结构编辑支持undo/redo和批操作。一次框选对齐/布局为一个事务；undo恢复布局和可见性，但已经发出的模型费用、工具执行、宿主fork不被假装撤销。涉及宿主副作用时撤销产生补偿记录或“该动作有外部结果”的提示。自动布局遵守箭头顺序，同链竖向优先、汇聚节点下游、reviewer旁挂；用户手工钉住坐标保留。缩放提供完整卡片、结论牌匾、图标层；四层ladder摘要可以本地生成或模型重选，可批量停止，但缩放本身不变上下文。

图诊断列出孤立/失效来源、悬空引用、超预算路径、重复材料、陈旧答案、无完成来源、混用版本和无法恢复的旧块。诊断不自动删节点。图可导出纯结构Thought Map，含节点/边种类、结构统计和可选匿名标题，默认不含完整问答。旅程海报保留调查转折/决定/未决项及来源，导出前有内容审阅；它是代码绘图产物，不等同调用图像生成API。

## 6. 上下文计划、预览与陈旧依赖

计划依次解析源、展开拓扑/角色、合并材料、预算/压缩、冻结预览。依赖按09章pinned/live区分：pinned核验原版本存在、hash与权限，不要求等于latest；live变更才返回CTX-PLAN-STALE并重做预览。后台记忆更新不改固定快照，安全删除/撤权仍阻断。布局/hover/语言不使计划陈旧，不能替换用户已见材料。

预览显示六类基本token构成和skill/material/reference/recall细分，工具schema显示提供方（第一方包、插件、MCP server或未知）、真实名称、schema、大小估计。实际消息可展开text、允许显示的reasoning、tool argument和result，顺序与模型渲染相同。签名思考块作为受保护artifact，只读预览其允许的摘要或宿主可见内容，不能为了浏览器清理而修改原字节。Raw/Markdown切换只改变展示，HTML/Markdown链接清理不影响原件。

附件按原消息块顺序显示，含文件名、类型、字节、尺寸/页码和估算方法。点开使用宿主附件预览，缺预览时回到统一ArtifactViewer，不直接在系统打开任意未校验路径。图片token若模型官方有明确算法则标算法版本，否则使用估算，不把DeepSeek算法套到所有模型。二进制、OCR和摘要转换保留原件hash、提取器版本、时间和对应页码。

用户更改上游问题、答案版本、边、角色或材料后，系统计算下游受影响集合，旧回答只标stale，不丢弃。每个stale记录是“输入已变”的可验证事实；快速决策器可补充“该变化可能不影响答案”的判断，但不能删掉事实。用户可忽略本次stale建议，忽略记录有适用的源revision；再变化后重新判断。依赖重放按拓扑执行，每个节点生成新版本，失败默认停止下游，独立支路可继续。共享祖先每波只跑一次。

受控比较固定问题、模型、工具开关和角色，分别冻结前后ContextPlan，显示改动项、两次结果、用量和成本差。温度、seed、provider行为是否可固定必须诚实标注；不能把两次随机输出差异声称为严格因果。循环reviewer每波有maxIterations、总模型调用和费用预算；达到任一上限便停，留下待用户处理，不会writer↔critic无限递归。

系统前缀/后缀作为统一提示策略保留。设置界面展示适用范围（用户/工作区/代理）、排序位置、额外token估计和下次生效边界。默认空，不把观测插件的设置悄悄应用给所有子代理。更改后ContextPlan记录policy revision；历史请求仍显示当时版本。persona complete模式或宿主提示组装使某段不生效时，诊断明确标注未进入请求，不能仅因配置非空就显示“已注入”。

## 7. Condense、Merge、Weave与材料工作流

Condense是图上派生副本，不是改写源会话。用户选择范围后，系统寻找连续无分叉段，显示原token、预计摘要、保留分叉/决定/转折/未决项的规则、预计调用费用和可取消进度。分叉边界、被引用精确代码、未完成工具对、固定决定节点默认不能跨段折叠。作业先生成全部候选summary，再验证引用与revision，最后一次事务添加新副本和映射边；任一失败不部分替换原路径。原路径和原文始终可访问；也允许按已完成段明确保存部分成果，但必须由作业状态显示。

Merge summary把选中原内容和用户意图汇总为新节点，源边保留来源。Merge & delete是“汇总成功且来源未变后归档源节点/选定后代”的可撤销图事务，不删除宿主日志或vault原件。汇总前列出会连带归档的节点数及被引用节点，避免误伤其它支路。摘要失败、取消或revision冲突时不归档任何源。

Weave只把用户选中的高光编织成连贯文本。每条高光带原节点/版本/范围/页码，生成结果必须保持可点击引用；不允许编造来源编号。高光分为insight/decision/pivot/rule-out/open等结构化种类，可作为过滤和保护依据，但自动分类是候选，用户可改。选中高光的顺序、是否附上下文、期望语言与意图都进入计划。没有高光时明确说明需要选择，不能偷偷改为对全部节点做Merge。输出对每个引用校验存在性；未被支持的句子标“未找到对应来源”供审阅。

材料节点保留PDF、图像、HTML、DOCX、Markdown、文本、代码、链接快照的原格式与提取文本。阅读器支持原件/文本/digest切换、选文或视觉区域提问、保存passage/image节点、页码定位、来源到回答到画布的双向跳转。远端OCR/视觉理解、学术搜索和普通web搜索都通过统一模型/工具网关，触发费用和外发范围可见；本地解析不请求无关网络。提取文本可编辑，但保存为新提取版本，原文件不被覆盖。

附件继承按material id和source revision去重。用户可在目标节点“排除本项”或“重新包含”，本次例外与默认继承分开显示；某节点排除不能意外删除其它工作区的共享材料。链接快照记录抓取时间、最终URL、内容hash和live/cache来源；之后网页变化不会悄悄改历史ContextPlan，可由用户刷新新版本。

## 8. 压缩单控制器、持久与恢复

每session有唯一`CompressionLease`，包含controller id、epoch、模式和宿主适配状态。状态机为`inactive→acquiring→ready→planning→summarizing→validating→committing→ready`；任何阶段可进入`cancelling/failed/recovering`。`ready`时可处理压缩或恢复，两个修改同一session的任务串行；只读status/search可读提交快照。跨session并发受全局worker和费用预算限制。lease过期不凭墙钟直接抢占，需确认owner失效并检查未提交事务。

压缩分预备和提交：先锁定源revision和消息完整区间，保存可恢复原件与hash，生成summary，验证源仍匹配、保护项/工具对未被破坏、summary非空且有益，再写prepared block与提交记录；只有原件持久化确认后才更新可见计划。中断前未commit的块不生效，启动恢复要么完成已具备全部原件的提交，要么标invalid并回退原文。block id和message id永不复用，墓碑保留引用，防历史指针指到新内容。

### 8.1 强制采用的模型自治增量分层路线

实现优先直接采用版本锁定的 acp-kernel，保留其完整生命周期、T1/T2/T3、增长提示、模型决定、最近区、protected tools与latest snapshot工具保护。任何必要改造都必须与原内核合成样本做行为差异报告，不能把它封装成普通 `summarize(history)` 后丢掉其状态机。内核负责稳定消息引用、块同步、范围归并、预算/可见性保护、工具噪声处理、nudge与最终渲染；宿主适配器负责模型 I/O、工具分发、请求/usage对应和持久；模型负责任务相关判断和摘要内容。采用内核时保留其载荷和控制顺序要求，不通过一个自创的通用pipeline重新排列这些步骤。

常态决策遵循“当前任务步骤是否仍需要这段内容”，而不是仅按年龄、大小或填充百分比选择。触发器综合新增可压缩token质量、层级积累、近期工作区和压力，但触发表示向模型提出有边界的建议。nudge给出稳定消息/块id、真实或明确标估算的候选大小、工具/文本构成和可压缩边界；遵循内核 doctrine 的关键规则，默认不把填充百分比作为催促模型的口号。模型可以拒绝、延后或改选合规范围，拒绝记为 `declined/deferred` 而不是错误；它也必须能在本轮没有nudge时主动调用压缩工具。系统不可在后台悄悄把模型拒绝改成一次固定摘要。

常驻且版本化的 doctrine 包含保护原始用户意图、当前约束、未决目标、决定及理由、精确错误、路径/行号、关键代码与数值、可恢复引用；压缩已消费日志/重复读取/探索过程时保留其结论与失败教训。doctrine、工具schema、nudge、层级规则和内核版本一起锁定。用户对提示词层级的 replace/remove/default 修改必须显示生效作用域和风险；移除底层保真规则应要求显式风险设置，不能由主题或语言包顺便改变。摘要中历史文字作为历史证据，不自动提升为新用户指令；未完成且未被取消/替代的授权任务仍保持其现有授权状态。

T1折叠新消费的连续原消息范围；T2按明确边界蒸馏累积的T1及边界内原消息；T3再蒸馏较高层。每块记录 directMessageIds、effectiveMessageIds、directBlockIds、tier、generation、runId、topic、active与来源revision，统一外层模型可映射字段但不能删掉内核依赖。块只因明确fold/restore操作变更；不在每个新turn中重写所有旧摘要、重新编号或全量重排序。不同层的增长阈值、保护最近区、每摘要字符预算、分批范围上限、提示节流和紧急预检均保留可配置，并按07章的缓存/成本及本章质量样本选择默认；论文示例50K等不被当作适用于所有模型窗口的固定常数。

正常模型自治与紧急硬上限分开。临近窗口上限可做有次数、token、费用和墙钟上限的preflight协商；若模型持续拒绝且原请求会溢出，保留当前数据并返回可操作状态，允许用户缩小范围、换窗口或明确启用有来源且可恢复的应急视图裁剪。不得为完成请求伪造模型已同意压缩，也不得通过破坏签名、未完成工具对或物理删除原件满足上限。用户手动指定范围的压缩同样进入此内核和单协调器。

### 8.2 可恢复血缘、检索与精确召回

多层摘要是带childBlockIds的可追溯树。递归压缩不能把原文丢掉；从高层恢复支持默认只展开上一层和 `full:true` 递归到原消息两种语义，两者必须在结果和UI清楚标记。恢复整块、一个下层块、消息子区间和原图为完整交付范围，当前wire不能内联时通过受控artifact/file通道恢复，不把范围能力永久裁掉。临时恢复有TTL和token预算，长期恢复改变计划revision；恢复不会写回父session。

默认采用不会改写现有消息前缀的读取/解压到文件：保持原块及其summary位置不动，从持久原件收集内容到受控artifact，模型随后按需read；小范围可明确选择追加tool-result式inline恢复，不能把全部旧原文重新插回旧前缀作为唯一实现。`full:false`只展开上一层，保留仍active子块摘要；`full:true`输出完整原消息并标内容/来源hash。inline和file都标请求、字节/token量及保留期，并显示是否仅返回handle、是否真的进入本次模型输入。文件输出只能落在插件受管且授权的目录，公开工具不接受任意绝对输出路径；兼容旧toFile由adapter转译为受控artifact destination。

search→decompress是常态闭环，不能只提供“对所有历史再跑一次模型”的昂贵入口。`context_search`默认检索可见消息与压缩块summary，返回稳定block/message refs、topic、片段、原文/摘要类别、对应覆盖范围与匹配方式；候选尚有原件时可检索原件索引并清楚标明。普通词法检索必须离线可用，语义/embedding与planAware重排是可选增益。模型先低成本定位目标，再仅恢复有必要的块/范围，恢复后的内容仍可在后续增量fold中再次折叠，避免“刚恢复→永远保护→窗口爆满”。重复读取计数、可用精确范围与整块恢复成本进入诊断；不对同一压缩作业例行执行一次search/decompress来“验证”而浪费账单。

### 8.3 与 prompt-cache 的联合决策

07章CachePlanner是这一内核的外围补强：读真实wire布局、provider reported usage、价格和ledger，向唯一协调器提供break-even、候选收益、稳定前缀差异、冷尾成本、预算和建议延后；它不另起摘要器，不直接改block树，不用一个缓存命中率目标覆盖模型的任务保真判断。压缩与缓存不是二选一：优先保留无关前缀、稳定工具schema/系统段、已提交摘要和append-only新后缀；只在模型批准且保护验证通过的边界折叠本次增量，实际发出前由同一ContextPlan和wire序列化结果校验。

每次fold写入 `foldEventId`、源区间、前后wireHash、最早改变字节/消息位置、token估算方法、摘要产生的actual请求、前后视图估算和后续请求归因窗口。恢复到file通常不动原prefix，inline追加仍可能扩大输入；高层蒸馏、角色承载、工具schema变化或供应商规范化仍可能造成缓存重付。因而不得把论文“prefix friendly”扩大为“任何协议永不失效”。本插件的可证承诺是受影响位置之前的可序列化部分字节稳定、变更原因可解释、reported命中与miss账目闭合；provider侧是否接受缓存由实际usage确认。无法解释的稳定前缀miss命名 `unattributedStablePrefixMiss`，不自动断言是TTL到期。

每次实际主调用、模型压缩调用、preflight、重试和恢复所触发的后续调用都进入07章同一attempt账本。账务缺失不填零，估算节省不和实际收费混加；模型调用成本、summary output、fold冷尾重付和重复read成本共同参与收益判断。若候选近期会被精确恢复或即将换provider，planner可建议延后/缩小范围并给依据；最终由同一模型自治/用户策略决定。全局controller冲突时先完成可逆owner交接；没有两套已接管状态并行运行的“兼容模式”。

### 8.4 载荷保护、双模式与外部客户端

CCR大工具结果外置、absorb摘要、原图保存/降采样必须是显式transform。原工具参数和执行结果原件保真，模型上下文可使用有来源指针的替代视图。tool-call/result成对处理，不能保留一个丢另一个；一个调用多个结果/流式结果按宿主协议组合。受保护工具、最近累计todo、当前未完成工具对、关键用户约束和签名payload默认不被摘要跨越。图片恢复返回受限artifact handle，由宿主读取，不能泄露任意本地绝对路径。

pluginMode与proxyMode都必须支持。前者宿主工具调用记录承载summary，后者代理生成的summary carrier在协议允许的位置出现，避免多system/角色限制和前缀移动；具体wire规则以采用内核和供应商契约测试锁定。切换模式不是在单个流中临时猜测，不允许同一session一半工具承载、一半summary承载导致双重包含。签名thinking/redacted thinking/Gemini thought signature逐字节保留；工具argument包含用户意图，也逐字节保留，不能用正则过滤“像内部标签”的字符串。

全局网络hook只由集中adapter装一次。对于无法识别、签名重签不支持或body预算溢出的协议，返回明确能力错误并给出“用宿主模式继续/使用已支持连接”的操作；是否允许原样直连由已配置策略决定，诊断显示本次未压缩及原因。不能默默宣称“压缩生效”，也不能把签名body改写后继续发。停用压缩保留全部可恢复块和导出，卸载不删原件，统一清理需显示影响范围和引用检查。

外部客户端连接桥保留native、launcher、baseURL三种上游价值。统一包可提供独立可选桥接组件，为Claude Code/Codex/Pi/OpenCode等连接同一内核；外部客户端自身权限和执行循环仍归其宿主，DSH只展示可授权的状态、会话和费用。不得因导入Pi扩展在DSH偷偷运行第二套权限系统。bridge有独立端口/token/允许client清单，不开放任意转发代理。

## 9. Atlas、why与跨代理历史

首次使用Atlas展示可选来源类型和待授权目录，不自动读取全部用户历史。支持DSH、Claude Code、Codex、Pi，以及本画布和外部agent只读memory；用户可启用/禁用、增加自定义来源、限制项目、排除目录并清除派生索引。关闭来源立即停止监视与新读取；已导入画布保留其本地副本并标来源不可访问，按用户数据清理策略可移除索引和缓存。

索引分source manifest、canonical session、turn/artifact link、全文/关键词与topic派生层。每session记录外部id、项目、格式、revision、最后完整记录游标、原件大小/mtime和解析器版本。只索引完整追加行；发现truncate/rewrite/format变更则重建该session，不把游标机械向后读。DSH多帧zstd、Codex多种记录、Claude工具记录、Pi树形会话各有解析器；不支持字段保留原记录引用和警告。reasoning是否索引由安全/来源规则明确，默认why解释不把隐藏推理当事实。

Atlas按项目分组，显示标题、agent、时间、工具数、变化状态和来源可用性；支持changed过滤、多session挂载、只读镜像增量追加、remirror和具体turn定位。镜像节点有sourceSession/sourceTurn映射；用户编辑覆盖版本后不再被live mirror覆写。源会话重写时旧镜像保留旧版本并标变化，不让同一id指向另一段内容。多个来源是同一会话的导出副本时通过内容/identity证据去重，不能仅凭标题去重。

why工具面包含四个稳定工具：check回答某artifact是否有历史；file返回触及它的turn和观察到的操作；find做可解释精确词匹配，可扩展显式语义模式；recall返回某turn完整可授权内容。file把“observed changes”与“candidate explanation”分列：工具diff是观测，回答里说“因为…”是当时文本，不保证真实决策原因。所有结果携带可点击来源、时间、agent、turn、索引revision和截断标记；结果不包含未经授权的其它项目。

可查artifact包括路径、URL、arXiv标识及材料id。相对路径相对当前项目根解析，Windows盘符/UNC/junction经文件服务规范化。历史工具中出现的路径只是证据字符串，不授权访问当前文件。why_check轻量返回boolean+count+freshness，不为了查询一个路径把全部历史全文返回给模型。why_file默认只写/改，includeRead才含读；find范围支持question/answer/material/all；recall转full时尊重输出token上限并提供分页handle，不能静默截断还说“完整”。

快速决策器保留Jev类选择能力，可配置聚合器、官方接口、Cloudflare、自托管或当前聊天模型。响应严格schema，记录provider/model、calibrated标志和来源；当前模型作为替代时显示未校准。单调用默认6秒deadline，失败后该provider一段60秒熔断，规则立即回退，不阻塞主聊天。每次决策实际token也记账。关闭决策器不意味着关闭模型回答或dossier生成，设置文案明确这些独立费用。

recall有两个维度：amount为lean/standard/generous，决定最终上下文预算；reach为light/deep/full，决定候选扫描深度。light可取40候选，deep可取2000，full扫描授权全集；这些是初始产品默认，配置可调并受预算限制。full开始前显示本地turn数量、估计时间/费用和最大调用，不把Infinity传到worker。topic dossier可整份加入，细节问题再加入原文摘录；每项含source、cost、included/excluded和理由，用户能inspect/open/cite/remove。一次临时修改不覆盖默认，明确“设为默认”才持久化。

topic支持用户命名、模型建议、合并/重命名、后台标注和CLI。dossier逐行带来源，结构覆盖“是什么、决定、当前状态、未决”；重建保留用户编辑和冲突视图。身份/偏好文档和项目事实inbox由统一记忆服务治理，提供changelog/undo，不建立重复的不可协调记忆库。跨agent memory是只读来源，不能因为某事实被dossier引用就自动写回外部agent。

## 10. 宿主分支、续聊、注入与审批

所有宿主写动作经`SessionWritePort`。fork接受完成turn锚点或已验证seq；锚点必须属于目标session、未被重写、位于完整turn结束。仍运行turn返回`CTX-TURN-OPEN`，不会截断日志。fork得到新的宿主session id与lineage，父会话不可变；原画布可同时保留父子。画布“回退到此处”表现为fork后选择子session，与文件恢复是不同能力，后者委托统一回退章节。

inject用于给运行agent追加插件上下文，message id唯一，source携带当前宿主支持的插件namespace；followup是用户发起的新prompt，经宿主session controller完成turn序列。两者操作记录包括contextPlan id、来源和调用人。若宿主原生上下文已经包含父链，画布只注入额外材料，不能把同一父历史再串一次。预览清楚区分“宿主固有历史”和“画布额外选择”。

启动画布模型可选裸模型问答或宿主agent。裸模型只调用推理，不自动拥有shell工具；宿主agent执行宿主工具/审批/停止循环。每个canvas operation绑定session/turn/request，事件过滤只收本次turn，不吞掉原生聊天同时发出的别的事件。busy session新prompt策略由宿主控制，UI显示queued/steer/followup语义；不得自行并行写同一session日志。

审批请求通过宿主approval服务接入；request id、session、turn、operation一致才显示和接受决定。画布关闭/流断开时待决审批默认保持宿主可见或明确拒绝，不能自动批准。过期审批答复返回`CTX-APPROVAL-EXPIRED`，重复相同答复幂等，不同答复冲突。UI显示真实工具、参数、原因、风险及允许的once/session等选项，不能在代理桥里降低宿主门禁。

取消一个模型operation时向宿主传递stop/AbortSignal，等待terminal事件，停止后不接收晚到chunk改写已完成版本。若上游不支持即时取消，状态显示cancelling并记录仍可能计费的attempt，用户可继续看部分输出；不能立即显示“已取消无费用”。流式断开不等同模型已停止，服务端必须显式清理或转后台可见任务。

## 11. 观测投影、Fleet与文件活动

会话概览展示轮次、步骤、用户输入、工具调用、活跃时长、实际token、估算成本和缓存指标。当前占用读取官方`contextPressure/contextBreakdown`或当前宿主等价公开投影，所有入口共用一个selector；与宿主环一致是验收要求。没有官方字段时展示估算且标方法/版本，不宣称精确一致。压缩预留、输出预留和剩余可用显示为不同区域，阈值不能用一条模糊百分比代替。

趋势以实际request为最细单位，可按turn汇总，模式有Total/Delta、总览带和DNA顺序。hover临时预览、离开恢复用户选择；pin固定请求明细；选中工具或文件跳到对应结果。历史被压缩移除的内容可从原件恢复重建，若缺失或只能近似则每个相关点都有approx标记，不能只在页面底部写统一免责声明。图表所有颜色还有标签/纹理，读屏有表格替代。

组成浏览器可搜索system、tools、user、injections、assistant、tool results和skill，各类显示数量/token/前一turn差值。助手支持thinking/tools/answer过滤；工具结果显示调用名/参数/成功错误/全文及Raw/Markdown。工具来源归因采用注册owner证据，其次包/已知MCP映射，最后unknown；不能根据名字以dsh开头就断定官方。按需请求内容有权限检查与结果字节上限，首页聚合不传所有prompt。

事件包括inject、compact、restore、prune、model switch、mode switch、role policy change、attachment extraction、recall inclusion和adapter降级。每条有session/turn/step/request、时间、来源、token delta、evidence和operation id。prune可能是模型可见视图变化，不表示物理删原件；UI要区分。重复事件按源seq/type/id去重，发生顺序来自宿主seq，不凭系统时间排序打乱。

文件活动归一read/write/edit/search/image和嵌套PTC/Minimal工具。每条operation记录真实工具call id和结果source；增删行是从可验证diff得出或标估计，不能把一次write字符数当行数。搜索命中应落实际文件行并保留命中数；未知格式只显示search operation，不编造文件。点击文件结果走统一文件服务和权限；观测不赋予恢复工作区的能力。

时长有墙钟活跃、请求耗时、TTFT、生成、解码类别、工具运行和未归因开销。并发工具耗时总和可大于墙钟，UI分别显示并注明；不能强行相加做100%饼图。计算跨度若有缺失事件则标部分观测。零剩余开销是真零也保留，避免掩盖对齐问题。后台暂停/用户等待/审批等待按产品定义分别计量，定义随methodVersion记录。

Fleet同时展示当前agent、祖先、子代理/兄弟、普通subagent和team成员。卡片含状态、persona/provider/model、上下文、request/step、运行时长、reported token和估算成本。父子血缘取宿主记录，成员名和任务归属取team投影，不能以标题猜测。悬停高亮整条来源链，点击跳到会话上下文，窄pane折成列表。team task board包含状态、owner、依赖和delegation，通信面板只展示已观测relay/mailbox，完整prompt/reply懒加载。缺实验投影时由集中adapter从真实事件重建可证部分；状态unknown不能画成“完成”。

跨会话洞察按request发生日期分桶，不以session最后活跃日分配全部token。筛选有7天/30天/all、自定义日期、workspace、provider/model、标题/项目搜索；每日token/成本图、8周活动热图、组成总览和session卡一起响应筛选。历史关闭的session也纳入授权范围，archived与删除不是同一概念。Family总计默认去重request id，父子共享历史不能重复当本期费用。

## 12. 搜索网关与故障切换

保留Keenable、Exa、Tavily三个适配器，配置只保存credential ref。至少一个有效provider即可使用；无配置时工具保持可发现的unconfigured状态并指向设置，不能挂载时抛错拖垮整包。原生工具和MCP共用同一个服务与调度状态，结果统一为title/url/snippet/publishedAt/provider/fetchedAt/citationId，缺字段保持缺失，不默认当前时间冒充发表日期。

search参数query非空、最大4096字符；maxResults整数1–20默认8；timeRange为day/week/month/year或缺省；可选providerPolicy为balanced/preferred/all，默认balanced。fetch接受http/https URL、maxChars整数1–50000默认30000、live默认false。公开schema写明enum/range/type，执行端仍校验，非法参数返回结构错误，不能把NaN、字符串或负数clamp成看似成功。provider API的时间筛选精度不同，response明确requested/applied/exact或approximate。

轮转指针在一次请求获得调度slot时原子递增；并发请求分到不同起点，失败不会让后来的请求全挤第一个源。每provider独立health、concurrency、rate budget和circuit；成功空结果是合法结果，不默认跨三源额外花钱，除非用户选择all或configured empty fallback。失败可在下一健康源继续，但取消、权限拒绝、预算耗尽、输入非法立即停止。401禁用该credential短期重试并显示需要配置；429按Retry-After冷却；5xx/timeout/连接错误有限切换。

单请求默认全局deadline45秒，单provider尝试最多15秒，不能三源各30秒累加无限等待；可配置但必须有上限。每个逻辑请求最多尝试每源一次，all模式并发受预算限制；不自动在搜索成功后再全文抓全部结果。总费用上界和外发查询可见，命中本地短时cache时标cacheSource/age；live抓取明确绕过索引缓存但仍受安全/预算限制。

取消信号贯穿DNS、连接、正文、解析和provider循环；收到后不访问下一源。所有失败返回`CTX-SEARCH-ALL-FAILED`和每源规范化code，不拼接上游raw body/secret。部分成功给partial与失败摘要，引用id稳定到该result artifact。HTML/Markdown是外部不可信内容，渲染清理脚本和危险URL，模型接收时以资料边界包含，不把网页文字当本插件指令。

安全URL规则覆盖直接fetch和把URL交第三方抓取的场景：拒绝userinfo、非http(s)、无效编码、控制字符、localhost/回环/链路本地/私有/组播/元数据地址；DNS解析所有A/AAAA筛选并固定连接地址；每次redirect重新验证，默认最多3跳；禁止跨源携带认证头。第三方provider代抓无法证明最终网络落点时仍不允许传私网URL，结果记录provider-mediated。正文按压缩与解压字节各有限额，防zip bomb；maxChars是输出展示限制，不代替网络字节限制。

## 13. UsageLedger与账户网关

用量来自provider reported或host normalized usage，估算另表保存。归一器按供应商明确prompt/cache语义拆成互斥的 `uncachedInputTokens`、`cacheReadTokens`、`cacheWriteTokens`，总prompt等于三者之和；`outputTokens`已包括reasoning，reasoning细分不再加一次。保留raw字段引用和semanticsVersion。若原始prompt已经包含cache，先减拆而不是再加；如果字段不确定，标ambiguous并不计算虚假精确总数；missing为null且与invalid分开。07章定义最终cache读/写、命中率、成本和收益；本章 `UsageRecord` 是对账本事件的投影，所有图表使用07章selector。

流式usage与final用logicalCallId+attemptId归并，final替代interim并修正桶。intentRequestId是业务幂等键，providerRequestId是供应商标识，不作同一call主键。同意图并行摘要/审核/reflect各有logicalCallId；不同attempt分别计费，不能按turn:step覆盖。旧日志用source seq与明确证据重建，歧义记录限制。重复投递/重连/持久-live切换不双算。

每session增量fold保存cursor、opaque revision、解析版本、最后样本和日/provider/model聚合。追加只处理新事件；seq gap、重写、截短、source模式切换或normalizer版本变更重折叠该session。聚合single-flight与原子保存处于同一临界区；跨进程采用事务/CAS，不能靠“最后写入获胜”。缓存只存统计和不透明引用，不存prompt/回复/明文路径/凭据；损坏缓存可从真源重建，并给出rebuilding状态，不显示零冒充真实无用量。

成本由实际usage乘有版本/时间/币种/供应商/模型的价格表，区分estimated cost与reported charge。支持时段/阶梯价格，但规则来自配置/官方信息，不用本地时区推断供应商峰谷；没有价格显示unknown。币种不直接相加，汇率有source/时间，默认分币种。账户余额、计划额度和估计成本并列，不能以余额变化估算每个会话账单。取消/失败请求若有reported usage仍保留。

账户保留13适配器：deepseek-balance、openrouter-balance、moonshot-balance、zai-balance、new-api、sub2api、sub2api-auth、general、opencode-go、zai-token-plan、kimi-token-plan、minimax-token-plan、declarative。每个adapter声明mode、区域、endpoint、credential role、response schema、单位和freshness。OpenRouter使用独立Management Key，不拿推理Key试探账户；New API先token usage与实例quota单位，仅在404/405且明确配置管理PAT时走管理fallback；Sub2API公共指纹检测只对已配置provider、限频、可关闭、显式adapter优先；OpenCode本地auth复用是显式可选来源，不在研究/开发时读取真实文件。

Token Plan按session/5hour/weekly/其它命名窗口分别显示remaining ratio、used/total（若有）、reset time及数据来源。缺total不能换算token；过期窗口不自行置100%，下一次成功响应才刷新。Z.ai/MiniMax区域可配置并显示真实目标域名。余额阈值按金额绝对值，计划阈值按ratio，默认warning30%/critical10%可改；负余额可表示欠费，adapter按协议允许而不是通用clamp0。

后台启动刷新后默认每5分钟更新configured账户，面板打开与否不影响；每provider single-flight，失败指数退避带jitter并尊重Retry-After。手动刷新更新usage/provider列表并强刷当前provider，不批量强刷其它账户。UI快速切provider时用operation token丢弃晚到旧响应，不让A账户余额出现在B卡片。快照带fetchedAt/expiresAt，失败后可展示旧值但明确stale和错误，不能用旧余额画成刚刷新。

declarative只允许受限GET+JSON Pointer；不执行JS、模板表达式或用户shell。配置验证path必须同源相对路径、禁止userinfo/credential query；header认证来自credential ref，普通header有白名单与长度限制；提取字段限制pointer深度/数组大小、数值有限和单位声明。所有monitor在路由/timer启动前验证，非法一个monitor只隔离该项并给出错误，不抹掉其它用户配置。

## 14. 凭据、网络与数据边界

凭据只由宿主credential service在服务端解析；配置、HTTP响应、浏览器store、导出、日志、错误和cache均不得含真实Key/Cookie/PAT。UI仅显示引用名、用途和configured状态。外部模型、自定义搜索、账户、decision/dossier/OCR共用凭据治理；从ThoughtDAG迁入的浏览器localStorage key必须迁移到服务端引用并清理旧副本，清理可验证但不打印值。

账户端点默认HTTPS、固定provider origin、手动redirect、1MiB解码响应上限、有限时间；发凭据前校验DNS并pin连接。私网、回环、特殊地址默认拒绝，自托管用户可明确授权某origin和网络范围，权限写入配置而非通用开关；fake-IP仅在已验证HTTPS域名+已知本地代理能力下受限支持，不允许字面198.18地址任意绕过。账户API不会向重定向的新origin转发认证。

插件HTTP/RPC优先沿用宿主认证/CSRF/来源校验。若精确路由绕过宿主统一边界，adapter必须自行检查peer socket回环、规范化IPv4-mapped IPv6、Host/Origin和session token；只检查Host不能防伪造。读端点GET，写端点POST/PATCH带CSRF；GET不能触发fork、保存、批准或付费调用。CORS不使用`*`带凭据。iframe消息校验origin、source window、view nonce、message schema，拒绝任意navigate/exec命令。

历史来源和vault读取以授权source id及相对handle定位，做规范化/realpath边界检查和symlink策略。任何路径逃逸、NUL、ADS、设备路径和超长路径返回安全错误，不把宿主文件系统原样暴露给浏览器。日志只存id/状态/数值/错误code，debug正文需显式临时诊断授权并自动过期；诊断包生成前脱敏和预览。分享默认本地导出，URL发布需用户发起并显示包含内容。

## 15. 事务、并发、取消、幂等与迁移

所有写请求带idempotencyKey和expectedRevision。相同key+相同payload返回原operation/结果，不能再fork、再收费或再建节点；相同key不同payload返回`CTX-IDEMPOTENCY-CONFLICT`。关键操作服务端保留结果到可配置期限，终端重试用原key。只读查询按snapshot一致性返回，分页cursor绑定revision，过期cursor明确重取。

Graph和layout分revision，布局高频保存不冲突语义编辑；语义修改用CAS，冲突返回当前revision和可重试补丁，不默默最后写覆盖。模型作业冻结source revision；晚到结果若源变了保存为orphan result候选而不覆盖当前节点，用户可接入新版本。单节点生成默认一个active operation，另起调用为明确比较分支；不同节点可并发但受上游依赖和预算约束。

operation取消是幂等状态转换。queued取消不启动；running发abort；summarizing取消保留已持久原件但不commit；committing进入不可中断短事务后给出最终成功或已取消后未应用，不能一半应用。已成功再取消返回already-completed及结果，不删除结果。所有回调检查operation epoch和目标revision，防重启/重放晚到写入。

预算先reserve再执行再reconcile。每次模型、搜索、decision、dossier、OCR、replay和压缩都可归属operation与logical request，统一看实际attempt费用；没有实时价格按token上限预留并标未知money，不以零费用绕过。触发预算上限后停止新调用，允许已付费流完成或取消；是否保留部分成果有一致规则。用户选择full recall/replay/外部bridge前显示预计量与硬上限，费用结果可追溯，具体缓存优化依07章。

旧数据导入识别Synapse v1-v4、ThoughtDAG完整JSON/IndexedDB导出、session logs和usage aggregate。先生成迁移报告和新namespace副本，完整校验成功再切换active pointer；不直接改旧目录。未知/损坏记录单独隔离，数量/原因可见。保留source snapshot与回滚入口，迁移重复执行幂等；引用重写有映射表，不能复用旧id造成跨图冲突。导出包有manifest、schema、内容hash与原件清单，导入拒绝路径穿越、压缩炸弹和不认识的执行字段。

持久主数据建议事务数据库或等价带journal/CAS存储，JSON文件可作交换/备份，不能把浏览器IndexedDB作为所有桌面数据唯一真源。画布切换不重载丢失正在运行作业；刷新后从operation列表恢复状态。自动folder backup保留版本和有限容量，备份失败可见，不阻断已提交主数据；删除策略先检查被compression block、ContextPlan和export引用的artifact，再做可恢复清理。

## 16. UI与可访问性细则

工作台使用宿主字体/主题token，统一留白、圆角、状态色和图例。中央地图和右侧检查器可折叠；上下文tab、侧栏和模态是同一view model的不同尺寸，避免三份独立请求。布局按pane容器宽度响应，不按整屏假定，窄pane把卡片改纵列，所有字段可到达，不以小字号硬挤。桌面标题栏安全区、最小390px pane、中英文长标签、浅/深主题均验收。

地图保留原界面的无限画布、漂亮的卡片、颜色连线和semantic zoom，细化层级/阴影/边框与一致动效；颜色同时有线型/图标/文字，motion遵守reduced-motion。卡片读屏顺序遵拓扑或列表替代；键盘可选节点、沿父子移动、打开panel、断线、预览和发送。拖拽有键盘替代；危险操作有清楚范围与undo，不凭悬停提供唯一入口。

主视图分总览/地图/上下文/历史/用量与账户/诊断，具体导航服从全插件UI章节。用户在图上选节点时，右侧默认“将发送”的紧凑列表，费用与窗口指标可展开；实现细节如adapter内部hook、fold cursor放诊断，不在普通提问流中占据界面。unknown、loading、empty、stale、partial、blocked、failed每个都有对应文案，不能用同一个空白卡代替。

图表可以切表格，hover内容可键盘focus并pin；长内容虚拟列表且保留搜索结果/展开状态。渲染大图使用视口裁剪和增量布局，不能因为2000节点就冻结输入。页面常驻只订阅摘要，原prompt/完整reply/附件按需取；不会为了展示Fleet每5秒全量读全部日志。具体性能阈值是验收门槛而非作者宣传：合成5000节点地图首个可交互状态应在3秒内，1000节点常规拖拽保持可操作；未达到要报告硬件与trace并优化，不能删减功能掩盖。

## 17. 工具与API契约

以下是新插件稳定工具面，全部归属 `nexus` 命名空间，表中是逻辑短名；最终模型工具名的分隔符/扁平化按平台章节统一映射并记录，禁止各模块自行发明名称。注册时使用平台章节确定的工具schema格式；所有object禁止额外字段，数组有maxItems，字符串有maxLength，数字有限。工具结果统一`{ok, operationId, data?, error?, provenance, truncated, nextCursor?}`。参数可选不等于业务可缺，依赖校验在服务端执行。只读工具可并发，变更工具按session/graph锁串行。MCP只投影授权工具并共享预算，不另建一套凭据。

| 工具 | 输入schema核心（均为object） | 输出核心/语义 |
|---|---|---|
| `context_status` | sessionId? string；planId? string；detail enum summary/full默认summary | 占用/窗口/来源/当前controller/可压缩范围；不读未授权其它session |
| `context_preview` | graphId string；targetNodeId string；expectedRevision string；modelId?；excludedItemIds? string[]≤1000 | frozen ContextPlan id、items概要、estimated budget、hash和过期时间 |
| `context_compress` | sessionId string；content array1–32 of `{startRef,endRef,summary?,topic?}`；expectedRevision string；intent?≤2048；idempotencyKey string | 支持m-ref/b-ref，保留模型自选范围与模型直接写summary的通道；省略summary时创建同一内核驱动的model proposal作业。校验后block ids/层级/回收估算/actual usage；被拒绝范围不偷偷改压别处 |
| `context_restore` | sessionId string；blockId? string；messageRange? `{firstMessageId,lastMessageId}`；imageRef? string；full bool默认false；destination enum artifact/inline默认artifact；lifetime enum temporary/persistent默认temporary；expectedRevision string；idempotencyKey string | blockId/range/imageRef按约束选择且不冲突；默认上一层，full递归原文，支持精确范围/原图。返回受控handle、真正注入范围和计划revision；当前inline不支持时提供等价artifact路径 |
| `context_search` | sessionId string；query string1–4096；scope enum visible/summaries/original/all；limit整数1–50默认10；cursor? | hit source/preview/原文或摘要标签/score方法；只读父链限定授权与深度 |
| `context_cache` | sessionId?；requestId?；detail enum summary/requests | 07章定义的reported cache与估算经济性，不改变请求 |
| `history_check` | artifact string1–4096；projectId? | hasHistory/count/freshness/source list摘要 |
| `history_file` | artifact string；includeRead bool默认false；limit整数1–100默认10；cursor? | observed touches与candidate explanations分列，来源可打开 |
| `history_find` | phrase string1–4096；in enum question/answer/material/all；mode enum exact/semantic默认exact；projectId?；limit1–100；cursor? | 原文片段、source、匹配模式、index revision |
| `history_recall` | sourceId string；sessionId string；turnId string；maxTokens整数256–32000默认8000；cursor? | 完整范围/分页正文、工具diff、provenance、truncated |
| `web_search` | query string1–4096；maxResults整数1–20默认8；timeRange enum day/week/month/year可选；providerPolicy enum balanced/preferred/all默认balanced | 结果、provider attempts/normalized errors、citation ids、费用状态 |
| `web_fetch` | url string≤8192；maxChars整数1–50000默认30000；live bool默认false | snapshot artifact、clean markdown、final URL、hash、截断/抓取来源 |
| `graph_branch` | graphId/nodeId/expectedRevision/idempotencyKey string；selection? range绑定version；question string1–65536 | 新节点/edge/operation，不自动执行模型除非explicit run=true |
| `graph_transform` | graphId string；kind enum condense/merge/weave；nodeIds string[]1–200；highlightIds?≤1000；intent?≤4096；expectedRevision/idempotencyKey；archiveSources bool默认false | operation、预估与结果node、引用映射、取消状态 |
| `session_branch` | sessionId string；turnId string；expectedSourceRevision string；idempotencyKey string；select bool默认true | 宿主新session/lineage，不改源 |
| `session_continue` | sessionId string；contextPlanId string；text string或blocks结构；mode enum user-followup/plugin-inject；idempotencyKey string | operation/turn id；审批与停止走宿主 |
| `usage_query` | range `{from,to,timeZone}`；groupBy array subset day/provider/model/session/request；filters?；cursor? | reported buckets、estimated cost、quality与来源 |
| `account_status` | providerId string；refresh bool默认false | 统一AccountSnapshot，不含凭据/raw上游body |

压缩引用的 `startRef/endRef` 为当前session及其已授权只读父链内的稳定m-ref或b-ref，最大128字符，先解析成一组连续、同revision且未被工具保护拆开的原子单元；允许跨块层级的合法内核范围，但不得按字符串字典序猜区间。`summary` 每项的字符/token上限使用锁定模型配置并在工具描述中公布，单项超限则整个原子compress调用失败而不部分fold；`topic` 上限256字符。模型直接提供summary与协调器申请模型proposal均保留其作者request id，执行端不假定summary可信或完整，必须做来源、保护、非空和收益校验。

恢复有三类合法选择：`blockId`可独立或与其内部 `messageRange` 配合；没有blockId的messageRange由ref索引唯一定位覆盖关系；`imageRef`必须独立且定位已存原始字节。block范围外、倒置范围、跨不同session而无合法父链、imageRef与其它选择混用均返回参数/来源错误。`full`只影响递归深度，不扩大明确messageRange；artifact destination不修改旧prefix，inline追加服从本次计划预算。状态查询、检索、file恢复读取已提交快照；persistent/inline可见性变更才获取session writer lease，不让长检索阻塞正常聊天。旧 `decompress({toFile})` 的适配保留文件恢复价值，但不把任意路径参数透传为文件写权限。

HTTP/RPC围绕同一服务，统一前缀`/api/nexus/context`、`/api/nexus/graph`、`/api/nexus/history`、`/api/nexus/usage`、`/api/nexus/accounts`、`/api/nexus/operations`。GET只读，POST创建operation，PATCH带If-Match修改，DELETE仅本插件数据且有引用校验。原`balanced_search/balanced_fetch`、`why_*`、`compress/decompress/search_context/acp_status/acp_cache`、`/context`、`/why`、`/acp`、`/acp-cache`和旧usage只读端点在兼容期映射；模型doctrine中的工具引用与实际注册名同步改写，避免模型被提示调用不存在的名称。冲突名由设置展示owner并允许关闭别名，不能覆盖现有其它插件工具。

流式operation事件`{operationId,seq,type,payload}`，type包括queued/progress/token/usage/approval/source-change/complete/error/cancelled；seq单调，客户端Last-Event-ID重连去重。服务器在`complete/error/cancelled`之一终结且只一次，终结后晚到usage可补充到账务事件但不再改答案正文。SSE心跳不当模型token，断流不是完成；轮询operation是等价恢复路径。

## 18. 错误模型与恢复

| code | 触发 | 对使用者行为 | 自动恢复 |
|---|---|---|---|
| CTX-CAPABILITY-MISSING | 当前adapter缺正式/兼容能力 | 显示具体功能和适配状态，保留数据 | 允许切可用连接/重新探测；最终交付前须恢复 |
| CTX-ADAPTER-CONFLICT | hook/压缩owner冲突 | 阻止双重接管，给出owner与诊断 | 安全释放/重试，不覆盖别人wrapper |
| CTX-GRAPH-CYCLE | 新边使上下文环 | 高亮路径，图保持原状 | 不自动删边 |
| CTX-SOURCE-CHANGED / CTX-PLAN-STALE | 源revision变化 | 重新预览/选择旧快照 | 无费用阶段可自动重建一次 |
| CTX-REVISION-CONFLICT | 并发图编辑 | 保留本地patch，显示冲突 | 可重放不冲突patch |
| CTX-TURN-OPEN | fork锚点未结束 | 等待完成或选已完成turn | 可观察终结后重试 |
| CTX-ORIGINAL-MISSING / CTX-HASH-MISMATCH | 恢复原件缺失/不符 | 禁止伪恢复，显示受影响块 | 从备份找回并验证 |
| CTX-COMPRESSION-INVALID | summary空/无效/保护区破坏 | 保持原文，显示失败原因 | 有限重试，费用照记 |
| CTX-BUDGET-EXCEEDED | token/费用/调用数超限 | 停新调用，保留已有结果 | 用户调整预算后继续 |
| CTX-SEARCH-ALL-FAILED | 合格provider全败 | 展示安全错误摘要 | 按retryable/Retry-After重试 |
| CTX-URL-BLOCKED / CTX-CREDENTIAL-ROLE | 不安全URL/错误用途凭据 | 不发请求，指向配置 | 不自动放宽网络或凭据权限 |
| CTX-HISTORY-FORMAT / CTX-IMPORT-LIMIT | 格式未知/资源超限 | 原件保留，报告受影响source | 升级解析器或分批导入 |
| CTX-APPROVAL-EXPIRED | 宿主审批已结束/不匹配 | 保留真实结果，不批准 | 用户重新发起操作 |
| CTX-CANCELLED | 明确取消 | 显示部分输出与已发生用量 | 同key不自动重跑 |
| CTX-IDEMPOTENCY-CONFLICT | 同key不同payload | 返回原操作摘要 | 新意图使用新key |

错误message面向用户解释可采取动作；detailRef只给脱敏trace。不得把上游HTML错误页、Authorization、cookie、全URL query、prompt或本地绝对私人路径原样拼进message。可恢复和终端错误分清，不能为了UI绿色状态把failed改成empty-success。

## 19. 验收矩阵与交付门槛

所有测试使用合成会话、演示账务和mock凭据，真实验证需要专用测试账户并由用户选择；不读取当前私人历史/密钥。上游已有测试可直接复用并补adapter契约。每个验收项有fixture、预期产物、命令/自动结果和适用宿主版本；“文档宣称支持”不等于通过。下表是最低完整集，ID必须进入实现追踪。

| ID | 场景/输入 | 必须观察到的结果 |
|---|---|---|
| CTX-HOST-001 | 最新desktop挂载/停用/重挂10次 | 工具、路由、timer、slot只注册一份，无遗留wrapper/监听 |
| CTX-HOST-002 | 公开API缺模型middleware，启用兼容fetch adapter | 只改注册模型端点；账户/搜索/普通fetch字节不变；卸载恢复 |
| CTX-HOST-003 | 别的插件先后包装fetch | 检测owner，协调恢复，不覆盖别人；无重复代理 |
| CTX-HOST-004 | preset内与顶层原生compaction同时存在 | 接管后仅协调器一套；停用/失败后安全移交宿主 |
| CTX-HOST-005 | 旧Synapse/ThoughtDAG入口和实验team接口 | 在最新desktop完整恢复地图/审批/任务通信；不能以hidden结束 |
| CTX-GRF-001 | A→B→C再接C→A，自环及reference-full环 | 原子拒绝，返回循环路径，revision不变 |
| CTX-GRF-002 | 菱形A→B/C→D，拖动/重排创建边 | A仅一次，用户order稳定，坐标不变语义hash |
| CTX-GRF-003 | 断开分支再重新连接 | 下次plan排除/重含，节点和原答案保留 |
| CTX-GRF-004 | 布局、四层semantic zoom、frames、键盘导航 | 只变展示，发送payload/hash不变；同链箭头顺序正确 |
| CTX-GRF-005 | 多画布CRUD/归档/隐藏会话/重扫描 | 状态持久，不意外复活隐藏；原DSH日志hash不变 |
| CTX-PLAN-001 | 打开预览后修改上游答案，再发送 | 拒绝旧plan并展示新差异，无静默换输入 |
| CTX-PLAN-002 | system/tools/skills/material/recall/附件混合 | 每项source与顺序和实际wire一致，unknown/estimated可见 |
| CTX-PLAN-003 | 两条路径同附件、目标exclude再include | dedup和本次例外正确，不影响其它graph |
| CTX-PLAN-004 | persona complete或宿主拒绝prefix | 显示未生效，不能虚报注入；历史版本可追 |
| CTX-STALE-001 | 上游变更后多支路重放、一个失败 | 旧版本保留，依赖顺序正确，下游停止/独立继续依策略 |
| CTX-STALE-002 | reviewer双向watch和自动重评 | 达maxIterations/calls/cost即停，无无限循环 |
| CTX-XFM-001 | Condense无分叉段含decision/pivot，摘要失败/取消 | 原件不变；成功生成副本/映射；失败不半替换 |
| CTX-XFM-002 | Merge & delete并发源编辑 | 不归档已变源；成功归档可undo，宿主日志不删 |
| CTX-XFM-003 | Weave选三条高光、制造无效引用 | 每引文定位正确，无效引用标错；无高光不改做全量merge |
| CTX-MAT-001 | PDF页/图片区域/DOCX/HTML/代码/链接 | 原件/提取版本/页码可跳，文本编辑不覆盖原件 |
| CTX-CMP-001 | 压缩后整块/子范围/原图恢复，递归T1-T3 | 恢复hash等于原件，full=false与full=true语义正确；inline不可用时artifact恢复仍完整通过 |
| CTX-CMP-002 | commit前断电、commit后断电、重复执行同key | 原文或完整提交二选一；无丢失、重复块、id复用 |
| CTX-CMP-003 | 同session并发两次compress+restore | 单writer串行或revision冲突，块树一致 |
| CTX-CMP-004 | tool-call/result、含内部标签的arguments、签名thinking | 参数/签名字节完全一致，工具对不拆 |
| CTX-CMP-005 | pluginMode/proxyMode及严格单system上游 | summary只承载一次、角色正确，前缀稳定性依07章通过 |
| CTX-CMP-006 | CCR/absorb/图像缩小/原图恢复 | 原件可取、transform可观测，费用/缓存分类正确 |
| CTX-CMP-007 | model/provider/key切换、resume、子session父链 | identity稳定，隔离其它会话，父块只读且循环深度受限 |
| CTX-CMP-008 | 不支持签名协议、网络body上限/解码炸弹 | 明确错误/安全策略，无body破坏或假压缩成功 |
| CTX-CMP-009 | 有nudge时模型拒绝/延后，无nudge时模型主动compress | 拒绝保留原文且记declined/deferred；主动调用经同内核正常执行；没有后台固定摘要替代 |
| CTX-CMP-010 | 30轮新增与多次T1/T2/T3晋级 | 只折叠选中增量/层级边界，旧块稳定，effective/direct血缘完整；不每轮重写全史 |
| CTX-CMP-011 | doctrine/nudge生成、候选大小与保护项 | 真实/估算标签正确；候选可定位；保留意图/约束/未决目标/精确值；提示修改有版本/作用域 |
| CTX-CMP-012 | 先search定位再恢复一个块及file-first完整解压 | search离线可用，refs有效，只取目标；原prefix不变，toFile不越界，inline预算真实可见 |
| CTX-CMP-013 | cache planner建议延后，模型坚持合法fold，宿主原生compactor同时触发 | 同一协调器仲裁且有记录，budget/硬保护仍有效；不出现两个摘要器或两次收费归并丢失 |
| CTX-CMP-014 | 相邻wire请求、fold、高层蒸馏、恢复/切provider、稳定prefix miss | foldEvent与usage attempt可追，最早差异正确，实际命中不冒充估算；残余不归咎TTL |
| CTX-CMP-015 | 同一合成长期任务对照原版锁定kernel与Nexus适配层 | 功能/保护/恢复一致，差异有解释，质量探针/重读/成本/缓存四组分别记录，不用单一压缩率宣称优胜 |
| CTX-ATL-001 | 四agent合成历史+DSH多帧zstd+部分尾行 | 全完整turn解析，部分记录等待，损坏位置报告 |
| CTX-ATL-002 | log append/rewrite/truncate、同标题不同项目 | 增量与重建正确，不按标题合并，不覆盖编辑镜像 |
| CTX-ATL-003 | 来源关闭/清索引/自定义root逃逸 | 停读取，授权边界生效，已挂载副本状态清楚 |
| CTX-WHY-001 | read/edit/diff与回答解释不一致 | observed与candidate分列，每命中可跳真源 |
| CTX-WHY-002 | check/find四scope/recall分页/跨project | schema/权限/精确匹配与截断标记正确，无越界历史 |
| CTX-REC-001 | amount三档×reach三档，全量费用超限 | 候选深度与最终预算独立，超限不偷偷执行 |
| CTX-REC-002 | decision超时/无效JSON/熔断、关闭 | 规则回退，主流不阻塞，所有实际调用记账 |
| CTX-REC-003 | dossier逐行引用、用户编辑、重建/undo | 引用存在，冲突保留，记忆由统一服务治理 |
| CTX-SES-001 | 运行turn fork与完成turn fork | 前者409/专用code，后者新session正确cut，父日志hash不变 |
| CTX-SES-002 | 原生聊天和画布同时请求同session | 宿主queue/steer语义正确，事件不串turn，历史不重复注入 |
| CTX-SES-003 | 审批错session/过期/重复/流关闭 | 不误批准，幂等与清理正确，宿主仍可见 |
| CTX-OBS-001 | 官方ring与所有上下文入口 | 同snapshot数值一致，无独立误差；fallback明确estimated |
| CTX-OBS-002 | 被压缩旧步骤、全内容/Raw-MD、技能/tool owner | 近似逐点标注，源可追，unknown不伪官方 |
| CTX-OBS-003 | PTC嵌套、Minimal editor、搜索多文件 | 文件归因/命中/行估算正确，点击到对应tool result |
| CTX-OBS-004 | 并行工具/缺失时长/零residual | 墙钟和累计分开，缺失/零如实显示 |
| CTX-FLT-001 | 普通subagent+team+relay+mailbox+父链 | 血缘/成员/通信分型，合计去重，详情懒加载 |
| CTX-SRC-001 | 三源并发轮转，一源失败/429/401 | 公平起点、分类切换、冷却正确，无重试风暴 |
| CTX-SRC-002 | 取消第一源、全局45秒、全源失败 | 取消不访问后源，deadline有界，结构错误无secret |
| CTX-SRC-003 | 私网URL/DNS rebinding/redirect/压缩炸弹 | 发送前阻止、逐跳复验、字节上限，认证不跨源 |
| CTX-SRC-004 | timeRange差异、空结果、live/cache fetch | 精度/来源可见，空结果不无故三次付费 |
| CTX-USG-001 | 同request interim→final、重复、不同attempt同step | 同attempt替换，不同已计费attempt都保留，raw对拍相等 |
| CTX-USG-002 | 含cache的prompt与不含cache的标准usage | 无双算，semanticsVersion/unknown正确，07指标一致 |
| CTX-USG-003 | seq gap/rewrite/live-persisted切换/并发聚合 | 重折叠一致，single-flight/CAS不丢桶 |
| CTX-USG-004 | 时区跨日、未来事件、同model不同provider | 日期归属正确，provider不混，未来按规则隔离 |
| CTX-ACC-001 | 13adapter合成成功/失败/未知形状/区域fixture | balance/window/币种/状态真实，缺字段不猜 |
| CTX-ACC-002 | OpenRouter无管理key、NewAPI fallback、Sub2API探测 | 凭据角色正确，仅许可条件回退，显式adapter优先 |
| CTX-ACC-003 | 快切provider/后台timer/手动当前刷新/429 | 晚到不串账户，单飞/限频正确，stale时间清楚 |
| CTX-SEC-001 | 对所有HTTP/MCP/导出/日志注入fake secrets | 不进入浏览器/日志/cache；边界路由防CSRF/Host伪造 |
| CTX-SEC-002 | path traversal/symlink/ADS/未知root/恶意import | 拒绝且无越界访问，原数据保持 |
| CTX-DAT-001 | 旧Synapse/ThoughtDAG迁移、重复/中断/损坏 | 新副本校验、幂等、可回滚、原目录不改 |
| CTX-DAT-002 | JSON/MD/CSV/结构图/海报/URL分享/folder备份 | 格式完整、hash可验、分享前审阅、恢复不丢附件 |
| CTX-UI-001 | 390/768/1440 pane、中英文/深浅/reduced-motion | 无遮挡/横向溢出，键盘/读屏可完成主流程 |
| CTX-UI-002 | 5000节点/超长会话/打开Fleet/切tab | 达性能预算，按需读内容，切换不丢作业 |

完成此章不仅是画面出现。交付必须包括六项目逐功能到实现模块与验收ID的追踪表、采用源码/许可清单、最新desktop适配矩阵、合成fixture与测试报告、可恢复迁移工具、诊断包样例和数据口径说明。所有作者宣传数字保留为研究背景，不写进“已达到”的产品成绩；任何性能/费用改善声明由07章的可重复样本和本章实际调用账本支撑。
