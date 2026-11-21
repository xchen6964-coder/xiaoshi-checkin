# 交接 · 小事打卡「加载慢 / 打不开」排查与优化

> 生成时间：2026-11-21 14:20。给人接手性能问题用。
> 项目根目录的 `AGENTS.md` 是总览，本文只聚焦**性能与可用性**。先读完本文再动手。

---

## 一、一句话现状

功能都通了，但**首屏要 3–4 秒、弱网下会卡在登录页**。瓶颈不在前端代码体积（已 gzip），主要在**每个 API 请求都要重新握手一次到新加坡的 TLS**，以及**平台 Edge 那一层的额外一跳**。

## 二、基本盘

| 项 | 值 |
|---|---|
| 本地目录 | `D:\WorkBuddy\小事打卡社区` |
| 仓库 | https://github.com/xchen6964-coder/xiaoshi-checkin （直接推 main） |
| 线上 | https://xiaoshi-checkin.app.workbuddy.host/?sharecode=UWJWMDUQ2R |
| 后端 | Supabase 项目 `mtkuieogemgpdvacphhs`（**Singapore**） |
| 形态 | Node 单端口服务 `server.js`：静态文件 + `/sb/*` 反代到 Supabase |
| 发布 | `workbuddy_sites_deploy`，appId `wbapp_jEnLgK2Qgw4V4yfcJpyUPT`，**发布必须用户同意** |

## 三、请求链路

```
手机浏览器
   │  HTTPS（带 ?sharecode 换来的 __wb_rsc cookie）
   ▼
平台 Edge ── 1) 校验 sharecode cookie，没 cookie 直接返回「链接不完整」HTML
   │        2) 会改写 Authorization 头（见第五节坑 1）
   ▼
server.js（单进程 Node，无依赖）
   ├─ /            静态文件 + 同步 gzip（内存缓存）
   └─ /sb/*        https.request 转发到 Singapore（**每次新建连接，没有 keepAlive**）
   ▼
Supabase（PostgREST / GoTrue / Storage）
```

**一次 API 往返 ≈ 1 秒**（下节实测），而首屏至少要 2 次（`my_context` + `loadAll` 的一批查询）。

## 四、实测数据（2026-11-21 14:20，从一台网络正常的机器测）

| 请求 | TLS 握手 | TTFB | 总耗时 | 体积 |
|---|---|---|---|---|
| `/`（index.html） | 0.22s | 0.42s | 0.42s | 1 KB |
| `/app.js`（gzip 后） | 0.23s | 0.60s | 0.64s | 35 KB |
| `/sb/auth/v1/health`（一次空往返） | 0.18s | **1.08s** | 1.08s | 101 B |

首屏脚本合计（gzip 后）：`vendor/supabase.js` 56 KB + `app.js` 35 KB + `styles.css` 9.7 KB + `cloud-adapter.js` + `config.js` + `export.js` ≈ **110 KB**。
`docx.umd.js`(742 KB) 与 `xlsx.full.min.js`(881 KB) **已经是按需加载**（`loadLib()` 只在导出时插 script），不要动它们。

## 五、四个已知坑（动了会坏，不是可选项）

1. **`Authorization` 会被平台 Edge 改写。**
   实测：同一秒签发的 JWT 回传后，GoTrue 自己都报 `signature invalid`，PostgREST 报 `PGRST301 No suitable key`。
   现解：前端把 token 放进自定义头 `x-sb-auth`（`vendor/cloud-adapter.js` 的 `wrappedFetch`），`server.js` 转发前还原成 `Authorization`。**别把它"简化"掉。**
2. **转发前必须删 `Accept-Encoding`。**
   PostgREST 的 JSON 是 gzip 的，Node 只透传不解压；若删了 `content-encoding` 还传 gzip 字节，浏览器拿到乱码（曾经踩过，表现为"接口返回一堆乱码"）。
3. **`/sb/*` 必须有 `__wb_rsc` cookie 才通。**
   裸访问 `/sb/...` 返回 403 的「链接不完整」HTML。所以任何 curl 断言都要先 `curl -c cookie "https://…/?sharecode=…"` 拿一次 cookie。
4. **不能再退回纯静态托管。**
   国内移动网络直连 `*.supabase.co` 不通（手机报 `Failed to fetch`）。`server.js` 就是为此存在的。

## 六、慢/打不开的候选原因（按可能性排序，附判定方法）

| # | 原因 | 怎么判定 | 属于谁 |
|---|---|---|---|
| 1 | **反代没有连接复用**：每个 `/sb` 请求都新建 TLS 到新加坡，白付 2 个 RTT | 看 `server.js` 里 `https.request` 未传 `agent`；对照第四节 1.08s 的空往返 | 可改，见第七节 A |
| 2 | **免费项目休眠**：Supabase 免费版连续 7 天无请求会 pause，冷启动 10s+ | 在 Supabase 控制台看项目状态是否 `Paused/Restoring`；或直接访问 `/sb/auth/v1/health` 若第一次 20s、第二次 1s，就是它 | 用户点一下恢复；或每天有人用就不会发生 |
| 3 | **手机网络本身差** | 用户截图状态栏曾出现 14 KB/s | 不是代码问题，但前端可以更抗弱网（第七节 C） |
| 4 | **启动是串行的**：`boot → getSession → enterApp → my_context → loadAll`，前一步不回就干等 | 看 `app.js` 的 `boot()` / `enterApp()` / `loadAll()` | 可改，见第七节 B |
| 5 | **微信内置浏览器缓存旧脚本** | 报「连不上服务器，检查一下网络再刷新」且换系统浏览器就好 | 已用 `cache-control: no-store` 缓解（`server.js`） |
| 6 | **平台 Edge 自身慢** | 同一台机器 `curl /` 若 TTFB 就 >1s，是 Edge 而非我们的代码 | 不可控，只能减小请求数 |
| 7 | **首屏脚本解压慢（低端机）** | 无 | 可选：拆包/预压缩 |

## 七、建议的优化清单（按性价比）

**A. 反代连接复用（收益最大，改动最小）**
`server.js` 里加一个共享 `https.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 30000 })`，传给 `https.request`。
预期：省掉每次握手，`/sb` 往返从 ~1.0s 降到 ~0.6–0.7s；首屏 2–3 次往返累计省 0.5–1s。
注意：`maxSockets` 别开太大（Supabase 免费版有连接数限制），32 够 9 个人用。

**B. 首屏少等一轮**
现在是 `boot` 里先 `getSession()`（本地，快），再 `enterApp()` 里等 `my_context`，然后 `loadAll()` 并发 5 个查询。
可优化：`my_context` 与 `loadAll` 的第一批查询**并行发出**（`my_context` 不带 group 时忽略结果），或在 `my_context` 里直接带上 tasks/members/今日打卡，把 2 轮变 1 轮。后者要改 SQL 函数（`sql/03-functions.sql`），改完**必须让用户在 SQL Editor 重跑**。

**C. 弱网兜底**
- `boot` 的 10s 超时改成"先渲染骨架，后台重试"，避免白屏 10 秒
- 图片加 `loading="lazy"`（打卡墙一屏多张时）
- 列表缩略图已经很小（400px / ~18 KB），不要回退到原图

**D. 静态资源**
- 已 gzip + `no-store`；如果还嫌慢，可以在构建期预生成 `.gz` 文件（省掉每次 `gzipSync`，但内存缓存已够用）
- 不要引入打包器（项目刻意保持"无构建"）

**E. 不要做的**
- 不要为了"看起来快"把照片改成 CSS 缩放（省不了字节）
- 不要去掉 `/sb` 反代改直连
- 不要动 `x-sb-auth` 那套

## 八、验收怎么做

```bash
npm i                                      # 只装测试用的两个包（站点本身无构建）
node sql/verify.mjs                        # 23 项 表结构与约束
node sql/verify-rls.mjs                    # 25 项 行级权限
node sql/verify-fn.mjs                     # 48 项 函数 + cron
chrome --headless --dump-dom tests/adapter-test.html    # 17 项 适配层契约
node --check app.js && node --check server.js
```

**端到端（推荐，改完必跑）**：`.workbuddy/tmp/cdp-login-test.mjs`
用 CDP 驱动无头 Chrome 打线上站点，跑完 注册 → 登录 → 建组 → 今日页，并截图。它能同时验证反代、鉴权、RLS、函数四层。

**性能断言**（改完前后各测一次，对比第四节）：

```bash
# Git Bash / PowerShell 通用
curl -s -o /dev/null -c ck.txt "https://xiaoshi-checkin.app.workbuddy.host/?sharecode=UWJWMDUQ2R"
curl -s -o /dev/null -b ck.txt -w "ttfb=%{time_starttransfer}s total=%{time_total}s\n" \
  "https://xiaoshi-checkin.app.workbuddy.host/sb/auth/v1/health"
```

**改前端必须做的三件事**：升 `index.html` 里的 `?v=N`、跑 `data-act` 对齐检查（当前 55/55）、`node --check`。

## 九、文件地图（只列和性能相关的）

| 文件 | 关注点 |
|---|---|
| `server.js` | 静态服务、gzip、`/sb` 反代、`x-sb-auth` 还原、私有路径屏蔽 |
| `app.js` | `boot()` `enterApp()` `loadAll()` `refresh()` 的调用顺序；`compressImage`/`thumbBlob` 照片链路 |
| `vendor/cloud-adapter.js` | `wrappedFetch`（搬 token）、`createSignedUrls`（改写签名地址） |
| `config.js` | `supabaseUrl` 取 `location.origin + '/sb'`；`file://` 时退回直连 |
| `sql/03-functions.sql` | 16+1 个函数；**改完必须让用户在 SQL Editor 重跑** |

## 十、协作约束（和 AGENTS.md 一致，重申三条容易踩的）

1. 动手前先给方案或示意图（用户偏好 SVG），等确认再写代码。
2. 不说"已完成"，要说"怎么验证的"；没验证的明说。
3. 发布要单独征得用户同意，`workbuddy_sites_deploy` 不要擅自调用。
