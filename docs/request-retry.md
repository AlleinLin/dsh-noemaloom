# Model request retry settings

The desktop settings page now includes **模型请求重试**. Select global, workspace,
or a specific native session. Settings use the existing revisioned scope store;
workspace and session overrides inherit live rather than copying a parent.
Child agents read their own session settings and their workspace/global defaults.
Only the connection owner may save or reset these settings.

## Controls

- **Provider policy** is the default. The existing provider policy and native retry
  plugin continue to own the wait and retry decision.
- **Custom** schedules retries at the native `agent/request-error` seam, with one
  durable `llm/retry` event per attempt. The native retry plugin is not also run
  for that decision. Counters survive Nexus reloads and reset with the native
  step or turn boundary.
- **Disabled** stops model request retries for that scope.
- Maximum retries: 0–100, excluding the original request.
- Interval: fixed, linear, or exponential. With initial interval `d`, retry number
  `n` starts from `d`, `d*n`, or `d*multiplier^(n-1)` respectively.
- Initial and maximum intervals: 0–86,400,000 milliseconds. Initial must not
  exceed the effective maximum, including inherited values.
- Exponential multiplier: 1–10. Symmetric jitter ratio: 0–1, capped at the maximum.
- The preview displays the first five intervals before jitter.

An explicit positive provider `Retry-After` overrides the calculated interval.
If it exceeds the configured cap, recovery records `NX_RETRY_DELAY_UNSUPPORTED`;
it does not send earlier than the provider permits. Changes apply to the next
failure decision, not an already scheduled wait.

User cancellation, parent cancellation, disposed agents, permission/quota/budget
denials and unknown operation effects remain authoritative stops. Context
overflow still belongs to the verified compaction recovery path.

## Opaque provider failures

`PI_AI_ERROR` now displays `NX_PROVIDER_FAILURE`, preserving the original code.
It alone does not establish a local bug, network failure or gateway outage.
Custom settings have a separate, default-off switch to retry this opaque provider
failure up to the configured count. Confirmed authorization, request rejection
and effect-uncertainty diagnoses cannot enter that opt-in path.

At provider finish, the original failure is observed before the public message is
replaced. Diagnostics retain only bounded codes, HTTP status, request identity,
trace identity and stack locations. They do not retain prompts, response bodies,
credentials or the original private message, and cannot delay the stream finish.

The session export supplied on 2026-10-22 showed real native rate-limit retries
followed by `PI_AI_ERROR` at turn 1 / step 48, stopped at retry 0 because the
provider allowlist did not contain that code. Its exported attempt already had
only the public Nexus diagnostic. That artifact cannot prove the underlying
provider or transport cause; new diagnostics improve subsequent evidence.
