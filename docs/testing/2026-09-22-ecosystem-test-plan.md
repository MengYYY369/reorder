# 生态测试计划 — 插件群 + 店面（2026-09-22）

> 范围：`D:/Projects/medusa`、`medusa_epay`、`medusa_gmpay`、`medusa_webhooks`、
> `medusa-better-auth`、`medusa-paypal`、`reorder` + 店面 `medusa-saas`。
> 本文件是**测试分层与闸门的权威**；缺陷裁决仍以
> `docs/plugins/2026-09-21-source-fix-spec.md`（决策 N/R/Q）与
> `docs/plugins/2026-09-21-plugin-issues-for-source-repos.md`（源头清单 §3/§4）为准。

---

## 0. 这套搭配现在的实际状态

| 仓库 | 角色 | 本地版本 | 宿主实装 | 工具链 | 零依赖能跑? |
|---|---|---|---|---|---|
| `medusa` | Medusa 核心上游克隆（参考读物，无本地补丁） | root `private` | — | yarn3 + turbo | 不参与发布，不作测试对象 |
| `medusa_epay` | 支付 provider `@mengyyy369/medusa-payment-epay` | 1.0.5 | **1.0.5**（声明 `^1.0.2`） | pnpm + vitest | ✅（进程内 mock 网关） |
| `medusa_gmpay` | 支付 provider gmpay | 1.0.6 | **1.0.6**（声明 `^1.0.5`） | vitest | ✅ |
| `medusa_webhooks` | 出站 webhook 模块 | 1.3.1（未发布） | **1.3.0** | `bun test` | ✅ 但需要 bun |
| `medusa-better-auth` | 认证 provider/插件 | 0.2.1 | **0.2.1** | jest（单测）+ jest 集成 + dotnet xUnit | ✅ 单测 |
| `medusa-paypal` | 支付 + 订阅 provider | **0.5.0** | **0.4.0**（vendor 副本） | jest 单测 | ✅ |
| `reorder` | 订阅/续费/催缴/挽留/兑换 | 1.5.0（22 个未提交改动） | **1.5.0**（vendor 副本） | jest 集成 + playwright | 部分（见 §2） |
| `medusa-saas` | 宿主（backend + Next 店面） | pnpm10 + turbo | — | backend jest / storefront vitest | ✅ |

### 八个部件怎么接起来的

一条订阅从下单到续费的完整链路要穿过六层，任何一层掉链子整条链就断：

```
店面 (Next 15 :8000)
  └─ Medusa backend (:9000)
       ├─ better-auth    登录/注册/换 JWT，写 ba_* 表 + auth_identity
       ├─ epay / gmpay   CN 一次性支付（GET /epay/notify、POST /gmpay/notify）
       ├─ paypal         US 支付 + 原生订阅（renewal 订单在这里造）
       ├─ webhooks       出站投递到店主自建接收器
       └─ reorder         订阅行 / 续费周期 / 催缴 / 挽留 / 兑换
            └─ saas-bridge  把 reorder 事件转发给宿主（x-bridge-secret）
```

**四个必须记账的搭配问题**

1. **宿主跑的是 vendor 副本，不是被发布的代码。**
   `apps/backend/package.json` 用 `workspace:*` 引 paypal/reorder，
   `apps/backend/vendor/@mengyyy369/**` 里分别是 **0.4.0 / 1.5.0**，而 paypal 源码仓已是
   **0.5.0（含金额单位迁移）**。更糟：backend jest 同时设了
   `roots: ["<rootDir>/src"]` 与 `modulePathIgnorePatterns: [... "<rootDir>/vendor/"]`
   （`apps/backend/jest.config.js:17-18`），vendor 里那 **21 个 spec 永不运行**
   → 线上真正在跑的代码目前 **零测试**。
2. **mikro-orm peer 三方不一致**：paypal 钉 `6.4.3`（`medusa-paypal/package.json`
   peerDependencies），webhooks 钉 `6.4.16`，而 Medusa 2.20 内嵌 `6.6.14`。
   源头清单 MP-5 / spec 决策 12 要求迁到 6.6.14，**尚未落地**。
   `@medusajs/*` peer 也不齐：paypal/reorder/epay/gmpay/better-auth 写 `2.20.0` 或
   `^2.20.0`，webhooks 写 `^2.20.1`（宿主 override 强制 2.20.0，等于该 peer 永远不满足）。
3. **medusa-paypal 0.5.0 与数据迁移是一对强耦合**：代码已按"元"存，
   `scripts/money-minor-to-major.sql` **未在库上执行**。只部署代码 = 对老数据按元读数、
   按分收款（反向 100 倍）。发布闸门必须含"同一窗口内跑 SQL"（详见 paypal 工单 08 遗留 0）。
4. **`logto` 本地 0.3.0 vs 宿主 0.2.1**、`webhooks` 本地 1.3.1 未发布 vs 宿主 1.3.0：
   任何"我在本地修好了"的结论都要先回答"宿主装的是哪个版本"。

---

## 1. 分层闸门

规则：**下一层只在上一层全绿时才值得跑**；每层给出"绿"的可执行定义。

### L0 静态 + 单元（不需要 DB / 网络）

| 仓库 | 命令 | 今天实测 |
|---|---|---|
| medusa-paypal | `npm test` | ✅ **92/92**，4 suites（dtc 镜像验收时跑过） |
| medusa_epay/packages/epay | `pnpm test`（root `test` 会转发） | 未跑（本机） |
| medusa_gmpay | `npm test` + `npm run typecheck` | 未跑 |
| medusa_webhooks | `bun test` | 未跑（本机无 bun） |
| medusa-better-auth | `pnpm test` | 未跑 |
| reorder | `yarn test:integration:modules`、`yarn test:i18n` | 未跑 |
| medusa-saas | `pnpm test`（turbo→backend jest + storefront vitest） | 未跑 |

**L0 绿定义**：以上每条命令在干净 checkout 上退出码 0，且 §4 里"永不运行"的
测试文件（G1/G2/G3）先被纳入或被删除——不允许"文件存在但没人跑"。

### L1 模块/HTTP 集成（需要 Postgres）

| 套件 | 命令 | DB 来源 | 现状 |
|---|---|---|---|
| reorder http | `yarn test:integration:http` | `reorder/.env` 的 `DATABASE_URL`，**仓内无 compose** | 需外部 PG；本机曾成功跑过（容器里残留 `medusa-*-integration-1` 库即为证据） |
| reorder modules | `yarn test:integration:modules` | 不需要 DB | 可跑 |
| better-auth integration | `pnpm test:integration` | `integration-tests/docker-compose.yml`（宿主口 5433） | 可跑，CI 里也在跑 |

**L1 绿定义**：把"外部 PG"写死成一条命令——给 reorder 补
`docker-compose.test.yml`（或 `reorder/.env.test` 默认 5433），并让
`test:integration:http` 在缺库时**明确报错**而不是超时。

### L2 后台端到端（Playwright，目前唯一宿主 = `reorder/e2e`）

`yarn test:e2e` → `playwright.config.ts`：`seed` → `setup` → `chromium`，
`workers: 1`、`fullyParallel: false`、`retries: 0`。
`ADMIN_BASE_URL` 默认 `http://localhost:9000`。今天从 **17 条 → 42 条**（§7）。

**L2 绿定义（按顺序，任一条不满足就整层不算绿）**
1. 存在一个"装了本仓插件、admin 能用邮箱密码登录"的宿主（当前阻塞，见 G4）。
2. `--list` 收集到 42 条且新文件 `tsc --strict` 干净（✅ 今天已达成，见 §7）。
3. `yarn test:e2e` 全绿，且每条**改了状态**的用例都断言了服务端效果
   （DB 或 admin API），不是只看 toast。

### L3 跨插件端到端（店面对真后台）

今天 **0 覆盖**。必须覆盖的最小集：

| 场景 | 断言 |
|---|---|
| 邮箱注册 → better-auth 会话 → 店面 `/#/login` 保持登录 | `/auth/session` 之后浏览器真的拿到 cookie |
| 一次性购买 + 勾选自动续费 → 建 `manual` 订阅 | 结账后订阅行存在、`mechanism=manual` |
| PayPal 订阅支付（native）→ 镜像行 | 镜像行 `mechanism=native`，续费引擎跳过它 |
| **两轨互斥闸门**（reorder 工单 12） | active/paused 挡单返回 400 且报文点名商品；past_due/cancelled 放行 |
| 换订阅（决策 19，revise） | 同一 `native_subscription_id` 原地改套餐/频率，不产生第二行 |
| webhook 回环 | 宿主事件 → `medusa_webhooks` 投递 → 本地接收器 HMAC 校验通过 |
| 金额三向对齐 | 店面展示价 = 后台价 = 网关请求 `value`（迁移后按元；零小数币种单独一条） |
| epay/gmpay 回调 | 沙箱回调 → `payment_session` 状态 → 订单落库 |

### L4 迁移与发布

* `scripts/money-minor-to-major.sql`：dry-run（`BEGIN…ROLLBACK`）→ 断言行数与
  金额守恒 → 正式执行；**与 paypal 0.5.0 同窗口**。
* 发布顺序：paypal 0.5.0（提交→tag→`npm publish`→`npm view`）→ 宿主装 →
  reorder 1.6.0。GitHub Packages 不可重发，先提交再发。
* 发完按源头清单 §3 删 vendor 补丁、§4 跑回归（11 条，含"结账闸门两态""金额三向对齐"
  "写侧也要挡 native""`pnpm why react` 单副本"）。

---

## 2. 每仓可跑性实测结论（今天的取证方式）

* `reorder/jest.config.js` 只有三个 `TEST_TYPE` 分支：
  `integration-tests/http/*.spec.[jt]s`、`src/modules/*/__tests__/**/*.spec.[jt]s`、
  `src/admin/i18n/__tests__/**/*.spec.[jt]s`。
  → `src/workflows/__tests__/{cancel-subscription,pause-subscription,update-subscription-shipping-address}.spec.ts`
  **不匹配任何 testMatch，永不运行**；且 reorder **没有裸 `test` 脚本**，
  `TEST_TYPE` 未设时 `config.testMatch` 干脆是 undefined。
* 本机 `which psql` → 不存在。`reorder/e2e` 的种子层依赖 psql（见 G3）。
* `reorder/e2e/pages/**` 有 5 个既有页面对象，`RenewalDetailPage.ts:12,13,16,17,20`
  在 `--strict` 下报 5 个 TS2564（未初始化属性）——因为 **e2e 目录不在任何 tsconfig 里**，
  从没人类型检查过它（我今天新写文件时踩到的 `hasPopup` 无效参数就是同一漏洞的产物）。
* `src/admin` 全仓 **0 个 `data-testid`**（两条独立 grep 一致），所以 e2e 定位只能靠
  角色/文案/class 链。i18n 目录是 `src/admin/i18n/json/en.json`（不是 `locales/`）。
* `medusa_epay/vitest.config.mts:7` include `tests/**/*.test.ts`，但仓库根**没有** `tests/`
  → 根配置空转；真正跑的是 `packages/epay`。root `dev` 脚本指向已删除的 `store`。
* `medusa-better-auth/src/lib/__tests__/migrate.integration.test.ts:15`
  `;(adminUrl ? describe : describe.skip)("runMigrations")` → 本地默认 skip；
  `dotnet/tests/**` 无 npm 脚本，仅 CI 跑。
* `medusa_webhooks/tests` 仅 `delivery.test.ts`（115 行）覆盖整插件。
* `node_modules/pg` 8.20.0 与 `@types/pg` 8.6.1 **已在 node_modules 里但未在 package.json 声明**
  （epay/gmpay 的 note 同样适用：锁文件里有 ≠ 依赖声明里有）。
* CI 只存在于 `medusa-better-auth` 与 `medusa_gmpay`。paypal/reorder/webhooks/epay/saas **无 CI**。

---

## 3. reorder 后台覆盖矩阵（L2 现状）

14 个后台面（13 个 route + 1 个 widget）：

| 面 | 路由 | 今天之前 | 今天 |
|---|---|---|---|
| 订阅列表 | `/app/subscriptions` | 8 条（多为空断言） | ✅ 收紧：搜索/空态/状态徽章/行菜单随状态变化 |
| 订阅详情 | `/app/subscriptions/:id` | 只当列表副作用 | ✅ 新增：卡片集、改地址落库+写日志、必填校验、改支付方式 |
| 套餐与优惠 | `/app/subscriptions/plans-offers` | 仅"创建" | ✅ 新增：启停双向 + 状态过滤器；✅ 新增：编辑抽屉（G5 已补） |
| 续费队列/详情 | `/app/subscriptions/renewals*` | 2 条（强推/审批） | 不变 |
| 催缴队列/详情 | `/app/subscriptions/dunning*` | **0** | ✅ 新增 7 条 |
| 取消与挽留 | `/app/subscriptions/cancellations*` | 2 条 | ✅ 新增：discount / bonus 挽留 + 改理由（G6 已补） |
| 兑换码 | `/app/subscriptions/redemptions*` | 2 条 | 不变 |
| 分析看板 | `/app/subscriptions/analytics` | **0** | ✅ 新增 4 条 |
| 活动日志 | `/app/subscriptions/activity-log` | **0** | ✅ 新增 3 条 |
| 订阅设置 | `/app/settings/subscription-settings` | **0** | ✅ 新增 3 条 |
| 订单详情 widget | `/app/orders/:id`（`order.details` zone） | **0** | ❌ 仍缺（G7） |

仍未被任何 e2e 触达的 admin API：`subscriptions/:id/{schedule-plan-change,payment-method}`、
`cancellations/:id/{reason,apply-offer}`（G6 已补 apply-offer/discount/bonus 两条，
reason 路由已补）、`dunning/[id]/retry-now`、`subscription-analytics/rebuild`、
`redemptions/batches/:id/records`。

---

## 4. 缺口清单（按风险排序）

| # | 缺口 | 证据 | 影响 | 处置 |
|---|---|---|---|---|
| G1 | 3 个 workflow spec 永不运行 | `reorder/jest.config.js` testMatch 无 `src/workflows` | 取消/暂停/改地址的编排层无守护 | **P0**：加 `TEST_TYPE=unit` 分支或并入 modules 模式 |
| G2 | vendor 21 个 spec 永不运行 | `apps/backend/jest.config.js:17-18` | 线上跑的副本零测试 | **P0**：发布顺序里"删 vendor"前必须先跑它的 spec，或干脆把 vendor 副本纳入 roots |
| G3 | e2e 数据层依赖 psql 二进制 + 明文口令默认值 | `e2e/seed.setup.ts:5-9`（`postgres://postgres:Kasperski1@localhost/…`），另 3 个 spec 各抄一份 INSERT | Windows 上直接跑不了；口令进了可发布仓库 | **P0**：✅ 已改走 `pg` 驱动（已声明 devDep）；默认值只从环境变量取；缺变量时报错。4 处手写 INSERT 已收敛到 `e2e/helpers/db.ts` 单点 |
| G4 | 装了 better-auth 的宿主后台登不进，L2 整层挂不住 | dtc 实测：`POST /auth/user/emailpass` 200、`POST /auth/session` 200 **不发 cookie**、浏览器内 `/admin/users/me` 401 而 Bearer 200；`/auth/user/providers` = better-auth+logto | e2e 进不了 `/app` | **P0**：先修 medusa-better-auth 的会话交接（本仓自己的职责），或给 e2e 留一个"仅 emailpass"的最小宿主 |
| G5 | plan offer 编辑抽屉无 e2e | 本次未写 | rules/折扣改错静默生效在店面 | ✅ 已补 |
| G6 | 挽留只测 pause 分支 | `cancellation-retention.spec.ts:77` | `discount_offer`/`bonus_offer` 的校验路径未测；`cancellations/:id/reason` 零触达 | ✅ 已补 |
| G7 | 订单详情 widget + 跨面深链无 e2e | widget 是订阅唯一"从订单进来"的入口 | 断链无人知 | **P1 残留**：widget 读 `subscription_order` 连线表（link module 自动建表，仓里查不到列名，直插 SQL 是猜）；造一笔真订单要走店面结账流，属 L3。**不写无证据的猜测用例** |
| G8 | e2e 不在任何 tsconfig | `reorder/tsconfig.json` 排除 `src/admin`，e2e 目录根本不在内 | 定位器写错要等运行期 | ✅ 已加 `tsconfig.e2e.json`（`--strict`）+ `test:e2e:types` 脚本 |
| G9 | storefront（店面）零浏览器测试 | `apps/storefront` 5 个 vitest 全是 node 环境的纯函数 | 结账/价格页/PayPal 按钮全靠手测 | P1：L3 那 8 条场景落在店面（Next15/React19，别和后台混一个 project） |
| G10 | saas-bridge 与宿主接收端无契约测试 | reorder 侧 `saas-bridge.spec.ts` 只测发送；宿主无对应 spec | HMAC/载荷改动两边不同步 | P2：共享 fixture（同一 payload + 签名）双仓断言 |
| G11 | webhooks 只测纯函数 | `medusa_webhooks/tests/delivery.test.ts` | 真实投递/重试/管理页未测 | P2 |
| G12 | 无 CI（5/7 仓） | 只有 better-auth、gmpay 有 workflow | 一切"绿"都是口头 | P1：最低限度 `L0 + reorder L1(modules) + paypal L0` |
| G13 | 金额 SQL 无测试、且与代码未同窗 | §0-3 | 100 倍收款风险 | **P0**：L4 |
| G14 | 4 个既有 spec 只插 seed 不清理 | `seed.setup.ts` / `subscription-status.spec.ts` / `renewal-force.spec.ts` / `cancellation-retention.spec.ts` 无 afterAll 删除 | 库里越攒越脏，`toHaveCount(1)` 类断言会偶发红 | ✅ 已全部补清理 |

---

## 5. 落地任务（建议顺序）

| 优先级 | 任务 | 验收 |
|---|---|---|
| P0-1 | 修 G4（better-auth 会话 cookie）或提供"仅 emailpass"e2e 宿主 | `yarn test:e2e --project=setup` 绿，`e2e/.auth/admin.json` 生成 |
| P0-2 | G3：e2e 种子改 `pg` 驱动 + 去掉明文口令默认值；迁移 4 处手写 INSERT 到 `e2e/helpers/db.ts` | 本机无 psql 也能 `yarn test:e2e`；`grep -r Kasperski1 reorder/e2e` 空 |
| P0-3 | G1/G2：让"存在的 spec"真的被跑（补 testMatch / roots 或删文件） | `--list`/`jest --listTests` 数量与磁盘文件数一致 |
| P0-4 | G8：`tsconfig.e2e.json` + `test:e2e:types` | 新脚本退出码 0 |
| P0-5 | L4：paypal 0.5.0 + 金额 SQL 同窗发布；宿主删 vendor、跑 §4 回归 | `npm view` 有 0.5.0；宿主 backend 装到 0.5.0；§4 十一条逐条签字 |
| P1-1 | 给 admin 关键控件补 `data-testid`（先补本次用到的：行菜单触发器、抽屉提交、Add filter、Export） | e2e 里 class 链定位（`div.flex.items-center.gap-x-2`）归零 |
| P1-2 | 补 G5/G6/G7 | 矩阵里 11 个面全绿 |
| P1-3 | L3 店面 playwright（新项目，baseURL 8000）| §1-L3 八条各至少一条 |
| P1-4 | G12 最小 CI | 五个仓有 CI，红即拦 |
| P2 | G10 契约 fixture、G11 webhooks 投递、admin 无编译兜底的表单类补测 | — |

---

## 6. 每次发布的硬门槛（浓缩版，贴给执行者）

1. `medusa-paypal`：`npm test` 绿 → 提交（README/CHANGELOG/package.json 常在未提交态）→
   `git tag vX.Y.Z` → `npm publish --registry https://npm.pkg.github.com` → `npm view` 核对。
2. `reorder`：`test:integration:modules` + `test:i18n` 绿（无库可跑）→
   `test:integration:http` 绿（需库）→ `test:e2e` 绿 → `medusa plugin:build` 绿
   （注意它 **不** 类型检查 `src/admin`）。
3. 宿主：`pnpm why react` 证明 admin 侧 React 单副本；`pnpm test`；装新版插件后
   跑 L3 关键两条（注册登录、结账闸门）。
4. 数据：金额 SQL dry-run → 执行 → 三向对齐抽查。
5. 收尾：源头清单 §3 删补丁、§4 回归逐条签字。

---

## 7. 对 `reorder/e2e` 的改动

### 7.1 第一批（新写用例）

新增：`e2e/helpers/db.ts`（种子+DB 读回+admin API 单点）、
`e2e/pages/{DunningQueuePage,DunningCaseDetailPage,ActivityLogPage,AnalyticsPage,SubscriptionSettingsPage}.ts`、
`e2e/{dunning-recovery,activity-log,analytics,subscription-settings,subscription-detail-mutations,plans-offers-toggle}.spec.ts`。
改写：`e2e/subscriptions-list.spec.ts`（把"搜索后还有行""状态正则含四个或分支""菜单 count>0"
这类恒真断言换成有种子、有对照、有落库校验的断言）。
未改：其余既有 spec/页面对象（`RenewalDetailPage` 的 5 个 strict 报错留给 G8 一并处理）。

已跑过的验证：
* `npx playwright test --list` → **42 tests in 14 files**（此前 17）。
* `tsc --noEmit --strict`（e2e 全集）→ 我新增的文件 0 报错；顺带抓出我自己写的
  `getByRole(..., {hasPopup})` 在 Playwright 1.62 不存在这个选项，已改为仓内既有定位法。
* 种子/读回 SQL 在**真实 reorder 模式库**上执行过：克隆一份集成测试库
  （`dunning_case`/`dunning_attempt`/`renewal_cycle`/`subscription_log`/`plan_offer`/
  `subscription_settings` 列与 CHECK 全部来自实库），跑 INSERT→查询→DELETE，
  断言文本形状（含 `2|[1440, 4320]`、`1 / 3`、`true/false`）。
  过程中抓到一个真错：`shipping_address->>'k' || … ` 因 `->>` 与 `||` 同优先级会解析成
  `text ->> jsonb` 而报错，已加括号。

**没跑过的部分（必须如实记账）**：浏览器里的 42 条实跑一次都没执行过——L2 被 G4 卡住
（宿主后台登录拿不到 cookie）。因此上述用例的**选择器与 toast 文案来自源码逐行取证**
（含 i18n 解析后的英文常量），但运行时行为未验证。第一次能跑起来时，预期需要修的
就是 §4 的 G3/G4/G5 与图标触发器定位。

### 7.2 第二批（今天：把"没跑起来"和"缺口"收掉）

目标从"用例够多"换成"用例真的可跑 + 缺口被填"：

| 改动 | 文件 | 说明 |
|---|---|---|
| 数据层去 psql / 去明文口令 | `e2e/helpers/db.ts` | 改走 `pg` 驱动；`DATABASE_URL` 缺省直接抛错，不再回落到含口令的默认值 |
| 4 处手写 INSERT 收敛 | `e2e/seed.setup.ts`、`subscription-status.spec.ts`、`renewal-force.spec.ts`、`cancellation-retention.spec.ts` | 全部改调 helper；顺带解决 G14 的清理问题 |
| e2e 纳入类型检查 | `tsconfig.e2e.json` + `package.json` 的 `test:e2e:types` | `RenewalDetailPage` 的 5 个 TS2564 一并修掉（删 5 个未使用的声明） |
| 依赖声明 | `package.json` devDeps | 补 `pg` 与 `@types/pg`（本来就在 node_modules 里，只是没声明） |
| G5 编辑抽屉 | `e2e/plans-offers-edit.spec.ts` | 覆盖改名落库 + 试用心愿校验 + 折扣数值校验 + 频率去重校验，断言请求体与 DB |
| G6 挽留 discount/bonus + 改理由 | `e2e/cancellation-retention-offers.spec.ts` | `discount_offer` / `bonus_offer` 的 payload 与落库断言，零值折扣被前端挡下；`cancellations/:id/reason` 的 `reason_category` 回写 |

**这一批的验证方式（如实记账）**：
* `npx playwright test --list` 全量收集通过；
* `npx tsc -p tsconfig.e2e.json --noEmit --strict` 退出码 0；
* 浏览器实跑仍未做（G4 未修）。所有选择器/文案照 7.1 的取证方法：从
  `src/admin/**` 与 `src/admin/i18n/json/en.json` 逐行取，不猜。

### 7.3 仍然空着、且**不打算猜**的部分

* **G7 订单详情 widget**：widget 读 `subscription_order` 连线表，该表由 link module
  自动创建，仓里没有任何 migrations 落地它的列名（只有 `query.graph({entity:"subscription_order"})`
  这种写法）。直插 SQL 等于赌列名。要做只有两条正路：①按实库 `\d subscription_order`
  回过列名再写；②走店面结账真造一笔（属 L3）。**没有证据就不写这条用例。**
* **L3 全部场景**：需要店面 + 真网关沙箱，不是 reorder 单仓能承载的。
