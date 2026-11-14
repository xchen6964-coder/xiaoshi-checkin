# AGENTS.md · 小事打卡（xiaoshi-checkin）

> 最后刷新：2026-11-14 20:00。**这一天项目换了后端**：从 WorkBuddy 托管云迁到自己的 Supabase，并加了同源反代解决国内访问。
> 本文只写"接手的人必须知道什么"，细节指向仓库里的文件。

---

## 一、这是什么

给一个熟人小组用的每日小事打卡网页。负责人设几条带截止时间的小事，成员到点前打卡（文字 + 照片），有打卡墙、进度矩阵、成员页、周报导出、站内提醒。

| 项 | 值 |
|---|---|
| 本地目录 | `D:\WorkBuddy\小事打卡社区` |
| 仓库 | https://github.com/xchen6964-coder/xiaoshi-checkin （公开，直接推 main） |
| 线上 | https://xiaoshi-checkin.app.workbuddy.host/?sharecode=UWJWMDUQ2R |
| App ID | `wbapp_jEnLgK2Qgw4V4yfcJpyUPT`（发布走 `workbuddy_sites_deploy`） |
| 后端 | 自己的 Supabase 项目 `mtkuieogemgpdvacphhs`（Singapore） |
| 形态 | **Node 单端口服务**：静态文件 + `/sb/*` 反代到 Supabase，无 npm 运行时依赖 |

线上必须带 `?sharecode=` 打开一次（平台据此种 cookie），之后同源请求才放行；裸域名返回「链接不完整」。

## 二、为什么有 server.js（不能退回纯静态）

Supabase 域名在国内移动网络经常连不上（手机登录报 `Failed to fetch`），而小组成员不可能都有代理。所以浏览器只跟本站说话，由服务器转发。

```
浏览器 ──> https://xiaoshi-checkin.app.workbuddy.host
              ├─ /            静态文件（自己 gzip）
              └─ /sb/*        ──> https://mtkuieogemgpdvacphhs.supabase.co/*
```

**两个必须保留的细节，动了就坏**：

1. **`Authorization` 会被平台 Edge 改写**。实测：同一秒签发的 JWT 回传后连 GoTrue 自己都报 `signature invalid`，PostgREST 报 `PGRST301`。所以前端把 token 放进 `x-sb-auth` 头（`vendor/cloud-adapter.js` 的 wrapped fetch），`server.js` 再还原成 `Authorization` 转发。
2. **转发前删掉 `Accept-Encoding`**。PostgREST 的 JSON 是 gzip 的，Node 只透传不解压；若删了 `content-encoding` 又传 gzip 字节，浏览器拿到乱码。

静态资源由 `server.js` 自己 gzip（`zlib.gzipSync` + 内存缓存）：`supabase.js` 220KB→56KB、`app.js` 145KB→36KB。手机流量慢时这一步很关键。

## 三、代码结构

| 文件 | 作用 |
|---|---|
| `index.html` | 入口骨架 + 五个脚本的版本号 |
| `app.js` | 单文件 IIFE，所有页面渲染 + 交互（约 2900 行） |
| `styles.css` | 设计令牌 + 组件样式 |
| `export.js` | 四种导出（HTML/Word/CSV/Excel）与 .ics |
| `server.js` | 单端口服务：静态 + gzip + `/sb/*` 反代（**部署入口**） |
| `config.js` | `supabaseUrl`（同源 `/sb`）+ `supabaseKey`（publishable，公开值） |
| `vendor/supabase.js` | supabase-js UMD 构建 |
| `vendor/cloud-adapter.js` | 把 `database/storage/auth` 转成 Supabase，**app.js 几百处调用因此不用改** |
| `sql/01~06*.sql` | 建表 / 权限 / 16 个函数 / 存储桶 / 注册确认 / 定时提醒，顺序见 `sql/README.md` |
| `sql/verify*.mjs` | 本地 WASM PostgreSQL 跑的三套测试（92 项） |
| `tests/adapter-test.html` | 适配层契约测试（假 supabase 客户端，17 项） |
| `package.json` | **只为测试**声明 devDependencies，站点本身没有构建 |

## 四、必须遵守的约束

### 1. 视觉方向已锁定（未变）

| 界面 | 方案 | 示意图 |
|---|---|---|
| 今日 / 进度 / 我的 / 管理 / 报告 | B 清爽数据卡片 | `docs/07-*` |
| 打卡墙 | C 便签拼贴 | `docs/08-*` |
| 可选皮肤 | A 纸质手账（只换令牌） | `docs/06-*` |

不加渐变、玻璃拟态、发光、装饰插画、动效炫技。动效只允许弹层 `rise` 与按钮按下缩放。颜色只走 `:root` 令牌，两个主题都要给值。

### 2. 所有按钮走 `data-act` + 全局事件委托

不写 `addEventListener` 绑页面元素、不写 inline onclick。改完必须跑对齐检查，两边数量必须相等（当前 55 / 55）：

```bash
node -e "
const fs=require('fs');const s=fs.readFileSync('app.js','utf8');
const html=new Set([...s.matchAll(/data-act=\"([^\"]+)\"/g)].map(m=>m[1]));
const js=new Set([...s.matchAll(/act === '([^']+)'/g)].map(m=>m[1]));
console.log('未接处理:',[...html].filter(x=>!js.has(x)).join(' ')||'无');
console.log('有处理无按钮:',[...js].filter(x=>!html.has(x)).join(' ')||'无');
"
```

### 3. 改了就要升版本号

`index.html` 里每个脚本都带 `?v=N`，改到哪个就 +1。手机浏览器缓存极顽固，不升版本号等于没改。

### 4. `[hidden]` 规则不能删

`styles.css` 顶部 `[hidden]{display:none!important}`。曾因 `.sheet-mask` 的 `display:flex` 吃掉 `hidden`，整页蒙灰。

### 5. 数据层：改了函数必须重跑 SQL

表结构、权限策略、16 个函数都在 `sql/`。**改 `03-functions.sql` 不重跑，线上库不会变**，症状是 cron 日志里 `ERROR: not_authenticated` 之类。执行顺序与重跑时机见 `sql/README.md`。

权限分三层，缺一层就漏：表级 grant（新表默认全锁）→ 列级 grant（`update` 按列给，否则成员能自封站长）→ 行级策略（10 张表全开 RLS）。

### 6. 不要把这些写进前端

`sb_secret_…` / `service_role` key、数据库密码。前端只用 publishable key，权限由 RLS 决定。

## 五、验收怎么做

```bash
npm i                        # 只装测试用的两个包
node sql/verify.mjs          # 23 项 表结构与约束
node sql/verify-rls.mjs      # 25 项 四种身份的行级权限
node sql/verify-fn.mjs       # 44 项 16 个函数 + cron 分支
chrome --headless --dump-dom tests/adapter-test.html   # 17 项 适配层契约
node --check app.js && node --check server.js
```

三套 SQL 测试跑在 WASM 版 PostgreSQL（PGlite）上，不用装数据库；用 `create role anon/authenticated` + `request.jwt.claims` 模拟身份。

**视觉验收**用无头 Chrome 截图。三个坑：

1. 无头 Chrome 最小视口 500，`--window-size=390` 拍出来是被裁的假象；要验 390 真排版，页面里写 `html,body{width:390px}` 再用 512 窗口拍。
2. 无头实例会缓存旧文件，**先用 CDP `Network.setCacheDisabled` + `Page.reload{ignoreCache:true}`**，否则会把"改了没生效"和"缓存了旧文件"混为一谈。
3. 线上要带 `?sharecode=` 并拿到 cookie 才能访问 `/sb/*`；curl 断言前先 `curl -c cookie` 访问一次首页。

**端到端**：`.workbuddy/tmp/cdp-login-test.mjs` 用 CDP 驱动无头 Chrome 打线上站点，跑完 注册→登录→建组→今日页。改完登录或数据层建议跑一次。

## 六、用户协作规矩

1. 动手前先给方案或示意图，等确认再写代码。用户偏好 SVG 示意图，不喜欢长文字。
2. 主观判断先问。新增评价性结论、新增比较维度、替用户选定方案，都要先说明动机。
3. 不说「已完成」，要说怎么验证的。没验证的明说没验证。
4. 只做被点名的事；发现范围外的问题，报告并询问。
5. 给命令必须标明 Git Bash 还是 PowerShell（两个终端都有）。
6. 每完成一个功能：`git commit` + `git push origin main`；**发布要单独征得同意**。
7. 用户非技术背景，术语首次出现补一句白话解释；不要用意象化比喻。

## 七、还没做的

| 事 | 说明 |
|---|---|
| 90 天照片清理 | 删 storage 里的文件需要 service key，不能只删数据库行。1 GB 免费额度按现在用量够 8–10 个月，不急 |
| 老照片补缩略图 | 不做回填，等它们被清理 |
| 手机端排版微调 | 390 宽下的挤压，需要真机反馈 |

## 八、历史决定（别推翻）

- 2026-11-07：视觉方向锁定 B/C + A 皮肤，不再重新定风格。
- 2026-11-09：教师角色（`teacher`）与教师码分离；教师不打卡、不计统计、不能当负责人。
- 2026-11-09：负责人可多个；站长指定是累加，负责人交接是移交。
- 2026-11-14：**不续费 WorkBuddy 云，迁到自有 Supabase**；旧数据不要（完整记录见 `.workbuddy/memory/2026-11-14.md`）。
- 2026-11-14：登录改邮箱 + 密码自助注册（无验证码、无手机号），注册即确认靠 `sql/05`。
- 2026-11-14：照片 1280/0.72 + 单独存 400px 缩略图，列表只用缩略图。
- 2026-11-14：加 `server.js` 同源反代，因为国内直连 supabase 不通。
