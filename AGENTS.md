# 交接 · 小事打卡（xiaoshi-checkin）UI 设计交给 Codex

> 生成时间：2026-11-07 22:40。下一个会话（Codex）的职责：**在既有设计体系内做 UI 设计与实现**，不是重新定风格。
> 本文就是这个仓库根目录的 `AGENTS.md`。只写"你需要知道什么"，细节一律指向仓库里的文件，不重复抄。

---

## 一、这个项目是什么

一个给小组用的「每日小事打卡」网页应用。6 人左右的组，负责人设几条带截止时间的小事（早起、日精进、运动），成员到点前打卡（可写文字、传照片），有打卡墙、进度矩阵、周报导出、站内提醒。

| 项 | 值 |
|---|---|
| 本地目录 | `D:\WorkBuddy\小事打卡社区` |
| 仓库 | https://github.com/xchen6964-coder/xiaoshi-checkin （公开，直接推 main） |
| 线上 | https://xiaoshi-checkin.app.workbuddy.host/ （需带分享码，分享码不写进仓库，向项目负责人索取） |
| 当前提交 | `a17c574`（已上线） |
| 技术形态 | **静态站**：原生 HTML/CSS/JS，无框架、无构建、无 npm 依赖 |

线上资源必须带 `?sharecode=` 才能取到，裸路径返回 403（分享链接的访问机制）。

## 二、代码结构（就这四个文件）

| 文件 | 行数 | 作用 |
|---|---|---|
| `app.js` | 2440 | 单文件 IIFE，所有页面渲染 + 全部交互 |
| `styles.css` | 652 | 设计令牌 + 所有组件样式，分区块注释 |
| `index.html` | 44 | 入口，只有骨架和三个 `?v=N` 版本号 |
| `export.js` | 343 | 四种导出（HTML/Word/CSV/Excel）与 .ics 日历 |

外部依赖只在 `vendor/`：云 SDK、docx、xlsx。**不要引入任何新依赖**。

`app.js` 里的页面渲染函数（改 UI 基本只会碰这些）：
`renderToday` / `renderWall` / `renderProgress` / `renderMe` / `renderAdmin` / `renderReport`，弹层统一走 `openSheet`。

## 三、必须遵守的约束（违反会被打回）

### 1. 视觉方向已锁定，不要再定方向

| 界面 | 采用的方案 | 示意图 |
|---|---|---|
| 今日 / 进度 / 我的 / 管理 / 报告 | **B 清爽数据卡片** | `docs/07-风格B-清爽数据卡片.svg` |
| 打卡墙 | **C 便签拼贴** | `docs/08-风格C-便签拼贴墙.svg` |
| 可选皮肤 | **A 纸质手账**（同一套布局，只换令牌） | `docs/06-风格A-纸质手账.svg` |

立场：安静、数据为主、不加装饰。**不要加渐变、玻璃拟态、发光、大圆角胶囊、装饰性插画、动效炫技**。动效只允许两处：弹层上滑 `rise`、按钮按下缩放。

### 2. 颜色只能用令牌，不许写十六进制魔法值

`:root` 里有 29 个令牌，`:root[data-theme="paper"]` 覆盖同样的 29 个 —— **纸质主题就是靠这一层覆盖实现的，所以新样式必须用 `var(--x)`，否则换主题时会露馅**。

```
底色 --bg / 卡片 --card / 描边 --line
正文 --ink / 次级 --muted / 弱化 --faint
品牌 --brand / 品牌文字 --brand-ink / 品牌底 --brand-soft
警示 --warn / --warn-soft / --warn-ink    危险 --danger
圆角 --radius      阴影 --shadow
中性：--soft --tile --track --dot-off --ring-track --tint --tint-line --seg-bg --check-line --bar --bar-has --heat-1..3
```

新颜色先问"有没有现成令牌"，没有就加令牌，**两个主题都要给值**。

**还没令牌化的残留（35 处，可作为第一批活）**：

- `#fff` 17 处（弹层底、勾选圆底、便签点赞底等）—— 纸质主题下应是暖白
- 便签四色 8 处（`#FFE9A8 #3A3220 #D6E8FF #26384D #FFD9D2 #4A2E28 #DCF0D4 #2F4229`）—— **有意保留，便签就是彩纸，不要令牌化**
- 零散 10 处：`.note .like.on` `#E5484D`、`.handover-ask` 边框 `#BFEDE6`、`.detail-table .st.late` `#B45309`、`.note` 纸片投影 `rgba(107,91,69,.12)`、`.btn.ghost.danger` 边框 `#F1C6C8`、`.sw-fresh/.sw-paper`（主题预览色块，故意写死）等

坑：SVG 的 `stroke="#E6EEF7"` 这种属性写法**不解析 var()**，必须写 `style="stroke:var(--ring-track)"`。进度环已经踩过。

### 3. 断点固定三档，别改

```
<1024  手机：单列 max 720 居中，底部 tab
≥1024  两栏：232 左导航(sticky) + 主列 max 780
≥1280  三栏：236 + 主列 760 + 320 右栏
```
`.main` 在桌面必须 `margin:0; width:100%` —— 一旦留 `margin:0 auto`，网格项会退化成内容宽度（曾把 723px 挤成 281px）。
桌面右栏 `<1280` 直接隐藏，不要硬缩主列。

### 4. 所有按钮走 `data-act` + 全局事件委托

不写 `addEventListener`，不写 inline `onclick`（`renderFatal` 里那一处是历史遗留，别学）。
改完必须跑对齐检查，两边数量必须相等（当前 47 / 47）：

```bash
node -e "
const fs=require('fs');const s=fs.readFileSync('app.js','utf8');
const html=new Set([...s.matchAll(/data-act=\"([^\"]+)\"/g)].map(m=>m[1]));
const js=new Set([...s.matchAll(/act === '([^']+)'/g)].map(m=>m[1]));
console.log('未接处理:',[...html].filter(x=>!js.has(x)).join(' ')||'无');
console.log('有处理无按钮:',[...js].filter(x=>!html.has(x)).join(' ')||'无');
"
```
（上面两行命令在 Git Bash / PowerShell 都能跑；用户机器上两个终端都有，给命令时要标明是哪个。）

### 5. 改样式必须升版本号

`index.html` 里 `styles.css?v=16`、`app.js?v=21`（`export.js?v=10`）。**只要改到就 +1**，微信内置浏览器缓存极顽固。

### 6. `[hidden]` 规则不能删

`styles.css` 顶部有 `[hidden]{display:none!important}`。曾经因为 `.sheet-mask` 的 `display:flex` 吃掉 `hidden`，整页蒙灰。

### 7. 不要碰数据层

数据库是云开发 PostgreSQL（10 张表，RLS 全开），前端通过 `cloud.database` 直连。**UI 任务不需要、也不应该动表结构、RLS 策略或 RPC 函数**。
举例：改昵称那条 `users_update` 策略是 `auth_uid = auth.uid()`，只能改自己那行 —— 这类信息 UI 侧看不到，别猜测权限。

## 四、先读这些（不要凭记忆重写）

| 文件 | 内容 |
|---|---|
| `docs/PRD.md` | v0.5.2，29 条决策表（含被推翻的）、十张表、未做清单。**权威需求文档** |
| `styles.css` 顶部 | 令牌表 + 两套主题，改前先看 |
| `docs/07/08/06-风格*.svg` | 三套风格的原始示意图 |
| `docs/12-今日页改稿.svg` | 最近一次 UI 改稿的写法范例（左边 1:1 手机版 + 右边逐条说明） |
| `docs/13-其余四页同源调整.svg` | 逐页改动清单的写法范例 |

## 五、当前 UI 状态（2026-11-07 已上线）

- 今日页：进度环（本人完成度）+ 缺口数字（还差 N 人交齐）+ 与昨日此刻对比 chip；任务行右侧成员点阵（≤8 人，超过退回数字）
- 进度页：矩阵，列头带该项 `x/6`，行末带本人 `x/3`，卡片头是缺口口径
- 打卡墙：便签四色轮换，顶部一行「今天 5/6 人已打卡 · 还差 1 人」
- 我的：四块 KPI（连续天数/总打卡/按时率/本周+较上周）、5 周热力图、外观主题切换、改昵称
- 报告：时间范围 → 四指标 → 模型总结 → 成员/任务条形（带 `done/expected`）→ 明细表 → 四种导出

## 六、验收怎么做（这里没有自动化测试）

```bash
node --check app.js          # 语法
# 再跑第三节第 4 条的 data-act 对齐检查
```

视觉验收靠无头 Chrome 截图。**两个坑必须知道**：

1. 无头 Chrome 的**最小视口是 500**，用 `--window-size=390` 拍出来的图是被裁的假象，不是真溢出。要验 390 真实排版，得在页面里写 `html,body{width:390px}`，再用 512 窗口拍。
2. 静态页面没有登录态，`.side` 右栏不在校样里 —— 桌面三栏的右栏只能线上看。

```bash
# Git Bash 版
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=512,1200 --force-device-scale-factor=2 \
  --screenshot="out.png" "file:///D:/WorkBuddy/小事打卡社区/preview.html"
```

**不建议交给 Codex 做的两件事**：发布上线（要 appId 和账号，由用户与本会话的 agent 执行）、真机验收（只有用户手机能看）。

## 七、用户协作规矩（这部分最容易踩）

1. **动手前先给方案或示意图**，等确认再写代码。用户偏好 SVG 示意图，不喜欢长文字。
2. **主观判断先问**。新增评价性结论、新增比较维度、替用户选定方案，都要先说明动机征得同意。
3. **不说「已完成」，要说怎么验证的**。没验证的明说没验证。
4. **只做被点名的事**。发现范围外的问题，报告并询问，不悄悄修。
5. **给命令必须标明是 Git Bash 还是 PowerShell**（两个终端都有）。
6. 每完成一个功能：`git commit` + `git push origin main`；**发布要单独征得同意**。
7. 用户是科研零基础，术语首次出现补一句白话解释；不要用意象化比喻。

## 八、第一批适合接的活（按性价比排序）

1. **样式收拾**：组件区还有 35 处硬编码色值（清单见第三节），抽成令牌并把 `paper` 主题补齐（机械、量大、风险低）。注意便签四色与主题预览色块是有意写死的，别动。
2. **单页重画**：用户指定一页，先出 1:1 的 SVG 改稿（参照 `docs/12`），确认后落代码
3. **可访问性**：`aria-label`、焦点态、键盘 Tab、对比度
4. **移动端密度**：390 宽下任务行、矩阵、报告的挤压问题（需要真机反馈，先别动）

## 九、访问方式（Codex 当前读不到仓库）

Codex 那边环境被策略禁网（`git clone`/`curl` 都被拦，也没有 GitHub 文件读取工具），所以只有两条路：

1. 在 Codex 里打开本地目录 `D:\WorkBuddy\小事打卡社区`（推荐，读写都方便）
2. 上传桌面重新打的 zip（`小事打卡-仓库-2026-11-07-最终.zip`，不含 `.git`、不含截图，含五个源文件 + PRD + 14 张 SVG + 本文件）

第一种方式下 Codex 打开项目会先读根目录的 `AGENTS.md`（就是本文）。

## 十、建议调用的 skill

| skill | 什么时候用 |
|---|---|
| `sites` / `workbuddy_sites_deploy` | 发布或下线（appId `wbapp_jEnLgK2Qgw4V4yfcJpyUPT`，须用户明确同意） |
| `cloud-service` | 只有真的动数据库时才需要；纯 UI 任务不该触发 |
| `widget_guidelines` + `show_widget` | 给用户出方案时画 SVG 示意图（用户吃这一套） |

---

**一句话定位**：这是一套已经上线、已经锁定视觉方向的小产品。你要做的是在现有令牌与组件体系里把它打磨得更好，而不是重做一遍。
