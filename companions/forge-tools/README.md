# DSH Forge Tools 0.1.6

Windows x64 / DeepSeek Harness **Desktop 0.2.1-rc.5**。
安装目标固定为桌面端的 `desktop` 配置；在原生桌面窗口的新会话中使用。
统一安装完整 Tools 包，同时替换文件读写、搜索和 PowerShell；不再提供独立 PowerShell 包。

## 交付与安装

完整交付目录为 `build/`，包含 ZIP、一个完整 Tools tgz、安装器及校验和。
可以直接运行同目录的 `Install-Example.ps1`；给其他 AI 执行时，
先让它阅读 [AI 安装说明](docs/INSTALL_FOR_AI.md)。
`npm run pack:delivery` 会同时更新 delivery 和 build。

把 delivery 中的 zip 拷到工作机并解压。先完全退出 dsh Desktop，
再运行解压目录里的：

```powershell
.\Install.ps1
```

本机桌面安装目录的完整示例（不依赖当前工作目录）：

```powershell
& 'D:\dshplugin\tools\build\Install-Example.ps1' -DshCommand 'D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
```

旧安装命令中的 `-Variant PowerShell` 保留为兼容别名，会明确提示并安装同一个完整 Tools 包。

脚本用注册表和常见目录定位 Desktop 捆绑的插件管理命令，不使用 WMI，
不要求全局安装 Node。捆绑的 `dsh.cmd` 只是安装渠道，安装结果写入 Desktop 配置。
找不到时：

```powershell
.\Install.ps1 -DshCommand 'D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
```

重开 Desktop，使用官方默认 **standard** 预设新建会话即可。
完整包直接替换 standard 的 read/write/edit/glob/grep/pwsh，
并新增 read_many/batch_edit/list_directory/pwsh_run/forge_status。
安装后 standard 共 36 个工具，保留宿主提供的其他操作。

现有会话请重新新建，确保使用更新后的工具配置。
不修改宿主二进制、不安装系统服务或关闭安全软件。
版本不符请先不要强行编辑 engines 绕过准入。

安装脚本读取当前 `DSH_HOME`（支持 `~` 前缀）；未设置或只有空白时，
使用 Windows 用户主目录下的 `.dsh`。目标为该目录的 `profiles/desktop`，
设置临时 `DSH_HOME` 时也只检查、安装到临时目录。
如果旧独立包 `@local/dsh-forge-pwsh` 已启用，脚本会停止并显示准确的卸载命令；
正常退出桌面端后先卸载该旧包，再安装完整 Tools 包，避免加载顺序冲突。
如果桌面配置的 `cordis.patch.yml` 已定义 `preset-standard`，脚本也会停止：
该用户配置层优先于插件，需要先备份并人工合并现有定制与 Forge 工具配置。
脚本保留这些配置，不会静默删除或覆盖。

离线机器可使用脚本默认的 `-Offline` 模式：tgz 已带搜索 exe 和完整插件代码，
无需编译原生依赖。SDK 由同版本 Desktop 宿主提供。若桌面配置的包缓存缺依赖，
pnpm 会明确失败；可在联网的同版宿主安装，或使用 `-Offline:$false`。
不要把其他机器的整个桌面配置、会话或凭据目录拷进来。

手工安装等价命令：

```powershell
& '你的\dsh.cmd' plugin --profile desktop add --offline --ignore-scripts '完整路径\local-dsh-forge-tools-0.1.6.tgz'
```

## 给 Agent 的操作习惯

```text
read_many({files:[{file_path:"src/a.cs"},{file_path:"src/b.cs"}]})
grep({pattern:"HandleRequest",glob:"*.cs",path:"src"})
read({file_path:"src/a.cs",offset:1,limit:120,fresh:true})
pwsh_run({file:"dotnet",args:["test","My Project.sln","--no-restore"]})
pwsh({command:"$env:NAME='value'; Write-Output $env:NAME"})
forge_status({})
```

普通调用省略 `sandbox_permissions` 和 `justification`，自动继承本次会话的实际权限。
有效的重复权限参数及空理由处理、真正扩大权限时的官方审批，
见 [权限参数说明](docs/PERMISSIONS.md)。

`pwsh_run` 接收字面参数数组，处理空格、单引号、双引号、`$`、反引号和中文。
`pwsh` 不默默把 Bash 语法翻译成另一条命令；`strict:true` 可在识别出常见 Bash 写法时先给出修正。
一次性环境变量使用 pwsh_run.env。老式非 UTF-8 exe 仍可能需要显式转码。

默认在 `danger-full-access` 下复用 PowerShell 7 管道进程，变量和函数可保留，
工作目录每次按 DSH 当前目录重设。空闲 120s、退出、超时、取消或权限变化会丢失进程状态。
受限模式仍经官方沙箱执行器逐次运行；不要求提升权限来启用本插件。
`session_mode:"isolated"` 强制隔离一次；调用 exit 的脚本、长期进程和改变 shell 全局设置的命令适合此模式。

`run_in_background:true` 注册正式 dsh job，后续使用 job_output/job_list/job_kill；
后台不受前台等待时间限制。前台超时会请求终止，本版不自动提升为后台。
如果 Windows 尚未确认清理完成，结果标记 `cleanupPending:true`，
保留资源占位并阻止该 agent 继续启动命令。任何命令都不会自动重试。
期限从调用入口起算，包含准备和排队；系统或 JavaScript 线程停顿时，
计时器也会延后执行。

## 性能与一致性

- 文件缓存默认最多 64 MiB、4096 条，按 UTF-16 字符串及元数据估算并 LRU 淘汰；
  单文件最多读取 2 MiB 进入缓存，使用宿主有界字节读取防止文件在 stat 后暴涨。
  缓存命中避免重复 resolve/stat/open/read。大文件按所需行窗流式读取并提早停止。
- TTL 过后先用 provider resolve/stat 校验原缓存的身份与版本；
  未变更时复用正文，避免再次 open/read。`fresh:true` 始终重新读正文。
- watch 提前失效，TTL 保底；默认最多复用 **1000ms**。
  read/glob/grep 的 `fresh:true` 用于外部修改、检查最终状态等场景。
  `forge_status({clear_cache:true})` 清空缓存。
- 目录使用 ignore-aware rg 快照；目录快照共用 16 MiB、最多 8 条，
  重复搜索结果共用 8 MiB、最多 8 条。不同根目录和查询不能各自无限累积。
  相同 grep 查询短时复用结果；
  不自动扫描全部内容建索引，不默认递归预热。
- 搜索线程默认 2，可在工作机比较 1/2/4；最多同时执行 2 次搜索，
  有全局结果预算和 30s 搜索超时。文件大于 8MiB 默认不搜。
  I/O 和搜索等待队列各最多 128 条；取消后仍未结束的实际操作继续占位，
  队列满时明确拒绝新请求，避免超时风暴不断放大负载。
- 写入、编辑始终调用宿主原子后端并提交到磁盘；
  保留 fs/observed、版本守卫、沙箱和升级审批。缓存不延迟写回。
- read_many 最多 32 文件；batch_edit 最多 32 编辑、依序提交，
  首次失败即停并明确已提交清单，**不是跨文件事务**。
  取消不回滚已提交文件；即便宿主把调用结果改为 ABORTED，也保留提交状态上下文。
  后端已接收变更但结果无法确认时，标记待核实，必须 fresh 读取后再决定是否重试。
  批量结果省略完整修改前后正文；单次结果的正文合计超过 64 KiB 时也省略。
- glob 返回文件，使用 Node 的 glob 匹配语义；grep 使用 Rust/ripgrep 正则，
  不支持所有 PCRE2 语法。搜索结果可能因全局预算截断，继续请缩小 path/glob。
  glob 在有内存与期限限制的独立 Node 进程中匹配，避免复杂模式阻塞宿主；
  相同模式可复用结果，不同模式可复用目录快照，但首次过滤增加一次进程启动。
- 本版不替换原生 PTY；图像、子代理、计划、目标、技能、网页、
  展示、工作目录与作业管理由官方插件提供。

真实基准见 [docs/BENCHMARK.md](docs/BENCHMARK.md)；
接口、社区和 Windows 主源研究见 [docs/RESEARCH.md](docs/RESEARCH.md)。
桌面安装、预设和工具激活验收见 [docs/VALIDATION.md](docs/VALIDATION.md)，
机器可读桌面记录见 [docs/desktop-validation.json](docs/desktop-validation.json)。
不能保证公司安全过滤器下的具体倍数，首次读取和真正落盘仍经过系统 I/O 路径。
极端慢 I/O、取消和内存压力的验证见 [docs/RESILIENCE.md](docs/RESILIENCE.md)。
上述缓存预算按插件实例计算，不是整个 Desktop 的 RSS 上限；
宿主临时缓冲、完整目录列表、原子编辑的前后正文及 PowerShell 用户变量另占内存。
实例销毁会清空缓存、监听器和队列；不能安全中断的操作仍保留追踪直到实际结束。

## 配置

在 standard 的 `@local/dsh-forge-tools` 行修改完整 config：

```yaml
cacheMiB: 64
cacheFileKiB: 2048
cacheTtlMs: 1000
ioConcurrency: 4
searchThreads: 2
watch: true
persistentPwsh: true
pwshIdleMs: 120000
maxOutputChars: 32000
```

`cacheTtlMs:0` 禁用缓存复用；不使用持久磁盘索引。
rgPath 可指定受信任的搜索 exe；默认带 Windows x64 rg，无运行时下载。
旧配置中的 shellOnly 不再禁用文件与搜索工具，始终注册完整工具集。

## 回滚

退出 Desktop 后卸载插件，再新建会话使用恢复后的官方 standard：

```powershell
& $DshCommand plugin --profile desktop remove '@local/dsh-forge-tools'
```

这里 `$DshCommand` 是 Desktop 捆绑 `dsh.cmd` 的完整路径。
插件只保留进程内缓存，不保存项目副本或修改安全软件配置。

## 开发

Node >=22.19，Windows x64：

```powershell
npm ci --ignore-scripts
npm test
npm run benchmark
npm run build
npm run pack:delivery
```

lockfile 固定 SDK 和构建依赖。运行包正向白名单，不携带 node_modules、
研究源码、私有 profile、会话、凭据和测试临时文件。
开发验收截图只保留在开发目录，不放入 build 或发布包。
