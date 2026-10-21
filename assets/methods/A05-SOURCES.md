# A05 来源与修改

`how-to-lint/` 来自 qiudeng7/how-to-lint 研究快照，锁定版本 `c6e2b5180917b8fd8952a0338d77c5318856e4a3`；保留完整 MIT LICENSE。正文为按需方法数据，实际 deterministic runner 是 Nexus TypeScript AST/项目原生工具 adapter，不把指南当成已运行检查。

`software-engineering-workflow/` 来自 qiudeng7/software-engineering-workflow 研究快照，保留 MIT LICENSE；复用 issue/PR、technical writing、README、CONTRIBUTING 的技能及示例。其 qiudengs-svg-diagrams 子模块未核实独立授权，因此不复制该子模块任何模板、源码、脚本或文档。八类图由 Nexus 自有等效 typed IR renderer 提供。

`../diagrams/archify/` 直接复用 tt-a1i/archify 的 MIT renderers、generated validators、schemas、locales、migrations、explainer 与 HTML viewer，保留双版权 LICENSE 和 THIRD_PARTY_NOTICES。模板移除嵌入 JetBrains Mono 字体子集，使用系统 fallback；不包含上游截图、示例媒体或独立安装器。adapter 固定输出到插件私有产物目录，经公共 executor 运行 renderer；CSP 和 sandbox 禁止宿主访问、网络、外部字体和 same-origin。未进行视觉复核的结果明确为 not_run。

feng0531/dsh-code-review 为自定义非商业源码公开许可证，禁止无授权的公司内部商业用途。本交付未复制其受限源码；Git/SVN 捕获、两阶段固定快照审查、证据校验、独立角色复核是依据产品规格独立实现。没有声称得到该项目商业授权。

Aegis 的完整 skills 直接复制到 `aegis/`，保留 Jesse Vincent 与 Ganyuan Ran MIT 通知，包括风险分流、根因调试、ADR、反熵、续接和单一 closeout。Superpowers DSH 完整 skills 复制到 `superpowers-dsh/`，上游 MIT 通知与实际包元数据并列，保留 DSH 工具适配文本作为方法数据，不注册旧接口。J-Space 分阶段问题构造与各认知模块由 `j-space/METHODS.md` 提供自有等效方法，不转载受排除第三方思维轨迹引文，保留 Apache 来源边界。统一工作流调度器拥有执行权，quality/artifact 不建立第二调度器。

文件操作撤销只存操作自身的 inverse delta 和 hash，用于产品内冲突保护；本次部署不创建 profile 副本、`.bak`、本机恢复快照或机器配置归档。
