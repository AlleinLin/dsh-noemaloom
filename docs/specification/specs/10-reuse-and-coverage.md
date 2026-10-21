# 10 来源组合、去重择优与功能复活台账

本台账的单位是**用户能力**而非原 npm 包数。“合并”不是删除，“复活”不是只改版本字符串，“复用”不代表未经检验保留上游的全局副作用。最终交付必须同时满足领域规格与来源追溯；以下概括不能代替各领域的细粒度操作表和验收。

研究覆盖33个本地目录与3个追加仓库，共36研究单元。Metis按固定commit研究，不能把其Desktop/CLI版本误当DSH adapter已可用。根package版本有时属于主应用、Python工程或聚合库，不能直接作为DSH adapter版本。完整本地初始快照在 `research/source-inventory.json`，各研究章补充嵌套包、许可与确切SHA。包声明和实际LICENSE矛盾时按具体组件重新核实，不能只读 `package.json.license`。

## 1. 全来源去向

| ID | 研究目录 / 仓库 | 必须保留的能力簇 | 组合与直接复用方向 | 合同与验收 |
|---|---|---|---|---|
| SRC-01 | annkun__dsh-memory | 用户/项目/目录触碰激活、关键词检索、纯文件索引、证据写入/去重/密钥拒绝 | LOCAL memory轻量基底、原子文件与范围约束；统一注入器替代独立system贡献 | 02 / MEM |
| SRC-02 | FuRongJun-1999__dsh-memory | CCG卡、五层与负记忆、规则裁决、条件路由/阶梯回退、38个高级op、时间线、token权限、进程换代检查 | Python brain及协议可直接适配；完整operation manifest迁移，不能只采tool list | 02 / MEM |
| SRC-03 | csyangwen__dsh-memory-evolve | 五轨/分支记忆、经验建议/审核、git同步；todo/技能/提示词/画布/会话/房间/CLI/旁观/通知 | 存储与迁移适配、复用可用工作台领域模块；维护状态不是剔除理由 | 02+04 / MEM,WF |
| SRC-04 | omdsh-dev__dsh-mnemon | Source×Strategy×Provider、分层、9后端、SDK、turn bar、brain mark、guided recall/writeback、备份与和解 | 统一Memory编排主要参考；SDK/Provider/生命周期优先复用并适配Desktop | 01+02 / HOST,MEM |
| SRC-05 | volcengine__OpenViking | VFS、L0/L1/L2、子树检索、资源/技能/记忆、会话capture、MCP保护、编译知识 | examples中的Apache适配层可复用；AGPL主服务作为可选部署，分别处理 | 02 / MEM |
| SRC-06 | zilliztech__memsearch | Markdown真源+Milvus影子、dense/sparse/RRF、search/expand/transcript、逐轮capture、跨agent共享、embed多后端 | 索引/检索/capture可选backend，保留去重与无结果零注入 | 02 / MEM |
| SRC-07 | vectorize-io__hindsight | retain/recall/reflect、pages与兜底、观察/时序/心智模型、可配置自动反思 | 可选Provider；保留reflect档与预算，不能按旧报告误认为仅pages/recall | 02 / MEM |
| SRC-08 | LoveDoLove__Veyra | 工程/信任记忆、反馈与复发、scope、代码脑cbm、冲突/健康 | 信任和反馈归公共memory，代码智能作为具名可选adapter | 02 / MEM |
| SRC-09 | omdsh-dev__DSH-better-sidebar | 文件树/编辑/搜索/预览、Git写操作和只读提交图、底部tabs、Side Chat、agent/workflow观察、扩展注册 | 工作台布局和文件/Git服务主基底；UI迁移React slots，PTY由宿主 | 03 / UI |
| SRC-10 | dsh-better-display-main | 阅读投影、成功轮自动折叠、内容保真、滚动/选择、MCP App | **复活**renderer与阅读行为，适配当前投影/slots，不只改peer | 03 / UI |
| SRC-11 | AnonyJcy__dsh-j-space | 认知方法、分阶段推理/问题构造、persona预设 | 方法资产/预设模块；旧宿主接缝迁移，第三方引文许可单列 | 04+06 / WF,RUN |
| SRC-12 | kingOfSoySauce__dsh-skin-market | 在线/缓存/内置目录、搜索/预览/安装、版本锁、主题切换 | 与资源市场合并目录层，保留来源区别；资产版权独立 | 03 / UI |
| SRC-13 | zhu1090093659__dsh-web | 19本地包全部功能；目录、任务、Git、远程、SSH、设置、更新、使用量等 | 逐子包复用，不启动多套聚合壳；统一模型与配置写入权威 | 03+04+06 / UI,WF,RUN |
| SRC-14 | zhu1090093659__dsh-web-ui | 镜像身份，以及清单记录的live-stats能力 | 镜像不重复导入；本次已从registry取回并校验0.1.20原包，复用liveTokenUsage投影，不能称镜像本来含源码 | 03+05 / UI,CTX |
| SRC-15 | feng0531__dsh-code-review | Git/SVN、只读capture、二阶段协议、上下文身份、覆盖、证据回执、后台审查 | 在许可允许范围直接复用审查核心；统一任务/模型/授权；商业定位另决策 | 04 / WF |
| SRC-16 | GanyuanRan__Aegis | 风险分流、工程纪律、基线/ADR/反熵/续接、跨宿主方法与诊断 | 方法包模块，与Superpowers和追加流程有角色分工，不多份常驻prompt | 04+08 / WF,QLT |
| SRC-17 | MichengAI__dsh-agency-agents | 专家目录/路由、persona、专家团、草稿、编辑、自定义、引擎选择 | 资产与schema可复用，统一Run；全部角色可发现，按需加载内容 | 04 / WF |
| SRC-18 | T-Auto__dsh-ops | 16类文件/文档工具、批处理、结果引用、原生/PTC、平台搜索、Rust执行核 | 成熟内核与双投影优先复用；与权限/输出token预算整合 | 04 / WF |
| SRC-19 | LayneChai__superpowers-dsh | 技能库、发现/按需加载、需求/计划/测试/调试/评审流程 | skill provider及资产复用，与Aegis/工程流程去重路由 | 04+08 / WF,QLT |
| SRC-20 | tt-a1i__archify | 十类图表、交互视图、explainer、HTML/导出、可配置参数 | 图表生成素材与流程，统一artifact与安全预览；恢复个人技能可见性 | 04 / WF |
| SRC-21 | dsh-synapse-main | 会话任务地图、节点布局/状态、上下文关系、分支与导航 | **复活**地图UI/领域结构，适配新session投影；不改日志 | 05 / CTX |
| SRC-22 | chaggle__dsh-powershell-check | 全部17条诊断、deny/warn、zh/en、可选PSScriptAnalyzer | tools preexecute gate与规则资产可复用；零常驻提示 | 06 / RUN |
| SRC-23 | hongweifei__dsh-pwsh-encoding-fix | 混合原生字节编码/Unicode文本、前后台一致、exit语义 | 复用字节识别思路，集中Codec适配；修复Write-Host/exit/大输出边界 | 06 / RUN |
| SRC-24 | liceses__dsh-gitbash-preset | Git Bash极简、正确发现MSYS、环境/路径/权限、无WSL误认 | **复活**为当前bundle预设；执行器适配保留，不再写废弃目录 | 06 / RUN |
| SRC-25 | gamegeek-saikel__dsh-coding-agent-preset | 持久PowerShell7、PTY、cwd/变量/函数/alias/env、受限one-shot | **复活**当前正式预设与持久runtime；下架原件锁hash与许可证据 | 06 / RUN |
| SRC-26 | yjh051108__dsh-super-injector | 外部插件同进程试运行、安装/热换/失败保旧、watch、自重载、staging/转正、修复、脚手架/构建/发布 | **复活**完整开发工作台；正式manager+可信runtime桥+隔离桥，资源owner治理 | 06 / EXT |
| SRC-27 | zhongjie10086__dsh-adaptive-native-standard | 首轮窄面、发现/解锁、任务路由/手动锁、熔断、Git Bash、所有权/备份 | **复活**能力与正式preset；固定dispatcher默认，明确epoch才改变wire工具表 | 06+07 / RUN,CCH |
| SRC-28 | Anionex__dsh-turn-rewind | 三模式回退、宿主fork、文件账本、救援/验证/补偿、崩溃恢复、管理/GC/大仓 | 成熟changeLedger/recovery引擎优先复用；当前Desktop入口适配 | 06 / REC |
| SRC-29 | bowenliang123__dsh-context | Steps/Summary/Insights/Fleet、构成/事件/活动、/context、前后缀偏好、metering parity | 观测投影和估算可复用；reported/估计分层，偏好变更新epoch | 05+07 / CTX,CCH |
| SRC-30 | ranxianglei__billion-context | 论文模型自治fold、T1-T3、逐块解压/历史检索/cache、原文保护、双模式/诊断、跨客户端 | **核心必交付**优先复用acp-kernel与native适配，集中控制器和缓存planner；保留产品署名附加条款 | 05+07 / CTX,CCH |
| SRC-31 | tianmingwan__dsh-balanced-search | 三源轮换/失败切换、search/fetch、时间范围、MCP+native | provider统一网关，轮转状态不改system；结果有来源/上限 | 05 / CTX |
| SRC-32 | chenxiachan__thoughtdag | 画布连线即上下文、多版/陈旧依赖、Condense/Weave、Atlas/why/recall、主题dossier、分享/导出/CLI/MCP | 画布与context-builder/历史解析可复用；当前宿主服务桥与认证统一 | 05 / CTX |
| SRC-33 | Ychris12138__dsh-usage-stats | 13账户adapter、余额/tokenplan、热图/下钻、增量fold、缓存/原子持久、安全GET | usage纯fold和账户adapter优先复用，和dsh-usage/live-stats统一账本 | 05+07 / CTX,CCH |
| SRC-34 | qiudeng7/how-to-lint | 配置渐进、类型/语义规则、规则单测、错误分层、多语言指南、增量采用 | 原方法作为版本化skill，新增确定性quality runner/计划/门禁/修复UI | 08 / QLT |
| SRC-35 | qiudeng7/software-engineering-workflow | Issue/PR/需求/设计/技术写作/终端输出/SVG、示例与分工 | skill与模板可复用；编译到统一workflow runtime，非第二调度器 | 08 / QLT |
| SRC-36 | Wholiver/metis | 多模型角色路由、T0–T3与高级有限层级、16框架/26角色、harness图编辑、独立门禁、适应性提案与追踪 | 复用contracts/纯policy/资产并接同一TaskPlan/Run、正式Host child AgentOptions；排除DeepSeek controller写死PASS路径，补真正执行与验证；sticky角色通道与全部attempt入账 | 12+07+13 / MMR,CCH,DEV |

## 2. dsh-web子包不漏项

| 子包 | 统一归属 | 完整保留范围 |
|---|---|---|
| dsh-git-graph | 工程/Git | 工作区分支、managed worktree、空会话入口、守卫与影响预览 |
| dsh-i18n | 全局 | zh/en/ru字典、命名空间、fallback与扩展语言注册 |
| dsh-liangshen | 会话执行配置 | 纪律/preset、native/PTC、MCP发现与激活、runtime回退 |
| dsh-market | 资源 | 皮肤/宠物/插件/预设目录、try-on、安装、统计口径 |
| dsh-plugin-manager | 设置/能力与扩展 | 官方bundle、兼容预检、更新队列、失败停队、回滚/待重启 |
| dsh-remote-bridge | 连接中心 | 原生手机协议、一次性QR、P256、设备撤销、历史/队列/审批 |
| dsh-remote-web-ui | 连接中心 | Web配对、倒计时、LAN/防火墙/隧道、窄屏工作台 |
| dsh-session-archive | 会话 | 全部可见会话、筛选/跨页、家族保护、归档/恢复/删除、自动规则 |
| dsh-session-id | Inspector/命令面板 | 完整ID展示/搜索/复制/剪贴板失败回退 |
| dsh-skill-explorer | 资源/技能 | 多来源、开关、创建导入编辑、健康、废纸篓与恢复 |
| dsh-ssh | 工程/远程 | 密码/key/agent/passphrase、跳板、池、PTY、SFTP、端口转发、集群执行 |
| dsh-task-board | 任务 | 五列、标签、子任务、团队、调度、交接、双开关目标运行与重启恢复 |
| dsh-task-board-github | 任务/GitHub | Issue纳入、冻结prompt、AI分析审核、PR/评论/close授权与receipt |
| dsh-task-board-remote | 任务远程投影 | 同账本snapshot/options/apply/changed，并新增revision冲突处理 |
| dsh-update | 能力与扩展 | 状态、版本、notes、进度；Desktop服从官方更新权威 |
| dsh-usage | 用量 | 日模型/供应商/余额/订阅/30日图/footer/token收据、非加法bucket |
| dsh-web-all | 包装与配置 | 聚合与旧名兼容；不重复加载全部子页 |
| dsh-web-settings | 设置 | 分类、schema表单、namespace与连接回退 |
| dsh-win-bash | 执行运行时 | session状态、exit/超时/截断、jobs、可见性与权限分离 |

聚合引用的外部卫星仅在已核实的范围声明；不能把本地只有引用的包说成已审完其所有源码。取回/补研究是实现前依赖清单，不影响上述本地能力必须保留。

## 3. 去重择优决策

| 重叠簇 | 首选基底 | 组合的精华 | 避免的重复 |
|---|---|---|---|
| 记忆编排 | Mnemon式Source×Strategy×Provider | 文件轻量、规则图、五轨、信任、VFS、语义/reflect | 多套system注入、重复capture、不同真源互相覆盖 |
| 本地轻量记忆 | Markdown+原子写 | touch scope、关键词、证据门、版本、负记忆 | 必须先安装向量DB才能存一句偏好 |
| 语义/反思 | 可选Provider | Milvus混合、OpenViking层级、Hindsight reflect | 所有服务同时自动召回/付费 |
| 任务与编排 | 一套TaskPlan/Run | 任务板交接、专家/团队、evolve多会话/CLI/房间 | 三套互不识别的todo与运行账本 |
| 多模型与质量门 | 同一Run上的Metis policy编译 | 分档/角色/框架/harness、独立actor、有限repair、未来run适应性；主会话固定、角色固定lane | 第二Metis调度器、每阶段切主模型、全历史复制、skill投影或写死PASS冒充完整执行 |
| 工程方法 | 路由到版本化MethodPack | Aegis治理、Superpowers操作、qiudeng工程文档/lint、J-Space认知 | 开场把所有技能全文常驻system |
| 文件与文档 | OPS kernel+宿主FS | 原生/PTC、结果引用、sidebar编辑和VCS | 隐式绕过sandbox、第二文件真源 |
| Git | Sidebar工作区操作+审查capture | dsh-web branch/worktree guard、只读review证据 | UI状态和审查快照混淆 |
| 图与历史 | ThoughtDAG context模型 | Synapse地图投影、宿主真实分支、why/dossier | 把UI连线直接改写宿主日志 |
| 压缩 | billion/acp-kernel | 宿主生命周期/基本服务、cache-aware计划和真实usage | 双重压缩、简单摘要替换论文路线 |
| 统计 | 一个UsageLedger | usage-stats账户、dsh-usage展示、context构成、live-stats即时投影 | 双计缓存/输入、把估算当真实hit |
| Shell | 一个ExecutionBroker+Codec | PowerShell诊断、持久pwsh、Git Bash与win-bash | 多层resolve包装、WSL误认、丢exit/输出 |
| 市场/开发 | 官方manager+Nexus开发桥 | 皮肤目录fallback、try-on、staging/热换/修复/发布 | 擅改Desktop profile、孤儿路由 |
| 恢复 | turn-rewind账本 | 文件hash/救援/恢复、宿主fork、图谱入口 | reset/stash覆盖、截断会话日志 |

优选依据依次为：当前功能正确与可恢复、官方契约适配程度、独特能力保全、缓存与token成本、测试和工程成熟度、许可与依赖代价、界面可组合性。代码行数、星数、作者宣传benchmark不能单独决定优选。

## 4. 复活任务单

| ID | 原阻断 | 必须实施的复活任务 | 完成证据 |
|---|---|---|---|
| REV-01 | better-display旧peer/旧UI接缝 | 移植阅读renderer、公开投影与成功轮折叠，React slots | rc.2 Desktop成功/失败/取消/选择文本/未知block录屏与测试 |
| REV-02 | GitBash写废弃.agent-presets | 包内正式bundle声明，正确执行器与沙箱回退 | 设置可选、实际创建会话并执行中文/空格路径命令 |
| REV-03 | coding preset下架/旧目录 | 锁定原件或复用官方终端实现，正式持久pwsh预设 | cwd/env/函数跨调用、后台/取消/进程树、重启/卸载 |
| REV-04 | adaptive旧宿主与动态工具表 | 当前preset+固定工具目录/dispatcher+可解释epoch | 窄工具发现与重工具可达、缓存回放不乱变schema |
| REV-05 | Synapse旧session服务 | 新投影与fork/inject/followup适配 | 地图完整、导航正确、日志只追加 |
| REV-06 | skin/J-Space旧客户端/preset | React slots/正式preset/版本化资产 | 界面可用、设置持久、主题能撤销、方法可达 |
| REV-07 | super-injector依赖私有装配 | 正式manager与可信runtime/隔离桥、owner/generation | 全部EXT操作，热载失败保旧，无残留 |
| REV-08 | live-stats源码迁出 | 已取回并校验0.1.20包；适配liveTokenUsage、stream估计→reported替换、retry/中断与TPS口径 | 03章来源/字段与UI-081–084，真实reported与估计区分、断线重连 |
| REV-09 | memory-evolve停更 | 当前注入/capture/CLI/任务/同步/通知适配与迁移 | MEM/WF/UI联合全部独特能力 |
| REV-10 | archify旧版遮蔽个人技能 | 合并skill provider根与去重优先级，保留用户资源 | 自带与个人技能均能发现、同名可解释选择 |
| REV-11 | web/mobile隐藏或旧HTTP通道 | 当前认证桥和响应式UI，按真实设备能力门控 | 远程任务/审批/技能/用量可达，本机动作具名转交 |

“依赖缺失卡片”只可表示用户未配置某可选依赖；若桥未写、接口未适配，必须显示开发状态且不能算上述任务完成。

## 5. 许可与来源组合

开发允许直接组合上游，但组件许可并不因打包为一个插件自动统一。实施仓库必须有 `sources.lock.json`、`THIRD_PARTY_NOTICES`、组件路径清单与补丁说明，记录 package版本、git SHA、tarball integrity、选用文件、许可来源与实际改动。

| 项目 | 研究中发现的重点 | 实施要求 |
|---|---|---|
| Code Review | 自定义非商业源码公开许可证，不是MIT | 非商业范围按许可复用；商业内部/发行定位需另获授权或采用合规替代实现；保留完整功能需求 |
| OpenViking | 根服务AGPL，examples及DSH桥Apache-2.0 | 组件级区分，不能对整仓贴同一许可；服务部署/分发义务单列 |
| billion-context | MIT正文后有产品表面署名附加条款 | 使用内核/源码时在About/首页/文档中满足可见出处与链接，不写“纯MIT无额外条件” |
| J-Space | 混合许可且部分引用不在开源授权内 | 代码、方法素材、第三方引文分别登记；保留认知方法能力 |
| Agency | 实现与persona素材许可分别声明 | 按路径保留Apache/MIT通知，用户导入素材另管 |
| dsh-web | 根Apache；market/manager/skill-explorer BSD | 子包级notices；宠物/皮肤/字体与截图不被代码许可自动覆盖 |
| qiudeng SVG子模块 | 父仓MIT不证明子模块许可 | 固定gitlink与来源；复用前核实授权，绘图能力不因此删除 |
| 下架coding预设 | 来源为保存的tarball原件 | 对实际原件hash、内嵌通知和派生官方代码逐项建档 |
| live-stats 0.1.20 | registry/package写Apache-2.0，tarball内LICENSE实际BSD-3-Clause | 保留实际BSD文本，记录元数据冲突并在分发前完成组件核对 |
| Metis 2.0.2 | 固定SHA `8b1eda95afea3592e08a315e29dc7746ee57ca25`；根MIT含2026 Wholiver和2025 Mario Zechner，vendored pi等需单列 | 仅复用选用组件，保留双版权及vendor通知；Metis Desktop字体/媒体不能按根MIT推定授权；不打包独立Electron应用或第二runtime |

这些是组件工程管理事项，当前研究与规格不因未来发行定位未定而停下。最终包许可证在确认分发组成后决定，不在本次凭空承诺全包MIT。

## 6. 覆盖完整性的机械校验

实施团队应生成三个清单并双向对账：

1. 来源侧：README、schema、真实dispatcher、注册表、路由、UI action和CLI action的联合manifest。文档与metadata可能漏项，不能只抓一个列表。
2. Nexus侧：公共目录action、内部adapter映射、页面入口、配置、迁移与验收ID。
3. 交付侧：实际激活功能、集成fixture、Desktop运行证据和已知限制。

来源action没有去向、Nexus功能没有来源或设计标记、已宣称完成却没有验收证据，都使覆盖检查失败。镜像重复和纯聚合壳可标 `deduplicated`，但需指向同一实现的证据。不可将“未知”“无法取回”“尚未适配”统一写成“不适用”。

细粒度覆盖基线在各章：02的38个高级operation、04的WF-R001–031、03的19包和全部界面action、05的graph/search/usage/压缩矩阵、06的17条规则及全部EXT操作、08的新质量方法与流程、12的角色/框架/门禁矩阵。第13章和 `development-plan.json` 将36来源完整分配到8个源码复用执行包；原62项以 `development-checkpoints.json` 保留为覆盖检查点，原769条验收定义保持不变。总表 `requirements.csv` 是来源功能簇索引，不假装已经罗列每一行上游代码的所有内部函数。

## 7. 用户直接新增能力

以下属于产品需求，不另算第37个研究来源，也不要求追加子代理研究：

| ID | 用户需求 | 实施归属 | 合同与验收 |
|---|---|---|---|
| USER-R01 | 文件即记忆：项目MEMORY.md及MEMORY/都可直接作为来源，兼容Claude Code工作过的工程，迅速接手 | A02合并文件Source、接手快照及界面（P21/P26/P28）；A08合并旧工程fixture和缓存对照（P56/P59）；只读源文件不强制改格式 | 02§16、13§9.1；MEM-079–096 |
