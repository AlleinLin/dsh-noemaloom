# Python

## mypy：中等偏下严格度

- 类型检查使用 mypy，不默认启用整体 `strict`。
- 必须检查已有注解中的类型不一致，也检查未标注函数体中可识别的问题；`check_untyped_defs` 为 true。
- 不强制所有函数、装饰器、泛型或局部变量拥有完整注解。公共接口、核心数据结构和外部输入边界优先明确类型，内部允许逐步补充。
- 允许 Any 存在，不默认开启全面的 `disallow_any_*`、`disallow_untyped_defs` 或 `disallow_untyped_calls`。
- 空值与普通类型应区分，不通过关闭 strict optional 行为隐藏 None 相关问题。
- 第三方库没有类型信息时，例外限定到具体模块；不全局设置 `ignore_missing_imports = true`，避免无意丢失所有依赖类型信息。
- 类型错误的局部抑制必须有具体原因，优先附带错误码；未注解代码仍可能因 Any 传播而缺乏检查，不能声称与全量严格标注等价。

下面是配置片段，不是安装或运行流程；项目原有 mypy 配置项应与它合并，而不是重复定义同名表。

```toml
[tool.mypy]
strict = false
check_untyped_defs = true
disallow_untyped_defs = false
disallow_untyped_calls = false
warn_unused_ignores = true
ignore_missing_imports = false
```

该基线不强制 `warn_return_any`，也不要求为消除每一处 Any 写复杂的抽象类型。

## 异常与环境配置

- 遵循 [异常处理](error-handling.md)：异常需要绑定和真实处理，禁止 `except ...: pass`、假处理以及把未知错误伪装成成功。
- 有预期错误时捕获具体异常；广泛捕获 `Exception` 只适用于有明确处理责任的边界。不能随意吞掉退出、中断或取消信号。
- 包装异常应保留原因，例如 `raise DomainError(...) from error`；清理资源优先使用上下文管理或 `finally`，不是依靠捕获后忽略错误。
- `os.getenv`、`os.environ` 等读取属于配置边界；settings 类或配置 provider 是合法实现，不强制单文件配置。
- 环境变量的字符串必须经过实际解析和校验；mypy 不能替代运行时配置检查。

## 语言范围

- JS/TS 的函数表达式、kebab-case 源文件名、`undefined`、30 条语句等语法风格不机械套用到 Python。
- Python 按语言与项目约定使用 `def`、snake_case 和 `None`。
- mypy 是类型检查器，不是格式化器或完整源码 linter。本规则集不指定 Python formatter；沿用项目明确约定，不以 Oxfmt 或 Prettier 代替 Python 工具。

## 正反例

以下片段假设 `ReadError`、`ConfigError` 和 `read_settings` 是应用定义的接口。

```python
# 反例：读取失败伪装成有效空配置。
try:
    settings = read_settings()
except ReadError:
    settings = {}

# 正例：配置入口转换错误并保留原因，不在中间层重复记日志。
try:
    settings = read_settings()
except ReadError as error:
    raise ConfigError("Cannot load settings") from error
```

如果空配置本来就是产品定义的合法降级，必须由具体错误条件和显式契约支撑，而不是为满足 lint 临时增加默认值。
