# 08 工程质量、文档与软件工程生命周期规格

版本：0.1.0。研究基准日：2026-10-19（UTC+8）。产品暂名：DSH Nexus（枢纽），命名空间 `nexus`，包占位 `@local/dsh-nexus`。证据：[07-quality-evidence.md](../research/07-quality-evidence.md)。本文规定可直接实现的行为、对象、边界、失败语义和验收；“净室软件开发级别”仅是详尽程度要求，允许在许可允许的范围直接组合、修改和复用源码。

本文的 `nexus_quality`、`nexus_workflow`、RulePack、QualityGate 等都是**本产品拟定接口**，不是 DeepSeek Harness 官方现成 API。宿主的工具注册、权限、job、会话、UI、文件访问和Desktop安装所有权服从宿主适配规格。上游资料中的步骤或命令是研究输入，不自动成为当前使用者指令。旧接口过时只意味着迁移适配，不能据此去掉旧有功能。

## 1. 产品范围与职责

本域把 `how-to-lint` 和 `software-engineering-workflow` 转化为用户可调用、模型可调用、可取消、可解释、可恢复的能力。用户可以在一个工作台完成项目规范发现、规则目录搜索与说明、配置采纳、检查计划、分层增量lint、类型/模板检查、跨边界语义审查、诊断比较、修复预览与回滚、质量门、证据收集，以及需求—设计—执行计划—实现—验证—审阅—交付的完整生命周期。还包括README/CONTRIBUTING/架构/ADR/Issue/PR草稿、双语文档、独立冷读、八类SVG图和自定义工作流。

本域不再创建第二套作业调度、模型计费或文件内核。`nexus_workflow` 是工程生命周期与文档方法的入口，编译到04章的 `TaskPlan`、`Run`、`Artifact`、`Receipt`；`nexus_quality` 负责确定性规则、工具适配、增量检查、诊断、修复和质量门。昂贵语义审查使用同一个Code Review引擎，图形产物与Archify共享产物管线，OPS提供有界IO和结果引用。UI和模型工具调用同一个domain service，不能出现按钮执行一套规则、工具执行另一套规则。

### 1.1 必须满足的结果

| 用户目标 | 产品必须给出的可观察结果 |
|---|---|
| “看看本项目现在有哪些检查” | 真实项目画像、命令来源、覆盖语言、作用域、配置冲突、缺失依赖和未验证项 |
| “采用这套规范，别破坏现有规则” | 最小配置变更预览、冲突解释、具体规则选择、授权范围、可回滚回执 |
| “只检查本次改动，尽量便宜” | 明确base/head/工作树快照，分层影响集合、稳定诊断差分和未覆盖声明 |
| “我要最终质量门” | 针对指定快照与策略版本的门决定、真实证据、缓存复核来源、无法验证项 |
| “修复这些安全问题” | 每项可修性与原因、精确diff、前置hash、受限应用、冲突保护、幂等与回滚 |
| “把项目流程规范起来” | 真实文档/平台约定画像、生命周期模板、本地草稿与任务计划，不编造命令或历史需求 |
| “写一份别人能接手的设计” | 版本化需求/设计、职责归属、图、失败与恢复约定、独立冷读结论和未解决问题 |
| “长程开发不能反复掉缓存” | 固定工具面、按需规则、报告摘要/引用、稳定epoch、可逆压缩、provider缓存指标或unknown |

### 1.2 合并择优决策

| 责任 | 主实现/方法来源 | 保留的其他优势 | 防重复规则 |
|---|---|---|---|
| 风险分流与计划尺度 | Aegis | Superpowers的问题分析、调试与执行技能 | 一次路由产生一份计划；tiny任务允许fastpath，不加载两套完整bootstrap |
| 确定性质量规则 | how-to-lint | 项目既有规范、ESLint/compiler/vet生态 | 每项diagnostic有唯一owner，formatter/unused/typechecker不重复负责同一检查 |
| 复杂语义与代码审查 | Code Review | Aegis证据分级、Superpowers独立上下文 | 复用同一preview、固定快照、预算和审查结果，不重复发相同文件 |
| 工程文档与生命周期 | software-engineering-workflow | Aegis基线/ADR、Superpowers计划执行 | 文档真源单一，生命周期节点编译到04章运行时 |
| 文件/结果/批处理 | OPS | 宿主沙箱与正式job服务 | 一份底层执行与回执，Native/PTC同语义，工具表不随每次任务变化 |
| 绘图 | SVG方法规范与共享产物管线 | Archify typed IR/renderer/HTML预览 | 一份图形artifact保留源、渲染与验证状态，不双份独立真源 |
| 完成汇总 | Aegis单一closeout模式 | lint、测试、审阅、文档证据 | 只聚合真实结果；方法包、模型、lint各自不能冒称拥有最终授权 |

所有上游特有能力保留为可选路由、模板、策略或执行模式。过时后台API迁入统一Run/job并恢复质量后台任务、进度、结果引用与续接，不保留空操作却显示成功。TDD、全量计划、独立审查的默认强度由用户/项目/风险策略决定，不叠加多套上游强制。

## 2. 公共合同、入口与参数

### 2.1 两个稳定工具

工具注册只发布固定的 `nexus_quality` 和 `nexus_workflow` 两个入口。名称、说明、schema序列化顺序、action顺序、枚举顺序和版本必须稳定。启停规则、切换项目、运行开始结束、进度变化不改变注册表；能力状态放在工具返回数据。正式SDK不支持某schema形式时由host adapter投影，domain参数合同保持不变。

```ts
type NexusRequest = {
  contractVersion: "1";
  action: string;
  projectId?: string;
  payload: Record<string, unknown>;
  output?: {
    detail: "brief" | "normal" | "full";
    maxItems?: number;
    maxBytes?: number;
    cursor?: string;
  };
  clientRequestId?: string;
};
```

`action`采用静态枚举，`payload`按action进行严格校验，拒绝未知字段和错误类型；不是可执行JavaScript。宿主允许时使用discriminated union；不允许时仍在domain进行同等校验并返回字段错误。单次payload默认不超过256 KiB，路径数量默认2000，单字段长度按各schema限制；大内容通过受控artifactRef，不通过字符串无限内嵌。`clientRequestId`用于同一操作的幂等去重，不提供额外权限。调用者提供绝对路径或project内规范相对路径，最终读取范围以宿主授权根为准。

返回采用04章公共信封，扩展以下质量字段，不能丢失 `status`、`effectState`、`error`、`coverage`、`receipts`。`completed`仅表示请求操作结束，不等于质量通过。

```ts
type QualityData = {
  subject: { projectId: string; snapshotId?: string; scopeHash?: string };
  resultRef?: string;
  digest?: string;
  epoch?: string;
  summary?: {
    errors: number; warnings: number; new: number; resolved: number;
    unchanged: number; unknown: number; skipped: number;
  };
  execution?: "fresh" | "revalidated_cached" | "mixed" | "not_run";
  verification?: "passed" | "failed" | "partial" | "unknown" | "not_applicable";
  stale?: { value: boolean; reasons: string[] };
};
```

完整报告通过resultRef分页读取，brief默认最多20条诊断、10个阻断项、24 KiB；超过预算时返回清晰的truncated、总数、cursor和原文引用，不截成看似完整的结论。`maxBytes`以UTF-8编码字节计，token估算单列并标模型/估算方法。

### 2.2 `nexus_quality` action合同

| action | 关键payload | 行为与输出 | 副作用/约束 |
|---|---|---|---|
| `discover` | roots、scope、refresh、executionPolicy | ProjectProfile、命令/配置来源、依赖与覆盖缺口 | 默认只读，不执行配置JS、脚本或包安装 |
| `catalog` | language、topic、severity、query、cursor | 稳定ruleId、摘要、默认级别、detector状态、来源hash | 不自动加载所有规则正文 |
| `explain` | ruleIds、includeExamples、contentHash | 选定规则正文、例外、适用域、检测边界、fix安全 | 长正文分页，正文按hash复用 |
| `plan` | snapshot、scope、layers、profileRevision、budget、gatePolicyId | ScanPlan、影响集合、命令argv、风险、预算、需要的权限 | 不执行检查；不存在依赖明确标blocked |
| `adopt` | rulePackId/version、selection、conflictPolicy、expectedProfileRevision | 规则采纳提案和配置diff、冲突列表 | 默认preview，实际写由`init`或已授权apply |
| `init` | proposalId、proposalHash、expectedFileHashes、authorizationRef | 写入最小配置、变更回执、rollbackRef | 不下载工具，不覆写未知改动 |
| `run` | planId、planHash、authorizationRefs、background、idempotencyKey | 统一Run或同步结果、状态引用 | 按计划执行，超时/取消/资源限制生效 |
| `status` | runId、afterRevision | 紧凑状态、进度、阶段、预算、等待原因 | 不重复输出完整诊断 |
| `report` | runId/resultRef、filter、sort、cursor | 当前快照报告、覆盖与证据、分页诊断 | filter不改变原始证据 |
| `diff` | baselineRef、candidateRef、matchPolicy | new/resolved/unchanged/moved/suppressed/out-of-scope/unknown | 不把未复查文件当resolved |
| `fix_preview` | diagnosticIds、snapshotId、mode、allowedSafety | 修复diff、风险、冲突、前后hash、验证计划、期限 | 不写业务文件，不改变未选诊断 |
| `fix_apply` | previewId、previewHash、authorizationRef、expectedRevision | 原子应用/部分失败回执、验证Run、rollbackRef | 授权只覆盖该预览；内容变化需重新预览 |
| `rollback` | rollbackRef、expectedCurrentHashes、authorizationRef | 仅回滚本操作文件delta、冲突与结果回执 | 不重置仓库，不覆盖用户后续编辑 |
| `baseline` | operation、reportRef、selection、reasons、expiry | 版本化接受债务/例外基线 | 必须具体范围和理由；不能隐藏新问题 |
| `gate` | snapshotId、policyId/revision、evidenceRefs、mode | GateDecision、blockers、waivers、unknowns | 门决策不产生merge/deploy授权 |
| `evidence` | operation、receiptRefs、snapshotId、format | 索引、校验、导出证据包 | 纯导出本地；外部上传单独动作 |
| `cancel` | runId、reason、expectedRevision | 取消请求回执、最终已执行/未执行/未知范围 | 已写入部分不伪装成无副作用 |

`baseline.operation`仅为 `create/update/revoke/list`；`evidence.operation`为 `list/verify/export`。每个action独立schema，不允许自由命令字符串逃逸到shell。执行任意已有项目脚本必须在plan中列出真实脚本、cwd、argv及其未知副作用；用户可选择“不执行项目脚本”的仅内置检查模式，但报告必须声明因此缺失的覆盖。

### 2.3 `nexus_workflow` action合同

| action | 关键payload | 结果与语义 |
|---|---|---|
| `discover` | projectId、platformHints、scope | 文档/任务/CI/模板/分支约定画像，来源和未核实项 |
| `catalog` | type、query、locale | 七类变更模板、文档类型、审阅问题集、图类型和自定义模板摘要 |
| `create` | changeType、goal、constraints、sourceRefs、templateId | WorkflowInstance草稿、最小必填缺口、建议phase与风险 |
| `plan` | workflowId/revision、phases、budget、executionPolicy | 编译到04章TaskPlan，显示每节点输入、输出、验证与副作用 |
| `transition` | workflowId、fromPhase、toPhase、expectedRevision、evidenceRefs、authorizationRefs | 校验guard，追加事件并生成新状态，不覆盖历史事实 |
| `artifact` | operation、kind、workflowId、inputRefs、locale、targetRef、expectedRevision | create/revise/link/render/validate；需求、设计、README等版本化草稿 |
| `review` | artifactRef/hash、questionSet、mode、sourceScope、budget | 独立冷读/事实核查、finding、上下文来源与独立性声明 |
| `status` | workflowId、afterRevision | phase、approval、execution、缺口、下一步和最新证据摘要 |
| `evidence` | workflowId、operation、format | 关联证据、覆盖矩阵、交付摘要、回执校验 |
| `template` | operation、templateRef、definition、expectedRevision | list/validate/create/update/archive，自定义DAG静态验证 |
| `validate` | workflowId、scope、strictness | 真源、链接、事实、阶段、命令来源、图文与证据一致性 |
| `export` | workflowId、format、destination、selection | 本地Markdown/JSON/证据包；外平台目标生成PublishPlan |
| `import` | sourceRef、format、dryRun、conflictPolicy | 解析本地/已授权远端任务与模板，保来源，不执行附带脚本 |
| `cancel` | workflowId或runId、reason | 停止后续可运行节点，保留文档与已完成证据，标未结束阶段 |

`artifact`不是任意文件写API：只作用于已注册artifact及明确target，先生成diff与所有权说明。`export`到远端仅产生可审查PublishPlan；实际发送由统一外部平台adapter执行，并要求已存在的明确人类授权，不能以某个skill写了“发评论”为授权。用户已经明确授权某次Issue/PR动作时，可在范围内继续，不每个阶段重复要求确认。平台不可用时保留本地草稿和待发布状态。

### 2.4 最小调用示例

```json
{
  "contractVersion": "1",
  "action": "plan",
  "projectId": "project_a",
  "payload": {
    "snapshot": {"kind": "worktree", "baseRef": "HEAD"},
    "scope": {"mode": "changed", "includeUntracked": false},
    "layers": ["format", "syntax", "affected_type"],
    "profileRevision": 7,
    "budget": {"deadlineMs": 120000, "maxOutputBytes": 5242880}
  },
  "output": {"detail": "brief", "maxItems": 20, "maxBytes": 24576}
}
```

plan返回 `plan_12/hash_a`、所需权限与未覆盖项后，调用run只传固定计划引用，不重新展开规则正文。状态查询传runId；模型只接收状态差分。最终gate单独绑定全量或指定影响范围，不能根据上述便宜计划直接报告“整个项目全部通过”。

## 3. 数据对象与持久化合同

所有持久对象沿用04章基础字段：`schemaVersion/id/revision/createdAt/updatedAt/ownerScope/provenance`。时间存UTC，UI本地化显示。内容hash使用明确算法（初版SHA-256）与schema canonicalization版本；不能对JavaScript对象随意JSON stringify后跨版本假定相同。敏感原文存受控artifact库，索引和日志只持ref/摘要。

| 对象 | 必需字段 | 不变量 |
|---|---|---|
| RulePack | packId、version、sourceRepo/SHA、licenseRef、manifestHash、rules、compatibility、contentRefs | 版本不可变；升级生成新版本，不悄悄改现有规则 |
| RuleDefinition | ruleId、language/topic、severityDefault、normativity、scope、exceptions、detectors、fixtures、fixSafety、sourceRefs、knownGaps | `required/preferred/example`分开；不能把建议擅自升级成禁止 |
| ProjectProfile | roots、languages/frameworks、packageManager/lock、configs、commands、resolutionGraph、formatOwners、ruleSelection、trust、revision | 观察事实与采纳决策分字段；命令有来源，不编造 |
| Detector | detectorId/version、engine、rulesCovered、syntaxSupport、typeRequirements、soundnessLimits、toolLocator、outputParserVersion | 不支持的语法和路径进入unknown，不能pass |
| SnapshotManifest | repositoryIdentity、base/head、worktreeState、files/hash/mode、submodules、configClosure、capturedAt、scopeHash | staged、unstaged、untracked、历史树不混淆；读取前后变化可检测 |
| ScanPlan | profileRevision、rulePackHashes、snapshotId、layers、nodes、affectedSet、commands、permissions、budgets、cachePolicy、planHash | 不随执行修改；改范围产生新revision/授权判断 |
| QualityRun | sharedRunRef、planRef/hash、executionState、layerResults、usage、coverage、reportRef、digest、epoch | 每层真实结果独立；运行失败不吞成零诊断 |
| Diagnostic | occurrenceId、fingerprint、ruleId、detectorRef、severity、messageCode/args、path/range、symbolAnchor、evidenceRefs、state、fixability | occurrence和跨run逻辑身份分开；未知匹配不强并 |
| FixPreview | diagnosticRefs、snapshotId、before/afterHashes、patchRef、safety、verificationPlan、authorizationScope、expiresAt、previewHash | 内容/工具/规则/文件变化失效；预览不应用 |
| BaselineEntry | fingerprint、ruleId、scope、reason、owner、createdFromReport、expiry、approvalRef | 例外必须窄范围且可过期；不能通配全部未来问题 |
| GatePolicy | policyId/revision、requiredLayers、thresholds、baselinePolicy、freshness、unknownPolicy、waiverPolicy | 门策略不可回头改成刚好通过后不留记录 |
| GateDecision | snapshotId、policyRef、evidenceRefs、decision、blockers、unknowns、waivers、createdAt、revalidateAfter | 不代表宿主批准，不授予发布权限 |
| EvidenceReceipt | operation、subject/snapshot、commandRef、tool versions、exit/signal、coverage、timestamps、cacheOrigin、hashes、resultRef、limitations | 读源码、命令存在、测试执行、渲染成功分别记录 |
| WorkflowInstance | changeType、goal、constraints、sourceRefs、templateRef、phase、approvalState、executionState、artifactRefs、planRef、events | 三种状态正交，不能单一百分比替代 |
| DocumentArtifact | kind、locale、contentHash/ref、truthOwner、sources、links、revision、status、reviewRefs、renderRefs | 当前事实、提案、未知和历史记录可区分 |
| ReviewFinding | artifactRevision/hash、questionId、classification、severity、evidence、recommendation、resolution、reviewerContext | 审阅针对具体版本，版本变化不能自动沿用通过 |

### 3.1 稳定身份与路径

项目使用宿主项目身份加规范化root绑定；不能仅用目录basename作为项目ID。Windows path保留显示大小写，比较按文件系统语义；case-sensitive目录、UNC、junction、symlink必须实际探测。相对路径一律相对明确root，不含 `..` 逃逸；符号链接目标经过授权检查，报告保留逻辑路径和解析目标身份。规则ID例如 `hlt.ts.function-max-statements`，稳定ID不把源文件行号或severity写进去；消息本地化不能改变fingerprint。

诊断range记录UTF-16或字节偏移的明确单位、1-based行列和源hash，UI转换后可定位CJK和emoji。新版本解析器造成范围漂移时保留旧原始值并标映射版本；不能把不精确行号显示为确定位置。

### 3.2 存储边界

默认将scan计划、报告、原始stdout/stderr、图与审阅证据存插件私有项目库；不默认在业务仓库写 `reports/`。用户可选择提交 `.nexus/quality.yml`、`.nexus/workflows/` 和文档产物；仓库配置只放可共享规则、模板和引用，不放token、完整源码报告或机器私有绝对路径。

建议私有布局为 `profiles/`、`rulepacks/`、`snapshots/`、`runs/`、`objects/sha256/`、`journals/`、`indexes/`。event log和数据库更新事务化，artifact先写临时文件后原子rename并落引用；数据库引用不存在的对象属于损坏，不悄悄重建为成功。清理按引用计数/保留策略，未完成run、回滚点和被gate引用的证据不可自动删。允许导出、备份、删除单项目数据；删除前明确失去哪些恢复/比较能力，不把业务文件包含在私有清理范围。

## 4. 项目发现、规则采纳与配置初始化

### 4.1 发现分两级

一级发现只读文件、解析静态JSON/TOML/YAML、锁文件、脚本声明、CI/hook/模板和已存在的文档。不会执行 `eslint.config.js`、Nuxt config、Python模块或项目启动脚本；“配置文件存在”只能说明观察到，不等于已成功求值。二级受信探测在计划中列出需要执行的配置加载、工具 `--version`、help或真实检查命令，继承宿主权限和任务范围，返回精确执行回执。

扫描顺序：识别root/workspace→锁文件与包管理器→语言/框架→已有config和extends closure→命令与CI覆盖→生成/第三方范围→alias/project-reference图→规则owner和缺口。Git忽略不是安全排除：手写代码风格可按生成/第三方例外，但秘密、可执行内容和运行安全问题不能靠扩大ignore解决。

每项来源含 `path/hash/line-or-key/observedAt/method`。脚本值和命令不等于已经执行。包管理器由真实lock与项目声明决定，多锁冲突必须显式；不自动切换为开发者习惯工具。不执行包管理器install来“顺便补齐”依赖，缺失工具输出安装建议和本地可用替代，由用户授权的依赖管理流程执行。

### 4.2 规则优先级与冲突

优先级为当前用户明确指令→项目明确规范与可解释例外→已采纳的本项目profile→上游默认建议。宿主安全权限属于独立约束，规则采纳不能扩权。来自不同源的矛盾以Conflict对象记录 `subject/left/right/source/impact/proposal`，不靠最后加载文件获胜。

采纳前生成：新增/保留/替换/禁用/无法映射规则；每条给作用域、默认severity、例外、detector、依赖、可能新增噪声、当前覆盖和需要手工判断的部分。`adopt`默认只生成proposal。`init`应用最小差分，保留用户注释与已有结构；无可靠AST/格式保持器时生成旁置草稿与人工合并说明，不用整文件重写冒充最小修改。

现有规则更严格且兼容时保持原强度；更宽松时说明差异，不能自动提升。项目允许function declaration而上游偏expression时产生可选择冲突；不擅自批量改。formatter按文件glob分配唯一owner；存在交叠时先处理冲突。unused诊断、import排序、类型诊断也有owner表，避免每次同一问题输出三份。

### 4.3 可共享配置草案

```yaml
schema: nexus-quality/v1
rulePacks:
  - id: how-to-lint
    version: c6e2b5180917b8fd8952a0338d77c5318856e4a3
profile: project-native
scope:
  generated: ["src/generated/**"]
  thirdParty: ["vendor/**"]
rules:
  hlt.ts.function-max-statements:
    severity: error
    options: { maxStatements: 30 }
  hlt.ts.no-explicit-any:
    severity: warning
exceptions:
  - rule: hlt.ts.internal-no-null
    paths: ["src/adapters/public-api/**"]
    reason: "外部协议使用 null，边界内保留协议语义"
    expires: null
checks:
  final:
    layers: [format, syntax, affected_type, semantic, project_test]
cache:
  deterministicResults: true
  reportProjection: delta
```

这是本产品配置格式，不是上游现成文件。外部命令不能直接写自由shell字符串；引用已发现commandId，或使用经校验的executable/argv/cwd对象。秘密从宿主凭据服务取，配置只保存secretRef。模板导入禁止YAML自定义可执行tag、原型污染键和无限alias膨胀。

## 5. 规则库的完整行为要求

每条规则提供简短目录项、完整说明、适用语言、原因、正例、反例、例外、detector能力、验证fixture、修复安全和来源。UI可直接查看，模型默认只取必要规则ID和摘要。上游正文在MIT保留署名下可复用；不得把文档示例误称完整可运行配置。

### 5.1 JS/TS 与类型检查

| 主题 | 默认合同 | 检测/例外 |
|---|---|---|
| 基础风格 | eqeqeq always、no-var、prefer-const、no-debugger、curly all为error | 尊重现有项目明确约定，差异进入采纳预览 |
| 函数与文件 | function expression优先规则、max-statements=30、手写文件kebab-case | 语句数不是行数；method/overload/ambient/framework声明和保留路由窄例外 |
| 导入 | type-imports独立、node:、no-duplicates、no-self-import | 装饰器运行元数据例外；type/value解析真实 |
| 类型形式 | namespace避免、内部undefined、T[]偏好、expect-error有理由 | 声明合并、外部null协议保留；T[]、any、ts-ignore相关默认warn |
| 架构 | alias一致、公共接口与前后端边界、循环依赖分类 | resolver基于真实tsconfig/build/test/framework；runtime/type分开 |
| compiler | strict、noUncheckedIndexedAccess、noImplicitReturns、noFallthroughCasesInSwitch | exactOptionalPropertyTypes不默认强推，module/target继承真实runtime |
| promise | no-floating-promises、no-misused-promises为error | void不是处理reject；type服务缺失必须unknown |
| 格式 | Oxfmt优先，Prettier补足并按文件唯一owner | formatter不替代语义或typechecker，不用于Python/Go |

ESLint是默认诊断路线，typescript-eslint使用适当推荐基线；不把盲目启用所有strict规则当成质量。Oxlint可作为用户选择的加速器或兼容实现，但要列规则覆盖差异；不能默认静默替换。compiler adapter必须读取实际可执行文件、依赖包版本与实现身份。命令叫 `tsgo` 或 `tsc` 都不足以证明Go原生实现；报告给 observed implementation 和依据，无法验证为unknown。build/transpile通过不等于typecheck通过。

函数长度与null规则的自动修复通常涉及语义，默认只建议。不得为了凑30条语句无意义拆函数、为了消除null诊断改变外部协议、为了any规则改成更隐蔽断言。class不被全面禁止。

### 5.2 Vue/Nuxt

SFC parser覆盖 `<script>`、`<script setup>` 与template，解析器嵌套正确；check覆盖props/emits及跨组件类型，`strictTemplates=true`。探针必须包含故意的模板类型错误，普通TS检查成功、编辑器无红线或仅 `*.ts` 扫描不能算模板已覆盖。

native compiler缺少某Vue能力时允许使用官方兼容checker；plan明确记录fallback原因、版本、覆盖和预算。禁止以exclude `.vue`、临时any、删生成类型或不运行template check来得到绿灯。Nuxt alias根据项目source/root和版本解析：`~`/`@`、`~~`/`@@`、`#imports`等分别记录，不推定 `#shared/#server` 在所有版本都存在。保留正确的自动导入。static import、dynamic import、type import、re-export和测试解析一致；client访问server秘密为独立高风险诊断。

框架路由名、保留文件名、组件命名、生成入口、发布输出、独立脚本可有窄例外，CSS/HTML不套JS规则。工具不支持某个template语法时报告unsupported语法位置和受影响范围，不把parse failure转换为“零问题”。

### 5.3 Python

mypy默认 `strict=false`、`check_untyped_defs=true`、`disallow_untyped_defs=false`、`disallow_untyped_calls=false`、`warn_unused_ignores=true`、`ignore_missing_imports=false`；保留strict optional。不默认启用所有disallow-any，不要求给所有代码补annotation，不默认强推warn_return_any。缺少第三方stub时只允许具体module例外，说明reason与有效范围；Any传播占比和未类型覆盖可显示，不能宣称所有路径已检查。

except必须体现错误去向，`raise ... from ...`保cause；cancel/KeyboardInterrupt/SystemExit等不能被普通降级吞掉。配置读取与解析按Python真实机制检查。Python formatter沿项目，不用Oxfmt/Prettier格式化。仅mypy不能覆盖所有异常和环境规则，缺口由自定义静态分析或语义review补，报告分层。

### 5.4 Go

默认go vet与gofmt，缺口可用 `go/analysis`/vettool扩展。不能强制同时安装多个大型聚合器；Staticcheck/errcheck等若项目已有则使用并说明owner。vet通过不等于所有error return、goroutine失败、配置读取都有证明。错误不能随意交 `_`，预期忽略要具体业务理由；保留 `%w`、`errors.Is/As`，goroutine error需要接收或明确可追踪处理。

环境检测包括Getenv、LookupEnv、Environ、ExpandEnv及底层等价方式；用types识别import alias和symbol shadowing，不能对名叫os的变量纯字符串判断。Go风格不套JS函数表达式、kebab-case或文件分段。适配Go module/workspace和build tags，平台相关代码不在当前目标执行时列未覆盖target。

### 5.5 异常语义与配置边界

异常规则至少识别：无绑定catch/except、空处理、只有注释、无用赋值/void、无意义catch-rethrow、原cause丢失、未知异常伪成功、日志泄密、重复日志、未接收promise/goroutine失败、失败处理器再失败。合法处理需要到达真实失败结果、传播、保cause转换、明确expected branch、补偿或部分失败；名为 `reportFailure` 的调用本身不是证明。子树里存在throw/log但路径未执行、被shadow、没接收原error，也不能证明处理。

配置规则至少识别：业务层直接环境读取、别名/解构/计算属性、未经runtime validation的强制类型断言、分散默认值、不明确优先级、私有配置进入public/SSR payload。合法多provider/多模块边界受支持，不强制巨型config。允许build/start/test独立入口，但其路径不扩大业务豁免。secret值不进入diagnostic或模型；证据用源位置、字段名、脱敏形状与hash，不回显真实值。

实现将检测强度分为 `syntax/type-aware/control-flow/interprocedural/manual-semantic`，每条结果记录level。AST模式只能标确定局部模式或candidate，不能把关键词匹配宣称跨函数数据流证明。无法确认真正错误去向时为needs-review或unknown；可安排有限范围语义review，不自动将全部代码发给模型。

### 5.6 自定义规则与fixture

每个自定义rule具备正反例、exact diagnostic/messageCode、位置、适用scope、例外正例及相似违规反例、语法覆盖、known gaps、engine版本。JS/TS/TSX/Vue使用真实parser测试，type-aware规则启动真实type service；缺失type service时测试必须失败或显式skip，不接受任意error作为命中。Go使用analysistest类真实类型环境。alias fixture包含re-export/dynamic/type、路径改名、跨包、client/server边界和symbol shadowing。

fixer另有修后内容断言、二次执行无变化、语义不变约束和歧义拒修。null变undefined、移动env读取、异常处理重构、改变函数边界默认不提供自动fix；仅输出建议和带风险的候选patch，进入显式语义审查后才可选应用。本节测试是后续实现验收要求，本次研究没有执行这些测试。

## 6. 分层、增量执行与影响分析

### 6.1 检查层

| 层 | 输入与默认范围 | 成功的含义 | 不能推导 |
|---|---|---|---|
| discovery | 配置、锁、命令与静态目录画像 | 完成所声明事实发现 | 配置执行成功或检查通过 |
| format | changed files与其formatter owner | 指定文件格式满足 | 语义、编译、业务正确 |
| syntax | changed files的无type规则 | 所支持语法和规则无诊断 | 跨文件类型与异常全路径 |
| affected_type | affected package/project与真实type service | 指定影响闭包类型检查 | 未覆盖package或Vue模板自动通过 |
| semantic | 指定架构/异常/配置边界 | 声明的分析能力与审阅结论 | 数学完备证明或全项目所有行为 |
| project_test | 按风险选择真实unit/integration/e2e/build | 所运行命令在该环境的结果 | 未执行检查、产品全部需求 |
| final_gate | 固定snapshot、policy和证据集合 | 该策略门决定 | merge/deploy/对外发布权限 |

用户可选quick、affected、full模式，但每个模式展开为实际layers和范围；UI不只显示一句“快速通过”。quick默认不调用LLM，不修改配置；affected能升级范围；full仍要显示平台/环境限制。长期后台监视可复用统一job，文件事件合并、去抖和取消旧run，但不能对每次按键开启新模型审查。

### 6.2 影响集合算法

先捕获SnapshotManifest，再计算直接变更集合和删除/重命名。按真实resolver建立模块依赖、package export、TS project refs、Python module、Go package/build tags、Vue组件和生成类型依赖图。变更源文件触发所属分析单元；公共接口、config、lock、parser版本、alias、compiler target、生成schema变化触发依赖闭包升级。formatter仅影响其owner文件；typechecker按必要project范围；跨边界语义按规则依赖图。

不能可靠建立依赖图时采用保守扩大范围，并说明原因，不能为了省时把unknown缩成单文件。若仅能观察mtime，最多作为预筛，最终以内容hash核验。删除文件和重命名也可能影响导入/包边界，不能只扫描还存在的changed文件。配置加载包含extends、plugin版本、workspace root和环境target，不能只hash顶层config。

plan显示 `direct/affected/expanded/excluded/unknown` 各集合和原因；图过大时按package汇总，并保留原文ref。目标快照捕获后文件变化，run可在隔离只读snapshot上完成并标结果对应该版本，或停止需重计划；不能混读前半旧文件后半新文件再出完整通过。工作树模式允许用户继续编辑，最终报告明确stale及改动影响。

### 6.3 执行器与资源

命令由exe路径、argv数组、cwd、受控env构成，不拼接shell字符串。PowerShell/bash/cmd仅在确需项目脚本时用明确adapter并保转义测试。工具探测记录可执行文件真实路径、hash或版本、依赖resolution、output parser版本；恶意同名PATH工具不能被默认为受信。配置JS和项目script可能执行任意代码，plan标副作用未知，继承宿主权限。

默认单节点deadline120秒、full任务可配置15分钟、并发按CPU/内存预算，stdout/stderr各5 MiB软截流到artifact、硬限额按项目设置。超限时保尾部/头部有界摘要和完整保存状态，不能OOM后报零问题。可配置max files/source bytes、内存、子进程数和模型tokens/费用；费用无法硬测时标advisory。cancel传递进程组，graceful窗口后强停仍记录signal；Windows job object或等价机制避免孤儿进程。不得因取消只杀父shell而留下checker继续改文件。

同文件写操作排他，读检查允许并发；CPU重工具限制全局并发。扫描失败分parse/tool/config/permission/timeout/cancel/resource/schema，不混为规则失败。可安全重试只读瞬态操作；自动fix、外部写、项目script副作用不确定时不盲重试。重启恢复根据job/event状态查询实际执行者，无法确认的run标interrupted/unknown，等待检查，不显示恢复后已完成。

## 7. 缓存、前缀稳定与可逆报告压缩

### 7.1 三种缓存必须分开计量

第一种是确定性检查结果缓存，目标为减少本地CPU与重复检查。第二种是规则/报告/文档内容寻址存储及分层摘要，目标为减少进入模型的正文并保持可逆恢复。第三种是provider的会话前缀缓存，目标为减少已缓存输入重复计费和延迟。三者的key、失效和指标独立；本地结果命中不能推导LLM cache命中，压缩字节比例不能直接当成token费用节省。

本域遵守缓存专项的可逆分层压缩合同：原始证据不可被摘要替换；每层压缩保有内容hash、来源span、压缩器版本、token估计、epoch和可展开ref。质量诊断、artifact、设计与审阅全部可从摘要定位完整原文。长会话续接先恢复稳定索引和当前目标，再按风险取原文；不默认把所有历史lint和文档一次性重新注入。论文依据、算法选择与跨域cache实验由缓存专项统一，本章不得另造不可逆“只留结论”捷径。

### 7.2 确定性缓存key

```text
resultKey = SHA256(
  cacheSchemaVersion
  + detectorId/version/outputParserVersion
  + rulePackManifestHash + selectedRuleOptionsHash
  + analyzerPlatformAndTarget
  + sourceSnapshotMerkleRoot + requestedScopeHash
  + configClosureHash + resolverGraphHash
  + lockfileAndToolchainHash + dependencyInterfaceHash
  + relevantEnvironmentDigest + generatedInputHash
)
```

canonicalization规定字段顺序、字符串UTF-8、数组是否有序和缺失值；路径按resolver语义，不用显示语言。环境只纳入与该检查相关的显式allowlist变量，秘密用项目私有salt HMAC，不记录原值；salt变化使相关key失效。无法确定环境依赖的可执行项目配置默认不跨run共享结果，或以显式非确定性标识降级。测试涉及时钟、网络、外服务、随机性或共享数据库，不能仅因源hash相同就复用成fresh pass。

缓存单元按detector自然边界，例如文件syntax、TS project、Go package，不为了单文件cache破坏跨文件语义。config/依赖/public interface/alias/框架生成类型变化向受影响闭包传播失效；未知传播范围保守扩展。工具升级、规则options、message mapping或输出parser变化也要失效。按内容hash验证输入，mtime只做加速；文件读过程中变化时重试快照或停止，不能缓存混合版本。

缓存条目包括原始执行receipt、输入manifest、结果hash、创建时间、determinism声明、有效范围和engine签名。命中后返回 `execution=revalidated_cached`、`originalRunId/originalExecutedAt/revalidatedAt`，表明当前输入闭包已重hash核验；禁止把旧执行时间改成现在并标“刚运行”。mixed报告按layer列fresh/cached。final GatePolicy可要求某些层fresh执行或允许重核缓存，但策略和UI明确，不偷换。

### 7.3 稳定诊断、digest与epoch

`occurrenceId`仅标一次run内实例；跨run逻辑fingerprint由ruleId、project-relative canonical path、messageCode、关键args的脱敏规范形式、symbol/AST锚点和detector identity组成。不能使用纯行号：插入注释不应产生全量new/resolved。也不能仅用message：同文件两个相同问题不能合并成一个。重命名/移动匹配保confidence和mapping依据，低置信保两个candidate，不隐藏可能新问题。

report有两种digest：`contentDigest`涵盖完整有序诊断与覆盖事实；`semanticDigest`只涵盖语义投影（rule、位置锚点、状态、严重性、覆盖和输入身份），不因展示语言或runId变化。字段明文区分，不用一个digest含糊表示全部。排序稳定：severity→canonical path→ruleId→anchor→occurrence；JSON对象key canonical，分页cursor绑定report hash和filter hash，不能读到前后不同report。

`epoch`表示语义解释边界。规则pack、detector/parser/compiler、profile规则options、resolver语义或诊断fingerprint版本变化时增加epoch；单纯运行进度/时间变化不改epoch。跨epoch diff先给兼容映射和可比范围，无法可靠映射为 `not_comparable`，不能显示“新增3000个问题”而不解释规则升级。一次配置变更产生一份影响事件，后续轮次引用同一事件不重贴全部规则。

diff分类为new、resolved、unchanged、moved、suppressed、out-of-scope、unknown。candidate未覆盖某文件时其旧diagnostic是out-of-scope/unknown，绝不是resolved。baseline接受属于suppressed，仍计总债务和到期；新同类问题不继承旧例外。修复后源改变但未复查为pending verification，不能提前resolved。

### 7.4 模型投影与按需展开

默认模型投影包括：project/snapshot简短身份、epoch、report digest/resultRef、执行fresh/cached摘要、覆盖范围、计数、新增阻断项、与上轮相比的变化、下一步所需规则ID。unchanged详细正文只保引用；没有变化时返回同digest和简短“语义未变”，不把零散进度日志全送模型。

正文分层：

1. L0：稳定目录与计数，约数百token，说明完整报告在哪里。
2. L1：当前任务相关的rule摘要、阻断诊断和受影响package。
3. L2：选定diagnostic完整证据、局部源码span、修复候选和已知边界。
4. L3：完整原始报告、规则正文、stdout/stderr和版本化文档。

每次展开指定ref/hash和范围，记录materialization receipt，不自动在下次重复注入已读同hash。用户要求完整报告时提供artifact/分页或文件，不为保持省token拒绝交付。正文变化产生新hash，引用旧hash仍能读取历史原文；若已被明确清理，返回expired并说明，不能悄悄指向新内容。对安全关键证据，摘要必须包含未覆盖与不确定性，不只压成“通过”。

### 7.5 前缀缓存安全规则

工具面、稳定说明和短规则catalog位于稳定区；动态runId、时间戳、active project、进度、诊断、启用rule列表和状态不拼接进system前缀。相同工具schema按固定顺序注册，不因运行结束移除工具、不因rule开关反复改tool description。已注册但不可用的action返回capability unavailable，不能每回合刷新注册表。

不重排或改写已经发送的历史消息，不为了摘要更新在早期消息中插入最新报告；新摘要作为append事件，保来源与旧版本关系。长文按需读取的结果自然追加在对话尾部。宿主确需compact/fork或provider路由变化时先产生恢复包与成本提示，保原始artifact，记录造成prefix变化的组件；不能宣称能保证provider永不掉缓存。

规则说明只在第一次需要或hash变化时加载；任务结束不自动卸载再重装rule provider。审阅子代理只带已明确的目标、快照/文档、必要规范和问题集，不继承作者全部长历史；其结果回主会话是紧凑findings+refs。语义审查可以在独立会话使用不同模型，但不能把主会话provider/模型来回切换当成免费优化。

缓存观测保存provider实际usage：input/output/cache-read/cache-write tokens、provider/model、价格表版本、latency和request id。没有字段为unknown，不用估算冒充。稳定窗口命中率分母明确为该provider可缓存输入token，单独显示uncached原因、冷启动、schema变化、模型切换、前缀不稳定、provider eviction和测量不可得。诊断不重复向模型推送完整usage，仅聚合到预算状态，避免监控本身破坏前缀。

### 7.6 缓存验收与目标

在固定repo、规则、provider/model、工具表和长程脚本下测cold run、warm unchanged、单文件修改、依赖变化、恢复续接五场景。记录本地命中、执行时间、进入模型tokens、provider cache-read比例、费用和接手正确性。性能目标初版为unchanged语义报告正文不重复、相同输入不重跑确定性checker、单文件变化不无故失效无关package；具体provider命中率SLO以专项基准和真实能力定义，不能无依据承诺95%或100%。

恢复正确性比摘要短更重要：恢复者必须能回答当前目标、授权范围、快照、已完成/未完成检查、已接受债务、阻断项、文档版本和下一步；随机抽取摘要断言可展开到精确原文；错误/缺失引用为失败。失效规则宁可多跑必要checker，不以缓存命中优先掩盖配置变化。

## 8. 修复、写权限、预览与回滚

### 8.1 安全分类

`safe_format`仅排版且formatter保证范围；`safe_syntax`限经fixture证明不改变运行语义的机械修复；`behavioral_candidate`涉及控制流、错误、public protocol、side effect、配置读取时机、依赖或函数边界；`manual_only`无可靠patch。上游rule的fix声明不是无限信任，adapter版本、项目语法和真实fixture通过后才进入白名单。

批量“自动修复安全项”仅包含前两类且在已授权路径；行为类必须清晰列风险与验证，不混入一键安全修复。多个fix同文件重叠或顺序依赖时生成冲突图，不能按工具返回顺序盲写；合并后重新parse和相关检查。fix后出现新诊断、输出不幂等或parse失败时不报告成功，保候选结果供检查。

### 8.2 预览绑定与授权

预览绑定snapshot、选诊断、规则/工具版本、文件before/after hash、具体patch、验证计划、目标cwd、权限、期限、最大副作用和previewHash。默认有效期5分钟，可按项目调整；期限不是唯一保护，apply前必须重hash。现有明确用户授权可覆盖范围内safe fix，不机械再次弹窗；如果没有该授权，UI确认的是已生成的具体diff。宿主审批始终独立，插件不回调true绕过。

apply前验证expectedRevision、路径授权、当前hash、preview期限和目标非符号链接逃逸，获取写lease。写入前journal包含文件mode、编码、换行、before blob、预期after；临时文件同卷原子rename。多文件不能保证操作系统原子事务时用journal状态机 `prepared→applying→applied→verified`，崩溃后恢复向前/回滚需hash判断。不能承诺多文件瞬时原子。

dry run不执行有写副作用的checker。某formatter缺少可靠stdout/check模式时在隔离拷贝上生成patch；不能让所谓preview先改真实文件再撤销。文件编码非UTF-8、BOM、CRLF和权限位保留；二进制文件不进入文本fix。

### 8.3 验证与失败

应用后运行预览中说明的最小相关验证，记录fresh execution，不把apply成功等同验证通过。验证失败的策略可选保留patch待检查或自动回滚本次delta；默认对parse失败自动回滚，对业务测试失败保留可审查状态并告知。自动回滚同样不覆盖用户并发编辑。原始失败、回滚失败和最后状态分别显示。

取消在prepared前无写入；applying中停止下一个文件，已应用文件按journal回执显示，必要时尝试安全回滚；verification中取消保留patch并标未验证。任意effectState=unknown必须提供inspect动作，不能给用户“重试全部”默认按钮。

### 8.4 回滚合同

rollback只撤销本次操作拥有的delta，不能 `git reset --hard`、清理untracked或整个目录覆盖。当前内容仍等于after hash时恢复before；用户后续有编辑时给三方冲突预览，默认不动；能够无冲突逆patch也要重新验证期望范围。工具创建文件仅在仍等于所创建hash且无他方修改时删除；目录仅当本次创建且空时移除，先验证解析绝对路径在授权根。

rollbackRef关联原operation、文件hash和存储保留期限；导出的patch能离线检查。回滚配置会改变profile/epoch并失效相关结果，不能沿用旧gate。回滚自己的产物不授予回滚他人代码或VCS提交的权限。

## 9. 质量门、证据与债务基线

GateDecision取值 `passed/failed/blocked/unknown/waived`。failed表示已完成的要求有违规；blocked表示缺工具、缺权限、缺前置或预算不允许；unknown表示无法证明状态；waived表示明确授权的特定例外，不伪装passed。policy可对不同层采用error/warn阈值、baseline允许、freshness和unknown处置，但policy来源和revision必须可见。

gate绑定同一SnapshotManifest或可证明兼容的输入；lint对旧工作树、test对新工作树时不能聚合出同一版本passed。证据有原执行时间、当前复核时间、环境、命令argv/cwd、tool版本、退出码/signal、输出hash、范围、未执行项、缓存来源和局限。输出parser遇到未知格式不能根据exit0或空数组独断无问题；exit0可代表命令成功，诊断完整性仍需parser状态。

对“最终通过”要求覆盖所有policy required layers；某语言缺detector为blocked/unknown。只读源码证据可支持设计事实，不充当运行测试；XML合法不能充当SVG已渲染；在一个viewer预览不等于全平台一致。证据等级可沿用Aegis A/B/C表达可信范围，但不是权限等级。

baseline接受现有债务需要具体fingerprint、scope、reason、owner、期限或永不过期的明确说明。更新基线以diff预览，不自动“把本次全部当旧问题”；新问题、严重度升级、相同问题扩散不会自动被旧例外覆盖。到期例外重新阻断或按策略warning，UI提前提示有依据的到期项，不后台对外催促。

evidence export含manifest、hash校验、报告/命令/版本/未验证清单、必要脱敏后的原文；默认不含凭据或仓库完整源码。导出选择保留敏感性等级，导出目的地路径授权。签名或hash只能证明包内容完整性和来源链，不能证明业务正确性。

## 10. 工程生命周期状态机

### 10.1 阶段、确认与执行状态正交

标准phase为 `intake→requirements→design→execution_plan→implementation→verification→review→delivery→closed`。也有 `paused/cancelled`控制状态，`blocked`为当前阶段的执行状态。approval为 `not_required/pending/satisfied/revoked/expired`，execution为 `idle/planned/running/waiting/blocked/completed/failed/cancelled/interrupted`。人已确认设计不等于实现完成，任务运行完成不等于审阅通过。

用户明确授权、项目规范和风险路由决定哪些阶段要人确认；已有授权覆盖当前计划时继续执行并记录authorizationRef，不在每个state transition反复问。大范围、不可逆、外部影响或超出已授权边界才需要新增确认，且先完成已授权、可复查的草稿/计划/diff。任何skill里的默认确认步骤不能覆盖用户已经提供的范围与偏好。

### 10.2 各阶段输入与guard

| phase | 主要输入 | 退出guard/输出 |
|---|---|---|
| intake | 目标、用户原话、项目事实、约束、来源 | 变更类型/范围/风险、未知项、最小计划尺度 |
| requirements | 使用场景、actor、输入、条件、结果、异常、原需求 | 可验收的新旧需求矩阵；facts/requirements/proposal/unresolved分离 |
| design | 已确认需求、真实source/env、可用外部能力 | ownership、I/O、state、side effect、failure、timeout/retry/concurrency/restart/compat/security；独立版本设计 |
| execution_plan | 设计、模块边界、验证策略、预算 | 可执行TaskPlan，先模块/lib/package+demo验证再集成，依赖/写claim/输出合同清晰 |
| implementation | 固定计划、工作区/快照、授权 | 每节点真实产物与阶段结果；偏差与影响记录 |
| verification | 变更快照、验收矩阵、quality policy | 实际check/test/覆盖及未执行项，GateDecision |
| review | 指定版本产物、问题集、必要源码范围 | 代码/文档findings，blocking已处理或明确接受 |
| delivery | 实际结果、偏差、验证、风险、外部计划 | 一个closeout/PR草稿/本地交付包，外部发送有独立授权 |
| closed | 交付回执与剩余项 | 最终状态和可续接索引，不捏造部署/合并结果 |

允许tiny fastpath把多个phase合并为同一简短artifact和几条事件；不要求为小排版改动生成全套Issue与十张图。fastpath仍保存目标、变更范围、验证和未覆盖；不能以简化为由跳过宿主写权限或谎称未跑测试已通过。

### 10.3 七类变更

`feat`和`demand-change`按上游提供的完整模式实现。demand-change必须查找原需求或明确用户来源，不能从现代码推断原本业务意图；保留原目标、不变条件、改动差异和新旧验收。requirements确认后，设计作为新版本/新评论草稿追加，不覆盖原需求。执行计划是将来要做什么，PR/Run才记录已经做了什么。

`fix/refactor/migration/DX/deployment`在上游仅有分类，没有同等完整流程；以下是本产品明确扩展：

| 类型 | 最低补充要求 |
|---|---|
| fix | 复现/触发、期望与实际、影响、根因证据或假设、回归验证；无法复现明说 |
| refactor | 行为不变边界、接口/性能/兼容约束、迁移粒度、等价证据；不夹带未授权功能变化 |
| migration | 旧新格式/版本映射、数据兼容、双写/回填如适用、恢复与回滚、不可逆点和试运行 |
| DX | 开发者痛点、真实命令/环境、使用路径、成功/失败反馈、对CI和新贡献者影响 |
| deployment | 制品/配置/目标环境、发布策略、健康检查、恢复/回滚、权限与影响；merge不等于deploy |

### 10.4 需求/设计/执行偏差

所有版本immutable，revise生成新revision与 `supersedes`，旧内容可读取。变更影响分析列哪些需求、设计、计划、检查、审阅失效。轻微实现差异在Run/PR阶段报告解释；超出目标、外部行为、schema、安全或费用边界的差异回到相关需求/设计phase并进行必要授权，不默默改原文制造“从来如此”。

若平台Issue/PR可访问，保留remote id/version/url/etag，导入为带来源artifact。外部被人编辑后更新冲突，不直接用本地覆盖；离线草稿可继续，最终发布前refresh比较。平台操作失败保留本地状态与可重试计划，幂等键避免重复评论/Issue。未知是否发送成功时先查询，不盲重发。

## 11. 文档能力、冷读与图形资产

### 11.1 真源分工

| 文档 | 应承担 | 不应承担 |
|---|---|---|
| README | 项目是什么、适用对象、最快跑通、边界、下一站 | 当前任务进度、完整设计、全部API |
| CONTRIBUTING | 开发环境、真实命令、验证、贡献/PR规则、失败求助 | 复制整个architecture或临时排查流水 |
| architecture | 当前模块/边界、关键运行关系 | 手工完整调用图或全部历史决定 |
| ADR | 为什么选某设计、备选与后果 | 每日进度、已交付测试证据 |
| Issue/需求artifact | 背景、目标、场景、设计与范围版本 | 每次执行输出流水 |
| PR/Run/commit/CI | 阶段结果、偏差、实际验证 | 重复Issue全部需求、虚报通过、只复述diff |
| code/config/tests | 当前实现事实 | 擅自解释历史业务意图、掩盖需求差异 |

validate检查重复事实、失效链接、术语冲突和职责错位，给具体证据与建议，不强制所有项目采用相同目录。文档链接先验证实际目标；不创建一个空文件只为让链接“有效”。动态任务链接到任务真源，不在README嵌入经常变动的进度表。

### 11.2 README与CONTRIBUTING

README支持CLI、library、web app、developer tool、backend service五类，选择类型后按读者问题组织；首句说明用途，给最短路径及前置、目录、输入、预期成功/失败结果，随后提供真实API/ops/architecture/contributing入口。无需使用的章节不凑齐。示例区分已执行/未执行，不把示例命令当真实可运行事实。

语言使用项目已有约定或用户指定；未指定且可推断时合理选择，不重复问。双语可单文件或双文件，但事实、命令、版本、边界和导航一致，互链；机器翻译只作草稿，涉及命令/路径/键名不随语言变化。同步验证针对语义字段，不要求逐句形式相同。

CONTRIBUTING必须采证README、deps/lock、scripts、tests、CI、hooks、模板、hosting后生成。每个command列cwd、工具/版本前置、范围、预期结果、可能外部服务/数据影响，mandatory与suggested分开。按变更风险映射format/lint/type/unit/integration/e2e/build最低验证；没有真实命令时说明缺口，不能编 `npm test`。凭据只说明如何获取与注入，不放真实key。新环境验证可作为显式计划执行，未执行则标未验证。

### 11.3 两段审阅

文档审阅默认先cold-reader，再source-fact-check。cold-reader只获得完整稿件、必要图片/链接、读者背景、目标问题与可访问资源，不获得作者聊天历史、预期答案或“请证明这已经清楚”的引导。问题采用开放式，如“使用者从哪里开始，成功是什么”，不把答案放问题中。第一段结果冻结后才提供源码/需求核实，避免倒填冷读答案。

每个finding包括问题ID、回答、依据位置、缺口、建议，分类为missing/terminology/contradiction/findability/ownership/factual/visual，severity为blocking/optional。源码只读不等于测试，SVG XML合法不等于已预览，review不能授予publish/git权限。主代理修改后由同审阅者复核相关findings；重大结构变化可重新cold-read一次。无blocking即停止，不无限处理可选措辞。

独立子代理由04章运行时按预算与当前授权创建，本域不自行无限递归spawn。没有子代理能力或用户禁止时提供self-review并明确“非独立冷读”；不能将同一模型自我复述包装为独立审阅。审阅者禁止编辑/发布/再委派是该review任务的权限边界，不影响父任务已有授权。

### 11.4 图形能力

保留context、use-case、flow、state、sequence、ER、components、wireframe八类SVG；按理解顺序整体→请求→数据→失败/运行保障，一图回答一个问题。不是每份文档必须画八张。图中的actor、状态、条件、箭头、实体、重试与终止语义必须与正文和需求一致。wireframe是界面结构草稿，不能冒充真实截图。

生成standalone SVG并保editable源；使用显式presentation attrs、title/desc/viewBox、可读字体fallback，支持CJK。禁止script、外部资源、foreignObject和未授权栅格/字体嵌入；预览使用隔离artifact viewer，禁网络和执行。dark仅改变paint而不改变geometry/text metrics，CSS禁用仍可读。source与outline副本通过关联保存，不用outline覆盖editable原文。

outline可调用受信 `rsvg-convert` adapter或等效实现，先探测存在与版本，不自动安装。输入/输出不得同路径，目标已存在拒覆盖或生成明确overwrite预览；临时目录、timeout、cancel、输出限额、原子写和错误回执必须实现。检查text/tspan/image残留、外链与light/dark结构差异；缺renderer为blocked，不输出伪outline。

验收包含XML、语义、正常/缩小尺寸、light/dark、CSS禁用、字体fallback/CJK、至少第二renderer（环境具备时）和真实发布平台显示。每项状态独立，未测试viewer明说。上游SVG固定子模块没有核实独立许可，发行前不能直接复制其代码/模板/正文而推定MIT；以核实授权或自有等效实现交付完整功能，不删图类型。

## 12. 自定义工作流

自定义模板是版本化声明式DAG，不是eval脚本。节点类型引用04章支持的tool/agent/review/manual/artifact/quality/export等executor；每节点定义goal、inputRefs、outputSchema、dependencies、failurePolicy、timeout、retry、budgets、writeClaims、permissions、idempotency和guard。用户可保存本地模板、导入导出、复制内置模板并修改；运行中的实例固定模板hash，模板升级不偷偷改变已有run。

静态validate至少检查：ID唯一、边引用存在、无环、required inputs可满足、输出类型兼容、未知executor、权限越界、缺timeout、无界重试/并发、重复写claim、无法到达的节点、无终止路径、条件引用未定义、预算溢出与外部副作用未声明。错误给具体node/path与修改建议；validation通过只表示结构合法，不表示运行或业务正确。

guard使用受限表达式或结构化比较，不访问全局对象、文件、网络、shell或JavaScript原型。条件unknown显式等待/blocked，不能按false悄悄跳过验证。动态fan-out设最大数量/深度、输入来源和总预算，超出时暂停等待可审查的新计划。并发节点写同文件应序列化或显式冲突，不能通过换工作目录绕过。

恢复从已提交event和artifact hash重建，已完成节点只在输入/模板/工具/策略兼容时复用。节点外部写效果unknown时先inspect，幂等键与外平台id对应，不自动重复。cancel保留已有artifact和证据并禁止新节点启动；可选择重新计划未完成节点，不把整个历史rewind。用户可人工跳过节点，但记录waiver、影响、授权与gate后果。

## 13. UI、状态与可接手性

一级导航“任务”，二级“质量与工作流”；与看板/执行/定时共享任务身份。质量页提供项目/快照选择、规则目录、检查计划、运行结果、修复预览、质量门、证据；生命周期页提供阶段、artifact、审阅和交付。不是把所有设置堆成一个长表单。

顶部持续显示当前project、scope、snapshot、profile/rule epoch、fresh/cached/mixed、最后执行与复核时间、stale原因。颜色之外用文字/图标区分passed、failed、blocked、unknown、cancelled、partial、stale。cache badge点开能看原run、输入核验和失效原因；不能只用“加速成功”掩盖未执行。

诊断列表支持新增/已解决/未变/移动/已抑制/范围外/未知过滤，稳定排序、分页、键盘定位、源码行跳转、相同rule聚合、完整证据展开。选中diagnostic后显示规则例外、detector级别、fix分类和相关证据，不默认把全rule正文展开进入模型。差分数字解释分母和scope，单文件quick结果不能以全项目大绿盾呈现。

修复预览显示文件diff、风险、冲突、验证计划、授权与过期状态；apply后显示已写/未写/未知和rollback入口。工作树变化提示具体文件与新hash失效，不让用户反复确认一个没有变化的预览。运行取消后保留可读结果与取消范围，不清空界面。

生命周期用阶段导航和每阶段输出卡片，而不是把approval等同完成。卡片列facts/proposal/unresolved、版本、来源、审阅blocking和证据。用户随时能查看“为什么不能继续”和“最小下一步”；提示来自真实guard，不是固定审批模板。执行耗时与预算可折叠，长文档/原始日志按需加载。

视觉与交互遵守总UI设计系统：统一间距/字体/对比度、虚拟化长列表、窄窗口折叠、深浅主题、键盘可达、屏幕阅读标签、reduced motion、操作结果明确。复用原插件布局中的熟悉概念，但统一导航与状态语言；交付具体token和页面线框由UI规格负责。本域至少暴露RulePack、ProjectProfile、ScanPlan、Run、Diagnostic、FixPreview、GateDecision、EvidenceReceipt、WorkflowInstance、Stage、DocumentArtifact、ReviewFinding的view model。

## 14. 错误码、兼容与可观测性

| 错误码 | 含义 | 下一步 |
|---|---|---|
| `QLT_INVALID_ARGUMENT` | 字段、action、路径或schema不合法 | 指出字段，不执行任何变更 |
| `QLT_SCOPE_DENIED` | 路径/进程/外部访问超出宿主授权 | 缩范围或通过正式授权流程 |
| `QLT_TOOL_MISSING` | 工具不可用 | 安装建议/可验证替代，保持blocked |
| `QLT_TOOL_UNTRUSTED` | 工具/配置可执行来源未获信任 | 展示路径、hash、风险与计划 |
| `QLT_CONFIG_CONFLICT` | formatter/rule/resolver等冲突 | 给具体冲突和采纳提案 |
| `QLT_UNSUPPORTED_SYNTAX` | detector不支持输入 | 列范围、兼容checker或unknown |
| `QLT_TYPE_SERVICE_MISSING` | type-aware规则未获真实type服务 | 修复服务，不按无诊断处理 |
| `QLT_SNAPSHOT_STALE` | 输入变化或快照不一致 | 新快照/重计划或保旧版本结果 |
| `QLT_PREVIEW_EXPIRED` | 期限/内容/工具/授权绑定失效 | 重新生成具体预览 |
| `QLT_WRITE_CONFLICT` | 当前内容或并发lease冲突 | 展示差分，不覆写 |
| `QLT_TIMEOUT` / `QLT_CANCELLED` | 超时或取消 | 返回已执行/未执行与effectState |
| `QLT_RESOURCE_LIMIT` | 输出、内存、进程或预算超限 | 缩范围/调预算，不隐藏覆盖缺口 |
| `QLT_OUTPUT_SCHEMA` | checker/model输出无法可靠解析 | 保原文，标unknown，检查adapter |
| `QLT_CACHE_CORRUPT` | hash/原文引用不一致 | 隔离条目、重跑必要检查 |
| `QLT_NOT_COMPARABLE` | epoch/范围无可靠映射 | 显示不可比原因与可比子集 |
| `QLT_EVIDENCE_INCOMPLETE` | gate缺必要证据 | 列最小缺项 |
| `WFL_TRANSITION_BLOCKED` | 阶段guard不满足 | 列缺输入/证据/授权，保现状态 |
| `WFL_TEMPLATE_INVALID` | DAG/引用/权限/预算非法 | 定位节点和字段 |
| `WFL_EXTERNAL_STATE_UNKNOWN` | 外部发送是否成功未知 | 先查询实际状态，不盲重试 |
| `WFL_REVIEW_NOT_INDEPENDENT` | 缺独立cold-reader能力 | 显式降级self-review |
| `WFL_LICENSE_UNVERIFIED` | 所选复用资产许可未核实 | 使用自有等效实现或核实授权 |

错误带retry分类、nextAction、detailsRef与effectState，不把stack trace/秘密塞进模型。遥测默认本地，记录阶段耗时、队列、缓存key类别、命中/失效原因、输出预算、parser状态、取消时延、恢复结果和provider usage；不上报源码/诊断原文/环境秘密。用户可导出脱敏诊断包，发送外部需明确授权。

adapter按版本矩阵管理：宿主SDK、OS、checker/parser/compiler、框架、rulepack、schema migration。升级前验证当前profile与在途run；不支持版本明确disabled/unsupported/unverified。迁移保旧版本对象与回退映射，失败不破坏原报告。过时社区工具名映射到新入口的alias可保留导入兼容，UI只展示一个主要入口；模型工具面不要为了每个alias多注册重复工具。

## 15. 实现分解与交付顺序

逻辑模块：`quality-domain`（规则/计划/诊断/门）、`quality-adapters`（ESLint/compiler/Vue/mypy/vet/formatter）、`quality-cache`（输入closure/结果/报告投影）、`fix-service`（预览/journal/回滚）、`engineering-workflow`（生命周期/模板/真源）、`document-service`（生成/验证/冷读）、`diagram-adapter`（共享IR/SVG/outline）、`quality-ui`（view model与页面）。它们同属一个插件包、一个配置/升级/卸载入口。

交付批次按可用纵切：

1. 固定工具合同、静态规则catalog、只读discover、项目profile、来源与许可记录；UI可见未执行状态。
2. formatter/ESLint/真实TS/Vue/mypy/vet适配、snapshot、分层plan/run/cancel、诊断规范化和稳定diff。
3. closure cache、digest/epoch、按需报告、provider指标、可逆摘要与长程恢复基准。
4. 规则采纳/配置init、安全fix预览/应用/journal/rollback、baseline与gate。
5. 生命周期、文档artifact、真实命令采证、七变更类型、自定义模板、cold review与共享审查引擎。
6. 八类图与outline、外部平台PublishPlan/幂等adapter、跨平台与故障恢复、完整UI和性能验收。

每批不能以“以后再适配旧功能”为由永久删减；缺宿主能力时用已验证的等效路径、明确blocked与待适配清单。发布清单记录上游repo/SHA、复用文件、修改、许可/NOTICE及第三方依赖；两个主仓MIT可直接复用并保留署名；SVG子模块另行核实。实现阶段可以直接使用源码组合，不要求隔离研究者或重新发明已有代码。

## 16. 可执行验收矩阵

以下编号是本域验收标识。实现提供fixture、操作步骤、预期结果和证据包；涉及provider/平台/renderer时注明环境能力。测试验证真正风险与合同，不用镜像函数实现的测试制造数量。首次完成对应要求后不无理由反复扩大测试。

| 编号 | 场景/输入 | 必须观察的结果 |
|---|---|---|
| QLT-001 | 新项目只调用discover，存在可执行JS config | 不执行JS；画像标静态观察和未求值；无业务文件变化 |
| QLT-002 | npm/pnpm锁和项目声明冲突 | 显示来源与冲突，不自动选偏好包管理器或install |
| QLT-003 | 项目已有明确规则与上游默认相反 | 保项目约定，生成可解释采纳冲突，不静默覆盖 |
| QLT-004 | 两formatter覆盖同一Vue文件 | plan阻止冲突或要求唯一owner，不能循环互改 |
| QLT-005 | 请求规则catalog后运行任务/切换项目 | 工具名/schema/说明/顺序hash不变，只有数据状态变化 |
| QLT-006 | explain指定两个ruleId | 只返回相应正文及来源hash，不注入全rulepack |
| QLT-007 | init预览后用户修改config | apply拒绝旧hash，保用户改动并提供新预览 |
| QLT-008 | 缺少checker依赖 | blocked与安装建议，无自动下载，无“零问题通过” |
| QLT-009 | 工具名tsgo但实际实现不可核实 | implementation为unknown，不能凭名宣称native |
| QLT-010 | TS strict基线采纳 | 四个既定flags正确，exactOptional不默认强推，any不全面禁止 |
| QLT-011 | 函数31行但仅20语句；20行31语句 | 前者不因行数误报max-statements；后者触发准确规则 |
| QLT-012 | method/overload/ambient/framework声明 | 合法窄例外不被批量改expression，近似违规仍诊断 |
| QLT-013 | public API需要null，内部无必要null | 前者例外有边界，后者诊断，fix不自动改协议 |
| QLT-014 | 装饰器依赖运行type metadata | import type建议不破坏运行元数据 |
| QLT-015 | promise加void但无reject receiver | 仍触发相应异常/异步诊断 |
| QLT-016 | catch仅注释/void error/未执行嵌套log | 不当成处理；明确合法补偿分支可接受 |
| QLT-017 | reportFailure同名无关函数/未传原error | 不靠函数名证明异常处理，标candidate/unknown或实际违规 |
| QLT-018 | env解构/alias/计算属性与shadow同名变量 | 正确命中真实读取，shadow不误报；跨函数缺口明确 |
| QLT-019 | SSR把private config整体发client | 产生秘密边界诊断，报告不回显secret值 |
| QLT-020 | Vue模板故意类型错误但plain TS通过 | Vue层失败，不能用TS通过代替模板证据 |
| QLT-021 | native Vue链路不支持特定语法 | 有明确fallback/unknown，不exclude.vue伪通过 |
| QLT-022 | Nuxt不同source/root及版本alias | 按真实config解析，#shared/#server不跨版本推定 |
| QLT-023 | Python部分未标注、第三方缺stub | 采用非strict/check_untyped_defs；例外限module，不全局ignore |
| QLT-024 | Python取消/中断进入except | 不能被通用降级吞成成功，保cause与取消语义 |
| QLT-025 | Go import alias/shadow及goroutine error | 用types区分；未接收错误不因vet已过而全部通过 |
| QLT-026 | Go/Python文件进入format层 | 使用项目适当工具，不套JS命名/表达式规则 |
| QLT-027 | 自定义type rule没有type service | 测试/运行明确失败或skip，不能接受任意error为规则命中 |
| QLT-028 | 自定义rule正例、反例、窄例外、近似违规 | exact diagnostic与位置符合，例外未扩大成全局关闭 |
| QLT-029 | changed单文件与公共export变化 | 仅必要集合执行；公共接口触发依赖闭包，原因可查看 |
| QLT-030 | 删除/重命名文件 | 依赖影响被检查，旧diagnostic匹配保confidence，不遗失 |
| QLT-031 | 无可靠依赖图 | 保守扩大或unknown，不静默单文件绿灯 |
| QLT-032 | scan中工作树继续变化 | 结果绑定旧snapshot并stale或停止重计划，不混合版本通过 |
| QLT-033 | 未tracked文件未显式纳入 | scope清晰排除；要求纳入后进入snapshot，不暗含 |
| QLT-034 | checker输出超限/格式未知 | 有界artifact/截断标记，parser unknown不变零诊断 |
| QLT-035 | cancel Windows子进程树 | 子孙进程终止或可见残留警告；已执行范围可审计 |
| QLT-036 | timeout/resource limit | run为partial/failed，门不得通过，effectState准确 |
| QLT-037 | unchanged内容不同mtime | 内容hash相同可复用，receipt保原执行与当前重核时间 |
| QLT-038 | 内容改但mtime恢复 | cache失效，不受mtime欺骗 |
| QLT-039 | extends/plugin/lock/alias/compiler版本变化 | 正确closure失效并更新epoch/影响范围 |
| QLT-040 | secret环境值参与结果 | key可失效，日志/报告/模型均不出现secret原值 |
| QLT-041 | 网络/时间依赖测试输入未变 | 不自动当确定性cache fresh pass |
| QLT-042 | warm unchanged重复report | semantic digest稳定，brief不重复完整diagnostics |
| QLT-043 | 插注释导致行号整体移动 | stable fingerprint尽量保持，不能全量new/resolved |
| QLT-044 | 同文件两个相同message | 不误去重，分别定位和计数 |
| QLT-045 | 候选run未覆盖旧问题文件 | out-of-scope/unknown，绝不resolved |
| QLT-046 | rulepack升级导致含义变化 | epoch变化，不可比项明确；不伪造成用户新增问题 |
| QLT-047 | 模型请求L2证据后续接 | 可定位L3原文/hash/span；不自动再次注入所有L3 |
| QLT-048 | 原文ref损坏/被清理 | 明确corrupt/expired，不指向别的版本或只留无法核实结论 |
| QLT-049 | provider无cache usage字段 | 缓存率unknown，不把本地命中率当LLM缓存率 |
| QLT-050 | 长程状态/进度/active rule变化 | 不改system/tools稳定前缀，不重排已发送历史 |
| QLT-051 | 恢复包抽查目标/授权/快照/未完成项 | 可准确回答并回溯原文，压缩不丢关键未知项 |
| QLT-052 | safe fix与null/异常/配置移动候选混合 | 一键安全修复仅白名单项，行为类单列风险 |
| QLT-053 | 多fix重叠/非幂等 | 冲突可见，拒盲写；重复执行无变化才可认幂等 |
| QLT-054 | preview命令内部会写文件 | 使用隔离副本或拒预览，不先改真文件再撤销 |
| QLT-055 | preview后tool/rule/scope/内容变化 | apply拒旧previewHash并列具体失效原因 |
| QLT-056 | apply中途崩溃 | journal恢复列已写/未写/未知，不谎称多文件原子 |
| QLT-057 | 用户在fix后继续编辑再rollback | 不覆写，给三方冲突；不git reset或清理untracked |
| QLT-058 | cancel发生在verification | patch保留或安全回滚状态明确，标未验证 |
| QLT-059 | CRLF/BOM/非UTF8/权限位文件 | 不意外转换编码/换行，无法安全处理时拒自动fix |
| QLT-060 | gate混入不同snapshot证据 | 不聚合passed，明确不兼容输入 |
| QLT-061 | 门缺Vue层、工具、权限或超时 | blocked/unknown而非passed，列最小缺项 |
| QLT-062 | 基线接受旧问题后出现新同类问题 | 新问题不继承豁免；债务计数与到期保留 |
| QLT-063 | policy改宽后重算门 | 新revision与差分可见，旧decision不被覆盖 |
| QLT-064 | 用户已授权普通任务执行 | 生命周期不为默认skill每步重问；授权和范围记录 |
| QLT-065 | demand-change只有当前代码、无原需求 | 原意unknown并请求必要来源，不编历史需求 |
| QLT-066 | design修改/执行偏差 | 新revision追加，旧需求/设计可读，重大超scope回guard |
| QLT-067 | fix/refactor/migration/DX/deployment模板 | 标本产品扩展，最低字段与风险验证完整 |
| QLT-068 | tiny文档修改 | fastpath能完成，不强造全套Issue/八张图，仍有验证声明 |
| QLT-069 | README/CONTRIB生成但脚本不存在 | 不编命令，来源可查；缺口标未验证 |
| QLT-070 | 双语README命令/边界不同 | validate诊断具体冲突，路径与命令不被翻译改写 |
| QLT-071 | cold-reader收到作者预期答案 | context校验拒绝该独立声明或重新构造最小brief |
| QLT-072 | 无子代理能力 | 显式self-review，不能冒称独立冷读 |
| QLT-073 | review后文档大改 | finding绑定旧hash，受影响审阅失效；无blocking后可停止 |
| QLT-074 | 八图类型生成与禁用CSS预览 | 类型齐全、standalone可读、无script/external/foreignObject |
| QLT-075 | outline renderer缺失/超时/输出残text | blocked/failed，无伪outline，源可编辑稿仍保留 |
| QLT-076 | dark与light geometry变化 | 校验失败或明确不兼容，不能只看XML合法 |
| QLT-077 | SVG子模块资产进入发行候选 | license gate识别未核实，保功能的自有实现路径 |
| QLT-078 | 自定义DAG有环、缺引用、无界重试/写冲突 | 静态拒绝并定位，不执行任意JS |
| QLT-079 | 模板更新时已有run在途 | 原run固定hash，不偷偷改变executor/guard |
| QLT-080 | 外平台发送超时且结果未知 | 先inspect；无明确人授权不发；已授权不重复发 |
| QLT-081 | 本地export草稿 | 完整文件/refs可读，无外部消息、git push/merge/deploy副作用 |
| QLT-082 | 任意路径含空格/CJK/UNC/symlink | argv和授权解析正确，不shell注入或越界写 |
| QLT-083 | UI与工具请求相同计划 | 共享同一domain结果/receipt，状态与范围一致 |
| QLT-084 | 键盘/屏幕阅读/窄窗/reduced motion | 核心操作可达，状态不用颜色单独表达 |
| QLT-085 | 从旧插件导入退役后台质量能力 | 映射到真实job/状态/取消/结果ref，不显示no-op成功 |
| QLT-086 | 只读源码/XML检查导出证据 | 不冒称测试/渲染通过，未执行项明确 |
| QLT-087 | evidence包hash被篡改 | verify失败并定位，不静默接受 |
| QLT-088 | 清理私有项目数据 | 不触碰业务文件；引用中的证据/回滚点遵守保留策略 |

最终交付须包含可安装插件包、规则与许可清单、适配矩阵、上述验收结果、缓存基准原始usage、已知缺口和可继续工作的恢复包。本规格阶段只定义这些验收合同，不声称相关实现或运行测试已经完成。
