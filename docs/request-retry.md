# Model request retry settings

Desktop settings include **模型请求重试** for global, workspace and native
session scopes. Children use their own session settings and inherit workspace
and global defaults. Only the connection owner can change this policy.

## Default and eligibility

The default is **64 retries**, excluding the original request, with exponential
backoff: 500 ms initially, multiplier 2, a 30-second algorithm cap and 10%
symmetric jitter. The cap includes jitter.

Every failed model request is eligible, including `PI_AI_ERROR`, `UNKNOWN`,
unattributed adapter aborts, network, gateway, HTTP rejection and internal errors.
Classification preserves the actual diagnosis; retrying an opaque failure does
not claim that it was a network failure. The old `retryOpaqueProviderErrors`
setting is still accepted for compatibility but no longer excludes PI failures.

Explicit user/parent/hook cancellation remains authoritative and interrupts
backoff immediately. An already aborted native run is never resurrected.
Only actual native signals/lifecycle events establish cancellation; a provider's
`ABORTED`, `CANCELLED`, `DELETED` or `DISPOSED` error code alone cannot do so.
Session deletion, agent disposal and plugin unload release recovery waits.
Explicitly disabling retries or setting the budget to zero is respected.

## Controls

- **Automatic/custom** owns the retry count, interval algorithm and timing.
- **Provider timing** (`inherit`) uses provider initial/max delay and jitter with
  exponential multiplier 2. Missing timing hints use the defaults above. It
  still uses the scoped retry count and accepts all error codes; the provider
  allowlist or smaller retry count cannot veto it.
- **Disabled** stops recovery for this scope.
- Maximum retries: 0–100.
- Algorithm: fixed, linear or exponential. Retry `n` starts at `d`, `d*n`,
  or `d*multiplier^(n-1)`, capped at the configured maximum.
- Initial/max interval: 0–86,400,000 ms; initial must not exceed the effective
  maximum. Multiplier: 1–10. Jitter: 0–1.

A positive provider `Retry-After` takes precedence, including when it exceeds
the algorithm cap. Long waits are split below Node's timer limit and remain
cancellable; they are not converted into immediate 1 ms timers.

Changes apply at the next failure decision. An already scheduled wait retains
its policy. If settings cannot be read, recovery uses the last known policy
(including a known disabled policy), or the default 64 retries on first use.
The read failure is recorded separately.

## Native execution and context recovery

One recovery owner schedules native `llm/retry` and `llm/retry-started` events.
It returns the official same-turn/same-step retry decision. It never appends a
synthetic “continue” user message. The native retry plugin is not also invoked.
Durable counters survive Nexus reloads and reset at native step/turn boundaries.
No completed tool is dispatched again.

Stream iteration exceptions before a terminal response become released failure
chunks, so they reach the same recovery seam. PI/transport cleanup failures
after an already complete successful response preserve that response instead
of resending its tool calls.

Context overflow shares the retry budget but retries **compaction recovery**,
not the unchanged oversized model request. Only the live compactor's verified
formal replacement and smaller measured context authorize a model resend.
Busy, unavailable and failed recovery stages back off until the same budget is
exhausted. Pending operations reconcile original receipts before further work.
The former independent two-overflow limit does not apply to managed recovery.

Automatic maintenance failures before streaming enter the same recovery seam
and repeat only the maintenance stage. The request waterfall continuation is
called once; replaying that one-shot continuation could skip admission hooks.

Every actual model attempt still passes the existing permission and budget
admission checks. Retry policy grants no additional access, spending allowance
or permission to replay an operation with unknown effects. If durable session
state cannot accept or verify a retry record, recovery reports that exact
storage failure instead of authorizing an unrecorded model request.

## Diagnostics

Retry events expose attempt number, budget and countdown in the native UI.
Exhaustion records `retry-exhausted` with the final count. The original code,
phase, bounded HTTP/request identifiers and trace identity remain available.
Diagnostics never persist raw provider bodies, credentials or prompt text.

The supplied R33-era session showed `PI_AI_ERROR` stopping at retry 0 because
the provider allowlist excluded it. Some middleware throws also bypassed the
native request-error seam. R34 addresses both paths. Those old exports do not
prove the original upstream cause; this policy recovers failed requests without
inventing such a cause.

## 订阅窗口冻结与定时唤醒（rc.5）

“模型请求重试”设置同时出现在全局设置、工作区/会话设置和代理任务洞察面板。会话级值覆盖工作区级值，主代理和子代理各自读取正在执行会话的有效范围。

“订阅限额冻结时长（小时）”只作用于订阅窗口、额度不足和限流类失败，取配置值与宿主 `Retry-After` 中较大的等待时间。填 `0` 时保持普通退避和宿主提示。等待结束后仍由 DSH 的 `agent/request-error` 同一步边界返回 `{ kind: 'retry' }`，不会合成用户消息，也不会重放已经完成的工具调用。

rc.5 宿主提供 Schedule 服务时，冻结等待会额外登记一个一次性宿主定时唤醒。唤醒标记在进入模型前由插件消费，实际重试仍沿用同一个 `llm/retry` 链；进程计时器继续作为兜底。宿主重启后，公开 Agent API 不能重新打开已经结束的 turn，因此遗留唤醒只会被清理并保留 `llm/retry` 审计记录，不会伪造输入或自动重放未知请求。委派子代理的 Session 被 DSH Schedule 明确拒绝绑定时，也会安全回退进程计时器。

诊断面板会显示冻结小时数、预计重试时间以及使用的唤醒方式。取消请求、父代理取消、会话删除或插件卸载都会取消等待并删除已登记的宿主任务。

冻结时长范围为 0–168 小时，可输入小数（如 5 或 5.5）；默认 0，不改变原有重试间隔。此设置不会重置服务商额度，也不能唤醒已关闭的电脑。DSH 关闭期间不能恢复原来的在途请求。
