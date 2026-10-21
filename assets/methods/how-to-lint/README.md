# how-to-lint

面向 AI 编程助手与开发者的代码检查规则集：约束异常处理、环境配置、代码风格、类型严格程度和路径别名，覆盖 JavaScript / TypeScript、Vue / Nuxt、Python 与 Go。

这是 **rule set，不是执行流程，也不是可直接运行的 lint 工具包**。它不要求安装 hooks、运行部署或执行固定开发步骤；实际诊断由项目中的 ESLint、类型检查器、vet 等工具承担。

## 使用

将仓库克隆到你的助手支持的 skills 目录。例如使用 `~/.agents/skills` 的环境：

```bash
git clone https://github.com/qiudeng7/how-to-lint.git \
  ~/.agents/skills/how-to-lint
```

不使用该目录的助手，应改为自己的 skills 路径。仓库本身只有 Markdown 规则和许可证，无需安装 npm 或 Python 依赖。

提示词示例：

```text
使用 how-to-lint 规则集审阅这段代码，指出不满足的规则和适用例外。
```

也可以在编写代码时直接引用该规则集。入口是 [SKILL.md](SKILL.md)，主题参考包含具体范围、例外和正反例；仅安装这个 skill 不会自动修改或启用项目的检查配置。

## 规则入口

- [通用约束与工具偏好](SKILL.md)：规则效力、强风格概览和主题索引。
- [异常处理](references/error-handling.md)：错误去向、原因保留、异步拒绝与合法降级。
- [环境配置](references/configuration.md)：集中读取、运行时校验与前后端秘密边界。
- [TypeScript / JavaScript](references/typescript.md)：ESLint、强风格、原生 TS 编译器与中等偏上类型严格度。
- [Vue / Nuxt](references/vue-nuxt.md)：SFC、模板类型覆盖和约定 alias。
- [Python](references/python.md)：mypy 中等偏下严格度，不强制全面标注。
- [Go](references/go.md)：vet 优先、错误返回和配置边界。
- [自定义规则测试](references/custom-rule-tests.md)：正反例、例外、parser、类型服务和修复安全性。

## 使用边界

- 明确的项目约定和用户要求优先；其余采用规则集默认值。
- 强风格约束允许框架保留名称、生成代码及外部协议的必要例外，不允许通过宽泛忽略或伪处理掩盖问题。
- Oxfmt 优先负责受支持的格式化范围，Prettier 补充必要兼容；不规定复杂排版偏好。
- Vue 原生 TS 方案必须覆盖模板，不能用只检查普通 TS 的成功结果替代。
- 文档代码片段是规则示例，不是已经执行的测试或完整项目配置。

## 许可证

[MIT](LICENSE) © 2026 qiudeng7。
