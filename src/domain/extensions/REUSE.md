# 扩展工作台来源与边界

行为来源为 `yjh051108/dsh-super-injector`：包审查、临时运行、持久安装、构建产物监视、
脚手架、staging 工具、转正/撤下、整包热换及失败保旧。旧实现依赖私有 registry 和按
目录名子串清缓存的部分未复用；Nexus 使用 `profile:完整包名` 与递增 generation，
精确句柄清理，并把永久安装交给官方 Plugin Manager。

`isolated.ts` 启动独立 Node 子进程；Node permission model 约束文件读写、子进程与原生
插件。仅传入运行所需环境变量，不传入密钥环境。模型/存储等能力经父进程精确 allowlist
RPC 获得。网络策略是否能由该 Node 版本实际强制执行单独报告，不能称为完整 OS 沙箱。
`native-managed` / `compat-managed` 为明确批准的可信同进程运行，不宣称隔离。

源码引用用于适配思路，不包含上游提示词、图标或品牌素材。本实现的新代码遵循主工程许可。
