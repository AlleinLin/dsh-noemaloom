# A07 源码组合记录

本模块使用一个 NexusServices 存储、执行器和认证 RPC。未创建 Desktop profile 副本、恢复快照或 `.bak`。资源源码和随包目录属于交付材料。

| 上游 | 固定提交 | 选用内容 | 本次变更 | 许可 |
| --- | --- | --- | --- | --- |
| Ychris12138/dsh-usage-stats | `f22d415f2ff042b57601a1445df329dcfec5653b` | `lib/accounts.js`、`balance.js`、`subscriptions.js` 的全部 13 适配器 | 接宿主 secret；默认禁用读取 OpenCode 本地 auth；精确 origin+地址授权；禁止隐式合成 DNS 放行；共享唯一 attempt 账本 | MIT；正文在 `src/adapters/models/accounts/LICENSE` |
| omdsh-dev/DSH-better-sidebar | `83faf70940160e5cd4c5332f5400aa8f4dbbb6d6` | 完整 `src/text-encoding.ts` | 由 Nexus 受限文件域调用，保留 UTF/BOM/GBK/GB18030 和换行往返 | MIT；正文在 `src/domain/files/LICENSE.better-sidebar` |
| tianmingwan/dsh-balanced-search | `7c7f5ce441f99c412ef88072b12984d6efa1fd38` | `providers.py` 三源端点、字段、时间范围和轮转语义 | 改为同宿主 TypeScript 服务；DNS 固定、响应预算、取消、截止、独立 circuit、凭据引用、缓存与规范化错误 | MIT；正文在 `src/adapters/search/LICENSE.balanced-search` |
| zhu1090093659/dsh-web | `1acaf870ab554a5edd67a20d60e00c07da943f3d` | remote-bridge 的 `crypto.ts`、`pairing.ts`、`envelope.ts`；SSH config Include 解析和远程 frame/设备生命周期设计 | ES256/P256 原生 `/ios/v1` 与独立 Web `/nexus/web/v1`；复用同一会话/任务/资源/用量服务；撤销关闭连接；配对码不持久化 | Apache-2.0；正文在 `remote/LICENSE.dsh-web` |

Git/SSH/SFTP/集群/转发代码由本工程实现，外部网络与模型服务不会从浏览器读取真实账号密钥。SSH 使用 ssh2 协议库；其依赖通知由交付脚本合并。

资源市场、皮肤目录与技能实现的细节见 `../resources/REUSE.md`。所有列出的运行测试尚须在统一验证阶段执行；源码存在或命令返回零不能替代 Desktop 功能证据。
