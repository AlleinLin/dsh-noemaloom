# 异常处理

异常必须有明确去向。适用于抛出异常的代码、Promise 拒绝，以及语言中的显式错误返回；具体语法约束不跨语言机械套用。

## 必须与禁止

- 捕获异常必须保留可引用的错误值。禁止无绑定 catch、空 catch、只有注释的 catch，以及将错误赋给无用途变量或 `void error` 的伪处理。
- 允许的去向：向上传播；转换成保留原因的错误；记录并形成真实失败结果；有明确业务语义的预期错误处理；可追踪的补偿/部分失败集合。
- 预期错误的降级必须有明确判定，例如错误类型或稳定错误码。非预期错误不能一并转成空数组、默认值或成功结果。
- 异常包装必须保留原始原因。优先语言标准能力，例如 JS `cause`、Python `raise ... from error`、Go `%w`；只保留字符串消息不等同于保留错误链。
- 日志由实际承担失败处理责任的边界记录；单纯传播异常的中间层不必重复记录。日志不得包含密码、令牌或原始敏感请求内容。
- 禁止无意义的捕获再原样抛出；不需要转换或处理时允许自然传播。

## 异步错误

- Promise 必须被 `await`、返回给调用方，或接入明确的拒绝处理。
- `void promise` 只表达丢弃值，不证明拒绝已被处理；不能单独作为异步错误规则的豁免依据。
- 有意后台执行的任务必须有错误接收方或明确的已处理 Promise 契约。
- 传入要求同步回调的位置的异步函数，不得让返回的 Promise 无人处理。
- 错误处理器本身失败时，必须仍有错误去向；不得在处理器中制造新的悬空 Promise。

## 正反例

下面是 TS 语义片段，`readCache`、`CacheMissError`、`refreshCache` 和 `reportFailure` 代表应用自己的接口，并非本 skill 提供的函数。

反例：所有故障都伪装为缓存未命中。

```ts
const loadCache = async () => {
  try {
    return await readCache()
  } catch (error) {
    void error
    return undefined
  }
}
```

正例：只把约定的未命中转为缺省值，其他错误保持传播。

```ts
const loadCache = async () => {
  try {
    return await readCache()
  } catch (error) {
    if (error instanceof CacheMissError) {
      return undefined
    }
    throw error
  }
}
```

反例：调用 `void refreshCache()` 不处理拒绝。

合法的后台调用可为 `void refreshCache().catch(reportFailure)`，前提是 `reportFailure` 确实接收该错误、完成失败报告，且自身不会抛出或返回拒绝的 Promise。不能只依据函数名字判断该契约成立。

## 规则检测边界

- 自定义 lint 不能把“catch 子树里出现 throw/log 调用”当成每条失败路径都被处理的证明。
- 嵌套函数中未执行的日志、同名但无关的函数、日志参数不包含原始异常，不能作为可靠的处理证据。
- 通用规则不绑定某个项目的日志函数名；项目专用允许列表必须有清楚的作用域和契约。
- 规则的正反例与限制遵循 [规则测试](custom-rule-tests.md)。
