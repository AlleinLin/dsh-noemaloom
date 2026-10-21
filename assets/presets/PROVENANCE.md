# 预设来源

完整预设基于 MIT 许可的 DeepSeek Harness 公开 commit `687f282e8625c6b8d11ff58211a90524be2e4317`。
原始声明在 `upstream/*.patch.yml`，宿主配置合同与 provider 源文件亦保留用于继续开发。
独立 persona 描述替代官方 persona 文案；全部 compaction provider 绑定 Nexus。
项目规则适配官方 agent-instructions 0.2.1-rc.2，源码与 MIT 许可在 `vendor/agent-instructions/`。
每目录依次查找 `DEEPSEEK.md → AGENT.md → AGENTS.md → CLAUDE.md`，首个命中即停止，禁用本地 overlay；保留官方预算、嵌套作用域和刷新。
子智能体工具适配官方 tool-subagent 0.2.1-rc.2，源码与许可在 `vendor/tool-subagent/`；按会话授权自动提供可用模型代号，空白 effort 默认所选模型最高支持强度，保留授权与生命周期合同。
生成脚本只读公开源码，不读取本机 profile，也不生成部署恢复备份。

