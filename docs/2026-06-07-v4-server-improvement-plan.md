# V4 Server 改进执行计划（基于第三轮审查的重新分析）

- **日期**:2026-06-07
- **范围**:`bazaarplusplus-server`(V4 mod-facing 后端,`mod-api-v4.bazaarplusplus.com`,Cloudflare Workers / D1 / R2)。
- **性质**:**执行计划**。每条结论以代码为唯一事实来源,附 `文件:行`;文档/CLAUDE.md 与代码冲突时以代码为准并记为漂移。
- **方法**:第三轮审查(5 维度独立 finder → 逐条对抗式验证 → 完整性批判,叠加人工通读全部 `src/` 与对每条 SQL 跑 `EXPLAIN QUERY PLAN`),把高层批次表逐项对照当前 HEAD 重新分析后落为本计划。
- **基线**:上一轮验证 `npm run check` ✅、`npm run test` 59/59 ✅(每个 PR 前重跑确认)。
- **边界**:验证仅用 `npm run check` / `npm run test`,不跑 `wrangler deploy`、不动 secret、不碰已冻结的 V3。跨仓(mod / analyzers)默认不在范围,仅在 wire 契约受影响时提示。

## 关联文档

本计划承接并不重复以下两份文档(其 P0–P3、WP1–WP6 经本轮逐条核对**均已落地、无回归**):

- `docs/2026-06-05-v4-server-audit-and-optimization-plan.md`(正确性/安全/D1/分层)
- `docs/2026-06-07-structural-refactor-execution-prompt.md`(结构卫生 WP1–WP6)

本计划只收录**当前仍可动手的新增项 / 已被验证为"修复不完整"的项 / 待决策项**。

---

## 1. 重新分析的关键结论

把原高层批次表逐项对照当前代码后,三个结构性结论改变了打包方式:

1. **"队列烧毁硬化"必须拆成两半。** "加批量告警"是零争议、零契约影响的纯观测改动(→ 1.1a);"max-attempts 不立即删 R2"是把 failed 对象清理交还给 R2 lifecycle 的改动(→ 1.1b),但它**改变了已写进文档的语义**且**强耦合保留策略**(`done` 由 confirm 立即删 R2,`failed` 由 R2 lifecycle 最终清),不能与 1.1a 同批。
2. **时间戳钳制对 analyzers 的风险比原评估更小。** analyzers 的 lexicographic keyset 游标走的是 `updated_at_utc`/`created_at_utc`,而这两列是**服务端 `new Date().toISOString()` 盖戳**(`src/features/runBundles/upload.ts:435-436`),**非**客户端时间戳。钳制 `submitted_at_utc`/`ended_at_utc` 只改善 analyzers 的指标值、不动游标格式 → 源头钳制(选项 a)比原报告评估的更安全。
3. **1.1b ⟷ 2.2 ⟷ "5 天窗口依赖 R2 lifecycle ≥ 5 天"是同一条 R2 生命周期主线**,应一次性决策,不要分散。BazaarDB snapshot 队列语义已明确为可丢:到 max-attempts 后只标记 failed,不自动重投/恢复。

**整体结论不变**:无 Critical、无存活 High。唯一 Medium 是早已知晓、被运维侧搁置的"R2 token 错配静默烧队列",其代码层收敛(1.1b)是本计划的最高价值项:它不保证数据恢复,只把失败语义和对象清理职责变明确。架构层面高内聚/低耦合成立(grep 验证零跨 feature 导入、零 kernel→feature 反向依赖、无环),热路径 SQL 全部命中索引、无全表扫描。

---

## 2. 执行计划总表

| 轨 | 项 | 性质 | 需协商 | 契约/语义影响 |
|---|---|---|---|---|
| **A 快赢(直接做)** | 2.1 删 `idx_bazaardb_delivery_pending_order` | 计费/写放大 | 否 | 无 |
| | 1.1a bazaardb 批量失败告警 | 观测 | 小(阈值常量) | 无 |
| | 3.3 `confirm` 并行删 R2 | 卫生 | 否 | 无 |
| **B 健壮性(小决策)** | 1.2 时间戳上界钳制 + 测试 | 正确性 | 是(是否钳 runs 列) | 文档 + analyzer 指标值 |
| **C 卫生批(行为保持)** | 3.2 抽 `logProjectFailure` | 重构 | 否(需逐字对账日志) | 无(byte-identical) |
| | 3.1 列清单 SSOT + 漂移守卫测试 | 防漂移 | 是(codegen 深度) | 无 |
| **D 决策轨(先拍板再开 PR)** | 1.1b max-attempts 只标记 failed + R2 lifecycle 清理 | 丢失语义收敛 | **是** | 改文档化语义 + 告知 BazaarDB |
| | 2.2 三表保留策略(cron vs 文档化) | 计费/运维 | **是** | 文档 |
| | 4-c partner 端鉴权 / 限流 | 安全(P2) | **是** | 改 wire / 需 mod 配合 |
| **E 文档/前瞻(零风险)** | 1.3 补 500 文档(+ 可选 CORS 包裹) | 文档 | 小 | 文档 |
| | 4-a `/health` liveness 说明 | 文档 | 小 | 文档 |
| | 4-b Content-Length 旁路说明 | 文档 | 否 | 文档 |

**统一验证**:每个 PR `npm run check && npm run test`。**PR 规范**:imperative 标题、无 conventional-commit 前缀、无结尾标点、正文末 `Release Notes:` 一条(`Added`/`Fixed`/`Improved`,后端内部用 `N/A`)。**铁律**:不内联改 `.rules`/`CLAUDE.md`(成规模式 → PR 描述"Suggested .rules additions");不碰冻结面——前述 24 列名 / `BATTLE_INSERT_SQL` 的 `?14 = ?6` 自战分支 / `seen_player_accounts` 上记是 D1 批内**末条** / R2 puts 只写 `httpMetadata.contentType` / `idx_runs_updated_at` 保留(analyzers keyset)/ SQL 常量留在 `upload.ts`。

---

## 3. 轨 A — 快赢(直接做,无需协商)

### 2.1 删 `idx_bazaardb_delivery_pending_order`

- **现状复核**:索引定义 `migrations/0001_v4_initial.sql:117-119`。唯一候选消费者是领取内层 SELECT(`src/features/bazaardb/peek.ts:101-109`,`ORDER BY uploaded_at_utc, snapshot_id`)。实测 `EXPLAIN QUERY PLAN`(空库 + 1471 pending 行 `ANALYZE` 后)**均**选 `idx_bazaardb_delivery_pending_attempts`(covering)+ `USE TEMP B-TREE FOR ORDER BY`,从不选 `pending_order`(仅显式 `INDEXED BY` 可触达,全仓无)。故该偏索引零读、纯写放大:每次快照 `INSERT` 写 1 条、每次 `pending→done/failed` 删 1 条。
- **改法**:新增 `migrations/0004_drop_unused_bazaardb_pending_order_index.sql`,内容:
  ```sql
  DROP INDEX IF EXISTS idx_bazaardb_delivery_pending_order;
  ```
  (沿用 `migrations/0002_drop_unused_runs_ended_at_index.sql` 的范式。)
- **决策点**:无。
- **风险·回滚**:零回归——实测 `DROP` 后六个 bazaardb 查询计划字节一致。D1 迁移前向不可改;若要恢复,再加一条 `CREATE INDEX` 迁移。
- **验证**:`test/schema.test.ts` 加一条断言该索引不存在(镜像 `:11` 对 `idx_runs_ended_at` 的写法);`npm run test`。
- **文档同步**:无。
- **小注**:若将来手动 `ANALYZE` 且数据大增,规划器可能翻转去用它以省临时排序;但 D1 不自动 `ANALYZE` 且 pending 集很小,此权衡可忽略。

### 1.1a bazaardb 批量失败告警

- **现状复核**:`failMaxAttemptRows`(`src/features/bazaardb/peek.ts:17-56`)目前在批量置 `failed` 时仅记**计数级** `logWarn`(`:36-41`),只有 R2 delete 失败才再记 `logWarn`(`:46-53`)。`logError` 全仓仅 `src/index.ts:93` 调用。该日志无法区分"一条毒快照"与"token 错配导致整队在烧"。
- **改法**:当 `failed.results.length` 达到独立批量阈值(建议新增 `MassDeliveryFailureThreshold = 3`)时升级为 `logError`(事件 `bazaardb.peek`、`outcome: "mass_delivery_failure"`、带 `failed_count`),使其可被边缘日志告警捕获;低于阈值维持 `logWarn`。
- **决策点**:阈值取值;不要复用 `MaxDeliveryAttempts`,它是单行重试上限而非批量告警阈值。CF 侧是否已有日志告警管道(本仓不可见)——本项只把信号变明显,真正告警链路需运维侧配。
- **风险·回滚**:纯日志,零行为/契约影响。
- **验证**:`test/bazaardb.delivery.test.ts` 加一条"批量置 failed → 触发 error 级事件"断言;`npm run test`。
- **文档同步**:无。
- **重要**:本项只解决"**早发现**",不解决数据丢失本身——唯一 Medium 要到 **1.1b** 落地才算关闭。

### 3.3 `confirm` 并行删 R2

- **现状复核**:`src/features/bazaardb/confirm.ts:66-77` 仍 `for...of await` 逐个删,单次至多 `PeekMaxItems=10`(`src/features/bazaardb/delivery.ts:3`)个串行 R2 往返;而 `peek` 两个循环已 `Promise.all`(`peek.ts:43-56,149-155`)。优化波(2026-06-05 P3)只覆盖了 peek 两处。
- **改法**:`confirm` 删除循环改 `await Promise.all(rows.results.map(async (row) => { try { await env.BAZAARDB_BUCKET.delete(row.r2_key); } catch (error) { logWarn(...); } }))`,保留逐行 `try/catch + logWarn` 的错误隔离。
- **决策点**:无。
- **风险·回滚**:纯延迟优化,无正确性/计费差异(同样数量的 R2 delete);并行后日志顺序可能变,无影响。
- **验证**:现有 `test/bazaardb.delivery.test.ts` confirm 用例;`npm run test`。
- **文档同步**:无。

---

## 4. 轨 B — 健壮性(需一个决策)

### 1.2 时间戳上界钳制 + 回归测试

- **现状复核**:
  - 只有 battle 自身 `recorded_at_utc` 有 +10min 钳制——`normalizeBattleRecordedAt`(`src/features/runBundles/upload.ts:178-189`)、`isAfterAllowedFutureSkew`(`:135-137`)、`MaxBattleRecordedAtFutureSkewMs`(`:62`)。
  - 回退值 `submittedAt.value`(`:185`)来自 `normalizeTimestampOrFallback`(`:154-162`)——**只校验 ISO 格式、无上界**。`submitted_at_utc`/`ended_at_utc` 经此(`:341-342`),`started_at_utc` 经 `normalizeOptionalTimestamp`(`:164-176`,同样无上界)。
  - **后果一(ghost 投毒)**:未来 `submitted_at_utc` → battle `recorded_at_utc` 写成未来(`bind` 第 3 位 `:450`)→ ghost 查询 `recorded_at_utc >= now-5d` 无上界(`src/features/ghostBattles/query.ts:62`)+ `ORDER BY recorded_at_utc DESC`(`:63`)→ 永不老化、恒置顶。全仓无 `DELETE FROM battles`,行永久。
  - **后果二(analyzer 污染)**:`runs.ended_at_utc/started_at_utc/submitted_at_utc` 直写,远未来或 `started > ended` 静默污染下游时长/recency 指标。
- **改法(两选一,见决策点)**:
  - **(a) 源头钳制**:在 `normalizeTimestampOrFallback`/`normalizeOptionalTimestamp` 内,超 `now + skew` 的值回落到服务端 now。一处修,同时治好 battle 反查窗 **与** runs 列。
  - **(b) 仅钳反查窗**:只在 battle 选定 `recorded_at` 后 `min(value, now + skew)`,不动 runs 列。窄,只治 ghost 投毒。
- **决策点(需协商)**:
  1. **是否钳 `runs.submitted_at_utc`/`ended_at_utc`(analyzer 耦合列)?** 重新分析后**倾向 (a)**:keyset 游标走服务端盖戳的 `updated_at_utc`(`:435-436`),**不受影响**;钳制只把垃圾未来值收敛到 now,对 analyzers 是净改善。但毕竟改了写入 analyzer 列的值,建议知会 analyzers owner 后落。
  2. `started_at > ended_at` 排序合理性是否一并校验?可选,低优先。
  3. 下界(拒游戏发布前的远古时间)是否需要?可选,本轮可不做。
  4. skew 复用 10min 常量即可(`submitted/ended ≈ now`,够用)。
- **风险·回滚**:更严格校验,注意阈值别误拒真实请求(10min skew 足够宽);逐项可回滚。
- **验证**:新增回归测试——**远未来 `submitted_at_utc` + 缺失/未来 battle `recorded_at`** → 断言库内 `recorded_at_utc` 被钳到 ~now(现有 `test/runBundles.parse.test.ts:358-382` 只喂过去时间,覆盖不到);选 (a) 再加一条 runs 列钳制断言。`npm run test`。
- **文档同步**:`docs/api-reference.md:49,62,68,82` 说明 fallback 本身也被上界钳制。

---

## 5. 轨 C — 卫生批(行为保持,可一个 PR 三 commit)

### 3.2 抽 `logProjectFailure`

- **现状复核**:`src/storage/putThenProject.ts:4-17` 的 `CleanupOutcome`/`ProjectFailure` 判别式经 `PutThenProjectResult`(`:24-26`)泄漏给调用方;`src/features/runBundles/upload.ts:511-551` 与 `src/features/bazaardb/upload.ts:119-155` 是两份结构近乎相同、**无 default/exhaustiveness** 的 `switch`,加第五个 variant 会在两处静默漏日志且不报错。
- **改法**:抽 `logProjectFailure(event, idFields, projectResult, outcomeMap)`;`outcomeMap` 用 `Record<CleanupOutcome, …>` 恢复编译期穷尽性。
- **决策点(设计细节,非阻断)**:`deleted` 分支 run-bundle 有 `committed == null ? "…_r2_cleaned" : "…_raced_object_cleaned"`(`:527-529`),bazaardb 是平的(`:131-135`)。故 `outcomeMap.deleted` 不能是纯 `string`,需 `string | ((committed) => string)`,或把 raced 串单独传参。
- **风险·回滚**:这会再 churn WP3 引入的代码 → **唯一硬要求是日志逐字段对账后仍 byte-identical**(WP3 不变量);对账即闸门。
- **验证**:逐条对照被删 `switch` 与新映射的 outcome 串/字段;`test/putThenProject.test.ts` + 全量。
- **文档同步**:无。

### 3.1 列清单 SSOT + 漂移守卫测试

- **现状复核**:同一有序列集重述于 7+ 处——`BattleProjection`(`src/features/runBundles/upload.ts:27-52`)、`BATTLE_INSERT_SQL`(`:78-120`)、按位 `bind()`(`:447-473`)、`GhostBattleRow`(`src/features/ghostBattles/query.ts:8-32`)、SELECT(`:53-59`)、row→json(`:71-95`)、`migrations/0001_v4_initial.sql:36-65`、`docs/api-reference.md` 两表。`?14 = ?6` 自战分支(`upload.ts:93`)把语义钉死在第 14/6 位。runs 侧**完全无 TS 类型**(`run_projection: Record<string, unknown>`,内联字符串键读)。`test/schema.test.ts` 只断言索引/表存在,无列集守卫。
- **改法(分层,见决策点)**:
  - **最小**:加一条 CI 漂移守卫测试,断言 `PRAGMA table_info(battles)`/`(runs)` 的列序 == 手维护的 runtime 清单数组。若要把 `GhostBattleRow` 纳入守卫,需先把读路径列清单抽成 runtime `const GhostBattleColumns` 并用 `satisfies readonly (keyof GhostBattleRow)[]` 做编译期约束;TS type 本身运行时不可读,测试不能直接取它的 key 集。
  - **进一步**:从单一清单派生 `GhostBattleRow` 键、查询 SELECT、row→json map(读路径不可能漂移);**保留 SQL 字面量在 `upload.ts`**(遵守规则)。
  - **附带**:给 runs 加具名 `RunProjection` 类型。
- **决策点(需协商)**:做到哪一层?——建议**先只做最小守卫测试**(行为保持、收益立竿见影),codegen 视后续意愿再说。
- **风险·回滚**:守卫测试纯增测;codegen 那层动读路径,需 `npm run check` 兜底。
- **验证**:`npm run check && npm run test`。
- **文档同步**:无。

---

## 6. 轨 D — 决策轨(先拍板,再开 PR)

> 这三项共享同一条 **R2 生命周期 / 数据保留** 主线,建议一次性决策。

### 1.1b max-attempts 只标记 failed + R2 lifecycle 清理(收敛唯一 Medium 的语义)

- **现状复核**:`presigner.sign()`(`src/features/bazaardb/peek.ts:149-150`)是纯本地 SigV4 计算(`src/crypto/presign.ts:31-49`),token 能否真的读桶它都成功。token 错配时 partner 下载 403、永不 confirm,3 轮租约后 `failMaxAttemptRows`(`peek.ts:43-56`)置 `failed` 并 `delete` R2;confirm 前 R2 是唯一副本 → 不可逆全队列丢失。叠加 `snapshotExists`(`src/features/bazaardb/upload.ts:9-18,60-63`)查询**不带 state/R2 存在性过滤**,上游重传短路返回 `ok()` 指向既有 D1 行;如果该行的 R2 对象已由 immediate delete 或 lifecycle 清掉,服务端仍不会自动恢复。
- **改法**:max-attempts 时**只置 `failed`、不立即删 R2 对象**;对象清理由 R2 lifecycle 负责。confirm 成功路径仍保留现有手动删除 R2 对象语义(`done` 立即清对象,`failed` 等 lifecycle)。`failed` 是接受丢失的终态,不做自动重投、revive 或 replacement。同 `snapshot_id` 重传仍按现有幂等 ledger 语义短路为 `ok()`。
- **决策点(需协商)**:
  1. **是否支持 failed→pending 重投?** 已决策:不支持。BazaarDB 接受该队列的 max-attempts 丢失语义。
  2. **保留下来的 failed 对象由谁清?** 已决策:交给 R2 lifecycle;D1 `failed` 行长期保留为幂等 ledger,除非后续另开 cron/ops 清理。
  3. 这改变了 `docs/bazaardb-snapshot-integration.md` 与 `docs/api-reference.md`(peek 节"after 3 attempts … deletes its R2 object")已写的语义 → 需同步并**告知 BazaarDB**(属内部行为变更,不改请求/响应 shape)。
- **风险·回滚**:行为变更,git 还原即可;文档/partner 告知需同步。
- **验证**:回归测试——3 次未确认领取后,行为 `failed` 且 **不会调用 immediate R2 delete**;confirm 成功仍会删除对应 R2 对象;重传同 `snapshot_id` 仍返回 `ok()` 且不 revive。文档说明若 lifecycle 已清对象,后续同 id 重传也不会自动恢复。

### 2.2 三表保留策略

- **现状复核**:全仓无 `DELETE`、无 `[triggers]`/scheduled、无 TTL。`runs`/`battles` 行永不删(`battles` 是 N 行/run 的高基数增长),`bazaardb_delivery` 的 `done`/`failed` 永不回收;run-bundle 仅靠 dashboard R2 lifecycle(`wrangler.toml:31-37` 无 lifecycle 配置)。**隐含不变量**:run-bundle R2 保留必须 `≥ GHOST_QUERY_LOOKBACK_DAYS`(`src/features/ghostBattles/query.ts:6` = 5 天),否则窗口内 battle 的 `replay-link` 静默返回 410(`src/features/ghostBattles/replayLink.ts:37-46`),无任何信号。
- **改法(两选一)**:
  - **(a) 文档化**:在 `docs/api-reference.md`/`CLAUDE.md` 显式声明"D1 行按设计永久保留、孤儿行(R2 已 lifecycle 删)预期存在",并记录上面那条"R2 保留 ≥ 5 天"的隐含不变量。零风险,先做。
  - **(b) cron**:加 `[triggers]` scheduled handler,按 R2 lifecycle 视界 `DELETE` 老 `runs`/`battles` 行 + 清 bazaardb 终态行/对象。更大面、需把保留视界作为已知常量(dashboard lifecycle 在仓外、无法在代码内强校验)。
- **决策点(需协商)**:(a) 还是 (b)?保留视界定多少(须与 dashboard 一致)?bazaardb failed 对象清理当前已决策为 R2 lifecycle;D1 failed 行清理由后续 cron/ops 再议。
- **风险·回滚**:(a) 零;(b) cron 误删需谨慎,带 dry-run/日志。
- **验证**:(b) 加 sweep 查询单测 + `EXPLAIN` 估扫描成本;`npm run test`。

### 4-c partner 端鉴权 / 限流(P2)

- **现状复核**:三个 mod-facing 端点零鉴权——`replay-link` IDOR(`src/features/ghostBattles/replayLink.ts` 忽略调用方身份)、`/run-bundles` 投毒、`/ghost-battles` 可枚举(均 2026-06-05 已记的待拍板 P2)。**新点**:`POST /bazaardb/snapshots/:id`(`src/index.ts:31-38`、`src/features/bazaardb/upload.ts:49-58` 无 `requireBearer`)是此前未单列的 partner 队列生产者,匿名可伪造任意 `player.display_name` 灌入 partner 系统。
- **决策点(需协商,先决策不是写码)**:(a) mod-facing 轻量 token/HMAC(`src/http/auth.ts:constantTimeEquals` 已具基础);(b) 调用方-account 绑定;(c) CF 边缘限流 + 在 spec 记为"已评估可接受"。会改 wire / 需 mod 配合发版。
- **前置只读核实**:`mod-api-v4` 自定义域前是否已配 CF WAF/Rate Limiting/Access(本仓不可见)。
- **本轮可立即做的零争议子项**:在 `docs/bazaardb-snapshot-integration.md` **告知 BazaarDB**"上传未鉴权、`display_name` 可被影响",并把该端点并入 P2 决策清单。

---

## 7. 轨 E — 文档/前瞻(零风险)

### 1.3 补 500 文档(+ 可选 CORS 包裹)

- **现状复核**:`src/index.ts:91-100` 对非 `Response` 异常 `logError` 后 `throw` → 无信封无 CORS 的裸 500;触发点 `src/crypto/presign.ts:13-17`(secret 缺失,经 `replayLink.ts:48`/`peek.ts:85`)、`src/features/runBundles/upload.ts:581`、任意 pre-batch D1 抖动。文档只为 `/run-bundles`(`docs/api-reference.md:134`)与 `/bazaardb/snapshots`(`:330`)记了 500。
- **改法**:(a) 给 `/ghost-battles`、`/replay-link`、`/bazaardb/peek`、`/bazaardb/confirm` 错误表补 500 行;**(b) 可选**:`index.ts` catch 内 rethrow 前返回 `withCors(jsonError("internal_error", 500))`,让意外失败也带信封 + CORS(已先 `logError`,不丢信息)。
- **决策点(小)**:只做文档 (a),还是顺带 (b) 统一信封?对 mod(.NET HttpClient、非 2xx 即重试)无差异,(b) 是纯改善 → 倾向 (a)+(b)。
- **风险·回滚**:(a) 零;(b) 改 500 响应体,行为变更但更一致。
- **验证**:(b) 加"未捕获异常 → 带 CORS 的 `internal_error` 500"单测。

### 4-a `/health` liveness 说明

- **现状复核**:`src/features/health.ts:3-8` 只回 200 + 时间戳,不探 D1/R2/secret;secret 坏时 `/health` 仍绿而 `replay-link`/`peek` 抛 500。
- **改法**:`docs/api-reference.md` 注明"`/health` 仅 liveness";**可选**加 secret 存在性检查(零 I/O,返 503)或独立 `/ready`(`SELECT 1` 有 D1 读成本)。
- **决策点(小)**:是否要 readiness?建议先文档化,readiness 视监控需求再加。

### 4-b Content-Length 旁路说明

- **现状复核**:`declaredContentLengthExceeds`(`src/http/request.ts:112-115`)在**无 `Content-Length`** 头时返回 `false`,两个未鉴权上传 handler 落到 `request.arrayBuffer()` 全量缓冲后才按 byteLength 拒(`src/features/runBundles/upload.ts:271-282,242-247`;`src/features/bazaardb/upload.ts:69-79`)。真实上界变成 CF 平台体积限。
- **改法**:文档注明"无 `Content-Length` 时上限在缓冲后强制";后缓冲检查本就存在,保留为真正硬上限。**可选**对这些 POST 拒绝无 `Content-Length` 的请求(mod 总带 CL,较安全,但可能误伤未来客户端)。
- **决策点(小)**:是否拒绝无 CL?建议先只文档化。

---

## 8. 需拍板的决策清单(汇总"协商"项)

1. **R2 生命周期主线(1.1b + 2.2 + "5 天窗口耦合")**:已决策 BazaarDB snapshot 队列 max-attempts 只标记 `failed`,不 immediate delete、不 failed→pending 重投;confirm 成功仍手动删除 R2 对象;failed 对象走 **R2 lifecycle** 清理,D1 failed 行长期保留为 ledger。仍需拍板的是 run-bundle 保留视界(须 ≥ 5 天且与 dashboard 一致)以及是否另做 D1 cron 清理。
2. **1.2 是否钳制 `runs.submitted_at_utc`/`ended_at_utc`**(选项 a vs b)?——倾向 (a),因 keyset 游标走服务端盖戳列、不受影响。
3. **3.1 做到哪层**:仅漂移守卫测试,还是连读路径 codegen?
4. **1.3 / 4-a / 4-b**:是否顺带做代码侧(CORS 包裹 500 / readiness 探针 / 拒无 CL),还是纯文档?
5. **4-c P2 鉴权**:走 token/HMAC、account 绑定、还是边缘限流 + 记为可接受?(需先只读核实 CF 边缘是否已有防护,并需 mod 配合发版。)

---

## 9. 落地顺序与 PR 打包

| PR | 内容 | 性质 | 前置 |
|---|---|---|---|
| **PR 1** | 2.1 删 `pending_order` 索引(迁移 + schema 测试) | 计费,零风险 | 无 |
| **PR 2** | 1.1a 批量失败告警 | 观测,零契约 | 无 |
| **PR 3** | 3.3 `confirm` 并行删 | 卫生,零契约 | 无 |
| **PR 4** | 1.2 时间戳钳制 + 回归测试 | 正确性 | 决策 2 |
| **PR 5** | 3.2 `logProjectFailure` + 3.1 漂移守卫测试 | 行为保持卫生 | 决策 3 |
| **PR 6** | 1.1b failed 终态 + 2.2 保留策略 | 丢失语义 + 运维 | 决策 1 剩余项 |
| **决策轨** | 4-c P2 鉴权 | 安全,改契约 | 决策 5 + CF 边缘核实 |
| **文档** | 1.3 / 4-a / 4-b / 2.2(a) / 4-c 告知 | 零风险文档 | 随各 PR 附带或单独一发 |

> PR 1/2/3 可立即并行推进(三项独立、零决策);PR 4/5 各自带测试;PR 6 与决策轨待决策 1/5 拍板后开。
>
> 备注:`docs/2026-06-05` 报告把"队列烧毁"列为"运维侧处置";本轮复核确认**代码层语义尚未收敛**,故 1.1b 从"已知未修"升格为本计划的最高价值待决项。该项不追求无丢失恢复,只追求 failed 终态、R2 lifecycle 清理和文档/partner 预期一致。

---

## 附录:本计划的来源发现(第三轮审查)

| 计划项 | 严重度(校准后) | 是否新增 | 验证裁决 |
|---|---|---|---|
| 1.1a/1.1b R2 token 错配烧队列 | Medium | 否(2026-06-05 P0-2 已记、未修) | confirmed |
| 2.1 `pending_order` 零读写放大 | Low | ✅ | confirmed(EXPLAIN 证 drop 无回归) |
| 1.2 时间戳钳制可被 fallback 绕过 | Low | ✅(P1-3 修复不完整) | confirmed |
| 2.2 三表无保留/GC | Low | ✅ | confirmed(critic) |
| 3.1 24 列投影 7+ 处重复无守卫 | Low | ✅ | needs-nuance(无现存 bug,属未来编辑风险) |
| 3.2 WP3 重复 switch 无 exhaustiveness | Low | ✅ | confirmed |
| 3.3 `confirm` 串行删 | Low | ✅ | confirmed |
| 1.3 裸 500 无信封无 CORS | Info | 部分 | needs-nuance |
| 4-a `/health` 仅 liveness | Info | ✅ | confirmed(critic) |
| 4-b Content-Length 旁路 | Low | ✅ | confirmed(critic) |
| 4-c partner 端零鉴权 | Low | 否(P2 决策项;snapshot 端点为新点) | needs-nuance |

> 已验证健康、本计划不动的部分:P0-2 顺序修复在位且有回归测试;"至多一个未决 peek"在非事务 handler 下正确;并发同 `run_id`/`snapshot_id` 上传无数据丢失;分层高内聚低耦合;热路径 SQL 全部命中索引。
