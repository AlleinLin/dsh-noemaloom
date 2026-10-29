# 2026-10-29 上游维护（R41）

逐项检查原有151项来源，并新增本地原创Forge companion，合计152项。
更新14个已发布npm插件；Cognition 0.9.16、ACP kernel 0.0.169、
memsearch 0.4.23、Codinput 0.3.6按固定来源重基。
Forge 0.1.5同步引擎、SDK、官方standard组合、安装器和AI说明至rc.3，
保留宿主文件/沙箱/观察版本守卫与进程生命周期。

当前交付继续面向Desktop 0.2.1-rc.3。已观察到0.2.2-alpha.2发布候选；
boot、session、preset及compaction边界已有变化，不能把该alpha自动当成
R40子代理压缩接缝已验收的宿主，也不能逐包混升SDK或改动正在使用的宿主。
React保持与宿主共享19.2；其他跨主版本工具链候选逐项记录并保留固定契约。

原始Superpowers、OpenSpec、Karpathy及DSH移植均纳入检查。
Ponytail原始hook的两项变更与DSH移植包分别记录；未把经典Claude hook
作为DSH入口直接加载。未复制受限code-review或外部AGPL服务器。
Karpathy Git不可达、Archify npm404和无远程地址的用户归档均不算“无更新”。
GitHub compare返回300文件时明确记录截断；实际kernel重基使用完整Git对象。

本批验证结果及未覆盖边界见[release-r41-verification.json](release-r41-verification.json)。
不得借用R39/R40的收据宣称本批通过；没有改动用户profile、代理或会话数据库。
