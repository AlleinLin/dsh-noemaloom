# 资源与市场复用说明

`skills.ts` 的来源排序、元数据语义和目录约定参考
`zhu1090093659/dsh-web` 的 `packages/dsh-skill-explorer`；
`index.ts` 的 W 市场下载计划、路径校验、暂存提交及来源记录参考其
`packages/dsh-market/src/core/installer.ts`。以上子包声明 BSD-3-Clause，
完整条款保存在 `LICENSE.dsh-web-resources`。Nexus 改造使用统一文件 CAS、
存储与执行端口，不写 DSH profile，不复制本机恢复备份。

`market-catalog.ts` 来自 `kingOfSoySauce/dsh-skin-market/data/catalog.json`，
其项目 MIT 条款见 `LICENSE.skin-market`。目录保留源许可、素材说明、
固定版本、上游检查与统计快照；上游的“验证”字段不代表 Nexus 实测通过。

安装包 `assets/market/{skins,pets,plugins,presets}.json` 来自上述 dsh-web
仓库 `market/dist/manifest`，根项目 Apache-2.0 条款另保留在
`assets/market/LICENSE.dsh-web`，仅作离线索引；不把列表项目的图片、字体、
角色形象及其他素材许可解释为插件代码许可。实际下载后保留该资产的
LICENSE/NOTICE、完整文件 SHA-256、目录 Hash、来源域与下载时间。
目录中没有报告的下载数、安装数、喜欢数及许可均保持未知。

K 皮肤和插件安装交给宿主官方 Plugin Manager；W 资产安装到插件自己的
数据目录，安装与启用分开。下载失败不留下半成品，已有目标默认拒绝
覆盖。预设保持惰性，必须由正式预设声明接口通过检查后启用。
