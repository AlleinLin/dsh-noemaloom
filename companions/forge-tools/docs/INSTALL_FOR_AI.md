# DeepSeek Harness 桌面端安装说明（供用户与安装 AI 使用）

本说明用于安装 **DSH Forge Tools 0.1.5**，适配 **Windows x64、DeepSeek Harness Desktop 0.2.1-rc.3**。项目交付目录为 `D:\dshplugin\tools\build`，也可以将整个交付目录或 ZIP 解压结果复制到工作机的其他目录。

安装使用桌面端自带的插件管理入口，目标固定为 `desktop` profile。插件直接作用于官方默认 **standard** 预设，不需要创建、选择或导入 Forge 预设。这里的 `dsh.cmd` 仅用于管理桌面端插件，不代表安装到命令行或 Web profile。

## 最短安装示例

保存工作，并通过应用界面完全退出 DeepSeek Harness Desktop；然后在交付目录运行：

```powershell
powershell -NoProfile -File .\Install-Example.ps1
```

已经在 PowerShell 中时，也可以运行：

```powershell
& .\Install-Example.ps1
```

始终安装完整 Tools 包，同时包含文件读写、搜索和 PowerShell 增强。此版本不再提供独立 PowerShell 包。

桌面端不在常见安装位置时，指定它自带的命令入口：

```powershell
& .\Install-Example.ps1 `
    -DshCommand 'D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
```

旧命令中的 `-Variant PowerShell` 仍可执行，但只是完整 Tools 包的兼容别名；安装器会显示说明，不会保留官方文件与搜索工具。

脚本根据自身所在目录定位文件，工作目录不必是交付目录：

```powershell
& 'D:\dshplugin\tools\build\Install-Example.ps1' `
    -DshCommand 'D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
```

## 交付文件与安装方式

| 文件 | 用途 |
| --- | --- |
| `dsh-forge-tools-0.1.5-win-x64.zip` | 可复制到工作机的完整交付包；解压到一个独立目录后安装 |
| `Install-Example.ps1` | 推荐安装入口，调用同目录的正式安装脚本 |
| `Install.ps1` | 正式安装脚本；校验完整 Tools tgz、宿主版本和配置冲突 |
| `local-dsh-forge-tools-0.1.5.tgz` | 唯一安装包：完整工具集，包名 `@local/dsh-forge-tools` |
| `SHA256SUMS.txt` | 解压后交付文件的 SHA-256 校验清单 |
| `INSTALL_FOR_AI.md` | 本安装说明 |
| `PERMISSIONS.md` | 权限参数、当前会话模式与真正提权的审批规则 |

使用同一次交付中的脚本、清单和包，保留它们的目录结构。不要只复制一个 tgz 后直接运行本安装示例。SHA-256 用于发现文件损坏，不能替代对交付来源的信任；不要在校验失败后修改清单继续安装。
开发验收截图不属于安装文件，不随 build 或发布包交付。

## 安装 AI 的执行约定

以下步骤可以直接用于执行用户已经授权的本次安装。常规检查和安装无需反复请求相同授权；仍需尊重用户已有的范围限制。

1. **确认真实桌面端与数据目录。** 读取当前进程的 `DSH_HOME`。非空白值应与用户实际启动桌面端时使用的值一致；若未设置或只有空白，默认是当前 Windows 用户主目录下的 `.dsh`。脚本支持 `~`、`~/` 和 `~\` 前缀。目标为该目录的 `profiles\desktop`。如果用户通过专用启动脚本设置了其他 `DSH_HOME`，应沿用那个真实目录。不要创建临时 `DSH_HOME` 来绕过安装检查，也不要指向别的用户的目录。
2. **确认桌面端已经退出。** 用户应先保存工作并正常退出应用。安装器检测到 `DeepSeek Harness` 进程会停止；不要自动 `taskkill /F` 或关闭可能有未保存工作的窗口。
3. **安装完整 Tools 包。** 默认 `-Variant Tools` 与兼容别名 `-Variant PowerShell` 都只安装 `local-dsh-forge-tools-0.1.5.tgz`，包名 `@local/dsh-forge-tools`。不要寻找或另外安装独立 PowerShell 包。
4. **使用桌面端自带的 `dsh.cmd`。** 脚本会在常见目录和卸载注册表中定位它。若找不到，使用实际安装目录中的 `resources\runtime\cli\bin\dsh.cmd` 绝对路径传给 `-DshCommand`。不要改用来源不明的全局 `dsh`、`npm` 或 `pnpm`。
5. **执行安装并检查退出状态。** 推荐调用同目录的 `Install-Example.ps1`；它委托 `Install.ps1`。安装器默认离线，使用 `--ignore-scripts --save-exact`，核对 tgz 的 SHA-256 和桌面端版本，并检查旧独立 PowerShell 包及 profile 层的 `preset-standard` 定制冲突。若旧包仍启用，保留配置并停止；按脚本给出的命令卸载该旧包后再安装。
6. **保留现有数据。** 允许插件管理器更新所选桌面 profile 的插件依赖和启用记录；不要用其他机器的整个 profile、默认模板或项目文件覆盖用户配置。不要读取或输出 API key、令牌、会话内容；不要删除用户的 `cordis.patch.yml`、凭据或对话目录。
7. **在实际桌面端验收激活。** 安装成功后按下一节新建 standard 会话验证。插件管理命令成功仅能报告“已安装”；未完成实际桌面验收时，不得报告“已在桌面端验证激活”。

安装不需要全局 Node.js、不需要管理员权限、不要求修改系统服务或安全软件。不要自动改变执行策略、关闭安全过滤器、添加白名单或更改宿主版本限制。

如果当前 PowerShell 会话使用了自定义 `DSH_HOME`，启动桌面端时也应使用同一真实设置；否则可能出现“安装到了 A 目录，桌面端实际读 B 目录”。不要为解决此问题复制凭据或整个 profile。

## 安装后的桌面验收

重开 **DeepSeek Harness 桌面应用**，新建会话并使用官方默认 **standard** 预设；旧会话不作为激活验收依据。

可以将下面这段提示发送给新会话中的 AI：

```text
请验证当前 DeepSeek Harness 桌面端是否启用了 DSH Forge 插件。
先实际调用 forge_status({})，核实返回版本为 0.1.5。
然后只使用只读操作，在当前已授权项目中：
1. glob 一个已知存在的普通文件；
2. read 该文件的少量行；
3. grep 其中一个已知存在的普通文本。
不要改写文件，不要扫描整个磁盘，不要输出凭据。
请分别报告实际调用结果；如果工具不存在或调用失败，保留错误，不要声称验证通过。
完整工具集应替换 standard 的 read/write/edit/glob/grep/pwsh。
```

完整工具集会在 standard 中新增 `read_many`、`batch_edit`、`list_directory`、`pwsh_run`、`forge_status`；安装后 standard 共 36 个工具，其他宿主操作继续保留。旧配置中的 `shellOnly` 不再禁用文件与搜索工具。

安装 AI 如果没有实际桌面工具调用能力，应交付上述验收提示并明确标记“安装完成，等待新 standard 会话验收”，不要用配置文件存在、CLI 可运行或 Web 页面测试代替桌面工具激活证据。

## 遇到错误时

| 情况 | 处理方式 |
| --- | --- |
| 校验不匹配、文件缺失 | 停止安装，重新取得同一版本的完整交付包；不要重写校验清单 |
| 宿主不是 `0.2.1-rc.3` | 停止并报告实际版本；不要编辑包的 engines 或跳过版本检查 |
| 旧 `@local/dsh-forge-pwsh` 已启用 | 保留现状并停止；正常退出桌面端后，按安装器给出的精确命令卸载该旧包，再安装完整 Tools 包 |
| profile 中已有 `preset-standard` 定制 | 停止并报告冲突文件；备份、审阅并合并定制，不要删除整份配置或强制覆盖 |
| 离线依赖缓存不足 | 保留真实错误并报告未安装成功；仅在用户允许使用网络时，重试 `-Offline:$false` |
| PowerShell 执行策略阻止运行 | 返回实际错误并按公司的既有策略处理；不要自动绕过执行策略或要求提升权限 |
| 新会话找不到 `forge_status` | 检查是否为桌面端、新建 standard 会话、相同真实 `DSH_HOME`；不要不断重复安装或更改预设 ID |

用户已允许本次安装使用网络时，联网重试示例为：

```powershell
& .\Install-Example.ps1 -Offline:$false
```

离线失败不代表插件已经激活。不要把“尝试执行过安装”当作安装成功。

## 回滚或从旧包升级

保存工作并完全退出桌面端。保留与安装时相同的真实 `DSH_HOME`，使用同一个桌面端自带的 `dsh.cmd`。只卸载本次安装的明确包名：

```powershell
$DshCommand = 'D:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

# 完整工具集：
& $DshCommand plugin --profile desktop remove '@local/dsh-forge-tools'
if ($LASTEXITCODE -ne 0) { throw '卸载失败，请保留错误并停止。' }
```

只有安装器明确报告旧 `@local/dsh-forge-pwsh` 已启用时，才先执行它给出的旧包卸载命令，然后安装完整 Tools 包。不要把卸载两个包当作固定清理步骤，也不要删除整个 `desktop` profile、`.dsh` 或应用目录。

卸载完整 Tools 包后重开桌面端，新建 standard 会话，应恢复官方工具配置。从旧独立包升级时，先卸载该明确的旧包，再运行完整 Tools 包的安装示例。

## 向用户报告结果的格式

安装 AI 最后至少报告：所用桌面端版本、实际 `DSH_HOME`（不含凭据内容）、所选包及版本、安装命令退出状态、是否完成实际桌面端新 standard 会话验收。遇到失败时说明停止的位置和原始错误的必要摘要，不输出秘密数据，不承诺任意环境绝无 bug。
