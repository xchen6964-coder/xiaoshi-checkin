# sql 执行顺序

全部脚本都是幂等的（`create or replace` / `if not exists` / 先 drop 再 create），**重跑安全**。

| 顺序 | 文件 | 作用 | 什么时候要重跑 |
|---|---|---|---|
| 1 | `01-schema.sql` | 10 张表、5 个枚举、索引与约束 | 表结构变了（新增列等） |
| 2 | `02-rls.sql` | 显式授权 + 行级权限策略 | 权限规则改了 |
| 3 | `03-functions.sql` | 16 个业务函数（前端 rpc 调用的全部入口） | **函数逻辑改了就要重跑**，否则库里还是旧版本 |
| 4 | `04-storage.sql` | 照片桶 `shared` + storage 策略 | 桶或照片权限改了 |
| 5 | `05-autoconfirm.sql` | 注册即确认（触发器 + 回填） | 控制台 Confirm email 又变回开启时 |
| 6 | `06-cron.sql` | pg_cron 每分钟跑提醒 | 定时任务丢了或改了频率 |
| 7 | `07-retention.sql` | 90 天前的照片自动清理（Vault 存 service key + pg_net 调 Storage） | 想改保留天数，或清理任务被删 |

`07` 有额外前置：先把 service key 存进 Vault（只需一次）

```sql
select vault.create_secret('你的 sb_secret_… 或 service_role JWT', 'service_role_key', '清理 90 天前照片用');
```

存完把编辑器内容清掉。函数从 Vault 读，密钥不会出现在任何表字段里。

## 本地验证

```bash
npm i                      # 只装测试用的两个包，站点本身没有构建
node sql/verify.mjs        # 23 项：表结构与约束
node sql/verify-rls.mjs    # 25 项：四种身份的行级权限
node sql/verify-fn.mjs     # 44 项：16 个函数 + 定时任务分支
```

这三套跑在 WASM 版 PostgreSQL 上，不需要装数据库。适配层的契约测试用无头 Chrome：

```bash
chrome --headless --dump-dom tests/adapter-test.html
```

## 改动函数后最容易忘的一步

`03-functions.sql` 是「代码」，改了本仓库却不重跑，线上库不会跟着变。
症状举例：cron 日志里 `ERROR: not_authenticated`，说明库里还是旧版 `enqueue_due_reminders`。
