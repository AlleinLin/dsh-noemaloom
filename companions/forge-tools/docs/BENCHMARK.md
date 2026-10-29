# 可复现基准

环境：Windows_NT 10.0.26200 / x64 / Node v24.19.0，采样时间 2026-10-20T00:08:31.065Z。

Single process, sequential medians; no cold OS cache flushing. Warm tests use watch=false and TTL=30000 ms. Fresh glob can include ripgrep enumeration and a separate Node glob-filter process; fresh grep uses ripgrep. Shell uses actual rc.2 subprocess and PowerShell executors. Simulated delays cover provider resolve/stat/readText/readBytes calls: the baseline uses readText and Forge uses bounded readBytes. Delays do not model individual Windows I/O/filter callbacks.

| 操作 | 中位数 ms | 次数 |
|---|---:|---:|
| provider resolve+stat+read (no plugin cache) | 0.7 | 9 |
| Forge read, warm bounded cache | 0.213 | 9 |
| Forge read fresh=true | 1.228 | 9 |
| Forge expired read, unchanged metadata validation | 0.436 | 9 |
| provider atomic write, 4 KiB | 9.342 | 9 |
| Forge atomic write, 4 KiB, same host durability | 9.323 | 9 |
| glob cold enumeration, 512 files | 133.942 | 9 |
| glob identical warm result, 512 files | 0.588 | 9 |
| grep fresh=true, global 20-match cap | 41.118 | 9 |
| grep identical warm query | 0.548 | 9 |
| pwsh official managed isolated executor | 417.875 | 5 |
| pwsh first resident call | 433.316 | 1 |
| pwsh warm resident call | 5.185 | 9 |

## 高延迟敏感性实验

- 每次 provider resolve/stat/readText/readBytes 人为增加 5ms：基线 readText 45.869ms，Forge 有界 readBytes 路径的热缓存 0.119ms。
- 每次 provider resolve/stat/readText/readBytes 人为增加 20ms：基线 readText 98.573ms，Forge 有界 readBytes 路径的热缓存 0.1ms。

这只是可控延迟实验，不是公司机器、WMI 或安全过滤器的实测。缓存命中减少的是调用次数；首次读取、唯一查询和写入仍要经过系统过滤器。Shell 常驻只在完整访问模式启用。TTL=30000、watch=false 是本次热缓存测量配置，交付默认 TTL=1000、watch=true。

运行：`npm run benchmark`。完整记录见 benchmark.json。
