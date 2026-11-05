# dshell 交接文档（2026-11-04）

给接手的人。这份只写**当下现场状态**与**为什么**——架构/协议/包职责看
[`dshell-architecture.md`](./dshell-architecture.md)、[`dshell-packages.md`](./dshell-packages.md)，
上手顺序看 [`README.md`](./README.md)。

本文里的读数分两批，都标了日期和来源：**§1–§5 是 2026-11-04 在本机**（Windows + WSL2，
`<repo-root>`）复跑或复扫得到的，命令一起写出来了，可以直接推翻我；**§6 是 2026-11-05 在
dshbox 容器里**量的（模板 `dsh-v0.2.2-rc.1`，宿主 runtime），容器跑的是本分支的代码，
但逐条命令没有随读数附上——要复核按 §6 自己写的方法重跑。

**这份文档取代 2026-10-19 那一版**——那一版的版本号、测试计数和工作区状态三条都已过时。
文件名里的 `2026-10` 是**第一次交接的日期，为了链接不断而保留**：别的文档（roadmap 的
目录、README 的文档表）引用的就是这个文件名，改名要连那些链接一起改。

## 0. 三句话状态

1. **WSL 这条线已经全部合进 main 了**（PR #70 与 #71，均 squash-merge）。12 个包的
   `package.json` **仍是 `0.1.16`**，npm `latest` 也是 `0.1.16`，最新 tag `dshell-v0.1.16`
   指向 `b3d72f9`（2026-10-31）。**`0.1.17` 的版本号提升、发布、打 tag 全都还没做。**
2. **门禁全绿**：`vitest` 77 files passed + 1 skipped，**786 tests passed / 44 skipped**；
   `tsc -b tsconfig.host.json` 与 `tsc -b tsconfig.client.json` 均 exit 0。
3. **WSL 这条线现在整条通了，而且已经提交**：exec 门丢 stdout 的洞已修并复量
   （`ProcessCommand` 改成真 duplex，读写两侧分开），`env` 经 `WSLENV` 桥接进 distro，
   文件面板依赖的三条 exec 都答得出内容；shell 门（ConPTY）一直是好的。见 §3 ①。
   修复随 PR #70（exec 门、registry 能力位、黑屏、文档）与 PR #71（0.2.2 窗口）合入 main；
   两边都过了独立审核。

## 1. 现场快照

| 事项 | 读数 | 怎么复核 |
|---|---|---|
| 当前分支 | 本文写作时在 `docs/022-review-polish` 上；`main` 已含 PR #70 与 #71 | `git status -sb`、`git log --oneline -3 main` |
| main | `36f3082`（#71 的合并提交）；本地 `main` 与 `origin/main` 均在此 | `git log --oneline -1 main`、`git log --oneline -1 origin/main` |
| 工作区 | **干净**（本文写作时；修复已全部提交） | `git status --short` |
| 包 | **12 个**，全部 `0.1.16` | `for d in packages/dshell/*/; do node -e "console.log(require('./$d/package.json').version)"; done` |
| npm 上 | `latest` = `0.1.16` | `npm view @nexus-aethra/dshell-bundle dist-tags --registry=https://registry.npmjs.org/` |
| tag | 最新 `dshell-v0.1.16` → `b3d72f9`（2026-10-31）；**0.1.17 线还没有 tag** | `git ls-remote --tags origin 'refs/tags/dshell-v*'` |
| dsh pin | `dsh-v0.2.1-rc.3`（`dsh-upstream.json`） | `cat dsh-upstream.json` |
| dsh 支持窗口 | `>=0.2.1-rc.2 <0.2.3-0`（含 `0.2.2-rc.1`，已在容器里实测） | `node scripts/sync-host-range.mjs --check` |
| 测试 | 77 files passed + 1 skipped / **786 tests passed / 44 skipped** | `pnpm run test` |
| 类型 | 干净（`tsc -b tsconfig.host.json`、`tsc -b tsconfig.client.json` 均 exit 0） | `pnpm run typecheck` |
| 工具链 | **本机 Node 是 `v22.14.0`，而 `package.json` 的 `engines` 要 `>=24.11.0`** | `node -v` |
| WSL 实测机 | Windows + WSL2 `Ubuntu-24.04`（默认）+ 一个 dshbox 容器 distro | `wsl.exe --list --verbose` |

**表里的提交数、HEAD 和测试数都是本文写作那一刻的快照**，不是承诺。合并或再提交之后它们
就会差一点；以右边「怎么复核」那一列的命令为准，别以本文的数字为准。

**Node 版本那条要当真**：门禁是在 v22.14.0 上跑绿的，而 `engines` 要求 `>=24.11.0`。
发布前在一个满足 engines 的 Node 上再跑一遍门禁。

## 2. 已合进 main 的提交是什么

| 提交 | 内容 |
|---|---|
| `6c23504` | WSL2 distro 作为一个内建设备 |
| `fc43e17` | WSL 的 mount 路径留在 Windows 的命名规则里（id 带冒号，Windows 目录名不合法） |
| `c6f63da` | 管理台（一个设置页） |
| `fc0fe7d` | WSL 那一行读起来像一种自己的登录方式（`auth: 'wsl'`） |
| `6c3d2d7` | WSL 卡片 + 图标 |
| `361eb10` | 所有设备共用一套卡片外框 |
| `3d0df4b` | ConPTY 重绘空行的修复 |
| `5c0c79e` | WSL 变成自己的包，藏在一个 device-provider registry 后面 |
| `7d1e953` | **exec 门修复**：duplex 拆分 + `env` 经 `WSLENV` 进 distro + `open` 支持 stdin |
| `86420ed` | **黑屏修复**：shell region 的网格变化时重建，不再追加空 delta |
| `1b4a7af` | **registry 能力位**：`helper` / `reachable` / 逐接缝拒绝语，SSH 包不再提 wsl |
| `6213e7e` | **文档**：roadmap 压缩到 40%、补全缺失 phase；handoff 按当前状态重写；删掉 upgrade-0.1.6 |
| `6589872` | **审核修复**：provider 声明 `helper`/`reachable` 能力位；修掉首帧空白与流式追加失效两处回归 |
| `642025d` | **文档数字快照化**：把提交数 / HEAD / 测试数统一改成「本文写作时」并加注记 |
| `75e0527` | **文档修复**：恢复上一轮文档编辑误删的 H1 与「0.1.17 版本号提升」待办；§2 补回 `6589872` |
（这些都是**已合入**的：PR #70 与 #71 各自 squash 成一个提交 `2069b83` 与 `36f3082`，
所以上面这些 SHA 在 main 上看不到，要看得 `git log` 那两个合并提交的正文。）
这一系的提交。`82e1bf5` 是 origin/main 的尖端，按定义不在这个区间里，所以不列。）

`5c0c79e` 是这批里结构性的那个：WSL 支持原先长在 `dshell-ssh` 里（一个 transport 文件、
device store 里的 WSL 分支、router 里的探测循环、forward 接缝里写死的拒绝语、客户端里的
卡片和 locale），每一条都让 SSH 包背上了它不拥有的词汇。现在 `dshell-ssh` 拥有一个
**device-provider registry**，SSH 包再也不提 `wsl` 这个词。契约见
[`dshell-architecture.md` § 20](./dshell-architecture.md)。

## 3. 没做完 / 要知道的事

### ① WSL 的 exec 门曾经是坏的，已修并复量

**修之前**（2026-11-04，本机 Windows + WSL2 `Ubuntu-24.04`，实测不是推测）：

```
doors.exec(device, 'echo HELLO')    -> { exitCode: 0, stdout: '', stderr: '' }   <- 错
doors.open(device, 'echo VIAOPEN') -> stdout 'VIAOPEN\n'                          <- 对
```

**原因是一条 duplex 背了两个方向。** `packages/dshell/wsl/src/transport.ts` 只造了一个
`PassThrough`，两头都接在子进程上：子进程的 stdout 写**进**这条流，而对这条流的写入又去
喂子进程的 stdin。于是无 stdin 契约里那句 `stream.end()`（关写侧）把**读侧也关了**，
子进程的 stdout 在收集器看到它之前就没了。

**修法就是照 SSH 传输层的形状拆开。** `ProcessCommand` 现在造一个真 `Duplex`：
**写侧是子进程的 stdin，读侧是子进程的 stdout，两侧永不相碰**——关写侧不再关读侧。
`packages/dshell/ssh/src/channel-process.ts` 本来就是三条独立的 `PassThrough`（stdin /
stdout / stderr），两个方向分开接；WSL 传输层现在与它一致。同一个门还补了两件小事：
`DeviceExecOptions.env` 现在会并进 `wsl.exe` 的环境，`openStdin` 为 true 时不再关写侧。
spawn 是可注入的（`WslSpawn`，默认是真的 `wsl.exe`），所以这条契约用假子进程就能证明，
不依赖一台有 WSL 的机器。

**修之后（同一台机器复量）**：

```
doors.exec(device, 'echo HELLO')      -> { exitCode: 0, stdout: 'HELLO\n', stderr: '' }
doors.exec(device, 'echo A; echo B')  -> stdout 'A\nB\n'
doors.exec(device, 'printf xyz')      -> stdout 'xyz'
doors.exec(device, 'echo OUT; echo ERR 1>&2') -> stdout 'OUT\n', stderr 'ERR\n'
router.test 的探针                    -> LAPTOP-65SFEHRB|gpumem|Linux 5.15.167 (microsoft-standard-WSL2)
router.ensureDeviceRoot 的探针        -> /home/gpumem
```

回归测试在 `packages/dshell/wsl/tests/wsl.spec.ts`（exec 门那一组 11 条）：**8 条在修前的代码上
失败、11 条在修后的代码上全过**——剩下 3 条两种形状都过（断言空答案的那条，以及旧形状恰好
能serve 的几条）。

**这个洞原先损失什么**：文件面板的 `resolve()` / `stat()` / `list()` 三条都走 exec 门
（`packages/dshell/ssh/src/remote-fs-shell.ts`），所以那时 WSL 设备上的文件面板什么都看不到；
`router.test` 的探针、`router.ensureDeviceRoot` 的探针同样答空——`8e7a5a3` 加的
`ensureDeviceRoot` 与加载期 provider 探测，对 WSL 实际没生效。现在这几条都答得出内容了。

**容器里复验时又发现并修掉一个洞**：`env` 只在宿主进程侧设置，`wsl.exe` 默认不把 Windows
环境变量转发进 distro，所以远端读不到——`printenv FOO` 空而 `$HOME` 正常就是信号。改用
`WSLENV`（WSL 自己的桥：列在里面的名字会被拷进 distro）携带，宿主原有列表保留。修后
`printenv DSHELL_PROBE` → `passed`。

**一直好着的（同一台机器量到的）**：**shell 门**（ConPTY pty）打进 pty 的标记能回来、
提示符渲染正常、会话干净退出；**设备面板的探测**（走 shell 接缝）真实的进程 / 容器 /
端口行都回来了。

### ② 还没做的（这些是欠着的，不是可以顺手带过的）

- **`0.1.17` 版本号提升**：12 个包的 `package.json` 全是 `0.1.16`。
- **发布**：`pnpm publish`（**不要用 `npm publish`**，见 § 4），按依赖序，`dshell-bundle` 最后。
- **打 tag**：`dshell-v0.1.17` 还不存在；`dshell-v0.1.16` 指向 `b3d72f9`（2026-10-31）。
- **0.2.2 的 surface 读数有了，但 pin 还没移**：`scripts/tests/upstream-surface-any.spec.ts`
  可以指向任意 checkout（`DSH_SURFACE_ROOT=<路径>`），已对 `dsh-v0.2.2-rc.1` 镜像量过：
  services 156 / slots 109 / events 62，dshell 用到的名字一个没少（0.2.1 是 146/103/62）。
  但 `dsh/` 镜像和 `dsh-upstream.json` 的 pin 仍钉在 `dsh-v0.2.1-rc.3`，所以**发布门禁守的
  还是 0.2.1 的面**。把 pin 移过去是剩下的那一半。
- **WSL 的真机验收**：目前只在**一台** Windows + WSL2 机器上量过（Ubuntu-24.04 + 一个
  dshbox 容器 distro）。WSL1 被过滤掉了，没验过；非 Windows 主机上 `wsl.exe` 不存在，
  内建行不出现，也还没在那种机器上跑过。

## 4. 交接纪律（先读这条再看代码）

- **绝不 `git add -A`**；按路径 add。**不直接提交 main**；合 main、发版、打 tag、推分支
  先问人。历史授权只覆盖当时那一个分支，不代表以后可以自己推。
- **发布必须 `pnpm publish`**（`npm publish` 会把 `workspace:` 原样发出去，装的人
  `EUNSUPPORTEDPROTOCOL`；0.1.4 就是这么报废的）。12 个包按依赖序、`dshell-bundle` 最后；
  坏版本撤不掉（token 是 bypass-2FA granular，`npm unpublish` 403），只能 `npm deprecate` +
  改版本号。npm CLI 默认导到 npmmirror（只读），发布/查版本要显式
  `--registry=https://registry.npmjs.org/`。发布细则见
  [`dshell-packages.md` § "The publishing environment"](./dshell-packages.md)。
- **凭据**：npm 发布 token 在 `~/.npmrc.publish`（只有 `NPM_CONFIG_USERCONFIG=$HOME/.npmrc.publish`
  时才生效；默认 `~/.npmrc` 里那枚**已失效**）。真实设备口令不在仓库里、也不要打印内容，
  要用时当场问，用完即弃。别把真实口令写进任何测试 fixture。
- **调试宿主只留一个实例**，临时起的当场收尾。
- 改完就测并把读数读回来（文本/几何/控制台），别拿"门禁绿"当"功能对"。
  **门禁绿也会漏**：`channelOf` 那个 flaky 就是门禁绿着、十次里挂一次——
  判据是"连续跑十次全绿"，不是"跑一次绿"。

## 5. 接手第一步

```sh
cd <repo-root>
git status -sb                 # 应显示与 origin 同步、工作区干净
pnpm i
pnpm run test && pnpm run typecheck     # 期望 786 passed / 44 skipped + 干净
pnpm --filter "@nexus-aethra/dshell-*" run build
```

> 本机 `pnpm` 不在 PATH 上时，用 `node_modules\.bin\vitest.CMD run` 和
> `node_modules\.bin\tsc.CMD -b tsconfig.host.json` / `tsconfig.client.json` 直接跑。

**第一件该做的事是 `0.1.17`**：12 个包的 `package.json` 还全是 `0.1.16`，而 npm `latest`
也是 `0.1.16`——也就是说这条分支上所有的 WSL / 0.2.2 工作，现在都还不在任何已发布的包里。
版本号提升之后按 § 3 ② 的次序走：发布 → tag，每一步都先问人。
**分支模型**（`dshell-setup.md` 写死了这条）：`main` 只放已发布的线，**不直接提交**；
一个开发方向一条分支，走 PR **squash-merge** 进 main，合完删分支。判断"某分支的活是否已进 main"
要**比树**（`git diff --stat origin/main <branch>` 为空即已进），不要看祖先关系——squash 之后
祖先关系必然骗人。

文档索引在 [`docs/README.md`](./README.md)；这批改动的规范在
[`dshell-architecture.md` § 20](./dshell-architecture.md)（device-provider 扩展点）与 § 19
（设备传输层）；包职责在 [`dshell-packages.md`](./dshell-packages.md)。

## 6. 0.2.2-rc.1 适配读数（2026-11-05）

容器 `dsh-022-verify`（模板 `github.com/deepseek-ai/deepseek-harness:dsh-v0.2.2-rc.1`，宿主
runtime，12 个 dshell 包全部 symlink 到本检出）：

| 验什么 | 读数 |
|---|---|
| 插件安装 | 12 个包全部装上（改 range 之前会被拒：`incompatible with dsh 0.2.2-rc.1`） |
| GUI 起来 | 是，console 0 error |
| provider 检测 | `wsl:Ubuntu-24.04` + dshbox distro，`builtin:true` |
| 设备列表 API | 200，两个 WSL 行 |
| 绑定会话 | `bind` 200，mount 落到 `mnt\wsl-Ubuntu-24.04\~` |
| WSL 终端 | `echo DSHELL_022_OK_42` → `42`，Ubuntu 24.04 LTS 欢迎语与系统信息都在 |
| `router.test` | `已连接 gpumem@LAPTOP-65SFEHRB（Linux 5.15.167 (microsoft-standard-WSL2)） · 334ms` |
| 主机密钥信任 | **未出现** `主机密钥 SHA256:…` 行——能力位生效（`wsl.spec.ts` 直接断言 `provider.reachable === false`） |
| helper 部署 | 400 拒绝（provider 自己的话） |
| **surface 检查** | 156 services / 109 slots / 62 events，`missingSurface` 为空 |

门禁：`vitest` 77 files passed + 1 skipped / 786 passed / 44 skipped；两个 `tsc -b` exit 0；
`node scripts/sync-host-range.mjs --check` 全部一致。