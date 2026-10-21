# TypeScript / JavaScript

## ESLint

- JS/TS lint 优先 ESLint；Oxlint 不作为默认方案。
- 现代配置优先使用 flat config；TS 语法由 typescript-eslint 支持，Vue 语法按 [Vue / Nuxt](vue-nuxt.md) 处理。
- 通用推荐规则提供基线，项目约束通过明确规则补充；不盲目启用所有 strict、stylistic 或第三方插件规则。
- 类型感知规则与独立类型检查职责不同；ESLint 的解析器或类型服务兼容性不等于原生 TS CLI 的兼容性。
- 正确性、异常去向、配置边界和明确的强风格约束以 error 为目标。下面明确列为 warn 的偏好不冒充阻断错误。

## 强风格规则

| 约束 | 级别与典型映射 | 例外与含义 |
| --- | --- | --- |
| 严格相等 | error；`eqeqeq: always` | 不使用隐式类型转换比较 |
| 禁止 var，优先 const | error；`no-var`、`prefer-const` | 确实重新赋值的局部绑定使用 let |
| 禁止 debugger | error；`no-debugger` | 不保留调试断点语句 |
| 分支、循环带花括号 | error；`curly: all` | 单条语句也适用 |
| 普通函数用表达式 | error；`func-style: expression` | 类/对象方法、重载声明、环境声明及框架要求的声明形式不机械改写 |
| 每函数最多 30 条语句 | error；`max-statements: 30` | 不是 30 行；生成代码排除，拆分应形成真实职责 |
| 文件名 kebab-case | error；可由 Unicorn filename-case 实现 | 框架保留文件名、文件路由、约定组件名为窄例外 |
| 独立类型导入 | error；`@typescript-eslint/consistent-type-imports`，`prefer: type-imports`、`fixStyle: separate-type-imports` | 运行时实际需要的类或值保留值导入；装饰器元数据等按运行时需求处理 |
| 避免 namespace | error；`@typescript-eslint/no-namespace` | 类型声明文件、模块扩展等必要声明合并允许限定例外 |
| 内部缺省值不用 null | error；可由 Unicorn no-null 实现 | 外部 API、数据库、DOM、框架要求的 null 保留在必要边界；不得改变协议语义 |
| Node 内置模块带 node: | error；可由 Unicorn prefer-node-protocol 实现 | 不把用户包名误认成内置模块 |
| 禁止重复/自身导入 | error；import 插件或等价规则 | TS 类型和值导入按解析器及规则合并方式协调，不要求为去重破坏独立 import type |
| Date.now() | error；可由 Unicorn prefer-date-now 实现 | 替代仅为获取当前毫秒而创建 Date 的写法 |
| 数组类型使用 T[] | warn；`@typescript-eslint/array-type` | 复杂类型括号与 readonly 类型保持语义 |
| ts-expect-error 优于 ts-ignore | warn；`@typescript-eslint/ban-ts-comment` 的针对性配置 | 抑制必须有具体原因，不能广泛隐藏类型错误 |
| 显式 any | warn；`@typescript-eslint/no-explicit-any` | 边界适配可局部说明；不全面禁止，也不为消除 warning 滥用断言 |

表中插件名称是规则映射，不是强制安装清单；相同规则不由多个插件重复负责。路径别名应与构建、类型检查和测试解析一致；禁止以别名绕过包的公共接口。循环依赖不得按未解析的导入字符串草率判断，类型依赖和运行时依赖应区分。

函数表达式不意味着“禁止 class”：框架依赖注入、装饰器和真正需要实例状态的 class 可以保留。无意义的空包装 class 不受鼓励。

## 原生类型检查：中等偏上

- 优先 Go 实现的 TypeScript 编译器。编译器实现由依赖版本决定，不仅由命令名决定；不能把 `tsgo` 永久当作唯一入口，也不能把所有 `tsc` 都视为 JS 实现。
- 中等偏上基线：`strict: true`、`noUncheckedIndexedAccess: true`、`noImplicitReturns: true`、`noFallthroughCasesInSwitch: true`。
- `exactOptionalPropertyTypes` 不默认开启；项目可按可选字段语义进一步收紧。
- `strict` 含隐式 any 和空值检查，但不禁止所有显式 any。外部输入优先用 unknown 配合缩窄或运行时校验。
- 公共接口、外部数据边界的类型必须清楚；内部实现优先合理推断，不要求每个局部变量重复注解。
- 未使用变量由 ESLint 或编译器明确负责，避免重复诊断；catch 的异常变量不能通过下划线前缀逃避异常处理要求。
- 编译器目标、模块解析、框架生成类型和项目引用必须匹配真实运行环境；不把统一 module/target 模板强加给所有项目。
- 构建成功或代码转译成功不等于完成类型检查。针对不支持的能力允许限定兼容回退，但不能静默缩小受检范围。

## 异步与格式化

- 类型感知 `no-floating-promises`、`no-misused-promises` 以 error 为目标；相关类型服务必须实际可用。
- `no-floating-promises` 的豁免策略不得仅凭 `void` 就认定拒绝已处理；后台任务契约以 [异常处理](error-handling.md) 为准。
- Oxfmt 优先负责其支持的文件；Prettier 仅补充必要范围或兼容需求。ESLint 不承担与 formatter 重叠的分号、引号、缩进等排版检查。
- 强风格中的函数表达式、语句数量、文件名和 null 语义不是排版，不能因 formatter 已运行而省略。

## 正反例

```ts
// 反例：隐式比较、var、无花括号、函数声明。
function isReady(value: unknown) {
  var ready = value == true
  if (ready) return true
  return false
}

// 正例：仅演示表达式函数与严格比较，类型直接表达需求。
const isReady = (value: boolean): boolean => value === true
```

不应为强行套用上例而改变业务输入类型；需要接受未知输入的边界仍应负责校验和缩窄。
