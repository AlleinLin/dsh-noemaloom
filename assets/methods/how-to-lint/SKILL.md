---
name: how-to-lint
description: 编写、修改或审阅代码及 lint 配置时使用的规则集。规定异常处理、环境配置集中化、强风格与路径别名，以及 ESLint、原生 TypeScript、mypy、go vet 和 Oxfmt 的工具偏好与严格程度。包含 Vue/Nuxt 约束和自定义规则正反例要求；不是执行流程或自动化工具。
---

# How to Lint

代码、检查配置和自定义检查器应满足以下规则。这是一份 rule set，不规定开发步骤、安装动作、提交流程或 CI/hooks 策略。

## 规则效力

- “必须 / 禁止”是适用范围内的约束；“优先”是默认选择，允许具体兼容需求下的替代方案。
- 用户明确要求和项目明确约定优先于本规则集的默认值。未规定之处采用本规则集；冲突不得被悄悄解释成已经符合。
- 例外必须限定到具体语法、文件或依赖边界，并有可解释的原因；不得通过全局关闭检查、扩大忽略目录或伪造处理逻辑规避规则。
- 生成代码、第三方源码不承担手写代码风格约束；其中的安全或运行问题不能仅因被忽略就视为已解决。

## 工具偏好

| 范围 | 默认选择 |
| --- | --- |
| JavaScript / TypeScript lint | ESLint；Oxlint 不作为默认替代 |
| TypeScript 类型检查 | Go 实现的 TypeScript 编译器；严格程度中等偏上 |
| Vue / Nuxt 类型检查 | 优先原生 TS 后端的兼容方案，覆盖 SFC 脚本、模板及框架生成类型 |
| Python 类型检查 | mypy；严格程度中等偏下 |
| Go 静态检查与自定义约束 | 优先 go vet 及可接入 vet 的 analyzer |
| JS/TS 等格式化 | Oxfmt 优先；不支持的文件或具体兼容需求由 Prettier 补充 |
| Go 格式化 | gofmt |

格式化以速度和一致性为主。分号、引号、尾逗号、缩进和换行由 formatter 负责，沿用项目配置；没有配置时优先工具默认，不叠加与 formatter 冲突的 ESLint 排版规则。同一文件类型只有一个格式化责任工具。Oxfmt/Prettier 不承担 Python 或 Go 源码格式化。

## 通用代码约束

### 异常与配置

- 异常必须被处理、传播或记录为可追踪的失败结果；禁止空 catch、伪处理和无明确错误去向的异步调用。
- 错误处理不得丢失原始原因，不要求每一层重复记日志。
- 环境读取、解析、校验集中在配置边界；业务代码使用解析后的配置，不直接读取环境变量。
- 客户端配置与服务端秘密分离；类型断言不能替代运行时配置校验。

### 代码结构与导入

- JS/TS 使用严格相等，禁止 `var`、遗留 `debugger`，不变绑定使用 `const`；分支和循环必须带花括号。
- JS/TS 普通函数采用表达式风格，每函数最多 30 条语句；这是语句数而非物理行数。不得无意义拆分或把语句挤到一行来规避限制。
- 手写 JS/TS 文件采用 kebab-case；框架保留名称、文件路由和约定组件名允许窄例外。
- TS 类型导入使用独立 `import type`，避免 namespace；业务内部缺省值优先 `undefined`，不得为了禁 `null` 改变外部协议语义。
- 禁止重复导入和自身导入；Node 内置模块使用 `node:` 前缀。
- 应用内部导入优先使用项目约定的路径别名，Nuxt 尤其如此；别名不得绕过模块公共接口或前后端边界。

强风格的准确范围、级别和例外以 [TypeScript / JavaScript](references/typescript.md) 为准，不将 JS/TS 写法机械套到 Python 或 Go。

## 主题规则

| 适用主题 | 规则正文 |
| --- | --- |
| 异常、日志、Promise 与合法降级 | [异常处理](references/error-handling.md) |
| 环境变量、配置校验与秘密边界 | [环境配置](references/configuration.md) |
| ESLint、强风格、原生 TS 与中等偏上类型约束 | [TypeScript / JavaScript](references/typescript.md) |
| SFC、模板、Nuxt 生成类型与 alias | [Vue / Nuxt](references/vue-nuxt.md) |
| mypy 的中等偏下类型约束 | [Python](references/python.md) |
| vet、错误返回与环境访问 | [Go](references/go.md) |
| 自定义规则的正例、反例和检测边界 | [规则测试](references/custom-rule-tests.md) |

上述参考是对应主题的规范，不是顺序执行的步骤。正反例用于解释规则，不表示本仓库已经提供或执行了这些检查器。
