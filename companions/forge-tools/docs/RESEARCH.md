# 2026-10-29 rc.3兼容补充

当前版本0.1.5，目标Desktop 0.2.1-rc.3，官方源码commit
1f81c047fc48fa190a683e469daa699857e9afe8。
standard组合直接取自独立且未修改的官方分发副本；文件摘要见research/host-installed/manifest.json。
引擎、SDK和安装器使用同一精确版本。构建器核对三个替换边界各唯一一次，
遇到宿主预设变更时停止，避免静默丢失原生工具。真实Host和Electron验收见VALIDATION.md。
本地实现未声明独立远程仓库；不能把DeepSeek官方更新虚称为Forge上游发版。
0.2.2-alpha.2只记录为候选，不为解决rc.3拒载而切换用户宿主。

## 以下为最初rc.2调研与设计依据

# 调研与最终取舍

目标固定为 Windows x64、DeepSeek Harness Desktop 0.2.1-rc.2。固定上游 commit：
`687f282e8625c6b8d11ff58211a90524be2e4317`。
本地研究原文保存在项目 research/ 下，不随插件携带完整仓库。

## 官方宿主

- [Tool registry](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src)：
  `ctx.tools.register(defineTool(...))`，同一作用域同名冲突；preset 作用域可遮蔽继承工具。
- [Filesystem seam](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/fs/src)：
  `resolve/stat/readBytes/streamText/writeText/editText`；targetKey/version 是不透明身份。
  小文件改用有 maxBytes 参数的 readBytes，防止 stat 后文件增长导致 readText 完整分配。
- [Filesystem sandbox](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/fs/fs-sandbox/src)：
  读取各模式允许，变更必须传递本次会话策略；不直接 Node 写文件绕过宿主。
- [PowerShell executor](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/shell/pwsh-local/src)：
  `ctx.shell.resolve` → `execute` → `result/done`；已内置 NoProfile 与 UTF-8 前缀。
- [PowerShell sandbox](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/shell/pwsh-sandbox/src)：
  受限执行保留官方沙箱实现，不自行生成另一套权限根。
- [Jobs](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/jobs/jobs/src)：
  `jobs.start` 同步登记、后台拥有自己的 signal、owner 为 agent.id。
- [Preset registry](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/preset/agent-preset-registry)：
  正式 bundle 声明，不使用废弃的 ~/.dsh/agent-presets 复制安装。
- 实装 Desktop 的 standard/minimal/ptc/cordis composition 已核对。
  正式 bundle 直接覆盖 `preset-standard`，其身份仍为 `standard`，
  保留官方非文件工具与 read_image，不要求选择独立 Forge 预设。
- 原版 Electron `main.js` 固定使用 DSH_HOME/profiles/desktop，
  通过私有 IPC 启动 dsh-desktop-host。Desktop 内部复用 dsh-web-app 的资源，
  这属于官方架构；验收必须启动真实 Desktop Host 和 Electron，
  不能用 web profile 的服务启动代替桌面验证。
- bundle 层先于用户 profile 的 cordis.patch.yml，因此用户已有的 standard 定制
  可以覆盖包。安装器检测并停止，保留定制；包不另写永久 preset 覆盖，
  卸载后自然恢复官方 standard。两个变体互斥安装。

## 社区

- [dsh-gitbash-preset](https://github.com/liceses/dsh-gitbash-preset)：
  学习 argv 直接启动、缓存 shell 发现、Windows/WSL 区分。
  其旧目录安装方式已过时，未采用。
- [dsh-pwsh-encoding-fix](https://github.com/hongweifei/dsh-pwsh-encoding-fix)：
  研究编码 wrapper 的限制。未采用全量 Out-String 加猜测转码；
  Forge 强制 UTF-8，不能修复所有旧 ANSI 程序的输出。
- 本地 Saikel coding-agent-preset 0.1.2：
  研究 owner 队列、持久进程和清理。避免 node-pty/ConPTY 的安装脚本、
  提示符轮询及固定静默等待；改为普通管道和每次请求的随机完成标记。
  社区历史接口不作为 rc.2 兼容证据。

## Windows / 文件搜索

- [Filter manager](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/filter-manager-concepts)：
  文件过滤器参与 I/O 路径。方向是少做重复操作，不是绕过安全软件。
- [ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)：
  缓冲区溢出可能丢失事件。监听只用于提前失效；TTL 提供新鲜度上界。
- [Node fs.watch](https://nodejs.org/docs/latest-v22.x/api/fs.html#caveats)：
  Windows、网络盘与虚拟化环境存在限制，监听失败时退到 TTL。
- [ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/15.0.0/GUIDE.md)：
  使用原生流式搜索、ignore 规则；`--max-count` 是每文件上限，
  Forge 另外实现全局结果预算，并在足额时终止进程。
- [ripgrep manpage](https://github.com/BurntSushi/ripgrep/blob/15.0.0/doc/rg.1.txt.tpl)：
  不默认 `--sort`（会禁用并发）；`--no-mmap` 是稳健性选择，
  默认 2 搜索线程是可调起点，不宣称比 1/4 线程始终快。
- Node path.matchesGlob 对多层 brace 和重复通配符的病理模式可能长时间占用 CPU。
  保留 rg 的 ignore-aware 目录快照，把匹配放到固定脚本的独立 Node 进程，
  模式和文件名通过 stdin JSON 传入，不作为代码执行。限制 old heap 64MiB、
  young semi-space 4MiB、输入 32MiB，并共用搜索期限、并发和终止追踪。
  相同模式缓存结果，不同模式复用快照；冷模式增加一次进程启动。
  未采用直接 rg --glob 枚举替代，因为显式正向 glob 会覆盖 ignore 规则。
- [Microsoft rg prebuilt](https://github.com/microsoft/ripgrep-prebuilt)：
  固定 npm Windows x64 包 1.18.0，构建携带 exe；
  无安装脚本、无运行时下载，真实 `--version` 为 ripgrep 15.0.0。
- [Git ls-files](https://git-scm.com/docs/git-ls-files)：
  只查 Git 索引无法完整覆盖未跟踪文件和非 Git 工程，未作为唯一目录源。
- [Everything IPC](https://www.voidtools.com/support/everything/sdk/ipc/)：
  依赖额外运行中的服务。当前交付不要求公司机器新增服务。
- [USN journal](https://learn.microsoft.com/en-us/windows/win32/fileio/change-journals)：
  卷接口、权限、日志截断与恢复复杂；不以管理员扫描全盘作为默认方案。
- [PowerShell quoting](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules)：
  `pwsh_run(file,args)` 通过单引号转义构造字面 argv；
  不把 JSON.stringify 当 shell 转义，也不随意把 && 改为分号。

## 覆盖范围与真实限制

| 能力 | Forge 实现 |
|---|---|
| read/write/edit | 替换模型工具，复用官方文件后端、观察记录与策略 |
| glob/grep | 替换为捆绑 rg、短时目录快照/重复查询缓存 |
| pwsh | 替换模型工具；完整访问下常驻，受限模式官方执行器 |
| pwsh_run | 新增字面原生 argv；独立环境与沙箱执行 |
| read_many/batch_edit/list_directory/forge_status | 新增批量调用和可观察性 |
| read_image、working_directory、job_* | 保留官方能力 |
| 子代理、任务、目标、计划、技能、定时、网页、展示 | 保留 standard 预设原有插件 |
| run_code/PTC | 宿主保留能力；本版直接增强 standard/native，PTC 预设不变 |
| 交互终端 | 未重新实现 PTY；需要时继续使用宿主 terminal 工具预设 |

缓存只保存在内存，文件缓存默认 64 MiB、4096 条，按 UTF-16 字符串和元数据估算，
单文件 2 MiB；目录快照全局 16 MiB/8 条，重复查询全局 8 MiB/8 条，均为每插件实例。
这不是 Desktop 总 RSS 的限制，运行中 provider 缓冲和 PowerShell 用户状态另计。
读/目录/重复查询最多复用 1000ms，`fresh:true` 立即绕过。
过期的文件内容通过 provider resolve/stat 核对身份和版本后可继续复用，
因此工具调用间隔超过 TTL 时仍可避免重复读取正文。
写入始终落盘，不延迟提交、不回写缓存冒充成功。
取消无法回滚已经原子发布的文件。真实 SDK 会将取消后的正常返回改为 ABORTED，
因此通过官方 deferContext 保留已确认提交摘要；后端变更失败但无法排除已发布时，
保留“待核实”目标，要求先 fresh 读取，不自动重试。
写前观察与版本守卫使用官方协议；初始 read 的 stat→read 并发窗口
与官方一致，可能导致随后编辑安全地拒绝陈旧版本，不能保证外部并发写入的原子读快照。

受限模式不能启用任意普通常驻 PowerShell，避免复用宽权限进程；
进程退出、超时、取消、权限变化和空闲都会丢失常驻状态。
不自动重试命令，避免重复副作用。这里的常驻是进程级性能优化，
不是不受信任代码之间的隔离边界。

慢操作取消后不能虚假释放实际 I/O 并发占位。文件队列与搜索队列各限制 128 条；
PowerShell 每实例最多 16 个前台受管资源。终止未确认的进程继续计数并隔离，
禁止循环“超时—替换进程”积累后台负载。等待清理有独立上限，但不把清理超时
冒称进程已退出；后台 job 继续使用官方作业生命周期，不适用前台期限。
期限同时覆盖准备与排队，计时器在事件循环或操作系统调度停顿时仍可能延迟。

首次读取、不同查询、遍历巨大目录、真实落盘仍受磁盘与过滤器约束。
无法从截图推断具体 WMI/过滤器数量，也未在公司工作机验证加速比。
