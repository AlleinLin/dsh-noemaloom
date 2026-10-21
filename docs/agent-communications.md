# 统一代理通信

主代理、普通子代理与 Agent Teams 使用同一任务邮箱。原有 `send_message`、`list_agents`、`wait_agent`、`interrupt_agent` 工具名保留；`target` 和 `agent_id` 均可用。推荐直接使用创建子代理时返回的完整 ID，无需先找“活跃队友”。

地址目录保留闲置的可继续子代理，支持队友名称、唯一任务标签、`parent`、`lead`。重名返回候选 ID，不猜测目标。普通 fork 会话是独立任务；运行时归属和父级持久子目录必须共同授权，不能仅凭 `parentSession` 跨任务发信。

## 接管边界

适配宿主 `0.2.1-rc.2` 的公开 `tools.get`、`tools/change` 与工具 admission guard。插件就地替换原所有者持有的通信定义，包括已有和后续注册的 Team scoped 定义，统一输入 schema、说明、输出 schema、执行与展示。原 registration disposer、scope、工具 allow/deny、Native/PTC policy 仍然生效。没有访问或改写 ToolRuntime 私有 layers，没有先执行旧通信再 fallback。

同样接管 `subagents.sendMessage` 与 `agentTeams.sendMessage` 的旧服务入口。使用 Cordis 公开的 `symbols.original` 获取服务原始身份，并监听 `internal/service` 变更，避免每次取得新 trace proxy 时重复包裹。子代理初始任务与宿主 `subagent-settled` 生命周期通知仍由原管理器提交，避免重复报告、重复创建和改变完成语义。Team 任务板与创建队友功能保留；模型组装时替换原 Team 的“寻找活跃队友”通信说明。

这是对具体宿主版本的兼容 hook，并非上游正式声明的定义修改 API。初次安装遇到不可修改的定义或服务方法（包括自身不可配置且不可写的 `sendMessage`）会同步抛出 `NX_MAIL_HOOK_UNSUPPORTED`，同步恢复此前的属性并撤销监听、guard 与新增工具。不可配置但可写的数据属性可接管，并保留原 descriptor。后续出现不可修改的 scoped 工具由 monotonic guard 拒绝；服务接管失败使已安装的通信 wrapper 拒绝新调用。

接管只作用于已扫描到的定义与当前服务对象。其他代码在安装前缓存的原始函数引用无法撤销；安装失败回滚后，原服务仍保留其原始能力，不能声称所有原始入口已技术封锁。服务后续更换期间或被外部冻结后的恢复，也不提供跨所有调用者的原子保证。卸载是幂等操作，先停止并等待自己的调用，再恢复仍由插件持有的属性并移除注册；若外部后来把 wrapper 冻结为不可恢复，记录恢复失败，留下的 wrapper 继续拒绝新调用。

## 收据与恢复

| 状态 | 含义 |
| --- | --- |
| `queued` | 发件箱已持久接收，尚未送到收件代理 |
| `held` | 用户已停止目标或其根任务；等待用户继续 |
| `unknown` | 投递已开始，但收件方效果未确认，禁止自动重发 |
| `accepted` | 收件代理原生 inbox 已接收 |
| `consumed` | 收件代理已 claim 输入；不代表回复或完成 |
| `discarded` | 收件代理丢弃输入 |
| `failed` | 发件操作确定失败 |

每个发送有稳定 `message_id`。`request_id` 可显式指定，省略时使用当前原生工具调用 ID；同一调用重试复用收据，改变收件人、内容或投递方式会拒绝。`reply_to` 必须关联当前代理收到的原消息。`get_message_status` 通过原生持久 inbox/history 对账，不能因超时重新派代理。

原生 inbox 的移除 splice 在非 canceled 时即为 claim 证据，无须等待后续 `user/message`；canceled 移除表示丢弃，不能单凭它判定是用户停止。只有明确的用户 cancel 或用户中止 turn 记录才设置停止状态。插件把停止标记写入独立的 CAS 控制记录，并在停止时捕获当前事件序号，后续真实用户输入才能释放。正常卸载等待已接受的标记写入；进程崩溃或持久写入失败仍有不可消除的窗口，失败会记录诊断。

运行中的目标在安全步骤接收；闲置目标由原宿主 continuation 管理器唤醒或恢复，保留原模型、权限、工具过滤与真实发送者身份。不可继续的一次性任务、外部执行和未知模式不会伪装恢复。父级暂不可用时保留发件箱；运行时状态或真实用户输入变化触发有限队列检查，没有轮询活跃队友的后台定时器。未知效果不会进入自动重放。

每个任务邮箱最多保留 2048 条消息，每条文本最多 64 KiB；达到上限明确返回 `NX_MAILBOX_FULL`，不会删除未确认消息腾位置。根索引通过持久 CAS 预留容量，因此多个邮箱实例不会各自超额接收。中断的预留也占容量，使用相同 `request_id` 可继续原预留，不能自动释放并重发。旧邮箱仅首次迁移扫描消息正文；正常接收读取轻量索引，分页只读取所选页（最多 100 条）的正文。消息行是状态的最终依据，旧索引不会让 `unknown` 或已处理消息重放。

待执行调用最多 512 个，等待最多 128 个，队列泵最多 32 个，每次检查最多 64 条；停止缓存与事件路由缓存各最多 4096 个身份，事件游标保留最近 512 条。停止缓存溢出时拒绝唤醒并要求重载检查。原生 `sessionQuery.readSession(sessionId)` 仅接受一个参数，底层没有取消接口；插件复用最多 64 个未结束的原生读取，调用方取消、插件卸载或 30 秒观察超时会释放自己的等待，迟到结果不触发投递。`wait_agent` 取消只释放自身。插件重启后重新获取目录游标。

同级代理只能交流，不能停止对方。中断仍须由原生精确祖先权限验证。代理消息保持 `agent-message` 来源，不能冒充用户审批、触发用户意图识别或绕过工具权限。

## 模型示例

```json
{"target":"创建工具返回的完整子代理ID","message":"接口已完成，请按原任务继续","request_id":"api-ready-1"}
```

```json
{"message_id":"send_message返回的message_id"}
```

后一段是 `get_message_status` 参数；只有 `accepted`/`consumed` 能证明收件情况。查看回复使用 `read_agent_messages`，回复时将原消息 ID 放入 `reply_to`。
