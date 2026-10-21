# Go

## vet 优先

- Go 静态检查优先 `go vet`，常规约束优先使用 vet 已提供的分析能力。
- 必要的项目自定义静态规则优先采用 `go/analysis`，通过 vettool 接入 vet；不默认同时引入多个大型 lint 聚合器。
- 额外分析器只承担具体能力缺口，不把 Staticcheck、errcheck 等设为所有项目的强制依赖。
- vet 不等于全量错误返回检查器，不保证所有 error 已处理，也不自动约束业务配置边界。自定义约束必须有对应实现才能称为自动检查。
- 编译、测试、vet 与格式化是不同职责；Go 格式化采用 gofmt，而非 Oxfmt 或 Prettier。

## 错误返回

- 返回的 error 必须被传播、处理或纳入有明确语义的失败结果；禁止仅为编译通过而用 `_` 丢弃错误。
- 可以不再传播的预期错误必须有具体语义，例如幂等操作中已经不存在的对象；不是所有错误都需要日志。
- 日志由承担失败处理责任的边界记录，返回错误的每一层不必重复记日志。
- 包装错误使用能保留错误链的形式，例如 `fmt.Errorf("load config: %w", err)`；检查错误链使用适当的 `errors.Is` / `errors.As`。
- 不将“函数返回 error”直接等同于“函数内部必须调用日志模块”；这种规则会鼓励重复日志，也无法证明实际错误路径得到处理。
- goroutine 内部的错误必须有接收或处理机制，不能因它无法直接返回给调用者就被丢弃。

## 配置与代码组织

- 环境读取集中在配置包，包括 `os.Getenv`、`os.LookupEnv`、`os.Environ`、`os.ExpandEnv` 以及等价底层访问；业务模块依赖解析后的配置。
- 命令入口、测试适配层可以有明确配置职责，例外不得扩展为任意业务包。
- 类型信息应能识别导入别名，不能仅靠字符串 `os.Getenv` 检测环境读取。
- 采用 Go 原生函数、方法与包组织方式，不移植 JS/TS 函数表达式、kebab-case、undefined 等风格。
- 文件内 Types / Exported API / Internal 分段不是通用强制要求；只有项目明确采用时才成为项目约束。

## 规则正反例

以下是函数体片段，`readConfig`、`fmt` 及外层错误返回签名由应用提供。

```go
// 反例：读取失败未处理。
config, _ := readConfig()

// 正例：保留错误链并传播，由上层决定如何报告。
config, err := readConfig()
if err != nil {
    return fmt.Errorf("load config: %w", err)
}
```

实际代码使用 gofmt。自定义 analyzer 的测试要求见 [规则测试](custom-rule-tests.md)，不以函数体内存在一次日志调用证明每条失败路径都安全。
