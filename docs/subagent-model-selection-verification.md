# 子代理模型切换修复与本机验收

目标：官方 Desktop `0.2.1-rc.5`，插件 `dsh-noemaloom@0.4.1`。

修复两个实际阻断：

- Codinput 请求原先使用不存在的 `session` 领域及 `model.select` 动作，未通过真实能力路由。改为已注册的 `agents` / `session/model.select`。
- 原生子代理在停止后可能只保留持久会话，模型选择不能要求 Agent 仍在内存。冷会话通过正式 `sessionPersistence.open(..., 'write')` 单写者句柄追加 `model/selection`，flush 后释放；存活会话使用正式 Session 追加及 flush。操作不创建 Agent、不恢复收件箱、不发送消息。后续原生恢复时，在 `agent/created` 阶段从本会话自己的选择事件恢复请求钩子，保留原生父子关系与组合策略。

选择失败时在输入栏显示错误；成功后立即更新名称。同一会话连续选择按顺序保存；跨提供方且未指定思考强度时使用目标提供方默认值。

## 已完成验证

- 新增真实 RPC 路由回归，修复前重现“此领域动作未注册”。
- 新增已释放子会话回归，修复前重现 `SESSION_NOT_LIVE`；修复后验证正式追加、flush、句柄释放，以及插件重建后请求装配仍采用新模型，不调用 `agents.resume`。
- `node --import tsx --test tests/session-model-selection.test.ts tests/codinput-adaptation.test.mjs`：10 项通过。
- 相邻压缩绑定测试的模拟 Agent 补齐正式 `session.header` 字段；原模拟只有 id/ctx，新增生命周期监听使这个缺失被 CI 检出。
- `npm run typecheck`、`npm run build`、`npm run pack:delivery` 通过，依赖审计 0 漏洞。
- 在用户实际 Desktop profile 安装，关键文件摘要全部匹配。
- 在实际打开的历史子代理页面点击 `hjmclaude` 下的 `claude-opus-5-5`，名称由 `Claude Opus 5.5` 变为 `claude-opus-5-5`，没有选择错误。
- 正常退出再启动 Desktop，原子代理页面仍显示 `claude-opus-5-5`，证明不是只修改前端临时状态。

本机验收期间主、子会话均已停止；未发送 prompt，也未触发用户项目执行。没有对正在执行的代理强制终止、恢复或修改会话存储文件。

## 覆盖边界

本机没有向用户配置的提供方发起计费模型请求。请求提供方、模型及思考强度的装配通过回归测试验证；真实提供方认证与生成留给用户正常继续时确认。此修复没有重新执行整个上游同步审查。

已安装包：

`dsh-noemaloom-0.4.1-3a01b1fb346f0ef55b3437923ffffbf19851e71bf1d73a04ec691afbd914cbcc.tgz`

SHA256：`3a01b1fb346f0ef55b3437923ffffbf19851e71bf1d73a04ec691afbd914cbcc`。
