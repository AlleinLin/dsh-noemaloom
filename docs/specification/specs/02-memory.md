# 统一记忆域行为规格

版本：0.1 研究规格。适用目标：主包统一安装的 DeepSeek Harness 桌面插件，内部暂以 Nexus 命名，最终产品名与包名由主规格确定。本文要求达到可直接交付实施者的详细程度，允许复用研究仓源码，不要求真正的净室隔离。研究证据与组件许可见 [02-memory-evidence.md](../research/02-memory-evidence.md)。本文定义目标行为；其中默认值、统一字段和 action 是新产品设计，不声称它们原样存在于上游。

## 1. 目标、范围与责任

用户安装一个 npm 主包即可在桌面获得离线基础记忆、五轨日志、分层披露、图关系、候选审核、证据信任、按目录/分支/项目隔离、跨会话复用、同步与迁移。默认不要求 Python、Milvus、PostgreSQL、Ollama、VLM、外部账户或另装八个记忆插件。用户可在同一设置页启用本地高级认知引擎、向量检索或已部署外部服务。关闭某模块保留它的数据与配置，并在对应入口显示可恢复的未运行状态。

原有项目的功能不因版本旧或停更而丢弃。统一实现可以采用“主包内模块”“可选本地引擎”“已部署后端适配”“其他领域的共享服务”四类承载，但每项能力必须有可发现入口、明确状态、数据归属与验收；不能以未实现的按钮或永久占位兑现功能。实施时可直接组合 MIT/Apache 模块，按实际复制文件保留归属与通知；OpenViking 主服务 AGPL 部分与 examples Apache 部分分别管理。

记忆域拥有 MemoryRecord 内容、证据、审核、检索、注入计划、Provider 空间映射和同步载荷。工作流域拥有任务、待办、技能、调度和多代理执行，记忆只保存其结果引用和技能候选提案；代码域拥有真实 AST/调用图；上下文域拥有历史压缩、takeover 和上下文重建；宿主 sessionPersistence 是原始会话唯一真源。任何摘要、记忆、索引都不能替代或偷偷改写宿主原始会话。

## 2. 核心用户故事

|编号|场景与完成条件|
|---|---|
|US-M01|用户说“记住我喜欢中文简洁回复”，可看到保存到个人画像的预览、范围和来源；确认后在下一合适注入点生效，其他项目能复用。|
|US-M02|用户记录项目架构决策，默认仅当前项目可检索；另一工作区会话不能因宿主 cwd 相同而读到它。|
|US-M03|用户进入 frontend 或工具首次读取其文件后，frontend 条件记忆激活；触及 backend 前不把 backend 约定塞入上下文。|
|US-M04|feature 分支的实验只在该分支起作用；切回 main 不泄露实验事实，通用记录仍有效。|
|US-M05|用户搜索一个旧故障，从摘要展开到完整教训，再回到经宿主授权的原始回合或代码锚点。|
|US-M06|模型从会话识别经验，先生成候选；用户能接受、编辑后接受、合并、拒绝、延期，且能看为什么被建议。|
|US-M07|旧记忆与当前代码冲突，UI 同时显示两方证据、过期原因与验证建议；系统不把相似度当作真理。|
|US-M08|用户记一条失败方案，未来相关任务能看到“曾失败及条件”，不会被当成推荐方案执行。|
|US-M09|用户整理未解问题，可更新同一问题的线索与目标，问题身份不随措辞变化。|
|US-M10|每条回复底部能看本轮使用/写入/跳过哪些记忆及 token 开销，点击可打开详情；已完成回复可一键存入。|
|US-M11|用户选择 Hindsight/OpenViking/Mem0 等后端，只输入该后端必要连接项，测试成功后发现有权限的空间；没有某能力时明确说明。|
|US-M12|用户在离线环境继续用本地记忆，后台服务故障不阻止聊天；待同步操作可重试、不重复记账。|
|US-M13|用户把旧8套记忆迁入，先看解析、范围、冲突、私密性和容量预览，确认后一次导入，重复导入可幂等。|
|US-M14|两台设备修改同一条记忆，三方差异逐项可选；不同记录自动合并、同记录冲突不静默覆盖。|
|US-M15|用户把重复工作流提炼为技能，候选带三个以上可追溯实例；是否安装与目标目录由工作流域确认。|
|US-M16|用户启用高级认知，获得条件路由、因果链、时空/双时间轴、推演分支、演化、盲区、校准等完整能力。|
|US-M17|用户检查“为何又犯同样错误”，可查看应用反馈、复发次数、根因、修复与验证结果，并跳转证据。|
|US-M18|用户关注 LLM 缓存率，记忆不因每轮计数、排序、日志增长而修改固定前缀，能区分真实命中与稳定性预测。|

## 3. 内容真源、目录与身份

本地 MemoryRecord 的唯一内容真源是 UTF-8 Markdown。SQLite 仅保存元数据、任务、游标、幂等收据、全文/关系/向量索引投影；删除全部可重建索引后，从 Markdown 和审计载荷能够恢复内容、关系、生命周期与来源。Provider 原生数据仍归 Provider，必须以 providerId+externalId 标识；缓存仅是缓存，禁止悄悄转成可写本地真源。

建议的逻辑布局如下，实际物理根由宿主配置解析；路径不是工具可任意填写的授权参数。

```text
<memoryRoot>/
  records/<scopeId>/<recordId>.md
  reviews/<proposalId>.md
  pages/<scopeId>/<pageId>.md
  audit/<yyyy-mm>/<eventId>.md
  archives/<scopeId>/<recordId>.md
  tombstones/<scopeId>/<recordId>.md
  exports/                     # 用户发起的导出成品
  state/                       # 可迁移配置、游标、幂等日志；无明文凭据
  projections/memory.sqlite    # 可重建索引与作业/元数据
```

上述 SQLite 中不可重建的运行作业/幂等状态必须同时可导出，不能宣称删库后任务仍不丢。内容写入收据与审计事件先后关系由事务日志明确；恢复流程可从 durable receipt 对索引回补，不反向用旧索引覆盖新 Markdown。

scopeId 是稳定随机 ID，不能取 basename；projectId 绑定用户确认的项目登记与规范化本地 root。Git remote 可作为“建议同项目”的证据，不能单独让用户未确认的两个项目合并。worktree 默认与主仓共享项目记忆，worktreeId 与 branchRef 仍区分；用户可选择隔离。非 Git 工作区也有稳定项目 ID，不回退到全局以掩盖身份未知。

目录重命名后可重新绑定同 projectId；root/home/临时公共目录不得自动被当项目根。Windows 驱动器、大小写、UNC、符号链接和 junction 使用宿主规范化路径与访问边界；不能用简单字符串 startsWith 判断子路径。UI 只可选择宿主已登记工作区或经宿主明确授权的自定义数据目录，不接受任意 cwd 覆盖。

## 4. MemoryRecord 字段契约

每条 Markdown 的 frontmatter 携带结构化元数据，正文承载内容。字段升级保留未知 namespaced 字段，不会因解析器较旧而删除。系统字段与用户编辑正文分开校验；手工改坏的文件进入 repair_required，不静默重格式化。

|字段|类型、约束与语义|
|---|---|
|schemaVersion|正整数，初版1；导入低版本通过显式迁移器；高版本只读预览。|
|id|`mem_`+不可预测稳定标识，创建后不变，最长80字符，不含路径分隔。|
|revision|正整数，首次1；任何内容/元数据语义修改+1；无变化的幂等重放不增加。|
|title|1–160 Unicode字符；只去首尾空白，不偷偷翻译。|
|body|1–20000 Unicode字符，默认建议4000以内；超长可转 managed document，不自动截断持久化。|
|summary|0–500字符，可机器提案/人工修订；摘要不是证据，需对应contentHash。|
|contentHash|正文与语义元数据稳定序列化后SHA-256；换行规范明确为LF；原始导入字节另存sourceHash。|
|track|`profile/facts/key/project_log/daily_log`；五轨为用户视图，不与认知层混淆。|
|layer|`anchor/structural/knowledge/contextual/self`；默认为knowledge；self/anchor写入有保护政策。|
|kind|`preference/decision/fact/lesson/document/evidence/observation/negative/unresolved/initiative/state`；导入未知值保留sourceKind并要求映射。|
|scope|Scope对象，见下节；最窄作用域默认。|
|lifecycle|`current/deprecated/superseded/historical/archived/tombstoned`；无布尔deleted与之竞争。|
|validation|`unverified/reviewed/verified/doubted/stale/invalid/expired/rechecking`。|
|authority|`candidate/derived/canonical`；canonical仅人工显式授予，不从confidence推导。|
|confidence|`low/medium/high/unknown`；必须标明人工/模型/规则来源，不代表数学概率。|
|importance|`critical/normal/low`；用于容量与排序，不允许绕过证据或审核。|
|createdAt/updatedAt|ISO8601 UTC带Z，updatedAt≥createdAt；UI按宿主时区展示。|
|observedAt|事件被观察的时刻；可缺失，不能默认替代effective时间。|
|validFrom/validUntil|可缺失UTC；若都存在则from≤until；未生效不当作当前事实，过期不自动删除。|
|tags|0–24项，每项1–64字符，去重、稳定排序；标签不是权限。|
|conditions|结构化适用对象与文本说明；见条件卡。|
|evidence|0–32个EvidenceRef；canonical工程结论至少一个可检查依据或明确人工声明。|
|origin|human/agent/tool/import/provider/git/document等与actorId、sessionId、turnId、toolCallId、sourcePluginVersion；来源缺失写unknown。|
|subjects|user/agent/role/self实体引用，不能从正文推断成访问授权。|
|relations|有向关系ID列表或独立Markdown关系记录；必须可从内容载荷重建。|
|protection|`none/user_pinned/policy_anchor`与reason/actor/time，保护状态可审计。|
|supersededBy|仅superseded态可有，指向可访问的现存记录；不能自动跟随到更宽scope。|
|sourceRefs|导入原路径/原ID/sourceHash/providerId/externalId等；路径仅在有权限的管理面展示。|

### 4.1 Scope 与跨域安全

Scope 为 `{kind,ownerId,projectId?,branchSelector?,pathSelector?,sessionId?,teamId?,sensitivity,sharing}`。kind=`user/project/session/team/reusable`；sensitivity=`public/internal/private/restricted`；sharing=`local/team/git/provider`。scope 的数据过滤先于检索评分与摘要。

branchSelector 为 `{mode:"all"}` 或 `{mode:"include",refs:[...]}`；无通配隐式扩大，refs 1–32个精确Git ref标识。未知分支时只允许all记录自动注入，include记录可在授权的管理检索中可见并标branch_unknown。detached HEAD 保留commit，可匹配显式commit规则；不得把它当main。pathSelector 为规范化项目相对目录列表，空列表表示根级；禁止绝对路径、`..`逃逸和跨symlink越权。

个人画像可跨项目，项目日志只能当前项目；reusable记录经显式提升可跨项目，但正文中带项目私密证据的记录不能在未移除/降密前自动提升。team记忆需宿主身份授权；读列表、图节点、计数、关系端点、健康统计、导出与日志都执行同scope过滤，防止“正文挡住、标题和数量泄露”。会话/时间筛选仅是查询维度，不是认证机制。

### 4.2 五轨、层级与图的归一

五轨回答“放在哪一类用户资料”，layer回答“在认知结构中扮演什么”，kind回答“内容是什么”，三者正交。例如项目KEY可以是structural decision，daily_log可以是contextual observation，negative可在knowledge而不代表推荐方案。导入不能以一个sourceLayer字段覆盖全部概念。

profile、facts、key默认可进入常驻摘要；project_log和daily_log默认按需查阅，不因每回合增长而改系统前缀。日志由一次完成回合产生一份摘要与两个视图引用，允许物理独立兼容导出但逻辑共享captureId，不能被统计成两个独立事实。情绪反馈只有来源明确为真人且携带原quote时才保存；无证据不猜用户情绪。

### 4.3 条件卡与证据

高级条件卡字段为 `{capabilityName,applicableWhen,dependencies,procedure,verification,notApplicableWhen}`，均为可读文本/引用。基础记录不强制六要素；kind=lesson/decision且启用严格验证单元时要求适用条件、依据、不适用条件（可以明确“尚未知”）并把缺失项返回。不能要求模型复制来源独有提示词模板。

EvidenceRef 为 `{id,type,uri,locator,excerpt,hash,observedAt,producer,verificationStatus}`。type=`session_turn/file_range/symbol/test_result/git_commit/url/human_attestation/provider_record`。file_range定位项目相对path+一基startLine/endLine+contentHash；symbol需真实代码索引的qualifiedName与索引generation；session_turn通过宿主提供定位，不把数据库绝对路径暴露模型。excerpt上限1000字符。链接失效、hash漂移、删除、权限失效分别报告，不能统称“可信度低”掩盖原因。

## 5. 写入、审核、保护与生命周期

所有写操作带requestId，更新带expectedRevision；工具/HTTP/后台/导入/同步共用同一应用服务，不能UI绕过模型工具的密钥检查。成功返回Receipt，不以HTTP 200或`ok=true`推断已落盘。

写入流程按序执行：验证结构与长度→固定调用者scope/generation→扫描密钥和受禁内容→检查权限/保护/revision→同topic候选去重与冲突预检→决定提案或直接提交→原子写与审计→索引更新/待重建标记→返回收据。任何阶段失败说明是否已提交；索引失败但正文落盘时返回committed=true、indexPending=true，而非诱导用户重写。

同topic去重仅在相同scope+track+用户明确topicKey或高确定性完全重复中自动合并；相同标题不足以自动覆盖。完全相同内容返回duplicate且不变revision；近似重复给出merge proposal。替换按精确id+revision，不沿用“唯一子串”作为内部主键；旧兼容工具如接子串，0命中not_found，多命中ambiguous_match，绝不选第一条。

密钥扫描覆盖title/body/summary/evidence excerpt/日志/导入/同步/更新，不在错误里复述命中字符串。高确定性私钥/令牌拒存；疑似内容进入review_required并提示用户可删敏后继续。扫描不是保证无敏感数据，产品不显示“已绝对安全”。可保留credentialRef而不保存凭据值。自动捕获默认不收集原始tool输出和思考，明确配置后仅采允许类型并脱敏。

审核状态机：

```text
draft → pending_review → accepted → committed
                    ↘ rejected
                    ↘ deferred → pending_review
                    ↘ needs_reapproval → pending_review
```

accept可以编辑、merge_into指定同scope目标；edit改变内容时reviewRevision增加，旧approval失效；编译者/提案者不能给自己做独立验证者，必须分别记录producer与reviewer。自动策略可提交明确低风险项目日志或已被用户授权的记忆写回，但不能给canonical、改anchor、扩scope、安装技能、导出私密数据或终裁自己的高风险候选。

规则闸门的写入裁决枚举为`accept/merge/drop/defer`，并带criteriaResults与reason；检索资格另用`accepted/rejected/deferred/blindspot`，不复用同一字段。policy缺失/版本不支持时，强审核写入返回policy_unavailable并保留候选；绝不降级成无审核写。

Receipt字段：`{requestId,operationId,state,committed,recordIds,revisions,duplicate,reviewId?,providerReceipt?,indexPending,warnings,occurredAt}`。state=`pending_review/queued/committed/skipped/rejected/failed/unknown_remote`。committed只能指真源已确认；异步语义提取的provider accepted不等于已生成目标记忆；skipped是合理结果。unknown_remote禁止盲目重发，先按operationId查询。

生命周期动作：archive减少常驻/默认搜索但可恢复；supersede保留旧证据与替代边；invalidate标错误不删原文；tombstone软遗忘并保留审计；restore需要明确授权且不得覆盖新版本；purge是单独管理动作，预览与范围确认后才不可逆清除。protected/anchor/canonical的普通forget拒绝并解释原因；解除保护/降权各是显式动作，不能通过导入或新revision绕过。所有动作接受reason，审计记录beforeHash/afterHash/actor/requestId而不复制秘密。

## 6. 检索与逐级披露

检索入口统一`search/recall/read/expand/related`，同一调用先固定scope、有效时间轴、generation、active空间和预算。搜索不隐式激活用户关闭的Provider；按需激活仅能在当前授权范围内并记录。无embedding时关键词/FTS/BM25可用；向量配置关闭不报服务不可用。

默认检索阶段：①在已授权runtime与managed documents找可回答的短证据；②并行检索active Memory Spaces；③各来源先执行适用/生命周期/信任筛选；④按各自rank进行RRF融合与精确重复去重；⑤按token/数量预算装包；⑥返回摘要、证据指针、未满足信息、Provider错误与质量统计。启用高级引擎后条件路由和T0–T3 tier并行显示，不改变scope硬过滤。

默认每回合至多一次自动动态recall、一次显式初始recall、一次不同query的精化和一次related；自动与显式共享2400估计tokens证据总包，避免工具并发绕过预算。同query+相同scope/generation/filters重复调用返回相同receipt/cache结果，不追加第二份上下文。用户明确“彻底检索所有历史”可开启独立任务预算，不能默默取消保护上限。

默认limit=8（1–50）；候选倍率3（1–5）；normalized-relevance低阈0.25、高阈0.6、中档最多4、未知量纲最多2；这组是初版可调产品默认。只对Provider声明的有限0–1相关度比较阈值，越界/NaN/无量纲变unknown；BM25、cosine距离、服务原始分数不能直接平均。跨Provider RRF输出rankScore，与confidence、trust分开。

结果类型为`{recordRef,title,summary,excerpt,source,scope,rank,score?,scoreSemantics,relevanceTier,qualification,trust,evidenceRefs,disclosure,temporal,warnings}`。disclosure=`abstract/overview/detail`；带可续读cursor、totalBytes、truncated、nextOffset；超预算不静默砍掉“不适用条件”和证据归属。read/expand返回固定revision；若源已变动，提示stale_cursor并可读新revision，不能混接两版本段落。

keyword是确定性子串/词项模式，basic是有限文本fallback，semantic需要可用embedding，smart可综合图/意图；用户选择semantic而服务不可用时可按配置fallback keyword，但结果必须标modeUsed。语言处理至少覆盖中英及混合符号/路径；CJK按真实usage校准token估计，不把字符数当token数。

negative/unresolved不进入普通推荐池，相关时作为有界覆盖尾，最多2条且不超过证据包20%；明确标“已失败/未解决”，score=0不冒充正向相关度。显式kind过滤可完整查它们；召回次数不能把未解问题自动提升成可信知识。重复否定同一hypothesisId幂等；同issueId更新线索保留createdAt与历史。

三阶段披露保留来源特色：L0/摘要→L1/overview或完整段→L2/原文/原回合。原会话回放依宿主授权接口，不枚举私人DB；资源URI由Provider读取，`viking://`绝不进入本地fs/bash工具。若原证据不再可访问，显示reference_unavailable并保留已授权摘要。

## 7. 信任、验证、反馈与代码影响

read-time TrustProjection=`trusted/review_required/stale/contradicted/insufficient_evidence`，另带reasons、freshness、temporal、applicability、authority、validation、degraded、recommendedAction。这是纯投影，读取不会悄悄更新record。优先级contradicted>stale>insufficient_evidence>review_required>trusted；UI保留所有触发信号，不能只显示最高项而隐藏缺依据。

trusted要求current、非candidate、适用条件可确认、未过期、未矛盾、证据可验证或明确人工声明，且验证状态足够。candidate永不trusted；文件hash变化stale；仅symbol但代码引擎缺失insufficient_evidence；validFrom未到review_required；条件不匹配为not_applicable且默认不注入；证据读取权限不够不转为“事实无效”，只标not_verifiable。

代码变化影响查询输入由代码域提供真实changedFiles/commit范围；输出directAnchors、transitiveDependencies、affectedRecords、trustSummary、coverage与degraded。相似文件名不是调用边；无代码引擎只能用路径/hash锚，不伪造AST关系。默认只读；createReviewCandidates=true需写授权，仅建候选，不改正文或权威。

验证动作`confirm/weaken/falsify/recheck`必须EvidenceRef和verifierIdentity；confirm不等于canonical；falsify生成negative证据并保留旧记录失效史；依赖一跳变doubted，多跳传播通过可预演的维护计划，包含maxDepth/maxNodes/cycle检测。传播达到上限返回truncated与frontier，不假装全图验证完成。

反馈记录`{recordId,applicationId,outcome:success|failure|partial|unknown,context,evidence,actor,time}`，相同applicationId重放幂等。recurrence按明确problemKey+scope+条件统计，不能按情绪或文本相似就断言复发。因果记录保留symptom/rootCause/remedy/verifiedOutcome与每段证据；时间先后和共现不能自动创建causal边。

## 8. 图、双时间轴和高级认知能力

图边枚举：`temporal/semantic/causal/entity/depends_on/derived_from/updates/extends/contradicts/supersedes/subject_relation`，每边有id、sourceId、targetId、type、conditions、strength?、evidenceRefs、createdAt、actor、revision。strength只有已声明量纲才比较；可缺失。端点不可读时不泄露隐藏节点ID/title；悬空边保留审计并列repair候选，不自动删。

图操作提供overview、局部k跳、指定edge、实体列表/反查、三元组subject/predicate/object过滤、观察时间/效力时间筛选、分页前聚合与稳定分页。默认局部hops=1、maxHops=3、nodes≤250、edges≤500；可配置管理预览更大但要虚拟化。移动节点/布局/颜色/筛选只改view preferences，不写关系。

时间线timeAxis=`observed/effective`，所有查询回显axis；无validFrom不伪造效力起点。支持时间窗相交、before/after/equal/overlap/contains/during等Allen关系和缺失端点unknown；空间bbox/RCC关系仅适用于有明确定义坐标系的记录，不拿代码路径当物理空间。状态链以subject+slot+有效区间输出current/history/retired，old/new均空非法，撤销为新事件，不删旧事件。

高级能力采用主包内认知模块或可选Python引擎，全部暴露统一action capability目录，默认不在常驻工具描述里膨胀。必须包含：

1. 条件路由、CCG编译/复核/attest、验证单元与依赖传播；候选编译保留span/sourceRef，独立复核检查遗漏/混淆，编译者不能自证；缺独立reviewer返回reviewer_unavailable，可显式选择降级但不伪称已独立复核。
2. 身份目录：user/agent/role/self观察、条件特征、位置、锚点、关系、历史和显式契约记录；自我/角色材料永不覆盖真人user画像，契约记录只表示用户授予产品行为的记录，不建立未经授权的权限。
3. 单主体状态卡与task/person/session/time/trust索引，refresh幂等、版本链、snapshot/bootstrap/relations/audit；状态卡引用原层正文，不重复搬运全部内容。
4. 信息缺口、轨迹、校准、盲区、信任、边界压力多维诊断。数值必须有来源公式和样本量，未实现指标显示unsupported，不能生成看似精确的伪数值；情绪推测不参与权限或事实信任硬判定。
5. 演化账本：缺失条件、规律、变更、证据、来源、节点史、聚类与回滚；rollback产生反向新事件，dryRun先给出影响，不抹历史。
6. 自净：sample/associate/audit/decontaminate/calibrate/sweep/history；默认只产计划，apply需权限、revision与预算；“污染”必须具体到来源或冲突，不因用户不同意见删除事实。
7. 因果path/chain/explain与伪因果检查；预测routes/feedback/stats，horizon默认3上限16、branchFactor默认5上限32、总节点有硬上限；结果标hypothesis、uncertainty、validity，声明不可预测或证据不足可返回无路线。
8. 推演分支fork/rewrite/search/merge/discard/list/tickets：与Git分支作用域不同；沙箱结果不进入真实记忆，merge提交候选，discard可审计且受管理授权。不得把推演当作已发生事实。
9. 文档/代码引用索引：只记录摘要/接口与源区间；支持增量、prune预览、maxFiles/maxItems、skippedSuffixes、hash漂移/悬空检查；源码仍属工作区真源。
10. peer互联：握手、协议声明、签名验证、信任观察/提升/降级/隔离/撤回/衰减、证据import/export；签名验证失败或未知协议fail-closed，不能因“可信peer”绕过本地scope/审核。网络默认关闭。
11. 文件/目录/JSONL/任务事件摄取、watermark、session note/recall/compact、长期固化promote/induce/contextualize与rollback；session compact委托上下文域，同一会话不得再开第二压缩器。
12. 自维持status/heartbeat/diagnose/heal/resume/note，所有计时器归宿主作业服务；关闭模块释放进程/定时器，不擅自重启宿主；generation指纹不同提示engine_restart_required，等待安全换代不强杀。

上述高级模块关闭时，能力页保留说明和启用操作，原数据可导出；调用返回module_disabled及availableAlternative，不“工具找不到”。仅有catalog不算功能实现完成，每簇须通过下文验收。

## 9. Provider与Source×Strategy契约

Source分为runtime、managed_documents、memory_spaces、session_references，可新增但API版本需校验。Strategy决定投影/检索/写回/维护参与，Provider决定空间原生存取。主包只暴露一套host生命周期协调器，各适配器不得自行第二次注入或捕获。

默认layered：profile/facts/key摘要常驻、文档先搜后读、空间按需；general在预算内统一检索；增强auto_capture、light_context、scoped可组合。开关Source只停该Source数据面、工具子动作与后台任务，不删除数据；管理目录仍能看到disabled。最少保留基础本地Source或明确整体关闭记忆，不能陷入页面空白。

ProviderDescriptor至少包含`{id,type,displayName,apiVersion,capabilities,scoreSemantics,connectionFields,workspaceBinding,dataBoundary,health}`。capabilities为search/browse/graph/entities/related/remember/link/forget/discover/get/reflect/pages/retain/resources/skills/export；writeMode=`exact/async_extracting/unsupported`，deletionMode=`soft/hard/unsupported`。服务连接字段与单空间字段分离，secret只存宿主secretRef；工具结果不含apiKey。

原M的9个Provider必须保留：native/OpenViking/Hindsight/Mem0/Honcho/Holographic/RetainDB/ByteRover/Supermemory；另将Memsearch作为共享Markdown+Milvus索引适配，灵枢作为可选本地认知引擎。基础local是默认，不能依赖native CLI才能工作。适配能力以当前服务版本探测，版本不兼容给version_unsupported并保留连接草稿；不以“统一了UI”声称各后端都有graph/forget。

Provider运行接口：`discover/status/search/get/list/related/graph/entityIndex/remember/rememberMany/retain/reflect/pages/resources/skills/link/forget/export/dispose`，按capability调用。分页有nextCursor与complete；query-only后端显示“先输入查询”，不是empty。discover只枚举凭据有权的namespace，OpenViking无admin key时可显式discoveryUser，不升级权限。

空间create/rename/activate/deactivate/merge有稳定spaceId、providerId+externalNamespaceId。deactivate不删远端，merge必须列出相同scope及capability、目标和源的明确映射，不能用“删除本地映射”伪装远端数据合并。自动放置只能在用户允许Provider、数据地域/隐私/能力硬约束下选择并记录reason/confidence；不允许模型发明endpoint或凭据。

O独有：viking虚拟树、L0/L1/L2、find/search、子树排除、peer all/actor、技能目录/经验、session commit、resume archive、捕获semantic/keyword、resource摄取/知识编译；retain捕获采用pending queue和operationId，短暂失败能同进程恢复。takeover只是上下文策略选项，启用时需上下文域确认唯一压缩所有者。

H独有：retain/recall/reflect、knowledge pages、mental models、world/experience/consolidated observation、initiative、Git播种/加深/代码普查、per-bank/path覆写、worktree共享、禁用转录但保留检索。autoInject可设pages/recall/reflect/none；默认选pages或本地recall，reflect显式启用预算，超时按pages→recall兜底并标fallback。页面禁用不删除旧内容；API accepted不是知识已可查，sync status分别显示queued/extracting/queryable/failed。

S独有：共享Markdown跨Agent、dense+BM25+RRF、chunk hash/增量watch、8 embedding Provider路由、可选reranker、search→expand→session证据、项目/用户维护和技能蒸馏。可直接复用原目录作为只读/协作模式，写入前确认所有权与文件格式；other agent的内容不能被“统一格式化”重写。

## 10. 捕获、后台作业与预算

事件输入由宿主适配层归一为session_created、turn_input、turn_completed、session_flushed、session_closed；不得依赖单一旧event。新宿主created与旧session-start双注册时用sessionId+activationId去重；resume无startup时pre-step兜底。只有真人新输入触发自动recall，工具续步、插件消息、时间提醒、其他Agent消息不触发一轮新召回。

capture默认在turn_completed产生候选摘要，captureKey=`hostId/originSessionId/originTurnId/schemaVersion`；普通新turn的origin就是当前来源。fork继承前缀按09章lineage标historical_replay，只重建读投影，不再摘要、写日志、retain或通知；无法证明origin时继承范围禁止外部写。日志与capture receipt原子提交。重复事件、重启、并行flush仅一份。失败/取消回合记录真实status，排除hidden reasoning、凭据、插件注入与重复recall。

Job字段`{jobId,kind,scope,generation,requestId,state,progress,checkpoint,attempts,maxAttempts,budget,cancelRequestedAt,startedAt,completedAt,error}`；state=`queued/running/awaiting_review/succeeded/partial/failed/cancelled/unknown_remote`。kind包含capture/summary/index/watch_refresh/review/consolidate/seed/deepen/pages_refresh/skill_distill/sync/migrate/repair。job创建即绑定允许scope/Provider/model/budget，后续设置变更不扩大权限。

基础capture/index不阻塞final回复；本地落盘默认2秒硬界，自动远端召回预算默认7秒、单Provider最大5秒，整包不超过7秒；用户显式工具可配置更长deadline。reflect工具默认120秒可升330秒；自动reflect默认20秒只在用户开启且预算允许时用。取消立刻停止新工作，向支持取消的Provider转发signal；已经远端受理的写返回unknown_remote/后台operation，不谎称回滚。

模型后台任务默认关闭付费seed与自动reflect；允许时选择inherit-global/inherit-session/fixed三种模型路由，记录provider/model/usage。idle review默认空闲30秒、最短间隔5分钟、每session最多20次（失败/取消计入）、输入上限24000字符、输出4096tokens；这些值可调且须回显当前有效值。检测用户活动停止/推迟任务；不能为了维护长期开一个子代理占住会话。

maintenance runner可每6小时检查，但各项默认关闭，最小实际间隔24小时；技能候选至少3次明确实例，导出为工作流域review提案，不自动install。seed上限300提交为可调兼容默认，但第一次启用必须预估范围与成本，不默认触发$2普查。所有网络、模型token、文件数量、图节点、输出字节均有上限；达到上限返回partial+continuation，不假全量。

后台并发：同scope写串行队列，不同scope可并行；全局索引最多2任务、远端请求全局默认4并发、单Provider默认2；这些不是语义写权限。锁应异步等待可取消，默认10秒超时，不busy-wait卡宿主。stale lock必须核实owner与lease，不能只按mtime删活跃锁。CAS冲突保留用户草稿并返回revision_conflict供三方比较。

## 11. 注入、缓存、epoch与配置热切换

与[07-cache-economics.md](07-cache-economics.md)及09章使用规范字段：memorySnapshotHash、memorySnapshotEpoch、memoryStoreRevision、toolSurfaceEpoch、promptEpoch、compressionEpoch。旧memoryEpoch/toolsetEpoch/snapshotHash仅在兼容导入时映射，不在公共输出独立维护。MemorySnapshot固定字节、字段顺序、LF、标题与排序，不含时间流逝、读取次数、当前计数、随机ID、在线状态、动态usage或“审查还有几轮”。

默认常驻MemorySnapshot≤1200估计tokens且≤25条，动态recall≤2400估计tokens且≤8条；记录估计方法，以usage校准CJK。1200/2400是可配默认，不能为省小量token每轮重写snapshot。正文hash与memorySnapshotHash不同；后台摘要/scope修改先推进memoryStoreRevision，只有接受新固定快照才推进memorySnapshotEpoch，不回改历史。

会话开始或显式memory refresh时构建snapshot，固定source revision集合与授权scope。已有会话中新写记忆只影响未来注入epoch，可在下一turn以一次增量recall附加；不能每轮删除旧消息、重新排序整个system、替换历史memory block或修改早期用户消息。用户显式refresh触发的未来epoch也以新增边界实现；若宿主必须重建上下文，走上下文域planned-rewrite并记录cache破坏与原因。

动态召回在当前turn由统一coordinator追加一次有source标记的内容，不拼进最早system前缀。source kind采用宿主合法的`plugin:<main-package>`，form=recall或其最新等价协议。trace包含recordRef+revision+hash+budget+qualification，模型消息不带secret/本地完整路径。无结果不注入“没有记忆”占位；失败在UI回合栏可见但无需在每轮模型上下文追加错误长文。

touch激活按工具真实规范化目标、touch时cwd和scope记录；相对path在发生时解析，cwd切换不重解释。触及集合会话内单调，resume可从宿主投影重建，fork只继承在分叉点已生效记录；不继承未来touch或另分支权限。路径激活只生成当前/未来turn增量，不改早期snapshot。

配置热切换先建candidate generation→校验连接与能力→原子替换future runtime；进行中turn和已委派任务固定旧generation，旧clients待引用归零再dispose。不因启用新Provider使旧子代理突然可读新scope。若配置无效保留旧图，UI显示draft error与active generation；不能保存后悄悄部分生效。

安全撤销、确认泄露、scope收缩优先于缓存收益。撤销record后立即从未来检索排除；已在模型上下文的敏感内容不能假装“删记忆就撤回”，需显式planned-rewrite或新会话，并清楚提示影响。缓存指标区分实际provider usage的cache_read/cache_write和prefixStable预测；未知cache数据显示unknown，不能以同snapshotHash宣称100%命中。

## 12. UI与桌面交互

统一工作台保留来源易理解结构，同时改进美观：左侧轻量导航“概览、我的记忆、项目关键、日志、知识与资源、空间、关系图、待审核、维护与同步”，顶栏固定当前查看工作区/作用域/分支、全局搜索与新建。页面可在主工作台、右侧栏和会话内打开，三者使用同状态/服务；不能不同入口各维护一份未保存编辑。

视觉使用主设计系统的颜色、间距、字体与圆角，浅深主题均可，禁大面积无意义炫光；信任态文字+图标+颜色三重表达。普通条目为紧凑列表，卡片仅用于详情与差异；关键字段先展示title/summary/scope/trust/source，hash、ledger、raw frontmatter放高级抽屉。默认中文，保留可本地化键与英语名称，窄窗支持抽屉，键盘可达。

搜索页：query、kind/track/scope/date/branch/trust/Provider筛选，模式选择、结果数、耗时、预算、partial；每条结果可读全文、证据、关联、存入、纠正。active filter用chips明确可清；筛到空态提示是哪项条件导致，不建议自动放宽scope。查询中可cancel；旧请求晚到不得覆盖新结果。

详情页：正文、适用/不适用、证据、生命周期/authority/validation、来源与版本、双时间轴、依赖与派生、反馈/复发、审计。编辑时保留expectedRevision，出现外部修改给本地/远端/合并diff；离开前保留草稿。删除/归档/保护/提升canonical等与业务语义一致，不共用模糊“清理”按钮。

审核页：分pending/deferred/needs_reapproval/decided，显示proposal与目标diff、来源、独立reviewer、scope变化和可能secret；接受/编辑/合并/拒绝/延期均可，批量只适用于同风险级且逐项结果可审查。异步Provider提交显示queued/extracting/queryable，不用一个绿色“成功”掩盖待处理。

日志页：五轨切换、日期范围、项目/分支过滤、摘要展开、原turn跳转、归档恢复、情绪反馈证据。每日日志按宿主时区分组但事件UTC储存，跨午夜明确归档日规则；改时区不改变captureKey或复制事件。

空间页：Provider状态卡、能力矩阵、空间namespace、激活、发现/重连、图/实体/列表/查询模式。没有browse能力显示“此服务仅支持查询”；未连接显示connect，断线显示retry，禁用显示enable，不把三者画成empty。链接外部控制台前使用用户配置的已验证地址。

图页：总览/本节点1跳/因果/矛盾/实体/派生/时间线切换，图例、搜索、缩放、适配、reset；节点可键盘列表等价查看。选点右侧详情，边标type与证据，不在图中堆全文；布局保存本机偏好。网络或代码引擎降级给coverage说明，不自动消失边。

概览：数量、待审核、过期/矛盾/无依据、存储容量、索引水位、后台任务、当前snapshotHash短码/memoryEpoch与真实usage；不把所有统计注入模型。回合记忆栏显示本轮recall/write/skipped/error、来源数、tokens/缓存实际或unknown，点击打开对应trace；完成回复一键“存入记忆”先给编辑和范围预览。

配置在主插件详情内统一“记忆”页：Sources/Strategy、基础存储、注入预算、自动捕获/审核、Provider连接、模型/成本、同步/备份、高级认知。输入类字段有草稿/应用，switch按明确live语义；secret不可回显，仅“已配置”+更换/清除。更换根目录只是切换路由，不默认移动旧数据，提供单独迁移向导。

## 13. 导入、迁移、同步、备份与外部编辑

迁移只在用户选定目录后读取，不自动扫描用户home和所有会话。向导执行discover→parse→map→validate→preview→apply→verify，preview列出来源版本、记录数、scope、候选/有效/归档、重复、冲突、不能解析、凭据风险、需外部服务的引用。没有可用license不删除用户数据能力，数据格式导入与代码复制许可分开。

八套兼容映射：

|来源|必须保留|
|---|---|
|A|每条md/id/title/path/tags/saved_at、个人/项目库、嵌套scope；MEMORY索引仅派生，不把它重复导入为记录。|
|L|layer、负记忆、六要素、条件、验证/保护、依赖/派生、双时间、主体、审计/审核/水位/图/推演分支；_index派生重建。|
|E|Hermes `§`、USER/MEMORY/KEY/两类日志、entryId、branch/dsh-only/summary、archive、SUGGESTIONS、项目身份与同步provenance。|
|M|runtime、documents、spaces、provider registry安全字段、策略、ZIP/Git和解；第三方服务原生数据仍外部引用。|
|O|viking namespace/user/peer、session/资源/技能引用、abstract/overview/detail、pending operation；无权读的内容不强行导入。|
|S|daily文档、session/turn anchor、PROJECT/USER、skill candidates、config非secret项、chunk哈希源引用；Milvus索引不当内容真源。|
|H|bank、external fact/page/model IDs、retain operations、world/experience/consolidated observation、valid/invalidated、entities/time；页只作为provider原生或显式导出副本。|
|V|SQLite导出后的body、各正交维度、证据、因果/图/负记忆/未解/反馈/复发/保护/审计；迁移后正文只保存在Markdown。|

导入requestId+sourceInstanceId+sourceId+sourceHash幂等；同源相同hash不重复，新hash以revision冲突方案展示；旧源不被删除/重写。apply原子批次，超过批量上限分checkpoint，取消后显示已提交数与可恢复位置。验证对比数量、scope与hash，不只看进度100%。

外部编辑：watch去抖默认1500ms，稳定读取后算hash，更新投影；非canonical格式允许只读/修复预览，不能全文件重写丢评论。替换操作持锁后重读并CAS，漂移备份到受控路径，返回backupRef；无变化不写磁盘、不变mtime。缺文件形成tombstone候选或external_deleted状态，不自动从远端复活。

Git同步默认off；关闭时不运行git、不读remote凭据、不提示每轮同步。启用后每项目opt-in，专用同步分支与manifest、稳定recordId，过滤凭据/索引缓存/临时锁/原始会话。push/pull用revision+baseHash三方合并；不同记录合并，同记录无冲突字段可合并，正文冲突展示local/remote/base选择；用户决定后生成新revision和审计。不允许last-write-wins静默抹内容。

同remote只作认亲建议，重名仓库、fork、多个tenant可不同projectId；冲突不得跨scope自动合并。同步remote删除变tombstone，恢复需显式选择；离线写本地durable queue，重连幂等。sync job状态显示local_committed/fetched/merged/pushed/failed及远端revision，不能把fetch成功当push完成。

ZIP备份含本地Markdown、审计/候选、非secret配置、作业/幂等必要状态与manifest/校验和，不含外部Provider全库和凭据、宿主原始会话、可重建大索引。export manifest明确exclusions、providerRefs、formatVersion、originTimeZone；导入先路径穿越/zip bomb/大小/文件数/hash/schema检查和预览。恢复默认merge，不覆盖整个根目录；rollback保留导入前快照指针。

## 14. 工具与RPC契约

统一模型工具建议 `nexus_memory`，可按宿主能力拆成`nexus_memory_read`等；最终名称由全局工具注册表仲裁。旧8套名称只做可选兼容别名映射，不能全部常驻导致工具schema膨胀。所有action有相同底层权限、预算和Receipt。多态工具整体不能谎标readOnly；若宿主只支持工具级安全标签，拆分只读与写action投影。

只读action：`search/recall/read/expand/list/related/status/health/trust/timeline/graph/entities/feedback_history/recurrence/diagnose/audit/capabilities`；写action：`propose/save/update/archive/restore/forget/protect/unprotect/verify/feedback/link/review/space_manage/import/sync/maintain/compile/reflect/seed`。reflect可能只是外部读但产生模型成本与provider日志，应按真实sideEffects声明；sync/import不能仅因“不改代码”标只读。

公共输入独立设计示例：

```json
{
  "action": "recall",
  "query": "Windows PowerShell 中文输出异常的既往修复",
  "scope": {"projectId": "prj_demo", "includeUser": true},
  "mode": "smart",
  "limit": 5,
  "budget": {"maxTokens": 2400, "timeoutMs": 7000},
  "timeAxis": "effective"
}
```

模型传projectId只能收窄当前允许scope，不能指定另一工作区。额外管理调用必须由宿主可信工作台context携带selectedWorkspaceId。

```json
{
  "action": "propose",
  "requestId": "req_example_001",
  "record": {
    "title": "当前项目在 PowerShell 中显式使用 UTF-8",
    "body": "在已验证的输出链路中使用项目确定的编码设置，并在更换终端后复验。",
    "track": "key",
    "kind": "lesson",
    "layer": "knowledge",
    "scope": {"kind": "project", "projectId": "prj_demo"},
    "conditions": {"applicableWhen": ["Windows PowerShell 输出链路"], "notApplicableWhen": ["尚未验证的其他终端"]},
    "evidence": [{"type": "test_result", "uri": "nexus-evidence:test_demo", "hash": "sha256:example"}]
  }
}
```

此例hash只是格式示意，不可当真实可验证测试。工具验证EvidenceRef存在且调用者有权，不接受凭空伪造uri。

```json
{
  "action": "update",
  "requestId": "req_example_002",
  "id": "mem_example",
  "expectedRevision": 3,
  "patch": {"summary": "终端编码修复与适用边界"},
  "reason": "缩短摘要，保留正文和证据"
}
```

响应统一包：

```json
{
  "ok": true,
  "data": {"items": []},
  "receipt": {
    "requestId": "req_example_002",
    "operationId": "op_example",
    "state": "committed",
    "committed": true,
    "recordIds": ["mem_example"],
    "revisions": [4],
    "duplicate": false,
    "indexPending": false,
    "occurredAt": "2026-10-19T12:00:00Z"
  },
  "context": {"generation": 7, "memoryEpoch": 2},
  "warnings": []
}
```

RPC命名空间固定`memory.*`经宿主API Gateway，不使用页面拼`http://localhost:port`。desktop `dsh-app://app/`、loopback、远程遵守宿主通信协议；remote管理默认只读，可读setting redacted snapshot，不能写、ZIP、改view/scope、导出私密正文或变secret。配置writeEnabled=false对全部产品写入口生效，但不代替宿主认证。

分页cursor绑定scopeHash/queryHash/generation/revision，不可跨scope复用。错误包`{ok:false,error:{code,message,retryable,stage,committed,operationId?,details},requestId}`；details不包含secret、不可读记录标题或原始请求全体。

错误枚举最低要求：invalid_argument、scope_unavailable、scope_denied、branch_unknown、path_outside_workspace、secret_detected、not_found、ambiguous_match、revision_conflict、protected_record、review_required、policy_unavailable、capacity_exceeded、lock_timeout、cancelled、deadline_exceeded、provider_unavailable、provider_unauthorized、provider_version_unsupported、capability_unsupported、module_disabled、index_pending、format_drift、schema_unsupported、stale_cursor、reference_unavailable、unknown_remote、quota_exceeded、budget_exceeded、engine_restart_required。UI将retryable与“可安全重试”区分，unknown_remote先查询操作而非重复提交。

### 14.1 高级认知操作完整迁移契约

此表是L的38个一级op的目标映射。`capabilityId`是内部能力标识，最终工具注册表可以改变外层名字，不能删除实际行为。统一高级调用包为`{action:"advanced",capabilityId,method,args,requestId?,expectedRevision?,budget?}`，RPC为`memory.advanced.call`；catalog按需返回单一能力schema，不能每轮把全部二级方法展开进system或工具描述。基础常用读写仍用前述简明action。表中R为只读，W为写或可能写，A为管理动作；实际sideEffects必须按method及apply二次判定，不能把整组标R。

|原一级op|目标capabilityId|必须保留的canonical方法与关键输入|结果、权限与特有限制|
|---|---|---|---|
|route|cognition.route|match：intent、view、scope、conditions|R；相关证据和建议能力，不自行执行建议。|
|read|memory.read|search/get：query或id、goal、includeRecent、offset、view、budgetTokens、excerptStrategy、mode、session、validity|R；稳定revision续读、tier、qualification、覆盖缺口与预算；goal只调检索排序。|
|write|memory.write|propose/commit：contentKind、dependsOn、importanceHint、gated、consistency、onConflict、derivedFrom、relation|W；统一写管线与Receipt，gated不能绕过强审核。|
|verify|memory.verify|confirm/weaken/falsify/recheck：id、evidence、verdict、marker、fact、questions、verificationTypes|W；独立验证身份、保护闸、依赖标疑与完整原文留痕。|
|review|memory.review|list/decide/records/rounds/stats/verifyRecord/backlog/preview/search：proposalId、decision、edits、mergeInto、olderThan、kind、sensitivity、query|列表R，决定W/A按策略；backlog和批量preview不隐式处理候选，no-op可统计。|
|protect|memory.protection|check/mark/protect/snapshot/history/stats/forgetting/forgettingHistory：id、reason、protectionPolicy|检查R，标记W；snapshot引用固定版本，保护与遗忘历史不可被常规purge误删。|
|identity|cognition.identity|profile/catalog/observe/trait/positions/anchor/history/contract/contracts：subjectId、subjectKind、trait、position、requestedLayer、contractId、grantor、grantee、docRef|查询R，观察W，改anchor和契约授予A；契约只是行为授权记录，不能让模型扩实际权限。|
|consistency|cognition.consistency|check/history/stats/catalog：candidate、excludeIds、maxDepth、autoFlywheel|检查R；autoFlywheel需W才建未解候选；循环/节点/增益预算与每条冲突依据可见。|
|metacognition|cognition.diagnostics|report/trace/calibration/blindspots/trust/selfCheck/history/dMeta/catalog：query、subject、window|R；只报告有公式和证据的指标；dMeta多维结果不能冒充真实情绪或心理诊断。|
|self_state|cognition.state|snapshot/refresh/bootstrap/relate/relations/index/dimensions/audit/history/summary/get/read/catalog：subject、dimension、links|读取R，refresh/bootstrap/relate为W；每主体一个状态卡与多维指针，重复刷新幂等。|
|evolution|cognition.evolution|record/entries/show/history/patterns/summary/rollback/catalog：rule、missingCondition、change、kind、entryId、source、dryRun|报告R，record W，rollback A；回滚建立新演化事件，不能消除审计。|
|sustain|cognition.sustain|status/beat/peers/diagnose/heal/evolve/start/stop/resume/note/catalog/provenance/poolCatalog/poolMeasure/poolCompare：intervals、autoFlags、allowEvolve、dryRun、pools、queries|状态/诊断R，写心跳W，启动/修复A；pool对比保留样本、配置、usage、延迟和结果质量，禁止捏造排名；全部任务归统一scheduler。|
|scrub|cognition.scrub|sample/associate/audit/decontaminate/calibrate/sweep/history/summary/catalog：ids、kinds、strategy、seed、minSeverity、apply、lexical|sample/报告R，apply A；固定seed可复现抽样，污染依据逐项明确，预览与实际revision一致。|
|predict|cognition.predict|routes/feedback/stats/catalog：startId或blindspotId、horizon、maxBranches、semantic、sort、predictedId、actualId、hit|路线R，feedback W；返回uncertaintyBound、extrapolationValidity、predictionHorizon和证据，不把候选当事实。|
|causal|cognition.causal|path/gate/chain/explain/catalog：a、b、relationTypes、direction|R；标记伪因果检查状态与路径覆盖，时间先后或语义接近不足以通过gate。|
|forget|memory.lifecycle|forget/restore：id、reason、force、overwriteLive、dryRun|W/A；force不能绕宿主授权，overwriteLive要版本冲突预览；普通forget软删。|
|goal|workflow.goalMemory|add/generate/list/setStatus：goal、priority、deadline、conditions、actionHint、sensitivity|实体由工作流域保存；生成只产建议，goal只导向记忆检索，不自动创建调度或执行任务。|
|task|workflow.taskMemory|open/status/planAdd/get/list/find/session/recordMemory/recallMemory/getMemory：taskId、plan、result、acceptance、boundary、condition、memory、includeHistory|任务由工作流域唯一管理；会话结果在contextual，经验候选在knowledge/unverified，不捕获全部中间过程。|
|recent|memory.recent|add/list/clear：text、role、meta、window、limit|R/W按方法；clear只清派生近期窗口，不删宿主转录和长期事实；同事件重放不重复。|
|state_event|memory.stateEvent|append：subject、slot、old、new、kind、seq、evidence|W；actor由可信context，old/new双空拒绝；查询走stateChain并显式timeAxis。|
|info|memory.info|summary：minSeverity|R；配额、层、关系、warning和可用能力；不得读取每份正文才显示状态页。|
|index_code|memory.referenceIndex|indexCode：path、patterns、skipDirs、prune、maxFiles、maxItems、incremental|W；只存接口/注释摘要；watermark在内容提交后；多根同名节点采用scope+sourceRoot+sourceRef稳定身份，不继承先到先占的数据遗漏。|
|index_doc|memory.referenceIndex|indexDocuments：同上另含sensitivity、maxHeadingLevel|W；正文在原文件；frontmatter中的井号不当章节；显式变密级不能被增量跳过。|
|ref|memory.reference|read/check/stat/prune：id或ref、roots、maxNodes、dryRun|前三R，prune A；stale和dangling分开；prune仅软删派生引用节点，源文件从不删除。|
|whitebox|cognition.whitebox|ask/ping/remember/report/verifyEncoding/verifyExisting：question、message、sessionId、marker、fact、questions|显式调用本地能力库；ask受模型预算，remember W；验证需真实测试/独立依据；“encoding验证”是语义编码质量验证，不等同文件字符编码检查；不得顺带写self层理论。|
|theory|cognition.protocol|check/show/declare/catalog：protocolId、version、declaration|查询R，declare W/A；兼容矩阵与协议hash固定，声明不证明外部peer可信。|
|link|cognition.peer|list/show/handshake/observe/promote/degrade/isolate/withdraw/decay/policy/card/publish/peers/evidence/export/import/derive/deriveDangling/deriveCatalog/deriveRebuild：peer、subsystem、positionMap、signature、subjects、pack、child、parent、ledgerOnly|本地查询R；联网/信任修改W/A；derive只读，rebuild默认dryRun；写来源边只经统一写管线，peer连接本身不能创建事实。|
|session|context.sessionMemory|note/recall/compact：sessionId、note、writeNote、budget|note W、recall R，compact由上下文域唯一所有者执行；压缩前捕获有一次性flush barrier。|
|ingest|memory.ingest|file/dir/jsonl/hive/stat：path、incremental、dryRun、watermark、maxEvents、mineFixPairs|统计R，摄取W；Hive任务事件仅适配输入，不依赖安装蜂巢；error默认私密，挖修复对默认关闭。|
|export|memory.export|graph/nodes/slice/stat：subjects、includeContent、since、until、tag、outputTarget|范围预览R，导出A按数据边界；模型不能自填任意out路径，输出只到宿主授予artifact目标。|
|maintain|memory.maintenance|stat/history/importance/longterm/prefeed/separate/rollback/backfill/cap/exempt/visionEvidence/refine/propagate及各自历史/回滚：mode、snapshotId、sampleN、prefix、batch、minJaccard、minDelta、minConfidence、apply|只读预演R，prefeed W，其余apply A；quota豁免必须有期限/理由；visionEvidence需要真实图像来源与权限，不能推测图里内容。|
|consolidate|memory.consolidation|promote/promoteRollback/promoteHistory/induce/contextualize/contextualizeRollback/contextualizeHistory：sourceLayer、targetLayer、minCluster、minMerge、minImportance、requireConditions、ids、reason、apply|管理预览/应用分离；归纳新规律是候选；contextualize改变层前列影响，不把长期知识误移成临时而无回滚。|
|insight|cognition.insight|window/record/verify/list/report/reconstruct/learn/outlook/catalog/fork/branchRewrite/branchSearch/branchMerge/branchDiscard/branches/tickets：clues、statement、state、windows、neighbors、sampleLimit、branchId、apply|读取R，record/branch写W，verify独立验证权限，批量apply/discard A；禁止bypassGain绕过全局scope、token和节点硬上限。|
|ccg|cognition.compiler|compile/review/attest/link/recalibrate/units/catalog：transcriptRef、producer、verifier、evidence、allowDegrade、apply|compile产候选，link才提交；凭据验签与self-reported身份分别展示，无独立验证不显示“已复核”。|
|status|memory.status|summary/describe/ledger：id、limit、cursor|R；紧凑状态头、单节点可读字段说明与版本事件，不重复整库内容。|
|edges|memory.graphEdges|query：subject/predicate/object、child、parent、ordering、aggregation、expandNodes、cursor|R；权限过滤后、分页前聚合；返回稳定排序、total和truncated，不能按当前页数量冒充全量统计。|
|audit|memory.audit|report：cap、scope、window|R；五面证据/覆盖、矛盾、验证、来源与生命周期审计；报告需具体record/evidence指针。|
|help|memory.capabilities|list/describe：capabilityId、method、schemaVersion|R；任何模块状态均能读最小帮助；无网络/无模型；按需schema的hash与toolsetEpoch关联。|

每个新capability manifest必须有`id/version/methods/aliases/inputSchema/outputSchema/permission/sideEffects/concurrency/maxInputBytes/maxOutputBytes/timeoutClass/scopeBinding/requiresModules/acceptanceIds/sourceRefs`。JSON对象只接收声明字段，数值拒NaN/Infinity，路径须正规化后校验最终边界，禁止任意Python表达式/模块名/函数名作为参数。args透传旧桥前先经过新Schema与权限，不能“为了兼容”将admin/actor/root/clearance等可信字段交给模型自报。

上游同义method如evolution的add/log、rollback/revert/undo和causal的reach/reachable可在alias表兼容，数据只走一个canonical实现。迁移验收应构建两张机器可读表：`source-surface-manifest`记录38个op、细粒度工具、真实dispatcher额外方法和库层委托方法；`target-capability-manifest`记录目标入口与验收ID。集合差必须为空或逐条标记“同义折叠到某入口”；“旧版本/接口失效/未维护”不能成为删项理由。元数据和dispatcher不一致时保留差异证据；不以某一张op表为唯一运行事实。

### 14.2 细粒度补充能力与跨域桥

L的细粒度工具还需覆盖以下独立语义，不能误把名字相似的操作当作同一功能：

|旧能力|新入口与输入|必需结果与边界|
|---|---|---|
|mdcg_reflect|cognition.reflection.record：query、k、feedback、evidenceRefs|记录信息差与反思轨迹；若D(t,C)、二阶差分缺真实样本则显示unknown，不生成伪精度；区别Hindsight远端reflect推理。|
|mdcg_flywheel|cognition.learning.recordError：query、expectedState、actualState、missingConditions|写unresolved候选并关联原失败；只描述误差，不能自动把模型猜测的修复写成verified。|
|mdcg_mine_fix_pairs|cognition.learning.mineFixPairs：events[{role,text}]或pairs[{error,fix}]、sourceRefs、dryRun|输出修复知识候选、相关negative与证据跨度；支持中文与中英混合；未审核前不直接覆盖正向事实。|
|mdcg_rejected|memory.negative.add：hypothesis、reason、verificationBasis、tags|同scope+hypothesisId幂等；保留否定依据与历史；普通负面情绪不自动变“被证伪假设”。|
|mdcg_unresolved|memory.unresolved.add：question、knownClues、goal|按issueId更新已知线索、保留firstSeen；找到结果后关联resolvedBy而不删除问题链。|
|mdcg_health/whoami/watermarks/service_info|memory.engine.health/identity/watermarks/info|返回实际版本、进程generation、库范围、授予操作、摄取水位；身份只显示调用者允许看到的字段，不泄露token。|

其他细粒度remember/recall/search/get/propose/review/forget/restore/identity等复用14.1对应服务；不能为每个alias另建一套数据库或审核逻辑。任务/目标桥以工作流域实体ID为真源；状态、代码索引、会话压缩均通过对应域API读取。高级引擎缺失时基础memory与negative/unresolved仍可使用；需要高级算法的调用返回明确module_disabled并提供安装/启用入口，不能悄悄返回伪造的空图或“全部通过”。

## 15. 验收清单

每项是必须验证的行为，不要求为每个小函数写镜像测试。使用合成项目/合成会话/假Provider与明确授权的集成环境，不读取用户私人记忆或实际购买模型预算来“验证”。性能数值在指定基准机器和数据集上给出测量；静态审阅不能标通过真实运行。

|ID|输入/操作|验收结果|
|---|---|---|
|MEM-001|全新桌面只安装主包，无Python/数据库服务/密钥|基础新增、检索、编辑、审核、日志、图与导出可用；无阻塞安装提示。|
|MEM-002|两个并行session分别在项目A/B，宿主启动cwd=A|各自只读本项目；UI选择B不改变A执行scope。|
|MEM-003|worktree与主仓，用户选择默认共享|同projectId，branchRef/touch独立；切换隔离后新操作在新scope。|
|MEM-004|title相同、scope不同的两记录|不自动覆盖/合并，搜索与计数按scope过滤。|
|MEM-005|密钥形态通过save/update/import/log/sync五条路径|全部拒存或待审且不回显命中secret，真源无明文新增。|
|MEM-006|save相同requestId重试、并发重试|仅一次revision与一份receipt，正文/审计不重复。|
|MEM-007|两个编辑者expectedRevision相同|仅一方提交，另一方revision_conflict且草稿保留。|
|MEM-008|正文已提交后索引故障|返回committed=true/indexPending；重建后可检索，不重复写。|
|MEM-009|手工加非规范注释后replace|重读发现漂移，备份并拒绝破坏性重写，原字节保留。|
|MEM-010|候选由模型生成|不进入ambient trusted；用户接受后方按策略投影。|
|MEM-011|审核后又编辑proposal正文|旧approval失效、needs_reapproval；不能用旧凭证落新内容。|
|MEM-012|编译者尝试自证六要素|拒绝独立验证声明，保留候选等待其他reviewer。|
|MEM-013|缺policy尝试严格写入|policy_unavailable，无无审核fallback。|
|MEM-014|普通forget protected/anchor/canonical|拒绝并解释；显式解除保护后动作有独立审计。|
|MEM-015|archive→restore/supersede/invalidate/tombstone|原文、来源、关系与历史可追溯，默认搜索符合状态。|
|MEM-016|profile/facts/key和两类日志写入|五轨视图正确，日志不被默认全量注入。|
|MEM-017|project+daily批量日志，重复turn/end|一个captureKey、两视图引用，不计成两条事实。|
|MEM-018|branch include=feature，当前main/unknown|自动注入不含feature记录，all记录仍可用。|
|MEM-019|在cwd1触及x后cd到cwd2，再触及x|两次按发生时cwd解释；不错误去重、不跨目录误激活。|
|MEM-020|resume/fork touch状态|resume可重建；fork仅继承分叉点已发生事件，不见未来touch。|
|MEM-021|无结果/工具续步/插件消息|不新增空记忆块，不重复自动recall。|
|MEM-022|同query并发recall+一次不同query refine|重复重放；共享证据预算、次数上限不能被并发绕过。|
|MEM-023|Provider分数BM25/距离/NaN/无score混合|量纲保留，未知不伪置信度，融合确定性。|
|MEM-024|keyword/semantic服务断线|基础仍可查，fallback明确modeUsed和error。|
|MEM-025|超长read后修改源再续读|stale_cursor，不混合不同revision。|
|MEM-026|negative/unresolved与正向结果同查询|有界覆盖尾清楚标失败/未解，不作为推荐方案。|
|MEM-027|代码hash变更/缺symbol引擎/未来validFrom/矛盾|五级trust及全部原因正确，读取不改record。|
|MEM-028|verify/falsify依赖节点并多跳传播|一跳标疑，多跳有计划/上限/循环与frontier，不悄悄改所有正文。|
|MEM-029|相同applicationId反馈重复|一次反馈；recurrence按problemKey与scope可解释统计。|
|MEM-030|图节点拖动、布局重置、过滤|record/edge revision不变；键盘列表能等价访问。|
|MEM-031|权限过滤隐藏节点但公开节点关联它|无隐藏ID/title/计数泄露，边标受限而不展开。|
|MEM-032|观察时间与效力时间相反|timeline回显axis并正确排序，关系unknown不乱猜。|
|MEM-033|高级认知模块开/关/不可用|catalog与入口保留，能力成功或准确module_disabled，不假结果。|
|MEM-034|CCG/身份/状态卡/校准/盲区/演化全簇|逐簇可执行、可审计、有真实来源；未知指标不虚构。|
|MEM-035|因果路线与语义相似边|相似不自动因果；预测标hypothesis，深度/分支/节点预算生效。|
|MEM-036|推演branch rewrite→search→merge/discard|隔离真实事实，merge走候选，discard留审计。|
|MEM-037|peer签名无效/协议未知/跨scope导入|fail-closed，本地权限不因peer trust绕过。|
|MEM-038|代码/文档引用索引不支持后缀、文件删改|coverage/skipped/truncated/stale/dangling明确，不假全覆盖。|
|MEM-039|9个M Provider加S/L可选适配目录|每家均能配置、探测、显示真实capabilities；禁用不删数据。|
|MEM-040|query-only Provider/no graph/no forget|对应状态明确，操作不调用未支持接口。|
|MEM-041|Provider write accepted但extracting|receipt queued且committed不假真；查询到后变queryable。|
|MEM-042|写已远端受理时取消/超时|unknown_remote+operationId，重试先查，未重复retain。|
|MEM-043|OpenViking URI交给本地fs或shell|被路由保护，必须Provider读取；子树/peer过滤有效。|
|MEM-044|OpenViking捕获短暂失败后恢复|同进程pending queue继续drain，无需重启、无重复。|
|MEM-045|H autoInject四档/reflect超时/页禁用|四档可用、pages→recall可见fallback、禁用不删页。|
|MEM-046|H retainSessions=false/seed/initiative|只关转录；seed有预算/租约/进度，initiative可查页。|
|MEM-047|S chunk未变/改/删与model改变|未变不embed，改删清旧块，model变更重建明确。|
|MEM-048|S summary失败|写可追溯摘要失败标记，无完整原转录泄露，错误可见。|
|MEM-049|三次同工作流实例蒸馏技能|候选含证据与review，未经工作流授权不安装。|
|MEM-050|用户开始输入时idle review运行|任务取消或暂停，新写不越过固定scope/预算。|
|MEM-051|设置热切换Provider与scope，旧子代理仍运行|旧任务固定generation，新任务用新图，旧权限不扩大。|
|MEM-052|引擎磁盘generation与进程不符|engine_restart_required，安全换代不重启DSH宿主。|
|MEM-053|每轮日志增长/计数变化/检索排序变化|已提交system/MemorySnapshot字节及hash不变，历史不重写。|
|MEM-054|写回新记忆后下一turn|只影响未来memoryEpoch/新增recall，旧turn消息hash不变。|
|MEM-055|真实usage无cache字段但snapshot稳定|显示cache unknown与prefixStable，不报100%命中。|
|MEM-056|用户安全撤销已注入敏感记忆|未来检索立即排除，明确需要planned-rewrite/新会话，不虚称撤回历史。|
|MEM-057|CJK大正文接近token上限|估计记录并真实usage校准，条目/证据不默默超总预算。|
|MEM-058|8类合成旧数据分别preview/import/reimport|字段/来源/归档/分支/证据不丢；重复幂等，原源不改。|
|MEM-059|高schema/损坏格式/未知enum导入|只读预览/映射修复，不静默降版本丢字段。|
|MEM-060|导入中断、进程崩溃、checkpoint重启|显示已提交数与恢复点，已导入不重复，未提交不假成功。|
|MEM-061|同步off与项目未opt-in|不运行git、不读凭据、不上传该项目。|
|MEM-062|本地/远端对同条正文修改|三方选择后新revision，绝无LWW静默覆盖。|
|MEM-063|两个同remote但不同tenant项目|仅建议认亲，未确认不合并。|
|MEM-064|ZIP路径穿越/巨量压缩/坏hash|预览前拒绝危险载荷，工作区外无写入。|
|MEM-065|ZIP导出后恢复|本地内容/候选/必要状态可核对，外部Provider和secret明确excluded。|
|MEM-066|非受信远程调用写/ZIP/设置/secret|宿主认证与产品scope双层拒绝；redacted读取可用。|
|MEM-067|暗色/窄窗/键盘/屏幕阅读器|五级信任有文字，所有图动作有等价列表、焦点可见。|
|MEM-068|搜索先A后B，A更晚返回|B结果不被A覆盖，cancel无残留loading。|
|MEM-069|内存根从A切B|预览说明只是路由，A不移动/删除；需迁移另操作。|
|MEM-070|旧接口插件功能复活映射检查|每项研究矩阵能力能定位新入口/action/模块与验收，不以停更/旧event遗漏。|
|MEM-071|源op元数据漏ref/check、review/backlog、consolidate/induce|source/target manifest对账捕获差异，真实能力在目标可用，未知方法不落入默认写分支。|
|MEM-072|whitebox verifyEncoding与verifyExisting|仅显式启用才调用；结果带真实测试问题/来源/usage；缺引擎不显示通过，不顺带写self理论。|
|MEM-073|L reflection与H reflect同在目录|用途、输入、模型费用与结果区分；信息差无样本显示unknown，不混用同一action实现。|
|MEM-074|错误/修复日志挖掘与flywheel|生成带证据跨度的unresolved/negative/修复候选；重放幂等，未验证不晋级已证实知识。|
|MEM-075|goal/task在记忆页新建与工作流页查看|同一实体ID和状态，无第二任务数据库；goal不偷偷创建schedule或执行动作。|
|MEM-076|poolMeasure/poolCompare超过模型/查询预算|停止并返回partial与真实样本数；质量与延迟分开，未执行样本不出虚构分数。|
|MEM-077|索引内容提交前后分别崩溃、deriveRebuild预演|watermark不领先内容；重建先报告差异，apply受权且原事实/源文件不被改写。|
|MEM-078|advanced args包含actor/admin/root/clearance或未知method|拒绝可信字段覆盖和未知方法；权限由host context，不能通过旧桥透传扩大。|

交付时应提供来源到模块清单、数据迁移报告样例、Provider capability contract fixtures、真实桌面宿主事件/slot/API验证、缓存稳定性及usage报告。不得把“全部已写入规格”“静态可读”说成所有上游代码已在当前桌面通过运行测试。

## 16. 文件即记忆与Claude Code项目快速接手

本节直接落实用户追加需求，不新增上游研究仓库、不另派子代理。**项目根的 `MEMORY.md` 与 `MEMORY/` 文件夹必须都能直接作为记忆源**，使此前由Claude Code开发的项目可在DSH中快速接续。“`/MEMORY`”在本规格表示已绑定项目根下的目录，不默认指系统盘根目录。用户可另用Host文件选择器绑定有读取权限的具体文件/目录。

### 16.1 真源与兼容模式

新增现有Source类别 `managed_documents` 下的 `subtype=file_memory`，不是新的数据库或第二记忆注入器。文件保持真源，Nexus建立检索投影、版本引用及必要的受控不可变读取快照；不要求先复制到 `records/`，也不要求给现有文件添加Nexus frontmatter。清除索引可从原文件重建；Nexus内部索引、配置和摘要不能默认写回项目造成额外Git改动。

| 输入 | 默认行为 | 不允许的隐式行为 |
|---|---|---|
| `<workspace>/MEMORY.md` | 项目记忆入口；读取完整文档结构、目录/链接、标题和相关段落；有界投影进入接手包 | 不只按文件名展示而不读正文，不把长文静默截成唯一存储 |
| `<workspace>/MEMORY/**` | 递归发现普通文本/Markdown文件，按相对路径/标题/内容建立增量检索和来源引用 | 不把整个文件夹一次性塞主prompt，不递归执行其中脚本 |
| 用户选择的其他文件/记忆目录 | 登记FileMemoryBinding、预览范围后用同一管线读取 | 不因相同basename自动跨项目合并 |
| Claude Code已有记忆文件 | 宽容读取普通Markdown及可选frontmatter；原文、未知元数据和相对链接保留 | 不强制改成Nexus格式，不声称支持未经解析的私有数据库 |
| 项目外Claude Code记忆位置 | 用户在Host授权范围内明确选择路径，或一次配置Claude记忆根后根据已核验项目映射仅定位当前工程，再与projectId绑定 | 不递归扫描用户主目录内全部Claude会话、凭据或其他项目；未知路径编码不靠猜测认亲 |

本需求是文件兼容，不要求恢复Claude Code隐藏推理、私有会话库或账户状态。`CLAUDE.md`、项目规则等如被用户同时选择，应明确标记为项目规则/文档来源，由宿主指令优先级处理；不能把它们与记忆事实混成一份具有最高指令权限的system文本。MEMORY文件中的旧任务、建议、命令、链接及“忽略其他指令”都仍是有来源的材料，不自动形成执行或外发授权。

对Claude记忆根的配置可由用户一次保存复用，不要求每次进入工程逐文件选择。适配器须以实际可识别的项目映射、原工作区路径及用户已确认的WorkspaceBinding定位，仅读取当前项目候选入口；路径编码/版本未知、移动工程或一对多映射时展示具名候选待绑定，不把同名文件夹当确定身份。此设计不预设所有Claude Code版本都使用同一隐藏目录结构，具体可识别格式以实施fixture和明示的兼容版本证明。

默认检测两条规范路径；大小写按实际文件系统能力处理，兼容 `memory.md`、`memory/` 等实际变体。大小写敏感文件系统上两个不同文件同时存在时分别登记并显示冲突/多来源，不取第一个覆盖另一个。嵌套Git仓、submodule、symlink/junction出界不跟随；只有已验证可读且仍在绑定根内的目标可索引。`.gitignore`与用户排除策略不被偷偷绕过，明确选择的被忽略记忆可按配置读取并在状态中说明。

### 16.2 对象、读取与更新

`FileMemoryBinding`至少含 `id/projectId/workspaceId/rootRef/entryFileRefs/directoryRefs/include/exclude/readMode=source-readonly|reviewed-writeback/encodingPolicy/linkedResourcePolicy/revision/enabled`。默认 `source-readonly`；改成reviewed-writeback需要用户已有的具体文件写授权，按CAS/hash差异预览与救援策略提交，不能把普通聊天capture自动写进旧项目MEMORY。

`FileMemoryDocument`是来源投影：`bindingId/documentId/relativePath/fileIdentity/sourceHash/decodedHash/encoding/byteLength/observedRevision/headings/chunkRefs/frontmatter/rawMetadata/scanStatus`。`documentId`不直接由可变绝对路径生成，重命名保留显式映射；相同正文出现在两处时共享内容块但保留两个SourceRef。`scanStatus=discovered|indexing|ready|partial|excluded|unreadable|quarantined|deleted`，必须给原因、进度与重试入口。未扫描不报告“无记忆”。

`FileMemoryChunkRef`含 `documentId/sourceHash/startLine/endLine/headingPath/chunkHash/binding=pinned|live`，行号对应解码后的原文件，保留原字节hash和编码，不用美化后的行号冒充原始定位。UTF-8及带BOM的UTF-16可读且不修改原编码；其他编码按明确候选探测或用户选择，不用乱码继续索引。二进制、超大文件、读取失败逐项记录；默认单文件2MiB软限、后台批次256文件/16MiB，可按项目调大或分块，不静默丢弃剩余文件。相对Markdown链接可在同绑定根内按需展开，循环有visited/depth/总字节上限；远程URL只保留引用，不自动fetch。

首次可信工作区绑定后只读检测、索引和相关召回可以按保存的项目记忆策略自动进行，无需逐文件重复确认；未受信项目先静态预览，按Host信任规则决定读取面。文件watcher用debounce合并变更、比对实际hash而非只mtime，定期补扫恢复丢事件。变更只重建受影响块；未变文件不重新embedding、不调用摘要模型。解析在worker完成，可暂停/取消，不阻塞会话启动。

源文件删除/禁用后不进入新召回；旧会话已发送内容不能声称从模型侧撤回。普通编辑不覆盖历史固定引用，快照遵第09章pinned合同；显式敏感撤回立即阻断未来发送并提示计划重建/新会话。发现疑似秘密的块进入隔离或脱敏视图，默认不复制到持久blob、不发外部embedding/模型，不在错误或日志回显内容。

### 16.3 快速接手与缓存合同

新工作区第一次任务形成 `ProjectHandoffPacket`，至少包括记忆来源清单、读取覆盖率、项目摘要/已知约束、已记录决定、未完成事项/失败教训、相关代码/测试/文档引用及冲突。字段必须能追到具体文件hash/行范围；原文没写的状态标unknown，不能把待办当已完成、旧测试结果当当前验证。默认初始包上限2,000估计token，**计入全局ContextPlan和记忆预算**，不另开不受限额；入口索引优先，更多正文通过 `nexus_memory.search/read` 按需展开。

“迅速”主要靠本地结构读取、keyword检索与已有索引，不强制先付费生成整仓摘要或跑向量库。初次读取MEMORY索引及相关小文档后即可给出有证据的接手概览，其余后台继续；索引未完成明确partial和覆盖，不阻止已知部分使用。大目录以分页/分块渐进完成，用户能查看尚未读取/排除项。

Packet被接受进入会话后固定 `memorySnapshotEpoch`、来源hash和字节；watcher只推进 `memoryStoreRevision`，不能每次文件变化重排原system段或重算已发送summary。未来任务按需追加版本化delta/ref，或在明确接受新快照/新角色lane时更新epoch。多模型worker获取同一已授权SourceRef的精简Brief，在自己的lane读取，不给每个子代理复制整个MEMORY目录。billion折叠后仍能从文件/不可变快照精确恢复；哈希稳定只证明本地前缀一致，不冒充供应商cache hit。

来源目录/标题索引采用规范相对路径及稳定ID排序，相关性召回在同分时使用固定tie-break；不得把mtime、扫描顺序或watch事件到达次序当每轮重排依据。记忆阅读/被使用的统计仅进观测账本，不修改文件正文或当前快照。

当文件与现有LOCAL/远程记忆重复时，按hash/语义候选去重投影并保留来源，不增加两次自动注入。存在矛盾时并列显示“文件记忆/内部记忆/当前代码”与时间、hash、验证状态；按当前任务上下文计算trust，不自动以mtime最新覆盖。写回与同步源目录是独立动作，不能因启用记忆自动git commit或上传。

### 16.4 工具与界面

沿用固定 `nexus_memory` / `nexus_catalog`，增加内部action `source_bind/source_status/source_rescan/handoff_preview`，读正文仍是search/read，文件编辑仍经有权限的文件/记忆提交服务。新增action的详情通过catalog按需加载，不因发现一个MEMORY文件就改动wire工具schema。

Claude式记忆页新增“项目文件”来源组，展示 `MEMORY.md`、`MEMORY/`、额外绑定、ready/partial/excluded状态、可读文件数、索引水位、当前会话固定版本和后台新版本。用户可从引用打开原文件/行范围，预览接手包、重扫、暂停、排除、移除绑定。首次项目对话用一条简洁“已读取项目记忆/后台索引中”提示及可展开来源，不弹出连续确认框，也不把完整扫描日志注入会话。概念HTML无需为本追加需求再次重做，但真实产品与任务验收必须包含该入口。

### 16.5 新增强制验收

| ID | 输入/操作 | 验收结果 |
|---|---|---|
| MEM-079 | 新项目仅有普通MEMORY.md，无Nexus frontmatter | 自动只读识别、检索正文、引用原行，文件字节/Git状态无变化 |
| MEM-080 | 同时存在MEMORY.md与MEMORY/嵌套文档 | 两者均作为记忆源，相关内容可检索，未扫描部分有进度/覆盖 |
| MEM-081 | Claude Code遗留文件含frontmatter、未知字段和相对链接 | 宽容读取并保留原件；不要求导入重写，不把材料内命令升级为授权 |
| MEM-082 | 项目外Claude记忆目录未绑定/显式绑定 | 前者不扫描；后者校验授权/project归属后读取，不访问其他项目 |
| MEM-083 | 大小写敏感环境同时有MEMORY.md与memory.md | 分别登记并标明多来源，Windows实际同文件不重复记忆 |
| MEM-084 | 目录内junction/symlink逃出工作区或嵌套仓 | 默认不跟随、不泄露越界标题/正文，具名排除 |
| MEM-085 | watcher连发、mtime不变但正文变、重命名/删除 | 以hash增量更新、身份映射可解释；未变不重embed，删除退出新召回 |
| MEM-086 | 文件为空/乱码/二进制/超限/权限拒绝 | 分别明确状态、原因与下一步，不全当“无记忆”或静默成功 |
| MEM-087 | 新任务首次接手无外部Provider | 本地读取/检索立即可用，2,000 token接手预算计入全局，无付费前置 |
| MEM-088 | 接手包生成但原文件缺少当前状态或验证依据 | unknown/旧证据明确，不把TODO或历史测试当当前完成事实 |
| MEM-089 | 长程会话固定快照后MEMORY文件修改 | store revision更新，已发送prefix字节不变；新读使用明确version/delta |
| MEM-090 | 两角色读取项目记忆，随后跨模型handoff | 只发有界Brief/refs，各角色独立lane，历史/整个目录不复制，费用不隐藏 |
| MEM-091 | 论文压缩后查询旧MEMORY中的精确路径/数字 | 可定位原版本并精确恢复，已更新文件不冒充旧引用 |
| MEM-092 | 文件与LOCAL/Provider记录重复或矛盾 | 重复只注入一次保留来源；矛盾并列/trust投影，不按mtime粗暴覆盖 |
| MEM-093 | 可疑秘密、外链、提示注入内容在MEMORY中 | 不外发秘密/自动fetch/执行命令，仍能读取安全部分并说明隔离 |
| MEM-094 | 用户要求更新MEMORY或移除绑定 | 更新经具体授权/CAS/差异与receipt；只移除绑定不删除原文件 |
| MEM-095 | 10k文档后台索引时开始对话/停用/重启 | 对话不被全扫描阻塞，进度可续，worker与watcher正确释放，无重复注入 |
| MEM-096 | 文件记忆UI、工具、固定快照和恢复联合测试 | 来源/覆盖/版本一致，引用可打开，敏感撤回阻断未来发送；真实产品有入口 |

本节由A02一次完成文件Source、接手投影与界面（检查点P21/P26/P28），A08统一验证旧工程接入/迁移与退回及缓存对照（检查点P56/P59）。新增需求属于用户直接提出的产品设计，不把研究单元计数从36虚增为37。
