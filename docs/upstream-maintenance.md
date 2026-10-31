# 上游维护

权威清单为根目录 `upstreams.json`，复制来源、许可证及文件摘要为
`sources.lock.json`。每周一、周四北京时间 10:00 集中检查，先完成适配，再统一验证；
各插件不再显示独立升级通知。检查不会自动安装、重启宿主或修改会话。

清单同时追踪原始 Git 来源、npm 运行插件及所有 Mnemon 组件、内置源码、
DSH 原生同版本依赖、用户归档和外部服务。原项目和 DSH 移植包分别记录，
例如 Ponytail 原项目 5.3.2 与 Wenaixi 适配包 5.6.2 是不同版本。

当前宿主目标为 Desktop **0.2.1-rc.5**。本体发布、全部来源、
输入/菜单/模型目录变化及新增插件的适配见
[2026-11-01 审查报告](upstream-audit-2026-11-01.md)和同名 JSON。
Computer Use 两个上游分别追踪，仅加载选中的 Windows 实现。

运行只读检查：

```powershell
node scripts/check-upstreams.mjs --output upstream-report.json
```

报告将区分升级、未变化、较旧 dist-tag 和无法获取。网络失败不能当成无更新。
宿主检测包括正式发布的 RC，并解析发布 tag 的 commit；DSH 同源包按该
发布版本查询精确元数据。客户端 inject 和仅开发时引用的宿主包也纳入检查。
检查结果不直接覆盖固定版本；评估公开差异、原生 API、Windows 支持、许可证、
既有兼容补丁和运行入口后，更新依赖或明确拥有的源码目录。
DSH 同源原生包必须随桌面宿主一起升级，不能逐包追随 npm latest。

更新流程：

1. 检查清单全部来源，包括归档和仅作参考的来源；新增插件必须同时进清单。
2. 保留原生入口、设置命名空间和生命周期。审查工具重名、配置持久化、
   workspace/session 范围及缓存前缀；不要重复注册同一能力。
3. 固定版本、commit/integrity 和完整许可证；更新生成适配锚点和来源记录。
   资源摘要用 `node scripts/refresh-reused-hashes.mjs` 显式刷新。
4. 所有实现冻结后统一 `npm run check`，集中修复后重验。
5. 对涉及的桌面入口、真实模型和调试协议单独验收。阶段结果只证明覆盖范围，
   不用过去的验收收据冒充新版本通过。
6. `npm run pack:delivery` 完成包审计，交付到 `D:\dshplugin\nexus\build`，
   提交源码和清单。运行中的宿主不自动重启。

2026-10-21 批次更新了 Context 0.74.0、ThoughtDAG 0.5.22、
Mnemon 0.5.34（含新的 skills source）、Agency 1.2.9、
桌面使用的 dsh-web 三个组件 0.4.8、皮肤目录 0.1.66、
memory-cognition 0.9.8、memsearch、ACP kernel 0.0.147、
Aegis 2.14.1 和 Nexus-Terminal 文档快照。新增的原生工作流入口见
[WORKFLOWS.md](WORKFLOWS.md)。

以下边界始终明确：

- DSH-agent-procedures 仅确认用户提供的归档，没有可核实的远程地址；
  保留原样，不能宣称从远程升级过。
- OpenViking、Hindsight 是外部服务器；本包追踪和维护适配器，
  不替用户升级服务器。
- 参考后独立实现的功能不会伪装成实际加载了参考插件；
  具体决定写在每个来源的 `decision`。
- 受限 code-review 源码仍未复制；旧 Git Bash/usage 的较旧 npm tag 不触发降级。
- 独立升级 UI 在构建时按精确源码边界移除，失配使构建失败；
  插件内部的版本历史、诊断版本号和用户主动管理第三方资源的功能保留。

## 子代理压缩接缝（R40）

DSH 0.2.1-rc.5 的 `commandUi` 对 `sessions.subagentAddress(sessionId)` 直接返回空宿主目录。
保留 `src/client/ContextMaintenance.tsx` 的子代理专属 `/compact` 客户端贡献及原生输入座位；
不要只以主代理的命令菜单或引擎单元测试替代侧栏验收。
宿主统一维护后端位于 `src/host/compaction-support.ts`，预设后端优先，禁止同一请求重复压缩。
升级时验证子代理实际请求里的 `compact_context`、运行中自身手动压缩、
全局/工作区/会话实时阈值、独立压缩模型、恢复与自定义预设，以及父会话不被修改。

## 原创 Forge companion（R42）

`companions/forge-tools`保存与外部开发目录`D:\\dshplugin\\tools`对应的可复现源码，单独交付，默认不安装。
升级时同时核对engines、所有同源SDK、官方standard组合、安装器和AI说明；
必须用独立官方桌面及合成profile验证准入、工具执行和卸载恢复，禁止版本豁免掩盖不兼容。
0.2.2-alpha.2仍是观察到的候选，本轮已选择官方 rc.5 作为唯一验证宿主；所有同源 SDK 必须与 rc.5 保持一致，不能混用 alpha。

## 模型时间遮罩（R45）

模型提示组装默认安装 `nexus:utc-time` 上下文。它移除已有的模型可见本地
时间/时区片段，只注入当前 UTC/GMT ISO 时间；宿主用于路由的
`clientTimeZone` 不会复制到提示。定时任务需要时统一提交 UTC，用户要求北京
等民用时间由模型从 UTC 算术换算后展示。关闭选项仅用于兼容性诊断，标准配置默认开启。
