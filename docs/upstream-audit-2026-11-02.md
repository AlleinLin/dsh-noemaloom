# 2026-11-02 全来源维护 / R49

153 个来源逐项核对，完整原始观察与决定见同名 JSON。官方 Windows nightly 仍为 rc.5，安装器 SHA512/大小未变；GitHub alpha.2 为另一个候选渠道，本轮不切换用户宿主或混升 SDK。

## 实际更新

- `@linxin666/dsh-client-ui-git-graph`：0.4.12 → **0.4.13**；许可证 Apache-2.0 未变。
- `@linxin666/dsh-client-ui-task-board`：0.4.12 → **0.4.13**；许可证 Apache-2.0 未变。
- `@linxin666/dsh-usage`：0.4.12 → **0.4.13**；许可证 Apache-2.0 未变。
- `@michengai/dsh-agency-agents`：1.2.20 → **1.2.21**；许可证 Apache-2.0 未变。
- `dsh-context`：0.78.2 → **0.79.0**；许可证 Apache-2.0 未变。
- `dsh-mnemon`：0.5.37 → **0.5.38**；许可证 MIT 未变。
- `dsh-mnemon-provider-byterover`：0.5.5 → **0.5.6**；许可证 MIT 未变。
- `dsh-mnemon-source-documents`：0.5.11 → **0.5.12**；许可证 MIT 未变。
- `dsh-mnemon-source-memory-spaces`：0.5.24 → **0.5.25**；许可证 MIT 未变。
- `dsh-mnemon-source-runtime`：0.5.16 → **0.5.17**；许可证 MIT 未变。
- `dsh-mnemon-source-skills`：0.5.4 → **0.5.5**；许可证 MIT 未变。
- `dsh-thoughtdag`：0.5.26 → **0.5.27**；许可证 MIT 未变。

- Cognition 0.9.18 → 0.9.21，含七份公开操作规范；另采纳上游 PR729 的三处 aliases 透传修复，逐文件摘要见 `vendor/memory-cognition/UPSTREAM-FIXES.json`。保留独立可信身份桥，不引入 Git HEAD 的扫描用户会话功能。
- ACP kernel 0.0.169 → 0.0.176，来源为 **0.1.211 包内 build-info 指定的源码提交**，不是无关的移动 HEAD。npm 包只含打包产物；不能把“未列出 kernel/ 目录”当成实现未更新。完整树三方合并，三个冲突保留两侧语义；新共享投影中的覆盖/用户锚点也通过本地有界索引查询。
- dshell 0.1.15 → 0.1.16，完整保留上游源码。包含会话切换时终端状态/重试修复、15 秒握手边界和会话所属的 SSH 端口转发；Windows PowerShell、PTY 沙箱、固定根目录显式授权等适配继续在独立 adapter 中应用。
- Context、Agency、ThoughtDAG 的精确编译锚点及 SHA/AST 断言已重定位；仍然失配即失败。Agency remote 生成元数据跟随实际包版本，不再残留 1.2.14。

## 参考来源与不可达渠道

Veyra 的 discovery/types/redact 三个实际复用模块在 0.1.54 与 0.1.64 间逐字节相同；j-space 新版本仅组合与说明变更，已复用素材无改动。dsh-web 仓库变化与三个已发布运行组件分别审查，未发布的 remote/web 服务不自动移植。Superpowers、Ponytail、OpenSpec 和 Karpathy 真正上游分别记录，经典宿主 hooks 不安装到 Desktop。OpenViking/Hindsight 只跟踪服务器变化，实际 DSH 适配器保持其已发布版本。

DSH-agent-procedures 归档没有远程地址；archify npm 404；Karpathy Git 需要认证，npm 版本可查且未变。j-space 的连接 reset 和 usage-stats 的 TLS 错误已重试恢复，HEAD 与前次记录相同。不可达不等于无更新。

Forge 维持独立可选 0.1.6，无独立可核实上游；按原包复用，保留用户启用选择。历史桌面和性能收据不代替本轮验证。

## 验证与交付边界

统一回归、Python 原始回归、SSH 真实本地运输、Forge 独立审计以及独立官方桌面合成 profile 的**实际结果**在 `release-r49-verification.json/.md` 中记录，包括失败、修复和未覆盖事项。R40 压缩、缓存、持久重试链、范围隔离、UTC、冻结、延时发送及原步骤恢复均在回归范围中。

不热安装正在使用的 DSH，不终止真实代理，不改写会话数据库。本轮包的本机安装状态必须明确为未安装。
