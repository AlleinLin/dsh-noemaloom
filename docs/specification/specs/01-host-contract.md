# DSH Nexus（枢纽）宿主集成与兼容契约

文档状态：研究后规格，未实现、未安装、未通过真实 Desktop 验收。版本：0.1，基准日：2026-10-19。适用工程：`D:/dshplugin/plugin`。项目暂名 DSH Nexus（中文“枢纽”）、包名占位 `@local/dsh-nexus`、自有服务命名空间占位 `nexus`；这些名称是项目设计，不是 DeepSeek 官方产品、服务或已注册 npm 名称。

本章是总规格的强制基础，约束所有内部功能模块。业务功能由相应领域章节细化；发生冲突时，先满足用户要求的完整功能恢复，再通过正式宿主接口或包内兼容桥实现。本章不把旧实现不兼容作为删减功能的理由。“净室级”表示足以供实现团队独立执行的细致程度，不要求隔离研究人员、不禁止源码复用。实际复用仍须遵守每个来源的许可证和署名义务。

本文中“必须/MUST”是交付要求，“应该/SHOULD”允许有记录、可验收的等效方案，“可以/MAY”是选择。条款 `HC-*`、验收 `HOST-*`、待验证门槛 `GATE-*` 均为本项目编号。官方事实使用 O，固定上游源码直接支持的判断使用 S，真实桌面或构建仍须验证的判断使用 V。项目提出的接口和阈值不冒充官方标准。

## 1. 发行基线与证据冻结

### 1.1 必须采用的宿主身份

| 项目 | 本规格基线 | 约束 |
|---|---|---|
| 官方仓库 | `deepseek-ai/deepseek-harness`，默认分支 `master` | 不从同名第三方项目推导宿主标准 |
| 固定 commit | `687f282e8625c6b8d11ff58211a90524be2e4317` | 本章全部上游文档引用对应此 commit |
| 官方 tag / npm 主包 | `dsh-v0.2.1-rc.2` / `@deepseek-ai/dsh@0.2.1-rc.2` | `latest` 和 `next` 在本次查询均指向 rc.2 |
| 主验收 Desktop | Windows x64，`0.2.1-rc.2` | 真实生产 nightly feed 已核实；未执行安装器 |
| 开发备选参考 | `0.2.1-alpha.5` | 仅迁移研究，不在首版自动宣称兼容 |
| 语义稳定版 | 此次未核实到 | 不把 `latest` 文案当作 stable 承诺 |
| 产品数据 | `$DSH_HOME` 的共享产品数据 | Desktop 与 CLI 的可执行依赖、锁、node_modules 不混用 |
| Desktop profile | `$DSH_HOME/profiles/desktop` | Desktop 独占；管理时遵守宿主锁 |

**HC-VER-001** 首次实现必须精确锁定 rc.2 的构建、类型和目标运行时，保存 lockfile、宿主版本、commit、平台、安装渠道、构建产物 SHA-256。不得把主包 rc.2、base `latest=0.0.1-rc.1`、web-app `latest=0.0.1-rc.1` 拼成未经验证的组合。

**HC-VER-002** 插件 manifest 必须使用当前宿主实际读取的 `engines.dsh`。首次交付只声明通过验收的精确 rc.2；扩展范围必须逐版本完成关键用例后调整。不得只写 `dsh.compatibility` 或自动修改宿主 `compatibility.json` 绕过准入。

**HC-VER-003** 上游兼容判断 `includePrerelease:true` 是当前源码事实，不意味着任意预发布版都兼容。自己的 `engines.dsh` 存在时优先于 DSH peer 回退；无效的 engines 必须失败，不能用 peer 掩盖。

**HC-VER-004** 升级报告必须保留“安装状态、保存状态、运行激活状态、浏览器模块代际”四者，明确 `failed`、`overridden`、`restart-required`、`incompatible-version`；安装命令返回成功不能直接标记所有功能就绪。

证据：研究报告 H-E01～H-E10、H-E20～H-E26；`apps/desktop/README.zh.md:115`、`:118`、`:133`；`packages/boot/app-boot/src/plugin-compatibility.ts:51`、`:55`。

### 1.2 本项目必须维护的变更账本

工程必须建立 `docs/compatibility-ledger.md`，每条记录包含 `ledgerId`、上游版本/commit、查询日期、官方来源 URL、旧行为、新行为、受影响功能 ID、适配器 ID、数据迁移、配置迁移、回退方式、用例、执行记录、负责人。来源为 proposed 的笔记只能记录为候选，不得当作已实施契约。

至少预置：engines 准入、插件字段位置、工作目录与权限根分离、Native/PTC 移除 both、preset bundle 组合、session generation、覆盖安装重启、session 同步历史 API 废弃、外部自定义 session 事件禁用、Desktop 认证 Connection、compaction 的单控制器接管。账本记录实现决策，不修改官方历史。

## 2. 单包、多模块与安装契约

### 2.1 单一交付物

**HC-PKG-001** 用户只安装一个 Nexus 主包，看到一个产品入口。主包内部可以有 Host 服务、Client 面、功能模块、旧接口兼容桥、可选辅助程序和多个 Cordis 行；不能要求用户逐一安装 33 个来源项目。

**HC-PKG-002** 保留所有来源功能的可追踪功能 ID。功能重复时选一个主实现，其他实现具有迁移映射或策略选项；故障、过时、依赖缺失的功能具有恢复实现和验收，不得仅标注 legacy 后消失。

**HC-PKG-003** 主包不得直接携带研究目录、原插件配置中的密钥、私人会话、`.credentials.yaml`、开发机绝对用户路径或完整上游仓库。运行资源按 `files` 正向列举，并核验实际 `pack` 内容。来源代码按许可证处理；研究归档不是运行依赖。

**HC-PKG-004** Host 导出采用 `apply(ctx, config)` 加可选 `inject/Config`，或默认 Service class，二选一。所有服务、路由、工具、skills、投影、事件、计时器、文件监听器、子进程和流都在 effect 所有权下创建，禁止 import 顶层永久注册。

以下是 manifest 形状规格，不是当前已有可运行文件；依赖清单和完整 external 列表须在实际实现与打包审计后填齐。

```json
{
  "name": "@local/dsh-nexus",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Unified workspace, memory, workflow and desktop tools",
  "engines": { "dsh": "0.2.1-rc.2" },
  "exports": {
    ".": "./dist/host/index.js",
    "./client": "./dist/client/index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./assets/icon.svg"
  },
  "files": [
    "dist",
    "cordis.patch.yml",
    "locale",
    "assets",
    "LICENSE",
    "NOTICE"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

`dsh.client.inject` 是客户端模块加载依赖声明；业务代码仍须声明实际 Cordis 服务依赖，两者不能相互替代。首版可以在同包导出更多内部子路径；这些子路径必须进入实际文件清单。若采用生成 Typert，追加 `./typert`、`./remote` 及生成声明，须通过 GATE-REMOTE-001 后才视为有效。

最小 bundle patch：

```yaml
- insert:
    - id: nexus-main
      name: '@local/dsh-nexus'
      config:
        schemaVersion: 1
```

**HC-PKG-005** `nexus-main` 等 ID 必须全局避碰，安装前检查现有插件和 bundle。宿主 override 替换整份 config；配置编辑器必须先读取 Config/schema 与有效层，生成完整期望值，不依赖不存在的深合并。

**HC-PKG-006** 应提供中文和英文 `meta.title/meta.description`，原始图标或有授权的图标。图标限 SVG/PNG/JPEG/WebP，不超过 256KiB，路径留在包内，符号链接不能逃逸。图标与文案的可渲染性须真实检查，不能由扩展名断言通过。

**HC-PKG-007** 默认不使用需要安装期脚本的原生依赖。功能确需 SQLite/PTY/索引辅助程序时必须列出 ABI、平台、架构、构建、许可和回退桥；用户通过宿主报告的 pending build 明确允许后才传 `approvedBuilds`。本规格不授权在研究阶段安装或运行它们。

### 2.2 受控安装与升级

使用 Desktop 内部 Plugin Manager 的正式安装/开关流程时由宿主协调锁；使用打包 CLI 管理 desktop profile 时，先完整退出 Desktop，再执行该版本的 `dsh plugin --profile desktop` 管理命令，结束后重开。不能在 Desktop 持锁时从 shell 并行编辑 profile 或执行 pnpm。

更新同一已安装包必须考虑宿主 JS 模块缓存和浏览器 release identity，按管理器提示重启；仅保存文件、同名 slot 仍在或 UI 无报错不证明加载了新代码。诊断面显示主包版本、build hash、Host release、Client release、数据 schema 与 compatibility ledger 版本。

## 3. Host、Client 与兼容桥边界

### 3.1 内部职责

| 层 | 责任 | 禁止越界 |
|---|---|---|
| HostAdapter | 对接当前宿主的 session、agent、工具、投影、preset、权限和数据能力 | UI 不直接读 Host 对象或 profile 文件 |
| Nexus domain services | 记忆、压缩、工作区、工作流、统计、集成等业务规则 | 不把来源项目 HTTP 路由当业务真源 |
| Nexus operation coordinator | 操作身份、并发、取消、授权来源、幂等、提交状态 | 不对已部分提交操作盲目自动重试 |
| Nexus compatibility bridges | 旧配置、旧工具名、旧 preset、旧模块协议的受控转换 | 不绕过认证，不伪造宿主私有事件 |
| Nexus repository | 插件自有配置、索引、任务、映射和恢复日志 | 不直接改写宿主 session journal |
| Nexus Client | slots、视图、草稿、交互、可访问性、连接状态 | 不运行 Node、读取凭据或重建所有 session 原始事件 |

**HC-ARCH-001** 领域模块只依赖项目 HostAdapter 的语义接口，不到处检测宿主版本。适配器以功能能力协商为主、精确版本表为辅。接口名是项目设计，不宣称 `ctx.nexus` 为宿主自带服务。

项目能力报告的最小 DTO：

```ts
type SupportState =
  | 'available'
  | 'available-via-bridge'
  | 'needs-configuration'
  | 'needs-runtime-validation'
  | 'temporarily-unavailable';

interface NexusHostCapabilities {
  protocolVersion: 1;
  hostRelease: string;
  hostCommit?: string;
  clientRelease?: string;
  carrier: 'desktop-shell' | 'web' | 'headless';
  connectionGeneration: string;
  features: Record<string, {
    state: SupportState;
    adapterId: string;
    reasonCode?: string;
    missingDependencies?: string[];
    lastValidatedAt?: string;
  }>;
}
```

generation 在本 DTO 中是不透明字符串，不规定宿主原始 generation 的实际类型。不得把未识别载体静默映射成 desktop。

**HC-ARCH-002** 功能不因桥接而删除，但“需要运行验证”不能伪装成已交付。UI 提供具体状态、原因、修复动作、保留的历史数据和配置；自动化调用返回稳定错误码。发布前所有必需功能必须进入 available 或经验证的 available-via-bridge。

### 3.2 适配矩阵

| 能力 | rc.2 首选接法 | 旧功能恢复方式 | 不可接受的捷径 |
|---|---|---|---|
| 原管理网页/API | React slots + authenticated Gateway/Connection | 将旧 handler 变成内部服务；包内协议翻译 | localhost 固定端口、Host HTML iframe |
| 同进程插件功能 | 包内 Host 模块与 Cordis scope | 加载受支持模块并映射旧配置，按服务依赖排序 | 将所有功能变成独立 MCP 而丢失同进程语义 |
| preset 文件分发 | bundle 声明 agent-preset | 读取旧文件为迁移输入，生成同包新声明 | 要求 registry 自动扫描目录 |
| 记忆/状态持久化 | 插件自有仓储 + 官方允许的模型上下文入口 | 迁移旧 JSON/SQLite/文件，保存来源与校验 | 自造 `plugin:*` session event |
| 会话展示 | Host session projection 的 `wire.view` | 将旧全量 fold 迁入 Host 纯投影/异步服务 | Client 全量下载所有 session 日志 fold |
| PowerShell 修正 | shell/provider 边界明确规范化，或显式工具 | 保留原命令与规范化后命令，二者可审计 | 改写冻结 `exec.arguments` |
| history 压缩 | 一个 compaction provider + 一个 Nexus 控制器 | 汇总所有来源策略与增强摘要 | 多个 pre-step 各自压缩；为缓存关闭压缩 |
| 外部服务 | Host adapter 持凭据与限流，Client 经本包 API | 旧服务响应归一化、配置迁移 | 浏览器明文暴露 key；未经授权发送数据 |

## 4. Desktop 的正式通信契约

### 4.1 真实载体

**HC-CONN-001** Desktop 正式页面为 `dsh-app://app/`。它加载共享 Web 客户端，由 Electron 将请求转给认证 Host。默认系统分配随机 Host 端口，绑定 127.0.0.1；不假定 3080、8080 或任何固定端口。

**HC-CONN-002** Client 通过宿主 Connection 与 Remote 服务调用 Host，不自行从 localStorage、profile、命令输出中获取启动 token/cookie，也不读 `.credentials.yaml`。`__DSH_TRANSPORT__.streamBaseUrl` 只是载体地址信息，不是授权。

**HC-CONN-003** 首版采用正式 Connection 的专属 exact route 与官方 Connection RPC 信封：Host 注册 `POST /api/nexus/rpc`，Client 调用 `ctx.connection.rpc.call('/api', 'nexus/rpc', payload, signal)`，本包对 payload 和 result 执行版本化严格校验。该路径不占用 Gateway 的单一 `/api` interceptor。Typert 的严格生成贡献作为后续可替换适配器：Host 显式 Remote 方法，Host descriptor/schema，Client 生成 contribution，Client 入口显式 `$mount`，消费方声明 `remote` 与 `remote.nexus` 依赖。不是导出 `/remote` 就自动被官方 api-remotes 装配发现。

**GATE-REMOTE-001（V，发布阻断）** 必须在实际 rc.2 Desktop 下证明本包 exact route、官方 Connection 信封、strict payload/result、取消、卸载和认证可闭环；不以 CLI/Web 结果替代。若采用 Typert，则额外证明第三方包的 Host generator、`./typert` 注册、Client `$mount`、严格 codec、卸载/重载与 node/browser 双构建。当前 generator 的 package 模式也查找同时含 `tsconfig.host.json` 与 `packages/` 的祖先；不能在平铺外部包中仅添加插件就宣称可用。验证记录保存命令、版本、产物和请求结果，不含凭据。具体纵向实验见 `../research/10-host-development-recheck.md`。

**HC-CONN-004** exact route 由宿主在认证后自动拒绝非 owner Peer；其 `fetch(request)` 回调没有 Peer 参数，不得虚构签名。业务权限、资源范围、操作身份、生命周期取消及 DTO 校验仍归本包。注册移除不代表在途操作自动停稳，本包须持有 operation controller 取消并等待。禁止另注册 `/api` interceptor（Gateway 已占用），禁止通过新增依赖 WebServer 的逻辑 channel 或未认证 server 绕过正式载体。旧 webServer route 仅作受控迁移输入。

**HC-CONN-005** 本包只拥有 `nexus` namespace 与 `nexus/*` 逻辑 endpoint；不得抢占宿主唯一 `/api`、`/api/remote.mux` 或修改其 cookie 信任策略。二进制下载若需信封外响应，注册专属精确 Fetch 路由，并遵循宿主请求体处理和取消。

### 4.2 调用、结果与错误

正式 Typert 调用的 HTTP 映射为 `POST /api/<namespace>/<method>`、body `{ "args": { ... } }`，Connection 另拥有 rpcId、附件、认证和取消信封。不要在业务 DTO 冒造另一层宿主信封。Remote 方法最后一个全局类型 `AbortSignal` 是取消控制，不放进 wire args。

**HC-CONN-006** Typert 已生成的一元调用返回 `RemoteResult<T>`，消费方显式处理 `ok` 分支；domain/carrier/cancelled 失败按 code 展示，装配错误仍可能 reject。首版 generic `connection.rpc.call` 返回 `ConnectionRpcResult<unknown>`，其 HTTP/载体/信封解析故障会 reject，不能套用 Typert 的“载体绝不 reject”承诺。Nexus transport adapter 只在实际 carrier 调用周围接住失败并规范化，业务校验与程序故障由各自边界处理；失败不得吞成空结果。错误用稳定 code 判断，不靠跨 realm instanceof 或匹配中文 message。

本项目业务错误最少包含 `nexus/bad-request`、`nexus/unsupported-capability`、`nexus/dependency-missing`、`nexus/policy-denied`、`nexus/conflict`、`nexus/stale-generation`、`nexus/not-found`、`nexus/cancelled`、`nexus/partial-commit`、`nexus/persistence-failed`、`nexus/remote-service-failed`。它们是领域错误名，官方 `gateway/*`、`session/*` 等 code 原样保留并分类，不冒充同一枚举。

**HC-CONN-007** 用户可见错误含简明原因、可执行修复、操作 ID 和可脱敏复制的诊断。日志不记录 cookie、authorization、原始 key、含 key 的 URL/query、完整请求体或私人会话正文。精确授权失败不能自动回退到未认证路由。

### 4.3 连接代际与流

**HC-CONN-008** Client 在 Connection ready 后才读取依赖当前 Host 的基线。ready 由 Host 挂好增量监听后发出；不能先读取快照再随意订阅，造成间隙。重连时以新 generation 替换旧订阅，旧请求结果不覆盖新代际 UI。

**HC-CONN-009** 不将 `ctx.remote.$host` 当响应式 store；需要恢复的消费者监听 connection/reset，普通消费者使用生成 namespace 和受监督流。自定义业务通知不自动进入 `$on` allowlist，项目需自己的贡献流或已支持的转发面。

**HC-CONN-010** Journal、snapshot、projection 不是普通 Remote 方法的别名。插件自有实体流明确声明初始快照、revision、cursor、delta 和 reset。cursor 不透明，generation 内单调；完整重复项忽略，缺口补页，部分重叠/反向顺序触发重建，旧代际暂存通知丢弃。

**HC-CONN-011** UI 隐藏或组件退出释放其独占流；多个视图共享数据时使用引用计数或宿主共享 resource，最后一个消费者结束后等待 iterator 停稳。主包禁用必须关闭所有本包在途调用和流，不能继续产生后台写入。

## 5. 客户端模块、slots 与视觉集成

**HC-UI-001** Desktop 同样声明 `dsh.client.platform: "web"`。Client bundle 使用宿主共享 React 和模块表，禁止第二份 React、CDN React、任意 runtime require 的私有宿主控件包。基座以外的模块请求必须逐条出现在 `dsh.client.external`，组合阶段无缺失、自依赖和同步环。

**HC-UI-002** 模块 factory 标识必须等于包名，执行体按宿主惰性 loader 约定。加载、热替换和撤回遵守 release identity；Client 与 Host release 不同必须提示刷新/重启，不能继续使用旧 codec 猜测兼容。

**HC-UI-003** 主工作台、设置页、浮层、会话状态和聊天内展示使用官方 slots。实现前必须以内省/slot subtree 验证目标父 slot、kind、owner、props 和生命周期；文档未证实的 slot 名不可硬写为宿主已有 API。

**HC-UI-004** 注册采用 owner 约束的注入，owner 撤回后递归销毁子 slot，owner 重建再注册。single/list/keyed/chain 按父声明使用；不得挂未知 slot、重复声明 child、跨 scope 复用同一 store handle。聊天增强通过官方 conversation node/events 路径，不全局扫描/改写消息 DOM。

**HC-UI-005** 视图使用最小 selector 订阅状态，列表虚拟化边界由 UI 章节细化。不得每条消息渲染都重新扫描全会话、查询所有配置或重新注册事件。取消的请求不得 setState；组件错误局部隔离，不使 Host 聊天入口丢失。

**HC-UI-006** 视觉应保留原插件易辨识的工作流与关键信息层级，同时用统一排版、间距、颜色、图标、密度、空状态和反馈提高完成度。颜色通过 `--dsw-alias-*` tokens 与项目派生 tokens，不硬编码整页颜色覆盖宿主；浅色、深色、高对比度、缩放 100%/150%/200% 均验收。

**HC-UI-007** 不修改 `document.body` 全局样式，不劫持宿主快捷键。CSS 使用 `nexus-` 作用域；所有弹窗、portal、焦点陷阱和 tooltip 可清理。控件有可读名称、键盘操作、可见焦点、合理 tab 顺序；状态信息不能只用颜色。

**HC-UI-008** Settings 使用宿主 accepted value/base/user/revision/writability 语义，保存采用有序 set/unset/mutate。草稿、已保存值、有效值和高优先级覆盖分别可见；冲突时展示差异并要求用户保留/合并，不覆盖远端变更。

**HC-UI-009** 语言跟随宿主 locale，可明确覆盖。术语与错误码分离；中文为首版完整语言，英文至少覆盖 metadata、设置、操作与错误，禁止把业务 JSON 原样塞进最终用户页面。

证据：H-E24、H-E29、H-E37、H-E38，官方 `practices.md:33`～`:38`。具体版式见 UI 章节，本章不伪造截图已验证结论。

## 6. 会话、Agent 与模型上下文

### 6.1 数据真源与读写

**HC-SES-001** 宿主 session journal 是模型可见行为真源，记忆、搜索、统计和 UI 都是派生数据。不得通过改写模型消息数组、直接编辑 session 文件、虚构 session event 或调用外部插件不允许的 `appendPluginRecord` 实现状态。

**HC-SES-002** 新代码不使用已废弃的 `eventAt/snapshotEvents/ownEvents` 同步全量读取。优先官方 projection 和持久化异步读取；大历史必须分页、受取消控制。项目自有状态写入自己的仓储，以 `sessionId`、宿主 generation、来源事件引用进行关联。

**HC-SES-003** `SessionSeq`、`SessionLogOffset`、surface 位置和本包 revision 是不同概念。seq 不当数组下标，surface span 不当数值连续区间，offset gap/prefix 规则不简化。所有 ID 视为不透明值，不切分推导 parent 或工具配对。

**HC-SES-004** 需要导出、检查点、恢复或用户可见“已保存”时，调用正确归属的 durability barrier 并等待；内存更改不能宣称已持久化。fork 使用官方精确前缀语义，保留源日志，不把 fork 当原地截断或覆盖。

### 6.2 投影

**HC-PROJ-001** 本包为宿主允许读取的事件注册纯、同步 projection：稳定 key、state schema、stateVersion、init/apply，Client 使用 `wire.view` 提供的小视图。无关事件返回同一 state 引用；wire 无变化返回同一 view 引用以避免发布。

**HC-PROJ-002** 投影不做 I/O、模型调用、计时器、随机数或 Date.now 推理；外部模型提炼和索引在仓储/任务层执行，结果经明确业务 API 合并，不混入 replay reducer。

**HC-PROJ-003** checkpoint 只含 JSON 数据。算法或 schema 不兼容时增加 stateVersion，回放重建而非强行读取旧状态。恢复后的结果必须与从零回放一致。

**HC-PROJ-004** 全局注册了 projection key 不代表当前 session 能提供该能力；能力信号必须结合 scope、session、数据版本与当前 Host 实际支持。历史数据缺失展示缺口和重建进度，不显示伪造零值。

### 6.3 上下文与提示词

**HC-CTX-001** 稳定产品说明、工具使用规则走 systemPrompt section；变化的记忆、计划、环境、策略走 runtime context 或官方 `agent.inject`。不能在 `agent/request` 临时改 messages 制造不可回放事实。

**HC-CTX-002** `agent.inject` 会将上下文加入 inbox 并在后续 admitted step 消费，但本身不唤醒 Agent；followup/steer 的唤醒语义不同。UI 必须明确“已记录上下文”和“已提交下一步任务”，不能把两者混为一次成功动作。

**HC-CTX-003** `complete:true` section 使系统段成为精确完整提示，但不自动清空 runtime context、工具或变量。两个有效 complete 必须显式冲突，不能静默选最后一个。persona + 记忆 + 技能 + 工具四者组合要验收。

**HC-CTX-004** 模型上下文使用真实当前工作目录服务；不可假定 `{{cwd}}` 内置变量存在。权限根始终依据 immutable `SessionHeader.cwd`，cd 后的 working-directory 不扩大文件写授权。

**HC-CTX-005** 保持稳定系统段和工具 schema 的字节前缀；未改变的动态上下文不反复追加。缓存率必须用提供方实际 usage（若提供）计算，并区分估算；不能通过丢失压缩、关闭记忆或省略必要上下文提高表面命中率。

### 6.4 生命周期与所有权

**HC-LIFE-001** Agent 专属注册在 agent.ctx 内，且 disposer 同时纳入主插件 effect，Agent 结束或插件禁用任一路径都释放。借用 registry 的 bare Agent 不获得 dispose 权；只有创建者持有的 AgentHandle 按约释放。

**HC-LIFE-002** creation listener 不等待 agent.whenIdle 或自行 dispose 同一正在创建 Agent，避免激活死锁。waterfall 对不负责的决定调用 next；转发决定时保留未知/新增字段，包含 startsRequestSeries 等字段。

**HC-LIFE-003** teardown 需要顺序时使用一个组合 async disposer，例如先禁止新任务，再取消执行，再等待流/子进程，最后 flush/关闭仓储。不能假设多个 async disposer 按注册反序串行完成。

## 7. 压缩、缓存与统一控制器

### 7.1 不可删减目标

**HC-COMP-001** 原项目增强记忆与压缩功能，包括用户指出以论文支撑的 billion 类长上下文压缩思路，必须保留在领域规格中并给出可执行策略。论文论点、原实现做法、官方已有能力和本项目实验假设分别标识。不得为了缓存指标移除压缩或以“官方基础压缩已足够”抹去原功能。

**HC-COMP-002** 每个有效 Agent context 只允许一个 `ctx.compaction` provider；每个 session 同时只允许一个变更表层的压缩操作。一个 Nexus CompactionController 接受自动 pressure、provider-confirmed overflow、用户 manual、选区/增强策略请求，并集中负责准入、预算、状态与审计。

官方 rc.2 `compaction-basic` 已有 pressure、overflow、manual 和 region 入口，支持 `auto:false`，并把 `summarize()` 明确作为唯一子类钩子。摘要会回放会话相同的 system、工具与被压缩前缀，从而在同 provider/model、头部范围下尽量复用热前缀；压缩与缓存并非必须取舍。增强策略应复用这些事务/边界/计价行为。

### 7.2 集中接管的指定结构

1. 用宿主 plugin inventory 查明当前 preset/global 提供方与自动监听，精确定位其 plugin ID、realm、配置层和覆盖关系，禁止猜固定 `compaction-basic` ID。
2. 通过本包 bundle/preset 组合只选择一个 provider。首选包内 `NexusCompactionBackend` 复用官方 basic 的公开扩展约定，配置 `auto:false`，让 Nexus controller 统一注册 pre-step 与 request-error；不能在官方 auto:true 旁再挂第二套自动压缩。
3. 基础策略、论文启发的结构化多级摘要、重要事实/任务/代码状态保留、可检索历史索引等由策略层选择摘要方案。持久事件、工具配对、范围稳定性与提交依旧委托正式 compaction provider，不在领域策略中直接 append 私有 session 事件。
4. `/compact` 和 Nexus UI 都路由到同一 backend/controller；保留兼容入口但不注册相互竞争的同名 command。按钮调用有对应的 request ID 和状态，重复点击返回同一操作或明确 busy。
5. 如必须替换默认 backend，记录原配置，保留用户 overrides，退出 Nexus 时恢复由宿主管理的组合；不能删除用户 preset 或粗暴关闭所有压缩插件。
6. “关闭压缩”选项分清自动压力、溢出恢复、手动和实验增强；关闭自动模式不卸载手动能力。默认不得关闭 overflow 保底。

**GATE-COMP-001（V，发布阻断）** 必须编译并实际证明外部包能够通过已公开的 basic 子类钩子/CompactionEngine seam 提供唯一 backend，并在目标 preset realm 替换默认 provider。不依赖未导出的内部函数或 monkey patch 私有方法。如果当前工具链受限，需完成包内版本适配桥与完整事务验证，不能只把事项留成“以后支持”。

### 7.3 压力、事务和缓存要求

**HC-COMP-003** 计价只用单例 tokenMeter 对最新已路由 envelope 的测量，容量来自真实 provider/model；不以 UI 字符数硬代 token。小窗口不能盲套默认 65,536 headroom；参数必须验证 `W-O-B>0`、保留预算低于阈值、输出 maxTokens 为正。

**HC-COMP-004** 常规压力先调用可选工具结果 pruner，重新计价后再决定摘要。工具调用/结果成对边界不得拆开；保留近期尾部；系统首节点、工具 schema 和独立过大 envelope 的限制明确报告。非工具不可分超大节点不能伪装已修复。

**HC-COMP-005** 事务使用正式 provider 的持久锁与 begin/summary/replacement/end 协议；原始日志保留，只有模型表层发生正式替换。取消、摘要失败、范围变动、提交失败、flush 失败分别呈现；不缩短摘要不能提交为成功。压缩中进程崩溃按官方 stale lock/end-seed 语义恢复。

**HC-COMP-006** 手动 compactNow 在空闲 Agent maintenance 中运行，后续提示被接收并排队，结束及 durability barrier 后再开始。选区 compactRegion 必须满足开放轮次和边界条件，不能从任意空闲 UI 直接冒用 region 接口。

**HC-COMP-007** overflow 恢复仅在提供方确认窗口错误时触发，且只有 surface replacement generation 已前进才授权重试。取消优先，重试有上限；摘要/prune 已部分持久化后不可回退到旧 UI 状态或重复提交相同替换。

**HC-COMP-008** 保持摘要输入热前缀：同目标优先、system/工具/消息字节保真，增强指令加在尾部。跨模型摘要或非头范围允许更低缓存但要标出原因。压缩质量、任务恢复、事实保留、总 token/成本与缓存率同时评估，不能单独优化命中率。

**HC-COMP-009** 语义索引、重要事实和分层摘要保存在插件仓储，引用被压缩原事件与 content hash；检索结果经正式 runtime context 注入。不得称“原始历史已删除”。用户可查看原始来源、压缩范围、模型、估算与实际 usage、策略版本和恢复能力。

证据：`packages/compaction/compaction/README.zh.md:78`、`:95`、`:111`；`compaction-basic/README.zh.md:62`、`:76`、`:107`、`:108`、`:113`、`:119`、`:233`；`compaction-basic/src/index.ts:237`、`:247`；`docs/subsystems/compaction.zh.md:84`、`:99`、`:101`。

## 8. 工具、Skills 与 Preset

### 8.1 工具面

**HC-TOOL-001** 工具使用正式 typed definition/input/output schema，工具名在本包内唯一。每个原工具有功能映射，重叠工具收敛成一个 canonical 名，必要时保留受限旧名 alias；alias 不能让工具列表重复膨胀或扩大权限。

**HC-TOOL-002** 同时兼容 Native 和 PTC 是两套已测试呈现，不是 `mode:both`。同一 Agent 一次选择 native 或 ptc；PTC runtime 缺失显示具体依赖，不能自动执行未隔离脚本替代。

**HC-TOOL-003** restrict 取交集缩小可见工具面，pre-execute 用于异步允许/拒绝/询问，guard 为同步单调否决；不把隐藏工具当完整安全边界。未知操作默认不可执行。

**HC-TOOL-004** 解析参数冻结后不在 pre-execute 改写 exec.arguments。PowerShell/路径规范化在明确的 shell adapter/工具接口层完成；保留用户/模型原输入、规范化依据和执行输入，危险语义变化不得静默自动纠正。

**HC-TOOL-005** 所有执行体观察 exec.signal，子进程、网络和流传同一取消；取消必须等操作停稳。timeoutMs 字段只是声明，必须挂正式 timeout policy 或项目已验收包装，不能把 Promise.race 超时当底层已停止。

### 8.2 Skills 与预设

**HC-SKILL-001** 内嵌 skills 使用官方 register/provider 接口并保留 disposer；provider 同步注册，避免占用保留 runtime provider 名。用户来源 skill 与插件自带 skill 具有清晰优先级、来源、版本和冲突提示。

**HC-PRESET-001** 当前宿主 preset 通过 bundle 插入 `@deepseek-ai/dsh-agent-preset`，不是散落旧 preset.yml 目录自动发现。合法声明示意：

```yaml
- insert:
    - id: nexus-preset-research
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: nexus-research
        plugins:
          - id: nexus-research-capabilities
            name: '@local/dsh-nexus/preset-research'
            config: {}
```

此示例只说明组合方式；`preset-research` 是待实现的包内导出，真实 preset 必须含经审计的完整依赖组合。用户 override 替换完整 plugins 列表，不自动继承未来内置更新。

**HC-PRESET-002** provider/consumer 必须同 `cordis:group` realm，Agent scope 继承所绑定 preset generation。新定义只影响新绑定；现有 Agent 继续使用旧代直至引用清零。UI 展示所用代际，不把热更新偷换到正在运行任务。

**HC-PRESET-003** 旧 preset、子代理模板和角色配置全部进入导入器：读旧文件→解析→字段迁移→冲突/缺失依赖报告→新 bundle 声明预览→保存→激活确认。旧原文件留备份；不能要求用户手写全部新配置才恢复功能。

**HC-PRESET-004** preset 不是安全沙箱。子代理创建、并发、取消和父子任务共享按运行时领域章节执行；不因能加载同进程模块就忽略来源信任和业务权限。

## 9. 权限、文件与外部资源

**HC-PERM-001** Host 插件运行在可信 Node/Cordis 中，manifest 不是官方按插件隔离的权限清单。项目必须在业务入口执行自己的政策，并通过宿主能实施的文件/进程能力消费 policy；不能把直接 node:fs 写工作区描述成“宿主自动沙箱保护”。

**HC-PERM-002** 文件模式只用宿主支持的 read-only/workspace-write/danger-full-access；会话根依据原始 header.cwd，逐调用显式 grant 优先于会话模式再优先部署默认。当前目录变化不扩大根。网络/进程控制另有项目 policy，不往 SandboxMode 塞虚构字段。

**HC-PERM-003** 工作区 API 的路径、分页、symlink 和范围语义按实际能力处理。当前 workspaceFiles 的 read/stat 不等于一律限根，list/watch 目录限制与读取不同；项目功能若需要更窄边界必须明确增加自己的限制。不能把 Client 传来的绝对路径视为已授权。

**HC-PERM-004** 模型轮次中的敏感操作走可用审批面；`never`、无 responder、取消都 fail closed。空闲 UI 用户动作不能直接调用只允许活动轮次的 userApproval.request；它应作为已明确交互授权的业务操作按项目 policy 执行，必要确认由 Nexus UI 持有，不伪造 turn 或审计事件。

**HC-PERM-005** owner 认证不取代业务授权。非 owner 默认拒绝，若未来支持共享须定义 roles/resources、列表逐条过滤和作用域；精确 Fetch 当前非 owner 返回 403，不能将其暴露为共享访问后门。

**HC-PERM-006** 外部模型、搜索、图像、邮件等功能的凭据仅在 Host secret adapter 中获取，展示掩码和已配置状态。禁止复制 `.credentials.yaml`、把 key 发到 Client、在导出/诊断包带出秘密。发送外部数据的动作遵守用户会话授权，不因批处理或自动流程偷换范围。

## 10. 操作、仓储与恢复协议

以下是 Nexus 自有协议，不是宿主 API：

```ts
interface NexusOperationState {
  operationId: string;
  requestId: string;
  kind: string;
  source: 'user-ui' | 'model-tool' | 'workflow' | 'migration';
  sessionId?: string;
  expectedRevision?: number;
  generation: string;
  stage: 'queued' | 'running' | 'cancelling' |
         'succeeded' | 'failed' | 'cancelled' | 'partial-commit';
  progress?: { completed: number; total?: number; unit: string };
  committedEffects: string[];
  retryable: boolean;
  reasonCode?: string;
}
```

**HC-OP-001** 所有写意图用第09章公共包络的 requestId 幂等，长作业由Host接纳后返回operationId，另外保存source与scope；Connection rpcId仅为每次载体相关键，不能替代前两者。公共请求/响应包络只采用第09章；传输层为 `NexusRpcRequest={protocolVersion:1,method,scope,payload:NexusRequest}`，Connection成功result.value为NexusResponse，具体示例见研究10。查询可重试，变更仅在有幂等证明或确认未提交时自动重试。客户端断线不等于操作已撤销；重新连接必须按ID查询最终状态。

**HC-OP-002** 同 session 的压缩、回退、迁移、导入等排他写按资源锁串行；无关 session 和只读任务可以并发。锁按确定顺序获取，等待支持取消，不能持有 UI 对话框等待时锁死整个 Host。

**HC-OP-003** operation cancel 先禁止新子步骤，再传播 signal，等待在途任务停稳，最后确定 cancelled 或 partial-commit；已提交外部邮件、已写文件等不能被文本“已取消”抹掉。UI 展示实际已发生的效果。

**HC-DATA-001** 插件数据目录由宿主可用路径能力/配置解析，按 profile、workspace、session 作用域分层，不把执行目录或 `D:/dshplugin/plugin` 当用户运行数据目录。敏感、缓存、可重建索引、用户资产、操作恢复日志分别管理。

**HC-DATA-002** 仓储必须有 schemaVersion、迁移日志和备份。配置写入原子替换或事务；索引由来源 hash/version 验证并可重建。升级失败保持旧可用数据，回滚需检查新数据 schema，不盲目用旧代码打开新库。

**HC-DATA-003** 关联宿主 session 的仓储记录包含来源 identity、last indexed cursor、projection version 与 generation。重建/迁移可以中断后续跑；崩溃时通过提交标记识别已完成单元，不重复外部副作用。

**HC-DIAG-001** 诊断页显示模块状态、适配路径、依赖、scope、运行代际、待重启项、最近错误与恢复动作。日志结构含 timestamp、level、module、operationId、reasonCode、duration 和脱敏 context；默认不采集用户正文。

## 11. 实际运行兼容矩阵

| 环境 | 目标 | 必需验证 | 当前研究状态 |
|---|---|---|---|
| Windows x64 Desktop rc.2 | 首发正式目标 | 全部 HOST 与业务关键验收 | 官方发行已核实，实际运行未验收 |
| 同版 Web app | 辅助开发/兼容目标 | Connection、权限、slots、主业务 | 设计复用，未实测 |
| 同版 headless/CLI Host | 后端能力目标 | 无 UI 启动、工具/仓储/取消 | 设计目标，未实测 |
| alpha.5 Desktop | 旧环境迁移目标 | 逐能力桥与全套回归后才声明 | npm alpha 标签已核实，不承诺已兼容 |
| macOS arm64/x64 | 后续平台 | feed/签名、路径、PTY/原生依赖、UI | 上游文档有目标，本次未实测 |
| 其他或未来 Host | 未知 | 准入拒绝/明确原因，完成升级审计 | 不自动允许 |

“未实测”是研究阶段诚实状态，不是允许最终交付空缺。实际开发交付时矩阵须附环境、日期、日志和通过/失败数量。全部功能的恢复路径在领域章节保留；平台特有能力缺失应说明 bridge 的成本和依赖。

## 12. HOST 验收用例

每个用例执行记录包括包 build hash、宿主 exact release、平台、profile、配置摘要、输入、期望、实际、证据路径。下面的故障注入在可丢弃测试 profile/工作区执行，不使用用户私人数据。时间阈值是项目目标，需由实测设备基线固定；没有执行结果时不得填“通过”。

| 用例 | 前置与输入 | 可判定预期 |
|---|---|---|
| HOST-001 基线身份 | 启动 rc.2 Desktop，打开诊断 | 显示实际 Host/Client/build 与适配器；无固定端口假定 |
| HOST-002 版本拒绝 | 在不匹配测试宿主安装 exact engines 包 | 管理器拒绝并显示版本要求；不写豁免、不部分激活 |
| HOST-003 包内容 | 构建并 pack，检查条目 | manifest exports 均存在；无研究归档、凭据、私人会话、开发路径 |
| HOST-004 单包激活 | 只安装 Nexus 主包 | 所有内部必需模块进入可用；没有要求分别装来源插件 |
| HOST-005 元数据 | 中/英文管理器查看 bundle/rows | 标题、说明、图标正确渲染，图标不超限，无意外 fallback |
| HOST-006 覆盖配置 | 上层覆盖生效时修改低层配置 | UI 显示 overridden 与有效值；完整 config 不被误深合并 |
| HOST-007 Desktop 认证 | dsh-app 页面调用本包读写 API | 使用正式认证载体成功；未认证复制请求 401 或信任拒绝 403 |
| HOST-008 随机端口 | 两次重新启动分配不同端口 | UI/API 自动适配；代码与配置不存在必需的 3080 |
| HOST-009 Typert 候选 | 选择 Typert 适配器时，干净构建 Host→Client，再 Desktop 调用 | 严格 contribution 挂载；错误字段在进入业务前拒绝；未选择该适配器时记录不适用，不伪称已通过 |
| HOST-010 首版正式桥 | exact POST `/api/nexus/rpc` + generic Connection RPC，使用官方信封 | strict DTO/取消/权限/错误用例通过；不抢 interceptor、不启动认证旁路 server |
| HOST-011 热卸载句柄 | 发起慢调用，禁用本包，再调旧句柄 | 在途取消停稳，旧句柄拒绝；namespace/路由/流撤回 |
| HOST-012 断线代际 | 快照读取中重启 Host，发新请求 | 旧结果不覆盖新代；ready 后重建，无重复副作用 |
| HOST-013 Journal 缺口 | 注入重复、缺口、部分重叠 delta | 完整重复忽略；缺口修复；不合法重叠触发协议错误/重建 |
| HOST-014 Host 安装锁 | Desktop 运行时由内部管理器更新 | 遵守 request admission/锁，明确 restart-required；不并发改 profile |
| HOST-015 Client 版本错配 | 保留旧页面接入新 Host release | 拒绝混用模块并提示刷新；不会旧 codec 静默继续 |
| HOST-016 Slot 生命周期 | 父 slot 移除再重建 20 次 | Nexus 条目无重复；旧 listeners/store/portal 清零，重建可用 |
| HOST-017 主题可访问性 | 浅/深/高对比，200% 缩放，只键盘操作 | 内容不丢失，焦点可见，dialog 可退出，状态有文字 |
| HOST-018 配置冲突 | 两个视图同 revision 并发保存 | 后写收到冲突或有序合并；不丢用户更新 |
| HOST-019 投影等价 | 同 fixture 从零回放与 checkpoint 恢复 | JSON 结果一致；无关事件保持引用，无多余发布 |
| HOST-020 投影版本 | 升 stateVersion 后读取旧 checkpoint | 重建正确，不把旧结构直接当新值 |
| HOST-021 Session ID 语义 | 使用不连续 seq、多次 replace、工具对 | 无 seq 当下标错误；cursor、surface 范围保持正确 |
| HOST-022 禁用私有写入 | 静态扫描与运行记录检查持久路径 | 无 appendPluginRecord、自造 session type、直接改宿主日志 |
| HOST-023 Inject 语义 | 空闲 agent.inject，再提交 followup | 注入本身不唤醒；后续 admitted step 消费且来源可回放 |
| HOST-024 Persona 组合 | 一个 complete persona + 动态记忆 + 工具 | 精确系统段、记忆和工具均符合配置；两个 complete 明确冲突 |
| HOST-025 当前目录 | 原根 A，cd 到 B，再尝试 B 外写入 | 显示当前 B，权限根仍 A；不因 cd 扩权 |
| HOST-026 工具双模式 | 相同 typed 工具在 native 和 ptc 各执行 | 输入/结果/权限等价；无 both；缺 PTC runtime 有明确失败 |
| HOST-027 参数不可变 | 运行 PowerShell 规范化 fixture | 不改冻结参数；原输入与执行输入可审计，语义变更显式 |
| HOST-028 取消与超时 | 网络/子进程工具运行后取消或超时 | signal 下传，底层停稳；无悬挂进程，无迟到成功覆盖 |
| HOST-029 Preset 迁移 | 导入旧 preset 与重复 ID/缺依赖样例 | 生成 bundle 声明预览、报告冲突、备份来源，合法项可加载 |
| HOST-030 Preset 代际 | 运行 Agent A，更新 preset，再建 B | A 留旧代，B 用新代；引用释放后旧资源销毁 |
| HOST-031 Realm 依赖 | 预设 provider/consumer 正确与错误分组 | 正确可用；错误被审计拒绝，不向全局泄漏 |
| HOST-032 子模块清理 | 有 Agent、流、监听、数据库时禁用本包 | 禁止新工作→取消→等待→flush/close；可重启，无重复注册 |
| HOST-033 审批范围 | 活动轮次 ask/never/无 responder，再空闲 UI 动作 | 活动审批遵守策略；空闲不伪造 turn；取消丢迟答 |
| HOST-034 Peer 权限 | owner 与非 owner 调本包读/写/exact route | 业务授权有效；非 owner 默认拒绝，exact route 403 |
| HOST-035 路径边界 | `..`、NUL、文件symlink、目录junction、根外路径 | 按能力与项目策略明确接受/拒绝，不能由字符串前缀放行 |
| HOST-036 幂等变更 | 同操作 ID 重复提交导入/迁移 | 只发生一次副作用；返回同操作结果或明确冲突 |
| HOST-037 部分提交 | 写入一部分后故障/取消 | 显示 partial-commit 与已发生效果，重试不重复旧效果 |
| HOST-038 数据迁移 | schema N→N+1 中途杀进程再启动 | 旧数据可恢复或安全续跑，原子配置无截断 |
| HOST-039 诊断脱敏 | 配置测试 key、含 key URL、敏感正文并触发错误 | 诊断/导出不含秘密与正文；保留可定位的 error/operation ID |
| HOST-040 压缩唯一性 | 默认 preset + Nexus 增强策略连续跨阈值 | 同 realm 一个 provider、一个自动控制器，同 session 无双事务 |
| HOST-041 压缩保留 | 运行基础/增强/论文启发策略相同任务集 | 各策略存在且可选择；任务、约束、关键代码事实可恢复 |
| HOST-042 压缩缓存 | 同模型热前缀摘要与跨模型摘要对比 | 同目标输入前缀字节匹配，报告实际/估算命中率及原因；不删压缩 |
| HOST-043 Prune→摘要 | 构造大工具输出与不可分非工具节点 | 先 prune 再计价；可省摘要，不能修复的节点明确失败 |
| HOST-044 手动压缩 | 空闲点 manual 并立即提交两条提示 | 一个 turn:null 操作，flush 后两提示 FIFO 开始，重复点击不双跑 |
| HOST-045 压缩取消/崩溃 | 摘要中取消、替换前后故障、flush 失败 | 锁/标记/原日志符合正式协议；无假成功，恢复不重复替换 |
| HOST-046 Overflow 重试 | 模拟确认的窗口溢出与非窗口错误 | 仅确认溢出触发；surface 前进才有限重试；取消优先 |
| HOST-047 No-UI Host | 无浏览器启动同版 Host，运行后端工具 | Client 缺席不导致 Host 必需模块挂死；能力报告准确 |
| HOST-048 性能与泄漏 | 连续开关20次、长会话和大列表 | 注册数量回到基线；无持续递增监听/进程；记录真实内存/耗时 |

## 13. 发布阻断与交付证据

首个可运行版本发布前，必须解除以下门槛：

- GATE-DESKTOP-001：实际 Windows rc.2 `dsh-app://app/` 安装、显示、调用、重启、取消、卸载端到端记录，不能仅用 localhost Web 结果替代。
- GATE-REMOTE-001：第三方严格 Typert 全流程，或符合本章要求且实测的 authenticated Connection 兼容桥；方案选择、限制和协议版本有记录。
- GATE-SLOT-001：实际 slot subtree 与注册点核验；截图、键盘与主题记录归 UI 验收，不能靠代码静态推断更漂亮。
- GATE-COMP-001：唯一 compaction provider/controller、增强策略保留、正式事务与缓存/质量联合验收。
- GATE-FEATURE-001：总功能矩阵中的每个来源功能映射到主实现/策略/迁移桥及验收，所有坏功能具有已执行恢复用例。
- GATE-RUNTIME-001：SQLite/PTY/其他原生或外部辅助程序在实际 Desktop Node ABI 下通过，缺省系统依赖有明确安装前检查与可工作的兼容路径。
- GATE-DATA-001：升级备份、数据迁移、取消、部分提交、崩溃恢复、秘密脱敏通过；许可证和 NOTICE 清单完整。

交付包应附 manifest/lockfile/build hash、版本兼容矩阵、功能覆盖矩阵、来源许可账本、Host 能力报告、API/DTO 版本、测试记录、UI 截图与可访问性结果、已知限制和升级/回滚手册。研究阶段只生成规格和证据，不提前标记运行验收成功。

## 14. 官方依据导航

本章依据归档见 `../research/01-host-evidence.md`，原文位于 `../research/host-upstream/`，均使用固定 commit。主要原文：

- Desktop：`apps/desktop/README.zh.md`、`apps/desktop/publishing/README.zh.md`。
- 插件：`packages/preset/agent-preset/skills/cordis-plugin-development/references/{host-plugin,ui-plugin,practices}.md`、`packages/boot/plugin-manager/README.zh.md`。
- Client：`packages/client/{modules,connection,ui-slots,ui-settings}/README.zh.md`。
- Gateway：`docs/api-gateway.zh.md`、`packages/api/{gateway,remote-access,session-controller,workspace-files}/README.zh.md`。
- Session/Agent：`packages/core/{session,agent,tools,system-prompt}/README.zh.md`、`packages/session/session-projection/README.zh.md`。
- Preset/Skills：`packages/preset/agent-preset-registry/README.zh.md`、`packages/skill/skill/README.zh.md`。
- 压缩：`docs/subsystems/compaction.zh.md`、`packages/compaction/{compaction,compaction-basic,compaction-tool-result-pruner,compaction-image-offload}/README.zh.md`。
- 权限/生命周期：`packages/sandbox/sandbox-policy/README.zh.md`、`packages/interaction/user-approval/README.zh.md`、`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md`。

原始资料陈述 O/S，外部单包工具链和真实 Desktop 接入仍为 V；本文的模块命名、DTO、控制器、错误码、验收和发布门槛属于 Nexus 设计。
