# 会话缓存、可逆分层压缩与成本控制规格

文档状态：实施规格草案 v1.0；证据截止 2026-10-19。目标宿主为 DeepSeek Harness Desktop `0.2.1-rc.2`，官方源码固定在 `687f282e8625c6b8d11ff58211a90524be2e4317`；它是预发布版本。本文给出开发和验收合同，没有宣称已运行真实模型基准。官方资料、价格快照、论文边界和源码出处见 [08-cache-evidence.md](../research/08-cache-evidence.md)，宿主准入见 [01-host-evidence.md](../research/01-host-evidence.md)。

## 1. 产品目标与不可降级能力

用户要求同时保留经论文和现有产品实践支持的省 token 能力，以及长程开发可承受的缓存复用。本插件必须以 billion-context/acp-kernel 的**模型自治、增量、可逆、分层压缩**为主设计，允许直接复用原实现，再补适配、确定性、计量和界面。不得用每隔固定轮数生成一份简单摘要、永久截断旧消息、仅做向量检索或只冻结 system 来替代这条主线。将旧接口迁移到新宿主不构成删减这些功能的理由。

必须保留自治 `compress`、分块 `decompress`、精确历史搜索、消息引用、块谱系、T1/T2/T3 递归折叠、保护当前工作区、原始内容恢复、写文件恢复、压缩状态和成本归因。工具在统一入口下可换名字，但同等行为及信息量不得消失。主会话能在窗口有界的条件下长期继续；窗口控制既不能损坏用户目标，也不能靠无提示丢弃旧事实来“通过”。

优化目标按优先级为：任务正确完成与来源可恢复；协议和权限正确；避免上下文溢出；同等质量下实际总费用；交互延迟；输入 token 和缓存读比例。输入更少、缓存比例更高都只是中间指标。严禁添加无用长文本、重复工具描述、空白填充或保留废弃日志来美化命中率。也不应因为旧内容便宜而长期保留大量已消费输出，损害注意力、吞掉窗口并导致更大的未来折叠。

缓存相关“必须”分两类：插件能控制的序列确定性、信息守恒、账本幂等属于硬门禁；供应商实际缓存命中属于观测目标，必须呈现适用范围和不确定性。不得承诺99%、95%或永不掉缓存。供应商缓存构建、淘汰、隔离、调度、服务端模板都不是插件可完全控制的变量。

## 2. 术语、分母和证据等级

| 术语 | 精确定义 |
|---|---|
| 原始事件 | 宿主已接受的消息/工具输入输出及来源；插件不得为省token修改其权威记录 |
| 原始归档 | 插件在授权范围内保存、可按引用恢复的副本或内容地址对象；具有完整性哈希和访问边界 |
| 可见投影 | 本次实际送到模型的消息、工具声明和其他协议输入；与持久日志不是一回事 |
| 稳定前缀 | 同一路由、同一模型输入模板中，首次变化之前完全相同的模型输入部分；本地不能总看到最终token化，只能给证据及估计 |
| cache prefix unit | 供应商持久化的完整前缀单元；不是本插件 summary block，也不是任意相同子串 |
| cache read share | 已上报读缓存token / 已上报总prompt token；无分母或未上报时为null |
| 压缩偿还 | 压缩改变输入后，原本可读缓存的一部分需要以未命中/写入价格重新预热；不是额外向供应商索取的独立账单项 |
| 提示世代 | 一组已接受的静态指令、工具和记忆快照版本；用于解释变化和固定重放 |
| 模型调用 | 每个真实发送尝试；重试、标题、审查、压缩辅助调用均单独记账 |
| 任务费用 | 指定任务及其因果子调用在指定计费口径内的费用；继承的历史支出不重复计入 |

证据状态至少区分 `provider-reported`、`host-normalized`、`local-estimated`、`unobserved`。`provider-reported` 的 token 也不等于银行最终扣款；乘价格得到的是计算费用，只有与结算记录对账后才能叫已核对费用。本地指纹证明稳定不代表真实 cache hit，反过来 usage 有 read 也不证明插件投影完全没变。

论文里的累计输入含多次缓存重读；生产总量、单次上下文、原始新增、summary standing mass 和压缩移除量必须分别展示。禁止把18.76B累计token标成“单会话窗口18.76B”，禁止把压缩比当实际费用节省比。所有图的分子、分母、覆盖次数、未报告次数、时间范围和币种必须可展开查看。

## 3. 总体构成及唯一所有者

内部划分为 `PromptEpochRegistry`、`StableToolSurface`、`CompressionCoordinator`、`WireArtifactRecorder`、`ProviderCacheCapabilities`、`UsageLedger`、`TariffRegistry`、`CacheDiagnostics` 和 `BudgetController`。这些是实施职责名，不要求对用户暴露。一次模型请求经过唯一协调管线；各模块只能提交有类型的候选，不能独立改写全局 fetch、同时修改历史或再包一层未知代理。

`CompressionCoordinator` 是本插件的唯一压缩所有者，内部复用 acp-kernel。宿主自身自动压缩与本插件自主压缩不得同时对同一范围工作；但手动 `/compact` 仍需被识别、显示并纳入迁移。使用宿主正式 compaction/LLM seam 优先；若 rc.2 尚无足够公开接缝，则建立版本锁定适配器，限制所触达的内部服务，启动时探测。探测失败必须明确暂停受影响适配并保留用户原数据，不得悄悄继续双重压缩。

唯一传输边界负责拿到**最终将发送的**请求形状、attempt ID、取消信号和usage。记忆、工作流、lint、可视化、恢复等能力不得各自 patch fetch。旧项目里的 transport interception 可以复用其已验证协议逻辑，但须合并到这个边界，并为重复安装、热重载、dispose和宿主升级提供断言。观察链路不能因为诊断失败阻塞健康请求；权限校验、签名重放校验或预算拒绝属于发送前硬失败，应保守停止。

推荐执行顺序为：接收用户输入 → 确定会话/用途/路由身份 → 接受本轮静态世代 → 处理恢复和既有块同步 → 接受本轮动态事实 → 运行模型自治压缩候选和窗口检查 → 形成稳定投影 → 路由准备与协议翻译 → 最终权限/预算准入 → 固定wire artifact → 发送 → 流式内容/usage归并 → 结算 → 更新诊断。若宿主在路由准备后才决定 system/tool update 能力，必须将这项能力纳入投影再生成，不能只记录先前尚未实际发送的草稿。

## 4. 会话身份、用途隔离和请求归属

每个调用必须具有 `sessionId`、`conversationBranchId`、`turnId`、`stepId`、`requestId`、`logicalCallId`、`attemptId`、`requestPurpose` 和 `routeIdentity`。`requestId` 是09章的一次业务意图幂等键，兼容旧名 `intentRequestId`；`logicalCallId` 是该意图所产生的一次独立模型调用；`attemptId` 是该调用的一次实际发送尝试；供应商回传的外部标识单独保存为 `providerRequestId`。`attemptId`可以全局唯一生成，但用量和结算的规范主键仍为 `logicalCallId + attemptId`。网络重试同一次模型调用时沿用logicalCallId、产生新attemptId；相同provider尾包重发沿用原call+attempt并只修订usage。用户可理解的一次操作由 `operationId` 聚合，不能用requestId或operationId吞掉多个收费调用/尝试。

`requestPurpose` 是封闭枚举加受管扩展：`main`、`compression-inband`、`compression-auxiliary`、`title`、`review`、`memory-extraction`、`workflow-planning`、`lint-repair`、`background-index`、`diagnostic-canary`。主会话工具调用产生的压缩摘要若与普通主调用共用响应，应记录该调用的用途组成，禁止把同一次输入重复记到两个费用桶。另起请求才产生独立attempt。

`routeIdentity` 至少包含 provider实例ID、非秘密endpoint标识、模型请求名、已知解析版本、账号/租户的内部别名、region（如可知）、协议族和适配器版本。账号凭据、Authorization、Cookie、请求正文不得混入UI可见ID。切换模型、provider实例或可能改变缓存隔离的账号会生成routeEpoch，不沿用先前warm状态。模型别名解析不确定时标 `resolvedModelStatus:unknown`，不猜测底层缓存可复用。

同一个DSH session ID 可能发起标题和风险审查等不同system persona。它们须具有不同用途命名空间和prompt指纹；辅助请求不能抢占主会话的首次锚点、覆盖主会话compression state、继承其缓存诊断序列或无限扩大主会话权限。共享来源只按显式引用；使用同一供应商实际可能复用公共前缀，但这是额外收益，不是内部会话归属规则。

收费capture必须位于唯一模型传输边界，而不只监听公共 `nexus_*` 工具。一次业务request可产生main、title、review、memory-extraction等多个logicalCall，必须全部捕获；没有模型工具调用的宿主自动标题或后台压缩辅助请求也要计量。内部自动任务从已接受的宿主来源/作业意图派生稳定requestId与因果operation，不冒用providerRequestId。只读查询外层requestId可选不意味着收费调用无身份；实际发出前必须生成内部call+attempt。重放外层同requestId同digest只能返回既有receipt，不能重发子模型调用；`delivery-unknown`也不能以外层幂等重试为由自动再付费。

分支创建保留父来源引用及祖先摘要，但支出起点设在分支产生时。父历史既有费用显示为“继承历史”，本分支新增费用从零开始。父子usage重放不得再次增加账户总支出。恢复或导入日志的请求账本须有原始 `ledgerOriginId`；缺少可信原请求ID时按独立导入记录显示，不伪装成本次新收费。

## 5. 静态前缀、工具表面与按需能力目录

统一插件的功能很多，但模型不应每步接收全部后端的长工具schema。提供稳定、精简的顶层调度/发现表面，工具名、参数结构、字段顺序、描述和顺序在会话世代内冻结。能力目录通过按需查询返回；某次搜索只返回与本任务相关且受预算约束的可调用项、schema摘要和版本。全部原功能仍存在，缩小常驻表面不得等于删后端。

工具选择不能依赖无稳定排序的对象枚举、插件加载竞争、扫描完成先后或本地时间。注册表采用明确order加名称code-unit排序，schema生成器版本固定；`required`数组、枚举、描述和默认值同样稳定。Host `toolOrder` 规则必须遵守。动态启用模块不能每轮自动增删顶层工具；通过稳定调度器做后端能力授权与发现。在有实证支持新增工具可追加的路由上可以启用追加能力，但仍须单独记录toolSurfaceEpoch和wire变化，不将其推广到不支持的DeepSeek/兼容路由。

目录内容变化时增加 `catalogRevision`，不会自动改旧消息。模型请求某能力后得到的目录条目是本轮新tool result，保持原文本和来源。后续条目更新不回写历史目录。调度器调用包含 `capabilityId`、`capabilityVersion` 和类型化 `arguments`；模型拿过的旧条目失效时返回明确 `CAPABILITY_VERSION_RETIRED` 及最短迁移信息，不能静默用新schema解释旧参数。授权撤销要立即执行，不为缓存保留危险功能。

system 常驻内容只含稳定角色、压缩doctrine、必要安全规则、工具使用原则和短能力索引。长技能正文、语言lint规则、项目调研、最近错误、检索结果按需作为当前轮有来源消息追加。不得把“现在是X秒前”“已索引N文件”“运行时长”“剩余额度”或每次变的排序放在静态头。预算告警可通过当前轮最短动态消息表达。

过度精简也有成本：调度器需多次发现、工具嵌套增加输出、模型选错能力会重试。基准必须比较总调用次数、schema prompt、发现工具开销、任务成功和费用，不可仅展示常驻工具token下降。对稳定高频能力可提供短固定入口，前提是加入后全会话固定、经配对基准确实更好。

## 6. Prompt、工具和记忆世代合同

`promptEpoch` 表示已接受静态文本；`toolSurfaceEpoch` 表示顶层工具集合、schema和顺序；`memorySnapshotEpoch` 表示会话开始或明确刷新时接受的持久记忆快照。三者与routeEpoch组成 `promptPolicyEpoch`，并持久保存其内容哈希和渲染器版本。epoch是解释和重放依据，不是发送给模型的动态文本；不能为了每轮显示epoch数字去改system。

跨章节的边界名称统一如下。兼容字段只在导入或投影时映射，不能作为多个可独立推进的计数器；若两个同义字段同时出现而值不同，返回schema冲突。

| 规范字段 | 兼容名称 | 推进条件 |
|---|---|---|
| `toolSurfaceEpoch` | 02章 `toolsetEpoch`；早期草稿 `toolsEpoch` | 实际发给模型的顶层schema/hash/order改变；catalogRevision、发现、解锁、恢复均不单独推进 |
| `memorySnapshotEpoch` | 02章 `memoryEpoch` | 本会话接受新的固定MemorySnapshot；记忆仓库后台写入只推进 `memoryStoreRevision` |
| `memorySnapshotHash` | `snapshotHash` | 该快照实际接受字节的内容hash，非每次动态recall的hash |
| `compressionEpoch` | 投影层 `stateRevision` 的对外版本 | 接受一次fold、晋升、inline恢复或已验证迁移；toFile只读恢复不改旧投影 |
| `promptEpoch` | 无 | 接受的稳定system/persona/doctrine文本改变 |
| `serializationEpoch` | 适配器render版本 | 最终协议序列化规则改变，即使语义hash仍相同也要记录 |

06章所定义bootstrap六个逻辑核心和固定discovery/action拓扑在本章直接继承，不另增顶层工具数量。06章 `capabilityId/action/schemaDigest/arguments/idempotencyKey` 是领域合同，最终公共wire严格使用09章4.2/4.3：`idempotencyKey→requestId`、业务参数 `arguments→params`、定位ID进入target、capabilityId/schemaDigest存已解析catalog元数据；不能将两套包络同时注册成每轮不同的模型工具。映射须保存目录版本、已接受能力版本和原始参数以复现，不能丢弃版本校验。

公共包络规范化只在新调用进入接受边界前完成；已经进入会话历史的tool call/result不得为升级字段名而逐轮解析、重新排序或重渲染。requestId和traceId在同一意图的幂等重试/历史重放中保持既有值，新logicalCall/attempt的内部标识只写观测账本，除供应商明确要求的协议字段外不注入system、工具描述或旧消息。09章规定无变化摘要稳定且不附时钟/余额/banner，与本章稳定性合同一致。公共归一化语义正确不能单独证明cache preserved，仍须对最终模型wire做金样比较。

会话状态为 `stable` → `change-pending` → `committing` → `stable`。用户编辑persona、升级规则、开启模块等非紧急变化先产生pending候选，在下一安全轮次接受为新世代。若用户明确要求立即应用，应接受并说明可能重新预热，不另行阻塞。升级不能半轮改变system而仍声称旧epoch。正在发送的请求固定旧接受态，响应归属旧epoch；下一请求才可切换。

新世代实际如何进入模型由宿主路由能力决定。连续request series且支持 `systemPromptUpdate:in-history` 时，Host可把新system放在已有历史之后；否则可能重写首system并清空旧tail。新series、清空prompt或工具更新能力不足也可能触发规范化。插件记录Host的实际结果，不能仅凭“我用了动态provider”声称只追加。在不支持的路由上，一次必要修改导致前缀失效是可解释事件，应集中变化、避免重复抖动。

记忆提取只更新持久记忆仓库及未来snapshot epoch；当前会话已接受snapshot不自动改头。即时召回只在需要的当前轮追加一次，保存选择ID、排序、确切文本、来源hash、召回策略版本和截断边界；重试重放相同选择，不重新检索生成稍有变化的旧轮内容。用户明确刷新记忆时形成新snapshot并记录原因。错误记忆更正或敏感信息撤回可立即生效，保留审计原因；安全和事实纠错优先于缓存。

同一轮去重以内容和来源确定，不能仅比较相似度就丢掉新的冲突事实。预算是准入上限，不是目标填充量；只找到三条有用记忆就发三条，禁止为达到固定“4K上下文”追加无价值内容。检索排序的随机性须固定seed或保存已接受结果，不能在网络重试时再次随机。

## 7. 可逆分层压缩的数据模型

优先复用上游 `CompressionState/CompressionBlock`，通过有版本的适配层添加观测字段，保留原字段语义。最少逻辑模型如下；这是一份内部规范，具体持久schema可以规范化拆表。

```ts
type CompressionBlockRecord = {
  schemaVersion: 1;
  blockId: string;
  runId: string;
  sessionId: string;
  branchId: string;
  tier: 1 | 2 | 3;
  generation: "young" | "old";
  directMessageIds: readonly string[];
  effectiveMessageIds: readonly string[];
  directBlockIds: readonly string[];
  summaryText: string;
  summaryHash: string;
  summaryRevision: number;
  sourceObjectRefs: readonly string[];
  sourceIntegrityHash: string;
  active: boolean;
  expanded: boolean;
  restoredInline: boolean;
  stateRevision: number;
  renderAnchor: {
    kind: "existing-summary" | "direct-range" | "legacy-effective" | "before-current-user";
    messageRef: string | null;
    anchorProofHash: string;
  };
  doctrineVersion: string;
  rendererVersion: string;
  createdByLogicalCallId: string;
  createdByAttemptId: string;
  replacementReason: string | null;
};
```

`blockId` 在其生命周期稳定，summaryText默认不可变。`directMessageIds` 是本次实际直接折叠范围；`effectiveMessageIds` 是含祖先的完整逻辑覆盖；`directBlockIds` 指向本次蒸馏的子块。这三者不可互相替代。来源图必须无环，子内容存在且完整性可检验；T2/T3建立后子块变为非活跃但可寻址，不能删除来源。单块还原默认上一级，full模式追溯原始；来源缺失必须报精确损坏或归档状态，不生成臆测原文。

`createdAt` 等展示字段留在仓库，不在每轮模型摘要内动态渲染。summary的首次生成可带固定来源标记，后续不根据相对年龄、活跃次数或当前序号重写。显示block排序应由稳定锚点决定；UI按最新活动排序不能改变模型投影顺序。对expanded/restoredInline后的原位refold允许保持blockId并增加summaryRevision，但必须记录首次差异和成本理由，不能偷偷沿用旧summaryHash。

原始数据归档先于压缩投影提交。最低事务序列：写内容对象并校验 → 写prepared block及来源 → 验证覆盖边界、工具配对和权限 → 原子提交新state revision → 发布投影 → 落观测。崩溃发生在prepared时，恢复后丢弃未提交候选或继续幂等完成；不得出现“原消息已隐藏但来源未落盘”。仓库不得调用外部插件无权写的Host私有事件接口来伪造历史。

归档对象受原会话/工作区权限约束。跨项目搜索不能因为内容地址相同而扩大可见性；hash不是权限。删除用户指定数据要处理块正文、子来源、搜索索引和诊断原文，保留最小不可逆删除标记，相关block返回已删除。不得为了恢复能力保留用户要求删除的秘密。

## 8. 模型自治压缩管线与保护区

按固定上游内核版本复用每轮管线：同步消息和引用、同步块、分析可压缩范围、确定保护区、应用既有折叠投影、估计窗口压力、按growth/tier条件给模型真实候选和doctrine、执行compress、保存谱系与结果、更新状态。实际顺序以锁定内核接口为准，迁移时用golden验证；不得为了漂亮架构重排出不同语义。

模型保留“当前步骤是否仍需”的判断。planner不得强迫固定最大块，也不得在每轮弹出同一压缩提示。候选需带精确消息引用、范围内容的估计token、受保护原因、预计回收量、是否含来源块和可能首次改写位置。对同一候选重复拒绝/失败后要冷却，growth不足不再提醒。若计划估计不确定，显示区间和置信度，不把字符估计当真实token。

保护至少包括：稳定首指令和首用户目标；当前未完成请求；最近raw工作区；未完工具调用及所有结果；并行tool burst完整单元；未提交代码变更所依赖的关键错误/约束；签名思维协议单元；当前模型已明确标记仍需的材料。保护区不能无上限膨胀到无法运行，应要求模型在安全边界完成或整理当前步骤，并显示阻塞原因；不能静默压缩尚未完成的配对工具。

summary doctrine保留KEEP类：用户目标、约束、决定与理由、当前状态、剩余工作、准确路径/标识符/关键值/错误、来源ref。DROP类可包括已消费冗余日志、重复完整文件和无后续意义的成功噪声，但原始归档仍可恢复。内容选取质量以任务和精确回忆探针检验，不能用固定字符长度断言高保真。

主要路径为in-band：模型已读过同一历史，在正常推理/工具流中提出summary，不自动另开一个全历史廉价模型请求。可保留上游已有的外部summary路径用于明确策略或兼容恢复，但必须标记独立用途、冻结输入、校验晚到结果和计费，不升级为默认异步全量摘要。另起辅助调用若要复用暖前缀，使用相同已接受system/tools和原前缀，末尾加指令；另换system开头会丧失这项收益。

最近工作区的“约50K”来自上游方法和实证，是候选默认，不是所有模型窗口的硬数。默认阈值应先继承锁定内核配置并暴露用户策略，按窗口和输出预留缩放；不足64K的小窗口要评估doctrine固定开销，不能照搬大窗口阈值。默认优先适合阶段性开发任务的保守自治配置，极限压缩作为用户可识别策略，经单独质量验收后开放。

## 9. 分层块、LSM写放大与供应商单元的关系

T1折叠原始已消费增量，T2折叠一批T1，T3再折叠T2；它们像LSM的多代蒸馏，目的是限制常驻summary增长和重复重写。已有T1不应在每次新增T1时整体重写；晋升遵守上游计数/质量/growth gates，批量完成，记录源层和回收量。不能为了提高单次压缩比每步重新总结整个祖先图，这会加重信息损失、输出成本和prefix反复改写。

新摘要先保留已有渲染位置；第一次生成锚定**本次direct range**，不锚定effective祖先范围。上游 #2733 已展示祖先锚点会把每次refold前移到很早的prefix，造成大面积缓存偿还。legacy块无direct字段时按兼容规则退回effective，并标记legacy迁移；不得未经验证推断direct范围并破坏可恢复性。无锚点时置于最新用户消息之前，明确诊断，避免旧summary放在当前问题之后夺取模型注意力。

供应商cache unit是完整输入前缀，例如 `P+S1+S2+R`，不是S1/S2独立可寻址对象。即便S2原文字节不变，若前面的S1改写，它处于不同token前缀和注意力状态，不能声称仍读取旧S2 KV。DeepSeek当前完整unit要求意味着“保留P”还需P曾被供应商写成独立prefix unit；否则压缩后第一次可能不命中，多个请求发现公共P后再命中。这部分必须在warming曲线中观测。

插件不会向托管供应商发送虚假的block ID并指望服务端保留KV，也不会偷偷发空推理请求“预热”来制造指标。若用户选择受预算约束的显式预热实验，每个请求单独计费与标识，只作为诊断模式；生产默认靠自然后续请求复用。自托管后端若暴露真实prefix-cache API，另立能力适配与契约，不能混同为DeepSeek默认行为。

压缩会牺牲一次局部后缀暖缓存，换来以后每轮少读已消费内容和有界窗口。这是核心设计的一部分，而非压缩失败。正确优化是：把变化限制在本次范围、保住已有summary和静态head、减少无收益microfold、避免反复祖先refold、以to-file恢复优先满足精确需求，并按真实价格和剩余工作衡量偿还。

## 10. Wire稳定性、哈希与金样轨迹

必须分别记录四种对象：逻辑原始消息hash；用于身份关联的规范化hash；适配器最终wire形状hash；服务商usage。身份hash可排序键、忽略非语义字段甚至用于模糊候选，但**不能作为缓存稳定证明**。wire证据保留原顺序、原文本、角色、tool ID、参数字符串、内容块次序、签名与适配器版本。

一般JSON对象的键排序可在首次生成schema时固定，但已接受的tool arguments字符串不得解析后再重排重写；签名thinking、redacted内容、Gemini thoughtSignature及供应商签名payload原样保存和重放。不能做Unicode NFC、换行转换、空白清理、转义风格更换或把字符串content转为text-block数组后仍宣称exact unchanged。必要格式迁移生成serializationEpoch并接受预热，先用协议测试确认语义和签名有效。

字节比较包括严格公共前缀和JSON-tail分析。`{"messages":[A,B]}`追加C变为`{"messages":[A,B,C]}`，旧闭合括号移动，整个HTTP body不再是逐字节前缀；这不应误报历史改写。JSON-tail分析仅在前置字段一致、旧元素原始区间一致、仅尾部元素增加或允许尾字段变化时成立，并报告具体路径。它仍是本地wire结构证据，不是供应商内部token化的证明。若只拿到翻译前消息，应标 `observationStage:pre-adapter` 和 unobserved final-wire。

下列符号用于金样：`P`=稳定system+工具；`S1`=已有summary；`R1/R2`=本次/较新raw；`U`=当前用户；`K1`=首次压缩工具结果。每个trace要保存synthetic exact JSON、差异路径、保留前缀估计和对照用途，不能只保存符号草图。

| Golden | 前一次 → 后一次 | 必须结论 |
|---|---|---|
| G-CCH-A | `P,S1,R1,U1` → `P,S1,R1,U1,A1,U2` | 旧消息不改，JSON-tail append；自然续写可复用已写完整前缀 |
| G-CCH-B | `P,S1,R1,R2,U` → `P,S1,K1,R2,U` | direct范围替换；P+S1稳定，首次差异在R1；R2不可假称独立缓存保留 |
| G-CCH-C | `P,S1,R1,R2,U` → `P,K1,S1,R2,U` | 摘要被无理由前移，首次差异提前至S1，除明确迁移外应被门禁拒绝 |
| G-CCH-D | `P,S1,S2,S3,R,U` → `P,S12,S3,R,U` | T2合法晋升，从S1起偿还；来源S1/S2可恢复，S3字节不变但其前缀已变 |
| G-CCH-E | `P,S1,R,U` → `P,S1,R,U,tool(toFileRef)` | 写文件恢复只在尾部返回引用；原投影不膨胀或重排 |
| G-CCH-F | `P,S1,R,U` → `P,raw(S1),R,U` | 用户要求inline/full恢复导致可解释展开；记新state，不叫“零缓存影响” |
| G-CCH-G | `P,S1,R,U` → `P,S1,R,U,SYSTEM2` | 仅支持in-history且连续series可成立；其他路由必须生成替换head的独立golden |
| G-CCH-H | `P,S1,R,U` → `P,S1,R,U,recall` | 本轮一次召回追加；重试保持文本/顺序，不重新渲染旧recall |

金样还需覆盖pluginMode与proxyMode的不同summary载体。前者可能保留客户端压缩tool call/result并移除重复kernel summary；后者在覆盖区原位渲染summary并转换角色。不得把两种载体同时发送，造成重复summary，也不得一轮一种模式交替。每个会话的renderMode固定，迁移有明确epoch、归档和回滚。

## 11. Cache-aware planner与压缩经济学

planner为模型提供成本提示，不能取代自治核心。它估计候选回收量、首次差异位置、预计重新预热token、summary生成输出、额外调用、剩余轮数和召回风险，给出 `beneficial|uncertain|window-required|low-benefit`。不确定时保守显示，不把估计收益当已实现节省。模型仍可因任务完成阶段变化请求压缩；安全窗口紧急需求覆盖经济门槛，但不能覆盖来源完整性。

每个真实调用费用为：

```text
promptTotal = U + R + W
modelCost = (U*pU + R*pR + W5*pW5 + W1*pW1 + Wother*pWother + O*pO) / 1,000,000
taskCost = sum(all attributable attempts' modelCost) + sum(external successful-call fees)
cacheReadShare = R / promptTotal        // promptTotal=0 或 usage未知 => null
```

DeepSeek当前没有独立cache write收费桶时，W为0；miss全部在U中，不能再以“写入费”加一次。Anthropic/OpenAI有互斥write桶的路由按能力解析。输出O已经包括reasoning；供应商单列reasoning只是分析，不再相加。外部工具可能按成功调用而非token计费；失败是否收费由具体tariff决定，不通用猜测。

候选的预测净收益可用 `N * removedUsefulInputPerFutureCall * applicableReadOrMissPrice - summaryGenerationCost - estimatedRewarmCost - expectedRecallCost`，其中N和命中状态均是不确定变量，应提供多情景范围。暖前缀下移除10K token节省的是每轮10K缓存读价，绝非每轮10K未命中价；空档后本来会全部cold，压缩反而降低下一次冷读量。把两种情境都计入，不能只挑好看的例子。

以2026-10-19谷价Flash为例，50K原始内容完全暖读每轮USD .00015；压缩首次若使40K仍需发送后缀从read变miss，附加约 `40K*(.15-.003)/1M=.00588`，另有summary输出和调用成本。只靠这50K的暖读节省需约40轮量级偿还，具体还取决于压缩前后形状和供应商单元。此例不用于禁止必要压缩，而用于阻止对只有极小回收量的重复早期refold。若未来100轮、原始内容更大、窗口逼近或主任务注意力改善，决策可能完全不同。

每次压缩记录原始估计长度、压缩后估计、真实后续usage、压缩调用费用、首次差异估计、回收量、偿还观测和质量信号。费用预测不回写成实际节省；实际节省需要匹配基线或可解释counterfactual，并标假设。单次压缩后cache share暂降不自动触发撤销，因为撤销也改写且会失去窗口收益。

阻止连续低收益循环：同tier候选增长未达门槛不再次nudge；预计回收不足最小收益、连续几次无法减少上下文、active保护区占满或summary比原文更大时返回结构化原因；不要反复发同一长提示。具体阈值来自锁定内核默认与基准调优，配置中标明估计，不发明为供应商要求。

## 12. Usage归一化合同与异常校验

```ts
type NormalizedUsage = {
  status: "reported" | "unreported" | "invalid";
  source: "provider" | "host-normalized" | "none";
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWriteByTtl: { ttl: string; tokens: number }[] | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  providerPromptTotal: number | null;
  providerTotal: number | null;
  isFinal: boolean;
  receivedAt: string;
  rawUsageSchemaId: string | null;
  warnings: string[];
};
```

计数只接受有限非负整数；若供应商确有小数单位，先为该协议扩展，不一概四舍五入。null表示没有数据，0表示确认是零，两者不可合并。某路由文档明确缺省cache写为0时，适配器可按能力补0并标来源；不明兼容网关缺字段时保持unknown。负值、NaN、字符串异常、总量小于cache、重复TTL子桶不闭合、total矛盾等标invalid并保留可诊断码，不能静默clamp后假装可信结算。

DeepSeek Chat原生：`R=prompt_cache_hit_tokens`，`U=prompt_cache_miss_tokens`，`U+R=prompt_tokens`。若只给cached_tokens别名可按文档映射，不将两个同义字段相加；冲突时invalid。Host TokenUsage已经互斥，应直接映射`inputTokens→U`、cacheRead→R、cacheWrite→W。不能把Host input当total再减cache，这会出现负数。Anthropic：input为U，creation为W，read为R；OpenAI路径按模型版本schema决定total/cache/write关系。

流式usage可能是累计快照或增量，须在每种适配器内声明 `usageMode`。累计100、150、200应最终记200，不能加成450。usage revision按attempt+序号幂等替代；增量协议必须有可靠chunk ID或去重规则。内容已收到而usage缺失时，status为unreported，费用未知；不能从本地字符数伪造reported。允许给单独估计上界，以预算处理，不和实际混合。

重放/恢复的旧usage不产生新支出，标题/审查真实新请求产生支出。被取消但服务端已计算的请求可能收费，attempt保持 `cancelled-unsettled` 等待尾usage或后续对账；不得取消即记0。中断后重试的两次attempt都保留，不能把失败那次覆盖。超时而未知是否到达服务端称delivery unknown。

## 13. 请求、预算和结算状态机

请求状态为 `preparing` → `admitted` → `sent` → `streaming` → `settled`。旁路终态包括 `rejected-before-send`、`failed-before-send`、`failed-after-send`、`cancelled`、`delivery-unknown`；后者可通过迟到usage进入带结算修订的终态，不重发请求。`sent`以实际提交transport为准，记录monotonic时间；不能以创建UI卡片当已发送。

权威持久条目至少采用如下字段。`requestId` 沿用09章业务意图幂等语义，兼容05章 `intentRequestId`；一意图可有多个logicalCall，每个logicalCall可有多个attempt。`providerRequestId` 可晚到、缺失或在兼容网关不唯一，因此只作外部关联，不作本地去重主键。

```ts
type UsageLedgerAttempt = {
  ledgerSchemaVersion: 1;
  requestId: string;
  logicalCallId: string;
  attemptId: string;
  providerRequestId: string | null;
  revision: number;
  ledgerOriginId: string;
  sessionId: string;
  branchId: string;
  turnId: string | null;
  stepId: string | null;
  purpose: string;
  state: string;
  preparedArtifactHash: string;
  routeIdentityHash: string;
  routeEpoch: string;
  promptEpoch: string;
  toolSurfaceEpoch: string;
  memorySnapshotEpoch: string;
  compressionEpoch: string;
  serializationEpoch: string;
  sentAt: string | null;
  firstTokenElapsedMs: number | null;
  finishedAt: string | null;
  usage: NormalizedUsage;
  usageRevision: number;
  tariffId: string | null;
  currency: string | null;
  calculatedCostDecimal: string | null;
  costStatus: "calculated" | "estimated" | "unknown" | "invoice-reconciled";
  reservationId: string | null;
  settlementRevision: number;
  inherited: boolean;
  previousComparableAttemptId: string | null;
  previousComparableLogicalCallId: string | null;
  operationId: string;
  parentOperationId: string | null;
  causeOperationId: string;
};
```

存储以 `logicalCallId+attemptId` 唯一；事件以 `logicalCallId+attemptId+revision` 去重，final usage以 `logicalCallId+attemptId+usageRevision` 比较替换，结算以 `logicalCallId+attemptId+settlementRevision` 替换而非累加同一条目。聚合selector读取每对call+attempt最新接受revision，排除inherited的新增支出，同时保留其历史视图；不排除真实失败收费或未知收费项。按requestId/operationId/session/purpose/route/sentAt建立查询索引，不在每轮扫描整个归档正文。previousComparable引用同时保留call和attempt两部分，不假定供应商ID可代替它们。

05章 `UsageRecord.usageState=valid/missing/ambiguous/invalid` 是投影视图：valid仅当本章reported且语义完整；missing映射unreported；ambiguous映射unreported加明确warnings、保留rawUsageRef，不能猜拆桶；invalid映射invalid。05章 `includedInBill` 只有取得结算或明确账务证据才设置；本地乘价不自动成为账单确认。事件名称可以采用 `ledger.attempt.changed`、`ledger.usage.accepted`、`ledger.settlement.revised`，必须带revision和最小引用，不把原始prompt广播到所有客户端。

preparing阶段固定输入和预估；admitted阶段持有预算reservation；sent开始真实尝试；streaming收内容和usage候选；settled只接受最终有效usage或明确未知结算状态。所有状态变更有revision，重复通知无效果。UI连接断开、同一session多窗口、事件重订阅都不重复记费。插件重启后从自身ledger恢复，不重新执行已经sent的模型请求。

预算包含任务货币上限、供应商token上限、单次输出上限、并发/重试、检索/搜索/Fetch次数、压缩辅助调用、memory抽取与background开销。默认不自动切换模型来躲预算；用户配置允许自动路由时仍生成routeEpoch、解释质量和cache冷启动影响。接近额度时减少可选检索、缩短冗余结果、推迟后台索引；不能删必要错误和原始恢复引用。

reservation按估计上界，不是实际扣款。未知价格或usage时使用用户允许的保守预算政策，UI标未结算；结束后释放未消费reservation，结算费用按revision替换。并发准入需要原子比较和预留，不能每个请求都看到余额充足而超发。预算服务失败时，已发请求继续接收结算，未发高成本调用遵循用户既定策略停止，不靠故障默认无限额。

成本控制拒绝返回明确原因和可执行恢复：如达到任务上限、缺少定价、上下文不足以安全发送、重试额度耗尽。只在确需用户增加预算或变更策略时提出选择；不要因日常一次压缩、读取公开目录或本地诊断要求反复确认。安全撤权立即生效且记changeReason，即使破坏缓存也不能延迟到下次会话。

## 14. 价格、日历与多币种账本

`TariffVersion` 至少有 `tariffId/provider/endpointClass/modelOrAlias/currency/unit/effectiveFrom/effectiveUntil/queriedAt/sourceUrl/sourceHash/tokenRates/toolRates/calendarVersion/resolutionRule/confidence`。费用条目保存当时采用的tariffId，之后价格更新不悄悄重写历史费用；若先前估计有误，可新增revaluation revision，保留原值和原因。

金额使用十进制定点或整数最小单位的高精度表示，逐请求保持足够精度，展示时才四舍五入；不能把每次极小费用先取两位导致大部分为0。不同币种不直接相加；汇率换算是独立估值视图，显示汇率来源和时间，官方CNY价格不能被美元换算覆盖。账户余额、任务已用、预算预留和未知费用分别显示。

峰谷判断按官方时区和法定节假日历。未知或过期日历时返回 `priceStatus:uncertain` 及峰/谷范围，不能默用普通星期逻辑。跨边界请求究竟按开始、结束或供应商结算时间，需要适配器证据；未核实则保持range。供应商实际账单可以覆盖预测，但必须单独记录结算来源，不假称用户余额查询已获授权。

DeepSeek Search/Fetch费在2026-11-01北京时间00:00生效；按调用类别和成功条件识别。不能仅由工具名包含search就计官方费，因为本地搜索和其他供应商不是同项。一个Agent tool可能内部有多个计费API调用，adapter应回报实际provider request计数或unknown；无证据时不虚构精确次数。Token省下但搜索多出造成总费增加，应在任务比较里可见。

## 15. 缓存观测状态、差异归因与可解释性

缓存观测分两条独立状态轴。`usageStatus` 为reported/unreported/invalid；`prefixStatus` 为preserved/changed/unobserved。再有行为标签cold-start、warming、reused、change-detected、idle-resume、route-changed，标签可并存，不能替代真实token字段。第一次请求是baseline，不能称插件导致miss。

`CacheObservation`至少包含requestId/logicalCallId/attemptId/providerRequestId/session/purpose IDs、provider/model/routeEpoch、promptEpoch/toolSurfaceEpoch/memorySnapshotEpoch、observationStage、wireFingerprint、previousComparableLogicalCallId/previousComparableAttemptId、firstDifferencePath、firstDifferenceByteOffset、prefixRetainedTokensEst及估计器版本、changeReasons、usage和tariff版本、observedAt。比较只能在相同用途、分支及兼容route中进行；不可把title请求与下一main请求配成“cache掉了”。外层requestId对应意图，不能据此将同意图里的两个独立模型调用合成一个缓存样本。

reason枚举包括user-prompt-edit、tool-schema-change、tool-order-change、memory-refresh、retrieval-rewrite、compression-t1、compression-promotion、inline-decompress、native-compaction、serialization-change、provider-route-change、credential-identity-change、safety-revocation、unknown。每条标 `confirmed-local-change`、`correlated` 或 `unknown`。发现真实wire首差异可确认本地改写，但其具体miss量仍受服务商单元影响；稳定prefix且miss不能确认TTL。

保留上游实用的近似分解：miss = newContent + estimatedCompressionRepay + unattributedStablePrefixMiss，所有值非负且相加闭合。新增量只是token总长度增长的代理；历史重写同时缩短/增长会使其不准确，必须显示heuristic。残余不能命名“TTL损失”，因为还可能是序列化漂移、缓存单元未写、路由隔离、服务端模板、重启或观测缺口。若最终wire不可见，降低归因置信度。

任何日志默认只含hash、长度、路径级差异和reason，不保存明文system、工具结果、记忆和密钥。用户显式开启trace时用synthetic/脱敏数据优先；真实trace加权限、保留期和删除入口。脱敏后的body不能再作为真实prefix byte proof，UI必须标redacted evidence。哈希可通过长度与命名猜内容，应采用会话域分隔的安全摘要并避免跨租户全局公开。

## 16. Desktop界面合同

主会话显示克制的“上下文/缓存/费用”状态入口，默认不挤占聊天区。摘要应给当前上下文占用（真实/估计标识）、已上报缓存读比例、本任务费用和未知计量数；点击进入详情。无usage时显示“服务商未上报”，不显示0%或费用0。prefix稳定但未命中时写“前缀保持稳定；本次读缓存较少，原因未确认”，不能自动归咎用户或服务商TTL。

详情分为时间线、压缩块、费用和诊断。时间线每个模型调用显示main/标题/审查等用途、route/epoch变化、缓存三桶、TTFT和结算状态；同一次调用的stream片段折叠成一条。压缩块显示tier、覆盖ref、summary、回收估计、原文可恢复状态和操作；一键按块恢复到文件，inline恢复要明确显示上下文会增大，沿用用户已授权的当前操作不额外制造审批流。

缓存图使用加权token比例，不平均每次百分比；有未上报请求时展示覆盖率，例如“87/100次有usage”。epoch/压缩/路由变化画成事件，悬浮给确切reason和估计前缀保留量。不同provider、模型、用途默认可筛选，跨路由汇总须保留分层；不拿99%阈值统一染红长会话。

费用展示已计算、估计、未知和预算预留；显示币种、计价版本、峰谷/日历不确定和Search/Fetch。reasoning只作为输出分解；不得在堆叠条中叠在output上造成视觉双计。引用论文时标作者实证和样本范围，不能把94.2%作为用户当前会话健康承诺。

诊断动作默认本地：查看首差异字段、比较相邻请求摘要、检查工具/记忆世代、导出脱敏报告。收费canary、上传trace、读取账户结算信息须遵循用户配置和明确授权，规格不默认开启。错误卡片给短原因和恢复方式；实现细节如Cordis内部服务名只在开发诊断展开中出现，普通用户界面不需要读内部栈。

## 17. 错误合同与恢复

| 错误码 | 触发 | 发送/恢复行为 |
|---|---|---|
| `CACHE_OBSERVATION_UNAVAILABLE` | 最终wire或usage不可见 | 正常请求可继续，指标unknown；不填0 |
| `CACHE_USAGE_INVALID` | 桶不闭合/负数/冲突别名 | 保存异常、费用未核实；不重复扣账 |
| `PROMPT_EPOCH_CONFLICT` | 同一accepted epoch内容hash不同 | 停止该候选发送，重建accepted snapshot；保留旧会话 |
| `TOOL_SURFACE_DRIFT` | 未授权schema或顺序漂移 | 恢复稳定版本或开启明确新epoch；禁止隐式每轮抖动 |
| `COMPRESSION_SOURCE_MISSING` | 原文对象丢失或hash不符 | 不提交隐藏；已损坏块标不可恢复，展示受影响ref |
| `COMPRESSION_STALE_RANGE` | 模型摘要覆盖的surface generation已变化 | 丢候选，按最新范围重试；迟到结果不覆盖新状态 |
| `COMPRESSION_NO_BENEFIT` | summary不小/回收不足/反复无益 | 返回短原因并冷却，不重复大提示 |
| `COMPRESSION_TOOL_PAIR_BROKEN` | 范围切断调用结果或burst | 扩展为合法范围或拒绝；不得发送非法协议 |
| `COMPRESSION_OWNER_CONFLICT` | 原生/旧插件与统一owner双重激活 | 暂停重复变换并提示修复；原始数据保留 |
| `SIGNED_REPLAY_MISMATCH` | 思维签名或原始payload被改 | 阻止非法重放，恢复原文；不得删签名凑成功 |
| `TARIFF_UNRESOLVED` | 模型/日历/生效价格未知 | 费用range/unknown；预算按已设策略处理 |
| `BUDGET_EXCEEDED` | 原子准入无法预留 | 不发新请求，给剩余额度与策略入口 |
| `ATTEMPT_DELIVERY_UNKNOWN` | 发送中断无法确认服务端接受 | 不自动视为0费；重试单独attempt并保留未知项 |
| `HOST_COMPATIBILITY_UNVERIFIED` | 锁定adapter探测失败 | 关闭受影响兼容面，保留数据和可用官方能力 |

诊断失败不自动修改会话文本来“修缓存”。自动恢复只做有证据且幂等的动作：恢复已接受schema、重载同epoch snapshot、关闭重复变换、清理未提交prepared状态。改变模型、删除历史、全量重写记忆或丢弃summary不是自动缓存修复手段。人工恢复后新attempt关联原错误和变化原因。

## 18. 配置合同与默认策略

配置分全局、provider/model、项目和会话已接受态。覆盖采用明确字段规则，不对未知深层对象随意merge；关键数组如工具顺序和tier策略整体替换并校验。会话运行时只读accepted snapshot，设置界面编辑的是候选revision。取消编辑不改变prompt；热重载清理旧订阅，不重复注册工具和账本监听。

```yaml
cache:
  policyVersion: 1
  stableToolSurface: dispatcher
  preserveAcceptedPrompt: true
  recordFingerprints: true
  plaintextTrace: false
  compareFinalWireWhenAvailable: true
  unknownUsageDisplay: unknown
  providerPolicy: capability-registry
compression:
  engine: acp-kernel
  engineVersion: exact-lock-required
  decisionMode: model-autonomous
  reversible: true
  multiTier: true
  preferToFileRecovery: true
  renderMode: session-pinned
  respectDirectAnchors: true
  planner:
    enabled: true
    enforceWindowSafety: true
    suppressLowBenefitRepeatNudges: true
    economicsAreEstimates: true
cost:
  currency: provider-billing-currency
  tariffUpdateMode: versioned
  holidayCalendarMode: versioned-or-uncertain
  includeAuxiliaryAttempts: true
  includeExternalCalls: true
  unknownSpendPolicy: existing-user-policy
```

这里不编造未经评估的token阈值或预算金额；首次交付从固定内核默认导入，生成可审阅的effective配置。用户设置覆盖明确记录来源。配置导入不带凭据，导出不含私有prompt和会话明文。provider capabilities的最低cache长度、TTL、读写倍率、显式断点和usage schema按版本登记；不允许用户随手给一个兼容URL就套用DeepSeek官方价格。

## 19. 可控SLO与实测目标

硬门禁：相同输入和accepted状态生成完全相同的投影；普通自然续写不得修改既有消息；无授权变化不得改工具顺序；每个已提交块来源可校验和恢复；usage/ledger重复回放不得改变总额；权限撤销即刻执行；供应商未上报不标实际0；所有压缩保留完整工具协议；安全窗口检查不忽略输出预留。

性能目标分离本地开销与provider波动。最终wire指纹默认采用流式或增量计算，避免每步对数百MB归档做全量序列化；比较相邻请求保留结构摘要，必要时按块惰性读取。每轮同步只处理新增/变化范围，长会话的累计归档增长不应线性放大当前step延迟。具体毫秒门槛应基于目标Windows机器测得baseline后冻结，不把此文未跑过的数值写成达标。

实际缓存目标按模型、provider、用途、间隔和压缩事件分层。自然续写的可控漂移应为0；实际cacheReadShare采用基准置信区间和趋势，不用单个固定百分比。压缩后的第1、2、3、5次调用、idle恢复、模型切换分别统计，避免冷启动稀释或掩盖机制。耗费下降同时必须任务成功不退化、精确回忆可恢复、TTFT没有不可接受增幅。

允许新策略在同等质量下cache share稍降但总费更低，也允许token稍增换来更少重复请求和更好任务完成；必须显示完整比较和原因。任何声称“省X%”的发行说明注明匹配workload、调用总数、价表日期、cache条件和质量尺度，不能只选择暖缓存最优样本。

## 20. 基准设计和成本验收

先运行不收费离线层：合成原始事件、固定内核投影、protocol fixtures、json-tail/首差异、usage录制回放、账本并发和崩溃注入。它可以证明确定性和归因逻辑，不能证明供应商真实cache命中。再在获得既定模型预算后运行小规模真实canary，固定模型/route/策略并记录实际usage、TTFT和费用。本文仅定义这些未来测试，不声称已执行。

对照臂至少为：锁定原billion-context完整自治默认；整合插件自治默认加缓存稳定层；相同功能但故意动态头部的负对照；仅用于解释的无压缩/一次性压缩基线。不得把原自治机制移除后冒称优化。论文中的deterministic或extreme策略可作为研究臂，但不是替代默认能力。所有臂使用相同任务、工具输出和provider能力；在线模型内容有随机性时至少三种任务顺序seed，记录置信区间及执行错误。

workload至少覆盖重复编辑、阶段迁移、跨数百轮决定依赖、长工具输出、精确错误回忆、旧约束恢复、多项目隔离、lint修复循环和中断恢复。长程轨迹不少于500次调用的合成回放，含真正T2/T3晋升；仅几十轮不能证明多代可恢复。在线成本可先短canary，再预算允许扩展；离线大规模不能等同在线验证。

记录总新输入、cache read、cache write、输出、summary输出、外部调用、总费用、每成功任务费用、首token延迟、首有意义内容延迟、总任务时长、窗口峰值、归档尺寸、恢复成功和探针得分。TTFT从实际发送至首个模型内容/思维协议事件；纯heartbeat不算；用户可见首内容另计，避免思维模式混淆。重试、取消未知和辅助调用都入分母。

cache比例用 `sum(R)/sum(U+R+W)`，不是每请求百分比算术平均。缺usage请求单列覆盖率；费用unknown时给已知下界和保守上界，不能悄悄删除缺失请求使节省好看。比较价表相同版本的模拟费用与按当时真实tariff的费用分别给出，避免不同时段峰谷造成伪优势。

通过条件先是所有信息守恒、协议、权限、幂等硬门禁；再要求整合版相对原自治baseline不引入不可解释首部漂移、同等质量下总费与延迟满足冻结门槛。若缓存策略只提高读比例却增加总费或降低回忆质量，不接受为默认。若新整合增加了其他必要功能，成本比较必须拆分同功能子集，不能把新功能开销藏进“缓存优化失败/成功”的结论。

## 21. CCH验收用例

以下测试均为计划。每项应产出输入fixture、固定版本、expected投影/账本或在线采样、通过证据；不得只断言代码内部字段等于自己写入的字段。离线金样必须从可独立检查的请求文本、原始归档和供应商录制usage推导。

| 编号 | 场景与操作 | 必须观察到的结果 |
|---|---|---|
| CCH-001 | 固定accepted状态、相同原始消息，冷启动和热重载各渲染10次 | 最终wire内容/工具顺序/摘要锚点完全一致；观察时间不进入prompt |
| CCH-002 | 普通user→assistant→user续写，消息数组闭括号移动 | strict-byte与JSON-tail结论区分；既有元素不变；不得误报mid-history rewrite |
| CCH-003 | 仅修改旧消息中的一个空白/换行 | 首差异路径和位置准确；不能因规范化身份hash相同而称preserved |
| CCH-004 | 插件加载顺序、文件扫描完成顺序随机打乱 | 接受的顶层工具schema和顺序不变；后台目录版本不影响头部 |
| CCH-005 | 启用新后端能力但沿用稳定dispatcher | 全部能力可发现；顶层schema不抖动；本轮目录结果作为尾部tool result |
| CCH-006 | 用户修改persona，支持in-history连续series | 新epoch被接受；旧消息不改；新system在尾部；实际prepared route能力写入证据 |
| CCH-007 | 同样修改但路由不支持in-history或开新series | 生成正确head replacement；明确prefix changed与reason，不伪称尾追加 |
| CCH-008 | 后台记忆写入，然后主会话自然继续 | 当前accepted snapshot不变；未来epoch候选增长；当前wire无头部变化 |
| CCH-009 | 当前轮召回遇网络重试 | 选择ID、顺序、原文本完全一致；不重新加入相对时间；不重复注入 |
| CCH-010 | 用户明确刷新记忆/撤销错误事实 | 新epoch和原因可见；必要改写正常执行；不存在为缓存延迟纠错 |
| CCH-011 | 同DSH session发title、review和main | 三种用途账本与比较链隔离；title不能成为main的previousComparableAttempt |
| CCH-012 | T1折叠旧raw、已有S1仍活跃 | 新摘要锚在direct范围，S1原位原文不变；golden G-CCH-B通过 |
| CCH-013 | 新块effective IDs含非常早祖先，direct IDs仅本次范围 | 不前移到祖先；回归#2733；首次差异留在本次直接范围 |
| CCH-014 | 缺direct字段的legacy块恢复 | 兼容规则明确且可恢复；标legacy，不臆造ID；迁移前后来源hash守恒 |
| CCH-015 | T1批量晋升T2、T2再晋升T3 | 来源DAG无环；子块非活跃仍可寻址；多级full恢复与原始逐字一致 |
| CCH-016 | 连续新增T1但未到晋升门槛 | 旧summary不每步重写；没有全祖先微型refold；写放大统计符合实际事件 |
| CCH-017 | decompress默认一层、full原始、toFile三模式 | 层级正确；toFile保持旧投影并只尾追加路径；full准确还原，费用变化明确 |
| CCH-018 | 来源对象写一半时崩溃，另在state commit后崩溃 | prepared不隐藏原文；已提交块可恢复；重放幂等，无无源summary |
| CCH-019 | summary晚到时已有新surface generation | stale range拒绝，不覆盖新历史；summary调用费用仍计入 |
| CCH-020 | compress范围切中并行tool burst/未完call | 调整完整合法范围或拒绝；供应商协议fixture全部有效，无缺tool result |
| CCH-021 | signed thinking/redacted/thoughtSignature跨压缩与重试 | 要重放部分字节完全一致；不得重排参数、擦签名或转换破坏形状 |
| CCH-022 | pluginMode与proxyMode分别运行同轨迹 | 每种各有固定golden；不出现客户端tool载体与kernel summary重复；不混模式 |
| CCH-023 | 一段summary意外前移到头部 | 稳定性门禁识别更早首次差异；诊断给本地确认原因；不能只看system没变 |
| CCH-024 | DeepSeek录制 `A+B→A+C→A+D` usage/单元fixture | 第2次不强制期待A命中；第3次可标warming/reused，遵守完整单位规则 |
| CCH-025 | 实际请求body稳定但供应商cache read=0 | prefix preserved与reported miss并存；残余原因unknown，不断言TTL |
| CCH-026 | DeepSeek hit/miss/total与cached别名同时返回 | 正确闭合且别名不双计；冲突版本返回invalid，费用不假精确 |
| CCH-027 | Host三桶usage与Anthropic三桶usage同值 | 总prompt只相加一次；output reasoning不重复；跨adapter计算结果一致 |
| CCH-028 | 流式累计usage100→150→200，尾包重复 | 最终200且ledger只结算一次；UI重连不变成450或400 |
| CCH-029 | DeepSeek最新尾包一个choice带usage，另录OpenAI旧空choices | 各按schema正常结算；不能因通用假设丢DeepSeek usage |
| CCH-030 | 缺usage、负值、NaN、字符串、cache大于total | unreported或invalid有区别；不静默填0/clamp；unknown计数可见 |
| CCH-031 | 请求取消后迟到usage，再网络重试 | 原attempt可修订结算；新attempt独立收费；不把取消当免费 |
| CCH-032 | fork继承大段历史和旧usage | 继承费用可查看但分支新增从零；账户汇总不重复旧支出 |
| CCH-033 | 两窗口订阅、插件重启、ledger事件重放 | attempt/revision幂等，费用和缓存分母不增长；不重发已sent调用 |
| CCH-034 | 并发两个请求争用仅够一次预算的余额 | 原子reservation只准入允许数量；未发拒绝无模型费用，结束释放剩余预留 |
| CCH-035 | 模型别名底层变更/账号或region切换 | routeEpoch变化，warm状态不直接继承；价格解析unknown有明确状态 |
| CCH-036 | 中国节假日工作日、普通周末、峰谷边界 | 命中版本化日历；未知日历返回range；复现修复dsh-context旧weekday缺陷 |
| CCH-037 | 2026-11-01前后Search/Fetch成功与失败计量 | 生效时间/成功规则正确；本地search不收官方费；模型token费独立 |
| CCH-038 | 多币种极小逐请求费用累计百万次 | 高精度累计正确，不逐请求两位取整；USD/CNY不直接相加 |
| CCH-039 | microfold收益极低、重复nudge、保护区满 | 冷却并返回短原因；不为节省几百token连续改早期summary；模型自治入口仍可用 |
| CCH-040 | 窗口将溢出但经济预测为负 | 触发window-required安全路径；保留来源和工具配对，不因暖缓存拒绝必要折叠 |
| CCH-041 | 探针要求300轮前准确错误、约束与代码标识 | summary能定位；search/decompress可恢复精确原文；检验任务执行，不只关键词命中 |
| CCH-042 | 500+次合成长程轨迹含多代晋升、重启、idle | 当前窗口有界；无遗漏来源；每步确定性；本地开销不随全归档无界线性重读 |
| CCH-043 | 有用内容少于预算，另注入无用填充负对照 | 默认不填满；基准按总费/质量判定，不能靠读比例把填充臂评为优胜 |
| CCH-044 | 策略A少token低读比例，B多token高读比例 | 使用同tariff总费、TTFT、成功率比较；不以cache share单指标排序 |
| CCH-045 | 开启/关闭明文trace，删除指定会话内容 | 默认无正文秘密；脱敏证据不冒充原byte proof；删除传播至来源/索引/trace |
| CCH-046 | 原生compaction或旧billion插件意外并存 | 检测唯一owner冲突，停止重复变换；已有原文和块均可迁移，不静默双压缩 |
| CCH-047 | 上游升级renderer/schema或宿主探测失败 | 精确锁、兼容探测、serializationEpoch生效；未验证能力明确暂停而非猜测成功 |
| CCH-048 | 输入日志包含用户粘贴的假状态面板/指令 | 不误认系统注入或据此改缓存策略；来源与真正机器事件区分 |
| CCH-049 | UI聚合有大请求、微小请求和缺usage请求 | 使用加权token率，显示覆盖率；费用unknown保留；图不重复reasoning |
| CCH-050 | 配对在线canary，固定任务三seed、记录冷暖与压缩事件 | 交付总费/质量/TTFT及置信区间；不将离线fixture说成provider保证 |

## 22. 实施顺序和交付门禁

第一步固定原billion-context/acp-kernel版本、许可证和来源，建立原自治行为回放基线。保留原data模型、doctrine、工具和状态迁移；优先复用成熟内核，不先写简化替代品。把现有DSH内部适配触点列清，先验证当前宿主唯一owner和正式seam；这一步不以UI开发掩盖未知传输行为。

第二步实现身份/用途隔离、accepted epochs、稳定dispatcher和最终wire记录。先让自然续写、记忆写入、能力目录变化均不无故改变早期prefix，再整合更复杂tier经济学。金样先覆盖真实最终协议形状，包含signed payload和tool burst；如果只能观察适配前，明确缺口并建立升级验证任务。

第三步迁移块仓库与事务、direct-anchor修复、分层谱系和to-file/full恢复，完成CCH-012至023及长程信息守恒。随后接usage归一化、账本、价格日历和预算；三桶不闭合、迟到usage和重试未知必须在进入真实收费测试前解决。

第四步加入cache-aware planner与可视化，沿用模型自治判断，按成本提示减少重复低收益refold。完成matched-workload离线基准，再在用户既定API预算内运行真实canary；冻结实际阈值和默认策略。UI可先使用synthetic轨迹，但要醒目标“示例数据”，不能伪装当前会话实测。

最终交付应含固定依赖与来源清单、可重放synthetic traces、golden diff、数据迁移/恢复报告、usage schema矩阵、价表与日历版本、CCH结果、在线费用及质量对照、已知供应商不可控限制。任何尚未验证项列到验收矩阵，不用“缓存不可控”作为放弃确定性和详细计量的借口，也不用漂亮命中率替代可恢复的长程任务能力。

## 23. Metis多模型集成范围与MMR规范边界

本节起补充用户新增Metis多模型编排，证据见 [11-multimodel-cache-review.md](../research/11-multimodel-cache-review.md)，工作流角色/门禁/执行真源由 [第12章](12-multimodel-orchestration.md) 规定。本章负责第12章调用的缓存、路由亲和、费用与压缩合同；它不再建立第二个workflow runtime，也不把Metis的自动思考等级当质量评分。主会话仍使用前22节规定的唯一CompressionCoordinator与自治可逆T1–T3内核。

**MMR-CACHE-001 固定主会话。** main会话的provider/model/endpoint binding保持稳定；planner、implementer、reviewer、verifier等需要不同模型时，创建或恢复各自的child session/lane，在该lane内固定路由。不得在每个角色step切换同一个main Agent的provider/model，不得为派子任务修改用户全局默认模型。用户明确要求更换主模型、模型退役、权限撤销或符合已接受failover策略时才显式handoff；记录冷启动与原因，不另造重复审批。

**MMR-CACHE-002 宿主适配。** Host已核实的 `AgentOptions.provider/model/reasoningEffort/maxTokens` 和逐child spawn能力是实施入口；由HostAdapter按当前宿主精确版本映射。`CredentialRef` 是suite内部不透明凭据引用，必须解析为Host已有provider route/secret能力，**不是擅自新增的AgentOptions字段**。不把Metis原子进程 `--api-key`、父baseURL环境fallback或私有认证文件带到DSH。选定不同provider却缺完整endpoint/credential/protocol时拒绝该候选，不拼接父配置凑出请求。

**MMR-CACHE-003 强候选约束。** 第12章生成RoutePlan时使用已授权候选和任务能力需求，候选池成员关系为硬约束；父模型未在显式池时不得因thinking更高绕过池。角色静态绑定、已接受run快照、用户override和fallback的优先级必须在RoutePlan里明确。`auto-tier` 的supported reasoning level只是能力元数据，不能作为模型质量、价格、cache TTL或节省比。未经质量基准的模型可按用户指定使用，但标 `qualityEvidence:unmeasured`，不伪装自动最优。

**MMR-CACHE-004 不变的上下文纪律。** 每个角色独立接受prompt/tool surface/memory snapshot，固定世代；main的常驻doctrine不会随child角色、队列长度、当前role状态或即时模型价格改写。主模型通过固定 `nexus_*` 工具获取角色状态和结果，动态状态以当前轮最短来源消息追加。子lane有不同工具权限可形成不同schema，但该lane内部冻结；权限是父授权的交集，不能通过高性能模型或更贵租约提升权限。

## 24. RoutePartition、RouteLease和provider隔离

**MMR-CACHE-010 分区身份。** 以下内部类型用于缓存可比性、路由绑定和诊断，均为suite合同；不要求provider接收这些字段。

```ts
type RoutePartition = {
  schemaVersion: 1;
  partitionId: string;
  providerRouteId: string;
  endpointIdentity: string;
  deploymentIdentity: string | null;
  protocolFamily: string;
  adapterVersion: string;
  requestedModelId: string;
  resolvedModelRevision: string | null;
  revisionEvidence: "provider" | "catalog" | "user-pinned" | "unknown";
  credentialScopeId: string;
  accountScopeEvidence: "verified" | "operator-declared" | "unknown";
  regionId: string | null;
  regionEvidence: "verified" | "declared" | "unknown";
  cacheContextNamespace: string;
  ownerSessionId: string;
  actorId: string;
  rolePromptSnapshotHash: string;
  promptEpoch: string;
  toolSurfaceEpoch: string;
  toolSurfaceHash: string;
  serializationEpoch: string;
  providerCachePolicyVersion: string;
  isolationPolicyRevision: string;
};
type RouteLease = {
  leaseId: string;
  leaseRevision: number;
  runId: string;
  taskId: string;
  roleId: string;
  actorId: string;
  sessionId: string;
  routePlanRevision: string;
  partitionId: string;
  state: "prepared" | "validated" | "reserved" | "active" |
    "draining" | "handoff-pending" | "closed" | "revoked" | "invalid";
  credentialRef: string;
  budgetReservationId: string;
  acceptedReasoningPolicy: string;
  acceptedOutputLimit: number;
  maxAttempts: number;
  deadline: string | null;
  createdAt: string;
  activatedAt: string | null;
  resumedFromLeaseId: string | null;
  handoffId: string | null;
};
```

`credentialRef`只在Host侧受保护层解析，UI投影只发scope非秘密别名和配置是否就绪。partition fingerprint采用规范版本与域分隔hash/HMAC，不含key/token；endpoint规范化不能删掉有语义的deployment路径、API版本或路由query，只隐藏秘密字段。相同模型名称、相同协议、同一个代理域名都不足以判定同模型实现/同账号/同region；未知维度保存unknown并按不共享的scope处理，不跨边界尝试命中。

**MMR-CACHE-011 Cache namespace。** namespace至少绑定租户/工作区授权域、owner session、actor/角色persona和provider路由域。相同lease自然续写复用namespace，后续恢复已接受同一session可继续；新任务只因角色相同不能自动拼接旧用户私密历史。可复用公共稳定persona/schema的收益以真实usage观测，不把不同session/账号/model的命中混为共享缓存。供应商隔离是安全边界，cache affinity是性能提示，二者不得互相替代。

**MMR-CACHE-012 不制造key抖动。** compressionEpoch、memoryStoreRevision、当前turn/step、用量、队列、heartbeat和时间不进入provider缓存key。prompt/tool确有accepted变化时形成新的可比性fingerprint；若Host支持in-history更新并保留同request series，可通过兼容关系记录旧新partition的共同前缀，不必把仍可续写的session换成全新cache namespace。并非每一个内部epoch都应强制换provider cache key。官方key/header的具体发送、长度、TTL和语义来自ProviderCacheCapabilities，不对所有endpoint盲发。

**MMR-CACHE-013 Lease状态。** RoutePlan先验证候选成员、功能、权限、价格可识别状态和Host可达，再原子预留root/child预算；成功后active，实际发送必须持有该lease revision。任务结束draining，等所有attempt结算或标未知、外部动作状态明确，再closed。handoff先draining旧lease、接受handoff快照，再activate新lease；撤权立即revoked，不能等缓存“划算”。租约deadline是调度限制，不是provider cache TTL；worker进程重启可恢复同accepted session，不能仅因重新分配leaseId强制改模型文本或namespace。

**MMR-CACHE-014 更新与恢复。** UI改候选池、价格表或角色配置只更新未来RoutePlan；运行中不逐step重算成另一模型。明确steering可在安全边界接受新routePlanRevision并产生handoff。插件重启从任务与route ledger恢复，不因内存lease丢失自动重发paid请求。已sent、delivery-unknown、pending tool必须先查状态；无法核实则保留unknown并按已接受策略处理，不用“自动继续”掩盖重复执行。

**MMR-CACHE-015 Header证据。** 稳定X-Session-Id、官方prompt_cache_key或gateway affinity header仅在adapter支持时发送，随机X-Request-Id仅用于每attempt传输关联，外部providerRequestId晚到也不改旧prompt。相同header不证明同KV实例，不构成跨账号共享许可；供应商淘汰仍可发生。长ID使用域分隔hash产生不碰撞的限长key，不能简单截断相同前缀造成两个任务共用key。若代理按随机request header路由造成miss，报告gateway evidence并更正adapter，不向system加入更多标识。

## 25. 多模型交接、分层压缩和最小产物回流

**MMR-CACHE-020 独立会话和协议。** 主模型、子模型、title/review辅助请求分别有自己的wire artifact、prompt/tool surface和pending tool状态。新模型不接管未完成的tool burst；必须先完成/取消并确认动作结果，或以显式unknown-action记录交给恢复协调器。重映射tool ID是目标投影的内部兼容操作，不修改原历史，也不赋予目标模型原调用执行权。

**MMR-CACHE-021 跨模型handoff。** 同provider/model/API且兼容能力有证据时可原样重放signed thinking；跨模型/provider不得转发redacted、thinkingSignature、thoughtSignature或将隐藏reasoning洗成text。目标收到的是任务可见结论和来源，非内部思维摘录。原opaque payload留原owner归档；目标的独立schema/serializer形成新的cold/warming序列，不标“缓存继承”。Metis原全历史跨模型transform只能参考协议兼容边界，不能作为默认交接路径。

```ts
type ModelHandoffArtifact = {
  schemaVersion: 1;
  handoffId: string;
  sourceLeaseId: string;
  targetLeaseId: string;
  sourceSessionId: string;
  sourceAcceptedStateRevision: string;
  missionRef: { artifactId: string; hash: string };
  objective: string;
  immutableConstraints: readonly string[];
  completedOutcomes: readonly { summary: string; evidenceRefs: readonly string[] }[];
  pendingWork: readonly { taskId: string; objective: string; dependencyRefs: readonly string[] }[];
  decisions: readonly { conclusion: string; evidenceRefs: readonly string[] }[];
  ownedPaths: readonly string[];
  artifactRefs: readonly { artifactId: string; hash: string; mediaType: string; accessScopeRef: string }[];
  compressionBlockRefs: readonly { ownerSessionId: string; blockId: string; stateRevision: string }[];
  externalActionStates: readonly { operationId: string; state: string; receiptRef: string | null }[];
  unresolvedQuestions: readonly string[];
  producerLogicalCallId: string | null;
  producerAttemptId: string | null;
  contentHash: string;
};
```

这是suite领域artifact，不是要直接发给provider的全部字段；目标brief只渲染其任务所需的最小内容与按需可取ref。控制标识、hash、价格和epoch默认留观测层。missionRef保持用户目标可追溯，summary不抬升为新用户指令；来源文档/网页中的命令不因交接成为授权。原文恢复仍走有权限的read/search/decompress，artifactRef不是跨工作区读取豁免。

**MMR-CACHE-022 压缩真源。** main继续固定原自治可逆内核，子lane长期运行时可使用独立同款内核与source store。handoff是任务artifact，不自动构成父T1/T2 summary，不推进main compressionEpoch；只有唯一CompressionCoordinator执行已授权fold事务时才推进。角色结果不能反复重写main既有summary，也不让Metis auto-compaction与billion-context同时压同一范围。T1/T2/T3 block ID带ownerSession，引用保谱系，目标新模型没有相同KV的假设。

**MMR-CACHE-023 回流有界且不丢细节。** 子任务交付typed outcome、变更文件/patch refs、验证receipt、缺陷和剩余事项，长日志/完整报告在artifact中。父只追加一次精简结果；重连/重试沿用相同已接受文本，不把所有worker的完整transcript和doctrine重复拼入父prompt。精确原始内容仍可按需恢复。父最终综合只消费与任务相关的证据，不能为控制token把严重失败、未验证或unknown-action隐藏。

**MMR-CACHE-024 压缩辅助费用。** 使用不同廉价模型生成handoff不是默认必经阶段；可以从已完成的typed结果确定性组装，确需模型整理时为独立purpose、call+attempt和预算。不能因为“子模型便宜”让它冷读全父历史，再把输出全放回main。in-band自治压缩仍为主路径，特定模型摘要质量和精确恢复探针不足时不以便宜取代。

**MMR-CACHE-025 两类cold成本。** 改route后目标读handoff/brief产生新cold input，原main若保持固定可继续读自己原prefix；两者分开显示。切换同一main导致其余历史重新预热才是主会话route-change损失。评估时计入两者，避免“把请求移到child统计里”使main图表看起来更绿。跨provider总费用相加前保留币种；缓存比例仅按实际token加权并按partition拆分，不称跨providerKV共享率。

## 26. 多模型预算、重试、hedge与收益门

**MMR-CACHE-030 Root预算守恒。** 每个RouteLease在同一个root预算中原子预留child货币/调用/输出/检索/压缩份额；子任务再递归委派时只转授余额，不复制一份完整parent预算。并发上限、累计任务cap、实际模型call cap、deadline和货币上限是不同约束。Metis tokensaver=6或wide=200不能直接当本产品默认成本策略；第12章按任务所有权和证据决定可用并发，本章按费用/缓存/质量衡量。

**MMR-CACHE-031 真实attempt。** 仍遵循requestId=业务意图、logicalCallId=独立模型调用、attemptId=一次实际发送、providerRequestId=外部标识。重试同模型同逻辑调用产生新attempt，cross-model竞争产生各自logicalCall并关联hedgeGroupId，显式handoff后新的独立推理产生新logicalCall。记录rootRunId/taskId/roleId/routeLeaseId/partitionId，不能用父call覆盖全部子usage。未收usage或取消未结算仍unknown。

**MMR-CACHE-032 消除隐藏重试。** SDK、provider transport和编排器不得各按maxRetries嵌套相乘而无账。唯一attempt准入为每次真实网络发送分配ID、预留和trace；不能暴露时默认禁用该SDK隐式重试，或明确记录attemptCount/fee未知并限制预算，不声称精确成本。`retryAfter`处理不能偷偷换provider；原route重试可复用相同已接受wire和namespace，必要幂等headers按供应商合同。

**MMR-CACHE-033 Retry分类。** auth/不支持模型/schema失败不盲重试；429/临时服务错误按已接受退避和截止；窗口问题交唯一压缩控制器，不能无限路由更大模型；delivery-unknown不视为肯定未执行。主会话必要恢复不自动重跑已经完成的工具动作。每次attempt使用当时tariff和usage，不把先前失败call从任务费用删除。

**MMR-CACHE-034 Hedge默认关闭。** 仅在用户策略明确允许、预算足够、任务为只读推理/独立候选产物、收益基准支持时可开启。发出前预留所有候选的最坏支出，各候选有不同logicalCall和隔离输出；首个响应不必是质量合格的winner，需满足声明的acceptance。loser取消仍可能收费，继续收settlement。低延迟不当“节省”。

**MMR-CACHE-035 唯一副作用提交。** 多模型可以并行给出建议、patch候选或独立只读验证，但不能hedge相同写文件、git apply、消息发送、发布或远端变更。每个可变操作由唯一commit lease持有者在receipt/CAS校验后提交；候选模型生成tool call不等于授权执行。winner确定后也先核实旧候选动作状态；取消或丢连接不撤销已发生副作用。不同工作树产物合并由第12章owner控制，不以cache快为理由抢同文件。

**MMR-CACHE-036 收益门。** 路由建议至少评估以下同功能总费用差和质量/时延约束：

```text
DeltaCost =
  Cost(all main+child+handoff+retry+hedge+merge+verification attempts under candidate plan)
  + Cost(external actions under candidate plan)
  - Cost(the same workload under the accepted fixed-route baseline)
```

预测必须区分当前warm、cold/idle恢复、首次handoff和后续N次复用，输入cache读写倍率与输出price分别使用候选真实tariff。不能只比较每百万未命中价格；昂贵模型的少量暖读可能比便宜模型的全历史冷读更省。N、质量与命中未知给情景区间，不能伪造break-even；安全/窗口必需和用户明确选择的路由以可解释reason覆盖自动经济建议。无基准时默认固定main加固定子role，而不是逐步auto-rerank漂移。

**MMR-CACHE-037 质量门。** 模型选择按task family、真实模型revision、输入/工具能力、质量oracle和user preference评估。最高thinking枚举不等于最优；catalog `cost=0`但无price证据为unknown，不作为免费候选胜出。质量劣化、重复返工、遗漏来源、重复副作用任一项都可能抵消低单价。默认策略至少不劣于已接受baseline的任务正确性与原文可恢复能力；少token不能替代完成任务。

**MMR-CACHE-038 定价/TTL矩阵。** 沿用08证据已有官方快照，不用Metis静态catalog覆盖。能力登记以provider route、model revision、协议、cache政策版本为键，包含最小长度、完整unit/显式breakpoint规则、TTL/writes、usage schema、签名重放能力、支持的reasoning参数及证据日期。未知或过期维度显示unknown；用户登记的免费本地模型保留provenance和费用口径，不自动宣称0总成本。不同账号/region无缓存共享证据即独立统计。

**MMR-CACHE-039 Observability与收益列。** 每个样本在前述ledger基础上增加run/task/role/actor/routeLeaseId/leaseRevision/partitionId/routePlanRevision/handoffId/hedgeGroupId/winnerStatus/commitLeaseId。指标包括各partition三桶token与输出、usage覆盖率、每成功任务费用、重试/loser未知费用、TTFT/完整任务时长、handoff估计tokens、父历史复制量、warming第1/2/3/5次、首差异原因、质量探针和副作用receipt。默认图先按partition/role分层；跨模型汇总不平均百分比、不把缺usage舍去。lease/role变化是观测事件，不能反过来每轮注入system。

## 27. MMR缓存实施顺序、基准与新增验收

实施关键路径为：固定run RoutePlan → Host逐child AgentOptions映射与credential route解析 → RoutePartition/Lease和root预算事务 → 固定角色prompt/schema与最小brief → 最终transport call+attempt捕获 → typed artifact结果和唯一commit owner → 显式handoff与独立目标投影 → 配对实测。第12章应引用本章MMR合同和CCH编号，不复制出另一套路由账本。

离线先覆盖路由绑定/重试状态机、exact wire、签名边界、来源和预算并发；真实费用测试在已接受预算内开展。至少三对照：相同任务单模型固定main；固定main+固定role child；同main逐角色切换负对照。功能、质量oracle、任务顺序和price版本保持匹配；分别报告cache/冷启动/输出/合并/验证总费和成功率，不能只选某个便宜worker的局部费用。多模型可能提高质量或交付速度而增费，必须如实展示，不预设它一定省钱。

以下新增用例与CCH-001～050共同构成缓存验收，均为实施计划；本次没有运行Metis或收费模型。

| 编号 | 场景与操作 | 必须观察到的结果 |
|---|---|---|
| CCH-051 | main连续10轮，planner/reviewer分别选不同provider child | main provider/default/system/tools不改变；child各固定lease/partition，费用全部归root |
| CCH-052 | 相同model名但endpoint/account/region不同 | partition不同，不继承warm或共享声明；未知region不猜同区 |
| CCH-053 | 相同会话自然续写、fold、记忆后台写、lease heartbeat | namespace不因compressionEpoch/memoryStoreRevision/时间而抖动；真实变化才形成新fingerprint |
| CCH-054 | 显式auto池不含父model，父thinking等级更高 | 选中结果严格在池内；不能复现Metis reduce初值逃逸；quality证据不由thinking虚构 |
| CCH-055 | explicit三候选导入Metis旧策略 | 映射明确显示0/1角色语义或经用户既定策略转新RoutePlan；不得伪称三候选轮询已实现 |
| CCH-056 | role.model变provider但缺baseURL/credential route | 拒绝或明确缺配置；不沿用父endpoint/key；Host AgentOptions不出现虚构credentialRef字段 |
| CCH-057 | spawn多个child，检查任务文件/argv/UI/导出 | 无API key；只有Host侧opaque credential reference；秘密不进入partition fingerprint |
| CCH-058 | 修改UI候选池/默认model时已有active run | 运行快照和active lease保持；新run或明确handoff接受后才变 |
| CCH-059 | main pending并行tool burst时提出跨模型切换 | 完成/取消且核实动作后交接；不得跨模型续接半套tool IDs或合成成功receipt |
| CCH-060 | 原模型signed/redacted/thoughtSignature后交另一模型 | 原归档逐字保留；目标handoff无opaque签名/隐藏reasoning，独立schema且标cold |
| CCH-061 | 同模型兼容route恢复signed历史 | 应重放部分exact相同；adapter能力证据有效；不因id规范化改签名payload |
| CCH-062 | 子模型给出长报告/完整日志，父正常继续 | 父只追加一次typed摘要和artifact refs；原文按需读；失败/未验证状态不丢 |
| CCH-063 | child handoff含T2/T3块ref，目标要求精确细节 | ref含ownerSession/state revision；search→decompress/file-first恢复原文；不假称原KV继承 |
| CCH-064 | Metis auto-compaction与billion折叠均可用 | 唯一owner生效；handoff不会自动重写main块或多推进compressionEpoch |
| CCH-065 | nested child分配预算并并发预留 | root余额守恒、无复制预算；子路由的调用/输出/搜索和压缩都入总账 |
| CCH-066 | SDK内部两retry加编排retry | 每真实发送有call+attempt与预算，或禁隐式重试/标未知；不能只记录最外一次 |
| CCH-067 | provider cancel/429后failover另一model | 旧attempt保留未知/收费；目标新logicalCall/lease，显式原因与warming，不删除旧费用 |
| CCH-068 | hedge两个read-only候选，loser仍返回usage | 两个独立call按hedgeGroup归因；loser取消不记0；winner需验收后确定 |
| CCH-069 | hedge候选尝试相同写/发布动作 | runtime拒绝重复副作用，仅commit lease owner可执行；model tool call不等于receipt |
| CCH-070 | 请求重连、父意图幂等重放、子作业恢复 | 同request返回既有receipt；子paid调用不重发；call+attempt去重不吞多个真实调用 |
| CCH-071 | 自定义catalog成本全0但无官方/用户价格证据 | price unknown，不作为“免费最优”；费用区间和预算策略明确 |
| CCH-072 | 同session header但换账号/网关backend | 诊断不宣称共享；providerRequestId/header只是关联；cache效果由usage证据分层 |
| CCH-073 | 两长namespace仅前64字符相同 | 生成不同限长opaque key；无简单截断碰撞；跨租户不共享内部映射 |
| CCH-074 | 仅支持较早retention字段与新prompt_cache_options模型并存 | 按能力矩阵分别渲染，无盲发；不把兼容URL当相同TTL/写价格 |
| CCH-075 | 暖贵模型 vs 冷便宜模型的相同任务 | 比较全部cold/brief/output/retry/merge/verify费用及质量；不只比较未命中单价 |
| CCH-076 | handoff结果晚到，source revision或权限已变 | stale候选不覆盖；敏感撤权立即生效；已发生模型费用仍计入 |
| CCH-077 | 配置改reasoningEffort/maxTokens但不改历史文本 | Host按能力接受并观测，记录request config；不无证据宣布必然cache失效或必然保持 |
| CCH-078 | 并行role发现能力/恢复catalog，主会话持续 | 固定wire schema不因role进度/解锁/排队改变；状态进入当前结果而非system |
| CCH-079 | 聚合多provider、不同币种和缺usage child | 分币种/partition展示并列unknown；不从main图移除child支出来虚报节省 |
| CCH-080 | 固定main单模型、多role固定lane、main轮换三臂配对基准 | 输出完整质量/总费/TTFT/warming/复制量与样本范围；真实cache未测时明确未测 |

阶段完成的审阅证据包括：Metis固定commit与差异表；Host child AgentOptions映射；RoutePlan/Lease及预算事务goldens；每partition最终wire与签名fixture；跨模型handoff来源恢复；实际call+attempt与loser结算账本；matched-workload收益报告。只完成角色选模UI或将多模型配置写进persona，不能认定多模型集成和缓存要求完成。
