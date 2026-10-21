/**
 * Implementation candidates are navigation, not proof. A file existing or a
 * test file passing never satisfies an entire source unit or frozen domain.
 * The reporter always prints the original acceptance text beside this mapping.
 */
export const domainCandidates = [
  { prefixes: ['HOST-', 'SYS-'], packages: ['A01'], files: ['src/host/index.ts', 'src/host/routes.ts', 'src/host/host-adapter.ts', 'src/domain/operations/index.ts', 'src/domain/storage/index.ts'], tests: ['tests/operations.test.ts', 'tests/storage.test.ts'], needs: '真实 Desktop slot/Connection/权限/持久化与生命周期证据；领域 fixture 只证明相应不变量。' },
  { prefixes: ['MEM-'], packages: ['A02'], files: ['src/domain/memory/index.ts', 'src/domain/memory/file-memory.ts', 'src/domain/memory/cognition.ts', 'src/domain/memory/providers.ts', 'src/domain/memory/sync.ts'], tests: ['tests/memory.test.ts'], needs: '完整来源 operation、Provider 合同与迁移故障矩阵；有账户的远端服务须实际调用。' },
  { prefixes: ['CCH-', 'CTX-'], packages: ['A03'], files: ['src/domain/context/index.ts', 'src/domain/context/cache.ts', 'src/adapters/upstream/billion/native.ts', 'src/domain/usage/index.ts', 'vendor/acp-kernel/src/index.ts'], tests: ['tests/context/context.test.ts', 'tests/integrations.test.ts'], needs: '最终 wire 金样与 500+ 轮；真实 Provider 配对费用/质量/TTFT，不能从本地前缀推导命中。' },
  { prefixes: ['CTX-GRF-', 'CTX-ATL-', 'CTX-SES-', 'CTX-MAT-', 'CTX-SRC-', 'CTX-STALE-', 'CTX-REC-', 'CTX-ACC-'], packages: ['A03', 'A06'], files: ['src/domain/graph/index.ts', 'src/domain/graph/history.ts', 'src/adapters/search/index.ts'], tests: [], needs: '图谱真实 Host 投影、分支导航和来源恢复；搜索 provider 实际调用及失败切换。' },
  { prefixes: ['WF-', 'MMR-'], packages: ['A04', 'A05'], files: ['src/domain/workflow/index.ts', 'src/domain/workflow/scheduler.ts', 'src/domain/workflow/orchestration-service.ts', 'src/domain/orchestration/index.ts', 'src/domain/resources/agents/library.ts'], tests: ['tests/workflow.test.ts', 'tests/domain/orchestration/policies.test.ts'], needs: '独立 actor/真实多模型执行与全部物理 attempt；CLI/房间/通知/任务相关动作须逐项证明。' },
  { prefixes: ['QLT-'], packages: ['A05'], files: ['src/domain/quality/index.ts', 'src/domain/quality/rules.ts', 'src/domain/quality/lifecycle.ts', 'src/domain/review/index.ts', 'src/domain/artifacts/index.ts'], tests: ['tests/domain/quality.test.ts'], needs: 'TS/Vue/Python/Go checker 真实工具链、工程流程与文档/图表交付证据。' },
  { prefixes: ['RUN-AT', 'REC-AT', 'EXT-AT'], packages: ['A06'], files: ['src/domain/runtime/presets/index.ts', 'src/domain/runtime/execution/index.ts', 'src/domain/recovery/index.ts', 'src/domain/extensions/index.ts'], tests: ['tests/recovery-extensions.test.ts'], needs: 'Desktop 正式 preset/PTY、真实同进程扩展消费、故障窗口与工作区恢复；只在隔离 fixture 测试救援文件。' },
  { prefixes: ['UI-'], packages: ['A07'], files: ['src/client/index.tsx', 'src/client/app.tsx', 'src/client/views.tsx', 'src/client/domain-views.tsx', 'src/domain/integrations/index.ts', 'src/domain/resources/index.ts'], tests: ['tests/integrations.test.ts'], needs: '真实 Desktop 逐页面交互、zh/en/ru、键盘/可访问性/窄屏、SSH/远程设备/市场与更新权威。' },
  { prefixes: ['REL-', 'DEV-'], packages: ['A08'], files: ['scripts/build.mjs', 'scripts/package-delivery.mjs', 'scripts/acceptance-report.mjs', 'docs/coverage/验收与证据说明.md'], tests: [], needs: '交付包审计、精确 Host 运行、来源追溯及所有强制断言；安装返回 0 不足以放行。' },
];

const source = (id, packages, files, capabilities, remaining) => ({ id, packages, files, capabilities, remaining, status: 'implementation_candidate_requires_evidence' });
export const sourceCandidates = [
  source('SRC-01', ['A02'], ['src/domain/memory/local.ts', 'src/domain/memory/file-memory.ts'], '范围、触碰、关键词、原子 Markdown、秘密拒绝', '实际目录激活、去重与安全故障'),
  source('SRC-02', ['A02'], ['src/domain/memory/cognition-manifest.ts', 'src/domain/memory/cognition.ts', 'vendor/memory-cognition'], '38 个高级 operation 与 Python brain 协议', '38 op × methods 联合 manifest、真实 Python 生命周期与权限'),
  source('SRC-03', ['A02', 'A04'], ['src/domain/memory/index.ts', 'src/domain/memory/sync.ts', 'src/domain/workflow/productivity.ts', 'src/domain/workflow/collaboration.ts', 'src/domain/integrations/cli/index.ts'], '五轨、建议审核、Git 同步、待办/模板/房间/CLI', '旧数据迁移、通知/旁观与真实执行'),
  source('SRC-04', ['A01', 'A02'], ['src/domain/memory/providers.ts', 'vendor/mnemon-providers', 'src/host/hooks.ts'], 'Source×Strategy×Provider、九后端、guided recall/writeback', '全部实际 provider 驱动路径/接口及 fork capture 防重'),
  source('SRC-05', ['A02'], ['src/domain/memory/providers.ts', 'src/domain/memory/external-engines.ts'], 'OpenViking VFS 与分层 Provider', '可选服务实测 retain/recall/资源/编译，服务许可边界'),
  source('SRC-06', ['A02'], ['src/domain/memory/external-engines.ts', 'vendor/memsearch'], 'Markdown 真源、memsearch hybrid/expand/transcript', 'Python/Milvus 不同 embed 合同、离线降级'),
  source('SRC-07', ['A02'], ['src/domain/memory/providers.ts'], 'Hindsight retain/recall/reflect/pages', '真实服务页面兜底、反思预算和时序'),
  source('SRC-08', ['A02'], ['src/domain/memory/local.ts', 'src/domain/memory/external-engines.ts'], '信任、反馈、复发、Veyra 代码脑发现与桥', '已安装可选代码服务真实行为；不能只证明发现文件'),
  source('SRC-09', ['A07'], ['src/client/views.tsx', 'src/domain/files/index.ts', 'src/domain/runtime/index.ts'], '文件树/编辑/搜索、Git、终端、工作台', 'Side Chat、底部 tabs/扩展注册及真实会话关系'),
  source('SRC-10', ['A07'], ['src/client/domain-views.tsx', 'src/client/views.tsx'], '阅读投影与成功轮折叠', '成功/失败/取消/未知块、选择文本与滚动实测'),
  source('SRC-11', ['A04', 'A05'], ['assets', 'src/domain/resources/index.ts', 'src/domain/quality/lifecycle.ts'], 'J-Space 方法资产与认知阶段', '13 模块/7 参考/周期重读、控制器/账本及 preset 的执行'),
  source('SRC-12', ['A07'], ['src/domain/resources/market-catalog.ts', 'src/domain/resources/index.ts'], '皮肤目录、缓存/内置、安装与主题 try-on', '在线与离线目录、失败安装与撤销'),
  source('SRC-13', ['A04', 'A06', 'A07'], ['src/client', 'src/domain/resources', 'src/domain/runtime', 'src/domain/integrations'], 'dsh-web 19 子包整合', '逐子包完整范围与当前 Desktop 接缝实测'),
  source('SRC-14', ['A03', 'A07'], ['src/domain/usage/index.ts', 'src/host/hooks.ts', 'src/client/domain-views.tsx'], '镜像去重、live usage 展示', 'stream 估计→reported 替换、断线/重试与 TPS'),
  source('SRC-15', ['A05'], ['src/domain/review/index.ts', 'src/adapters/vcs/index.ts'], '独立实现 Git/SVN capture 与二阶段审查', 'SVN UUID/peg/mergeinfo、覆盖、后台审查；未复制受限源码'),
  source('SRC-16', ['A05'], ['assets', 'src/domain/quality/lifecycle.ts'], 'Aegis 风险/基线/ADR/反熵方法', '规则资产与流程实际路由和续接'),
  source('SRC-17', ['A04'], ['src/domain/resources/agents/library.ts', 'src/domain/resources/agents/upstream'], '全部专家目录、persona/团队与自定义', '331 角色可发现、按需正文及真实团队执行'),
  source('SRC-18', ['A05', 'A07'], ['src/domain/files/index.ts', 'src/domain/operations/index.ts'], '16 文件/文档操作、批处理与结果引用', 'Native/PTC 等价、平台搜索、可选 Rust 执行核实际路径'),
  source('SRC-19', ['A05'], ['assets', 'src/domain/resources/skills.ts', 'src/domain/quality/lifecycle.ts'], 'Superpowers 技能与版本化流程', '用户技能可见、完整方法路由与实际产物'),
  source('SRC-20', ['A05'], ['src/adapters/upstream/archify/index.ts', 'src/domain/artifacts/diagrams.ts', 'assets/diagrams/archify'], '十类 Archify 图与 explainer/导出', '全部图类型/交互参数、CSP、安全预览/last-good'),
  source('SRC-21', ['A06'], ['src/upstream/synapse/projection.ts', 'src/domain/graph/index.ts'], 'Synapse 会话地图投影', '当前 Host 导航/分支/上下文且不改日志'),
  source('SRC-22', ['A06'], ['src/domain/runtime/presets/index.ts', 'src/domain/runtime/presets/host.ts'], 'PowerShell 17 类检查与执行前门禁', 'PS5.1/PS7 AST、例外绑定、PSSA 故障'),
  source('SRC-23', ['A06'], ['src/domain/files/text-encoding.ts', 'src/domain/runtime/execution/index.ts'], '字节与文本编码集中适配', 'CP936/GB18030 跨 chunk、Write-Host/exit/大输出'),
  source('SRC-24', ['A06'], ['src/domain/runtime/presets/index.ts', 'src/domain/runtime/presets/host.ts'], '正式 Git Bash bundle 与发现', '中文路径 Git Bash/非 WSL、受限模式'),
  source('SRC-25', ['A06'], ['src/domain/runtime/execution/index.ts', 'src/domain/runtime/presets/host.ts'], '正式持久 pwsh 与 one-shot', 'cwd/env/function/alias 跨调用、actor隔离、取消树'),
  source('SRC-26', ['A06'], ['src/domain/extensions/index.ts', 'src/domain/extensions/isolated.ts', 'src/workers/isolated-extension.ts'], 'native/isolated、热换/staging/脚手架/build/pack', '同进程 service 真消费、动态 UI、watch 失败保旧与 owner 清理'),
  source('SRC-27', ['A03', 'A06'], ['src/domain/runtime/presets/index.ts', 'src/domain/operations/index.ts'], '固定 dispatcher、发现/解锁与 epoch', '窄面→解锁→熔断/显式工具晋升完整链'),
  source('SRC-28', ['A06'], ['src/domain/recovery/index.ts', 'src/domain/recovery/upstream'], '三模式、成熟 changeLedger/recovery 内核', '所有持久边界强杀、链接/补偿/GC/大仓矩阵'),
  source('SRC-29', ['A03'], ['src/domain/context/index.ts', 'src/domain/usage/index.ts'], '上下文/构成/事件/使用量观测', 'Steps/Summary/Insights/Fleet、偏好 epoch 与真实计费 parity'),
  source('SRC-30', ['A03'], ['vendor/acp-kernel', 'src/domain/context/index.ts', 'src/adapters/upstream/billion/native.ts'], '真实自治可逆 T1/T2/T3 内核与 native commit', '最终 wire 金样、双模式/迁移/故障、500+轮与真实配对费用'),
  source('SRC-31', ['A03'], ['src/adapters/search/index.ts', 'src/adapters/search/network.ts'], '三源轮换与 search/fetch 网络网关', '真实三源/时间范围/失败切换、MCP/native 等价'),
  source('SRC-32', ['A06'], ['src/domain/graph/index.ts', 'src/domain/graph/context.ts', 'src/domain/graph/history.ts', 'src/upstream/thoughtdag'], 'ThoughtDAG 上下文/历史/Atlas/主题与导出', '连线真实上下文、Condense/Weave、分享/CLI/MCP全部入口'),
  source('SRC-33', ['A03', 'A07'], ['src/domain/usage/index.ts', 'src/adapters/models/accounts'], '账户 adapter、统一 attempt 用量、余额与订阅', '13 账户接口、热图/下钻与缓存持久化实际数据'),
  source('SRC-34', ['A05'], ['src/domain/quality/index.ts', 'src/domain/quality/rules.ts', 'assets'], 'how-to-lint 方法、确定性 checker/计划/门禁', '全部语言语义、错误层次、增量采用与安全修复'),
  source('SRC-35', ['A05'], ['src/domain/quality/lifecycle.ts', 'src/domain/artifacts/diagrams.ts', 'assets'], '工程流程、技术写作、模板与 SVG', '需求/设计/实现/冷审查闭环、全部模板可执行与来源'),
  source('SRC-36', ['A04'], ['src/domain/orchestration', 'src/domain/workflow/orchestration-service.ts', 'src/domain/workflow/scheduler.ts'], 'Metis policy/16框架/26角色/蓝图/独立门/适应性', '同一 Run 真实多模型与独立 oracle，角色 lane、全部 attempt 与主会话固定'),
];
export const webSubpackages = [
  ['dsh-git-graph', ['src/domain/runtime/index.ts', 'src/client/views.tsx'], '分支/worktree/守卫/空会话/影响预览'],
  ['dsh-i18n', ['locale', 'src/client'], 'zh/en/ru 字典、命名空间、fallback 与扩展语言注册'],
  ['dsh-liangshen', ['src/domain/runtime/presets', 'src/host/compaction.ts'], '纪律/preset、native/PTC、MCP 激活与回退'],
  ['dsh-market', ['src/domain/resources/index.ts'], '皮肤/宠物/插件/预设、try-on、安装与统计'],
  ['dsh-plugin-manager', ['src/domain/extensions/index.ts', 'src/host/host-adapter.ts'], '官方 bundle、兼容预检、更新失败停队、回滚/待重启'],
  ['dsh-remote-bridge', ['src/domain/integrations/native-remote.ts', 'src/domain/integrations/remote'], '一次 QR/P256、设备撤销、历史/队列/审批'],
  ['dsh-remote-web-ui', ['src/domain/integrations/index.ts', 'src/client'], 'Web 配对、倒计时、LAN/防火墙/隧道、窄屏'],
  ['dsh-session-archive', ['src/domain/runtime/index.ts', 'src/client/views.tsx'], '全部可见会话/跨页/家族保护/归档恢复删除/自动规则'],
  ['dsh-session-id', ['src/client', 'src/host/host-adapter.ts'], '完整 ID、搜索/复制与剪贴板失败回退'],
  ['dsh-skill-explorer', ['src/domain/resources/skills.ts'], '多来源、创建导入编辑、健康、废纸篓恢复'],
  ['dsh-ssh', ['src/domain/integrations/ssh.ts', 'src/client/views.tsx'], '密码/key/agent/passphrase、跳板、池、PTY/SFTP/转发/集群'],
  ['dsh-task-board', ['src/domain/workflow/productivity.ts', 'src/domain/workflow/scheduler.ts'], '五列、标签/子任务/团队/调度/交接/双开关目标运行与重启'],
  ['dsh-task-board-github', ['src/domain/workflow/github-board.ts'], 'Issue/冻结 prompt/AI 分析审核/PR评论close 授权与 receipt'],
  ['dsh-task-board-remote', ['src/domain/integrations/index.ts'], '同账本 snapshot/options/apply/changed/revision 冲突'],
  ['dsh-update', ['src/host/host-adapter.ts', 'src/client'], '状态/版本/notes/进度，Desktop 官方更新权威'],
  ['dsh-usage', ['src/domain/usage/index.ts', 'src/client/domain-views.tsx'], '日模型/供应商/余额订阅/30日/footer/非加法桶'],
  ['dsh-web-all', ['src/domain/index.ts', 'cordis.patch.yml'], '单包组合、旧别名兼容，无重复页'],
  ['dsh-web-settings', ['src/client/domain-views.tsx', 'src/host/routes.ts'], '分类/schema/namespace 与连接回退'],
  ['dsh-win-bash', ['src/domain/runtime/index.ts', 'src/domain/runtime/execution/index.ts'], 'session/exit/超时截断/jobs、可见性与权限分离'],
].map(([name, files, scope]) => ({ name, files, scope, status: 'implementation_candidate_requires_evidence' }));

export const testBindings = [
  { file: 'tests/memory.test.ts', title: 'MEMORY.md and nested MEMORY retain bytes and pinned versions while hash refresh detects edits', ids: ['MEM-079', 'MEM-080', 'MEM-085', 'MEM-089', 'MEM-091'], coverage: 'partial' },
  { file: 'tests/memory.test.ts', title: 'memory CAS preserves draft on conflict and rejects secrets before Markdown persistence', ids: ['MEM-094', 'MEM-093'], coverage: 'partial' },
  { file: 'tests/memory.test.ts', title: 'fixed snapshot remains byte stable after new memory; explicit refresh advances epoch', ids: ['MEM-089', 'CCH-008', 'CCH-010'], coverage: 'partial' },
  { file: 'tests/memory.test.ts', title: 'secret file chunks are quarantined and not copied into pinned raw blob', ids: ['MEM-093'], coverage: 'partial' },
  { file: 'tests/memory.test.ts', title: 'unknown advanced methods and self-declared host authority fail closed before process launch', ids: ['MEM-078'], coverage: 'partial', kind: 'domain-test' },
  { file: 'tests/workflow.test.ts', title: 'public workflow refuses DAG cycles before creating children', ids: ['WF-003'], coverage: 'complete', kind: 'domain-test' },
  { file: 'tests/workflow.test.ts', title: 'one Run executes ready peers, waits dependencies, disposes every exact handle and reuses idempotent result', ids: ['WF-001', 'MMR-044', 'REL-017'], coverage: 'partial' },
  { file: 'tests/workflow.test.ts', title: 'empty/fixed-PASS gate is unverified and failed real oracle blocks dependent work', ids: ['WF-002', 'MMR-022', 'MMR-037', 'MMR-038', 'MMR-045', 'DEV-005'], coverage: 'partial' },
  { file: 'tests/workflow.test.ts', title: 'model-call budget rejects work before a second host spawn and records every physical attempt', ids: ['WF-016'], coverage: 'partial' },
  { file: 'tests/workflow.test.ts', title: 'full Agency catalog remains expandable and expert persona retrieval is separate from listing', ids: ['WF-097'], coverage: 'partial' },
  { file: 'tests/workflow.test.ts', title: 'cancel waits exact activation dispose and never substitutes abort-only success', ids: ['WF-011', 'HOST-028'], coverage: 'partial' },
  { file: 'tests/workflow.test.ts', title: 'room messages need runtime permission, preserve source, and presence is never execution evidence', ids: ['WF-020', 'WF-061'], coverage: 'partial' },
  { file: 'tests/integrations.test.ts', title: 'file CAS preserves BOM, CRLF and original bytes on a concurrent edit conflict', ids: ['WF-021', 'WF-022'], coverage: 'partial' },
  { file: 'tests/integrations.test.ts', title: 'workspace path refuses traversal and an ancestor symlink escaping root', ids: ['WF-023', 'WF-024', 'HOST-035', 'MEM-084', 'REC-AT06'], coverage: 'partial' },
  { file: 'tests/integrations.test.ts', title: 'host normalized input is disjoint; DeepSeek and Anthropic do not double count cache', ids: ['CCH-026', 'CCH-027'], coverage: 'partial' },
  { file: 'tests/integrations.test.ts', title: 'usage ledger replaces interim samples, retains all retry attempts and separates currencies', ids: ['CCH-028', 'CCH-031', 'CCH-033', 'CCH-038', 'REL-017'], coverage: 'partial' },
  { file: 'tests/context/context.test.ts', title: 'same static epoch and projection replay keeps byte-identical prefix; actual wire has an independent sequence', ids: ['CCH-001', 'CCH-002', 'CCH-003', 'CCH-023'], coverage: 'partial' },
  { file: 'tests/context/context.test.ts', title: 'T1/T2/T3 use real kernel lineage and exact originals survive restart, search and restore', ids: ['CCH-012', 'CCH-013', 'CCH-015', 'CCH-016', 'CCH-017', 'REL-005'], coverage: 'partial' },
  { file: 'tests/context/context.test.ts', title: 'session lanes and purposes isolate compression and physical samples; retries update one observation', ids: ['CCH-011', 'CCH-028', 'CCH-031', 'CCH-033'], coverage: 'partial' },
  { file: 'tests/context/context.test.ts', title: 'real autonomous controller can wait and compress; malformed response never fabricates success', ids: ['CCH-039', 'CCH-040', 'REL-005'], coverage: 'partial' },
  { file: 'tests/context/context.test.ts', title: 'edits allocate a new source version; corruption fails exact recovery instead of returning guessed text', ids: ['CCH-018', 'CCH-041'], coverage: 'partial' },
  { file: 'tests/context/context.test.ts', title: 'epoch changes wait for in-flight leases and route changes cannot borrow old warm state', ids: ['CCH-006', 'CCH-007', 'CCH-035'], coverage: 'partial' },
  { file: 'tests/context/context.test.ts', title: 'native conversion retains tool JSON bytes, source, replay state and opaque media; seqs follow surface order', ids: ['CCH-020', 'CCH-021', 'HOST-021'], coverage: 'partial' },
  { file: 'tests/context/context.test.ts', title: 'native proposal never activates kernel before exact authoritative official commit; fabricated PASS rejected', ids: ['HOST-040', 'HOST-045', 'CCH-046'], coverage: 'partial' },
  { file: 'tests/domain/quality.test.ts', title: 'quality discovery never evaluates project JS config and reports package-manager conflicts', ids: ['QLT-001', 'QLT-002'], coverage: 'partial', kind: 'domain-test' },
  { file: 'tests/domain/quality.test.ts', title: 'AST statement rule counts statements, stable occurrence fingerprints survive line shifts', ids: ['QLT-011'], coverage: 'complete', kind: 'domain-test' },
  { file: 'tests/domain/quality.test.ts', title: 'safe fix preview rejects user edits and rollback never overwrites subsequent changes', ids: ['QLT-007', 'QLT-055', 'QLT-057'], coverage: 'partial' },
  { file: 'tests/domain/quality.test.ts', title: 'all eight original SVG types are standalone safe and paint-only theme preserves geometry', ids: ['QLT-074', 'QLT-075', 'QLT-076'], coverage: 'partial' },
  { file: 'tests/domain/quality.test.ts', title: 'real Git review distinguishes staged snapshot from later working-tree content', ids: ['WF-081', 'WF-082'], coverage: 'partial' },
  { file: 'tests/recovery-extensions.test.ts', title: 'conversation-only recovery preserves files, validates direct user boundary and forks once after retry', ids: ['REC-AT01', 'REC-AT02', 'REC-AT11'], coverage: 'partial' },
  { file: 'tests/recovery-extensions.test.ts', title: 'injected messages do not displace the first real user turn; unknown create never retries', ids: ['REC-AT11', 'REL-022'], coverage: 'partial' },
  { file: 'tests/recovery-extensions.test.ts', title: 'fixture ledger restores raw bytes, retains rescue, rejects post-plan edit and excludes credentials before capture', ids: ['REC-AT03', 'REC-AT04', 'REC-AT05'], coverage: 'partial' },
  { file: 'tests/recovery-extensions.test.ts', title: 'compensation preserves an external edit after a committed path and reports recovery-required', ids: ['REL-021', 'REC-AT09'], coverage: 'partial' },
  { file: 'tests/recovery-extensions.test.ts', title: 'extension review hashes real source and native failed generation keeps old active', ids: ['EXT-AT04', 'EXT-AT09'], coverage: 'partial' },
];

/** Explicit IDs in a test name produce a partial mapping only. Even an ID in a
 * title cannot attest all clauses, actual Desktop seams or paid-model effects. */
export function idsInTitle(title) {
  const out = new Set();
  for (const match of title.matchAll(/\b(MMR|MEM|CCH|QLT|HOST|UI|WF|REL|DEV)-(\d{3})(?:(\.\.|[/-])(\d{3}))?/gu)) {
    const prefix = match[1], first = Number(match[2]), tail = match[4] ? Number(match[4]) : first;
    if (match[3] === '..' && tail >= first && tail - first <= 100) for (let id = first; id <= tail; id++) out.add(`${prefix}-${String(id).padStart(3, '0')}`);
    else { out.add(`${prefix}-${String(first).padStart(3, '0')}`); if (match[4]) out.add(`${prefix}-${String(tail).padStart(3, '0')}`); }
    // MMR-025/026/027 abbreviates the repeated prefix.
    const remainder = title.slice(match.index + match[0].length).match(/^(?:\/\d{3})+/u)?.[0] ?? '';
    for (const suffix of remainder.matchAll(/\/(\d{3})/gu)) out.add(`${prefix}-${suffix[1]}`);
  }
  return [...out];
}
