# 通过 `seen_player_accounts` 表实现 `battles` 入库过滤 — 技术方案

- **日期**:2026-06-07
- **范围**:`bazaarplusplus-server`(V4 mod-facing 后端,`mod-api-v4.bazaarplusplus.com`,Cloudflare Workers / D1 / R2)。仅改 `POST /run-bundles` 的 battle 入库行为 + 新增一张派生表;不动读路径、不动 wire 返回结构、不动 R2/BazaarDB。
- **方法**:代码为唯一事实来源,每条结论附 `文件:行号`。
- **基线**:`npm run check` ✅;`npm run test` 33/33 ✅(审计报告记录值)。
- **决策已锁定**:D1 丢弃 NULL 对手;D2 analyzers 不消费 D1 `battles`(跨仓阻塞项已解除);D3 不清理存量死行;D4 采用 **B(SQL 条件 INSERT)** 实现;D5 接受新用户首次上传前已被别人打到的 ghost battle 不会补录/可见。

---

## 目录

1. [前置事实:这是一次"回滚已决决策"](#1-前置事实这是一次回滚已决决策)
2. [需求分析与设计目标](#2-需求分析与设计目标)
3. [数据库设计](#3-数据库设计)
4. [实现方案与步骤](#4-实现方案与步骤)
5. [代码实现示例](#5-代码实现示例)
6. [性能考量与优化](#6-性能考量与优化)
7. [数据一致性与错误处理](#7-数据一致性与错误处理)
8. [迁移与部署方案](#8-迁移与部署方案)
9. [测试验证方案](#9-测试验证方案)
10. [实施清单(可勾选)](#10-实施清单可勾选)

---

## 1. 前置事实:这是一次"回滚已决决策"

这张表与过滤逻辑在 V4 里**曾经存在,且被主动删除**。证据:

- **曾完整实现**:`5f598a0`(*"Project battles in batch with ON CONFLICT, sticky final, seen filter"*)引入 `seen_player_accounts(player_account_id, first_seen_at_utc)` 表,并用 `INSERT ... SELECT ... WHERE` 在写入时过滤。
- **被主动移除**:`a9539ba`(*"Ingest all battle projections"*)删表、改回无条件 `VALUES`,并把规则改成今天 [bazaarplusplus-server/CLAUDE.md](../CLAUDE.md) 里的:
  > Battle projection is full-ingest ... **Do not reintroduce opponent allow-list filtering without updating the API doc, schema, and tests together.**
- **当前 schema 不含该表**:[migrations/0001_v4_initial.sql:1-5](../migrations/0001_v4_initial.sql) 头注释写明 V3 的 *seen-account filter* 已被 collapse;0001 只建 `runs / battles / bazaardb_delivery`。
- **文档已标记移除**:[api-reference.md:135](api-reference.md) — *"Former `seen_player_accounts` opponent filtering removed; battle projections are fully ingested."*

**因此本方案的实现基线 = 恢复 `5f598a0` 已验证过的形态**(而非凭空新写),并按当前 25 列的 `BATTLE_INSERT_SQL` 对齐、按锁定决策收敛。CLAUDE.md 明令的前置条件("API doc + schema + tests 一起改")在 §8/§9 全部落实。

当初选择全量入库的最大疑点是 analyzers 是否依赖 D1 `battles`——**D2 已确认不消费**,该阻塞项解除,本改动回归为低风险、可秒级回滚。

---

## 2. 需求分析与设计目标

### 2.1 为什么过滤有意义(数据模型推导)

幽灵战斗读写非对称,这是方案根基:

- **写**:玩家 A 上传 run,`battles` 行 `player_account_id = A`(上传者)、`opponent_account_id = B/C/D`(A 打到的幽灵对手)。见 [upload.ts:568-602](../src/features/runBundles/upload.ts)——`player_account_id` 永远写 metadata 级上传者,`opponent_account_id` 取自每条 battle 投影。
- **读**:`GET /ghost-battles?player_account_id=X` 的 SQL 是 `WHERE opponent_account_id = X`([query.ts:60](../src/features/ghostBattles/query.ts))。

**推论**:一行 `battles` 只有当 `opponent_account_id` 是某个会来查询的真实 BPP 用户时才可能被读到。异步 PvP 里 A 打到的对手大多是**非 BPP 用户**的全局匹配幽灵,其 `opponent_account_id` 不会出现在正常 BPP 客户端查询参数里 → **近似死行**:占 `battles` 主表与 `idx_battles_opponent_recorded`([migrations/0001:66-68](../migrations/0001_v4_initial.sql))写入成本,通常没有读取价值。

边界取舍(D5):如果 X 是新 BPP 用户,在 X 首次成功上传前,其他玩家已经打到 X 的 ghost battle 会因为 X 尚未进入 `seen_player_accounts` 而被丢弃。服务端没有补录机制,后续 X 即使上传也不会把这些已丢弃 battle 恢复出来。这个冷启动损失已接受;本方案只保证 X 进入 seen 之后的新 battle 被保留。

`seen_player_accounts` = "见过的真实 BPP 账号"集合;"见过"定义为**该账号至少上传过一次 run**。入库时只保留 `opponent_account_id` ∈ 该集合(或自战)的 battle。

### 2.2 解决的核心问题

| 问题 | 证据 | 过滤后 |
|---|---|---|
| 写放大 / D1 写成本 | 每请求最多 200 条 upsert([upload.ts:66](../src/features/runBundles/upload.ts) `MaxBattleProjections`),多数对手永不可查 | 死行不写主表也不写 partial index,按非 BPP 对手占比削减大部分 battle 写入 |
| 表/索引膨胀拖慢热路径 | ghost 查询走 `idx_battles_opponent_recorded` | 索引更小 → 查询更快、缓存更友好 |
| 匿名投毒面(部分缓解) | 无鉴权 + 全量投影 → 任意人可向任意 `opponent_account_id` 投喂伪造对手 | 只能投毒"已 seen 的真实用户",缩小目标集。**不根治 IDOR/投毒**,根治需 P2 鉴权 |

### 2.3 功能范围与边界

- **范围内**:`POST /run-bundles` 按 `opponent_account_id` 过滤 battle;上传者写入 `seen_player_accounts`;新增表 + 迁移 + 回填 + 测试 + 文档/规则同步。
- **范围外(显式声明)**:不改 `GET /ghost-battles` 读路径与 wire 返回;不改 `runs` 投影、R2 写入、BazaarDB;**不清理历史死行**(只向前过滤)。
- **预期效果(可度量)**:已有日志字段 `battles_projected/battles_in_payload`([upload.ts:707](../src/features/runBundles/upload.ts))比值稳态下降;`battles` 表增速放缓;ghost 查询 `phase_ms.d1_read` 不退化或改善。

---

## 3. 数据库设计

### 3.1 表结构(复用旧表最小形态,按要求改名)

```sql
-- migrations/0003_add_seen_player_accounts.sql
CREATE TABLE seen_player_accounts (
  player_account_id           TEXT PRIMARY KEY,   -- 对应 battles.opponent_account_id / runs.player_account_id
  first_seen_at_utc TEXT NOT NULL       -- ISO-8601 UTC，首次被标记 seen 的时间（运维/审计用，不参与过滤）
);
```

设计取舍:

- **不加二级索引**:唯一访问模式是 `player_account_id` 等值/IN 成员判断与 PK upsert,主键 B-tree 已覆盖。额外索引是纯写放大(审计报告发现 #18 批评的零读索引)。
- **`player_account_id` 用 TEXT PRIMARY KEY**:与 `battles.opponent_account_id`、`runs.player_account_id` 同为 TEXT([migrations/0001:43,52](../migrations/0001_v4_initial.sql)),等值比较无类型转换。
- **不加 `last_seen_at_utc`**:旧版该列被证明无人读取而删除,别加回。
- **不建物理外键**:这是派生集合,FK 校验只增成本无收益;关系只体现在入库 SQL 的 WHERE。

### 3.2 与 `battles` 的关系

- `battles.opponent_account_id` →(过滤判断)→ `seen_player_accounts.player_account_id`
- `battles.player_account_id`(= 上传者)→(写入)→ `seen_player_accounts.player_account_id`

### 3.3 数据量增长下的性能

- 行数 = 历史唯一上传者数,是 `runs` 行数的真子集,远小于 `battles`;PK 索引可常驻缓存。
- `opponent IN (SELECT player_account_id FROM seen_player_accounts)`:子查询单列且为 PK、无 WHERE → SQLite 优化为 B-tree 探查,每条 battle `O(log n)`。
- 表**只增不删**(monotonic),无删除碎片,非常规 `VACUUM` 需求。

---

## 4. 实现方案与步骤

### 4.1 过滤数据流

```
POST /run-bundles
  ├─ 解析 + 校验（不变，upload.ts:447-513）
  ├─ findExistingRun 幂等短路（不变，upload.ts:517-529）—— 同 run+同 hash 直接返回，不触碰 seen
  ├─ 构建 D1 batch statements[]:
  │     [0]   runs INSERT（不变）
  │     [1..N] 每条 valid battle 一条“条件 INSERT”:
  │             仅当 opponent == 上传者(自战)  或  opponent ∈ seen_player_accounts  → 写
  │             （否则该语句写 0 行，被静默丢弃；NULL 对手天然落入“否则”分支）
  │     [N+1] INSERT OR IGNORE INTO seen_player_accounts(上传者) —— 放最后
  ├─ putThenProject: R2 put → env.DB.batch(statements)（单事务，原子）
  └─ battles_projected = battle 切片 meta.changes 之和（不变，upload.ts:669-676）
```

### 4.2 核心 SQL（方案 B,25 列对齐当前 `BATTLE_INSERT_SQL`）

把当前 [upload.ts:80-114](../src/features/runBundles/upload.ts) 的 `VALUES (?...)` 改成 `SELECT ?1..?25 WHERE ...`,并改用显式位置参数 `?N`(让 `opponent`、`uploader` 在 WHERE 里复用已绑定值,无需重复绑定):

```sql
INSERT INTO battles (
  battle_id, run_id, recorded_at_utc, day,
  player_name, player_account_id, player_hero, player_rank, player_rating, player_level,
  player_prestige, player_victories,
  opponent_name, opponent_account_id, opponent_hero, opponent_rank, opponent_rating, opponent_level,
  opponent_prestige, opponent_victories,
  result, winner_combatant_id, loser_combatant_id, is_final_battle, updated_at_utc
)
SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25
WHERE ?14 = ?6                                           -- 自战:opponent == uploader（字面量，不依赖子查询）
   OR ?14 IN (SELECT player_account_id FROM seen_player_accounts)      -- 对手是已见的真实 BPP 账号
ON CONFLICT(battle_id) DO UPDATE SET
  run_id = excluded.run_id,
  recorded_at_utc = excluded.recorded_at_utc,
  day = excluded.day,
  player_name = excluded.player_name,
  player_account_id = excluded.player_account_id,
  player_hero = excluded.player_hero,
  player_rank = excluded.player_rank,
  player_rating = excluded.player_rating,
  player_level = excluded.player_level,
  player_prestige = excluded.player_prestige,
  player_victories = excluded.player_victories,
  opponent_name = excluded.opponent_name,
  opponent_account_id = excluded.opponent_account_id,
  opponent_hero = excluded.opponent_hero,
  opponent_rank = excluded.opponent_rank,
  opponent_rating = excluded.opponent_rating,
  opponent_level = excluded.opponent_level,
  opponent_prestige = excluded.opponent_prestige,
  opponent_victories = excluded.opponent_victories,
  result = excluded.result,
  winner_combatant_id = excluded.winner_combatant_id,
  loser_combatant_id = excluded.loser_combatant_id,
  is_final_battle = MAX(battles.is_final_battle, excluded.is_final_battle),   -- sticky，不变
  updated_at_utc = excluded.updated_at_utc
```

`?6 = player_account_id`(上传者)、`?14 = opponent_account_id`。三个正确性不变量(全部来自旧实现踩过的坑,必须固化进规则):

1. **自战分支 `?14 = ?6` 必须字面量比较,不能靠子查询。** 上传者写入 `seen_player_accounts` 的语句在同一 batch(最后一条)。**D1 不保证 batch 内 read-after-write 可见性**,所以"玩家打自己幽灵"不能依赖刚插入的上传者行对前面 battle 子查询可见,须用字面量兜底。
2. **`seen_player_accounts` upsert 放 batch 最后一条。** 它只为后续请求服务,对本请求过滤无影响;放最后还能保持现有 battle 计数切片 `slice(1, 1 + validBattleProjections.length)`([upload.ts:672](../src/features/runBundles/upload.ts))不变。
3. **`ON CONFLICT(battle_id) DO UPDATE` 必须保留**(CLAUDE.md 硬规则):否则批内 battle_id 冲突会回滚整批含 `runs`。`INSERT ... SELECT ... WHERE ... ON CONFLICT` 形态在 SQLite 里需 SELECT 带 WHERE 消解 `ON` 歧义——我们的 WHERE 天然存在,合法。

**NULL 对手(D1=丢弃)**:不写专门分支。`NULL = ?6` 与 `NULL IN (...)` 在 SQL 中均求值为非 true,WHERE 自然挡掉 NULL 对手。

### 4.3 实施步骤(首次 vs 后续)

**首次(部署期,一次性)—— 解决冷启动**:空表会误杀一切。回填唯一可信信号 = 历史上传者(`runs.player_account_id`),**绝不从 `battles.opponent_account_id` 回填**(否则历史随机对手全标 seen,过滤白做):

```sql
INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc)
SELECT player_account_id, MIN(created_at_utc)
FROM runs
GROUP BY player_account_id;
```

一次性全表扫 `runs`(无 `player_account_id` 索引,但表小、低频后端,可接受)。大表场景改为部署后跑一次性 `wrangler d1 execute` 分批回填,迁移只建表。

**后续(稳态)**:每次新上传按 §4.2/§5 自动过滤 + 把上传者纳入 seen。集合随真实用户单调扩张,过滤命中率自我提升(一个对手一旦自己上传过,以后别人打到他的 battle 就被保留)。首次上传前已经被过滤掉的 battle 不回补,这是 D5 已接受取舍。

**存量死行(D3=不动)**:已存在的"对手非 seen"历史行保持可查、停止增长。是否溯源清理是独立破坏性运维动作,不在本次范围。

---

## 5. 代码实现示例

### 5.1 迁移 0003(建表 + 回填)

```sql
-- migrations/0003_add_seen_player_accounts.sql
-- Re-introduces opponent-side ingest filtering for `battles` (reverts a9539ba's
-- full-ingest decision). Only battles whose opponent is a real BPP uploader are
-- kept; see docs/api-reference.md and CLAUDE.md (updated together).

CREATE TABLE seen_player_accounts (
  player_account_id           TEXT PRIMARY KEY,
  first_seen_at_utc TEXT NOT NULL
);

-- Cold-start backfill: seed from historical uploaders only (NOT opponents).
INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc)
SELECT player_account_id, MIN(created_at_utc)
FROM runs
GROUP BY player_account_id;
```

### 5.2 `upload.ts` 改动要点

- `BATTLE_INSERT_SQL` 换成 §4.2 的条件 INSERT;绑定从 `?` 改 `?1..?25`,参数顺序与现状完全一致([upload.ts:574-600](../src/features/runBundles/upload.ts)),**无需新增绑定值**——`?6`/`?14` 复用 `playerAccountId`/`opponentAccountId`。

```ts
// 循环不变；仅 SQL 与“?N”语义变化。opponentAccountId(?14)、playerAccountId(?6) 已在绑定列表里。
for (const battle of validBattleProjections) {
  const opponentAccountId = optionalTrimmedString(battle.opponent_account_id);
  const isFinalBattle =
    battle.is_final_battle === true || battle.is_final_battle === 1 ? 1 : 0;
  statements.push(
    env.DB.prepare(BATTLE_INSERT_SQL).bind(
      optionalTrimmedString(battle.battle_id),   // ?1
      runId,                                      // ?2
      battle.recorded_at_utc_normalized,          // ?3
      optionalFiniteNumber(battle.day),           // ?4
      optionalTrimmedString(battle.player_name),  // ?5
      playerAccountId,                            // ?6  ← 上传者；WHERE 自战分支复用
      optionalTrimmedString(battle.player_hero),  // ?7
      optionalTrimmedString(battle.player_rank),  // ?8
      optionalFiniteNumber(battle.player_rating), // ?9
      optionalFiniteNumber(battle.player_level),  // ?10
      optionalFiniteNumber(battle.player_prestige),   // ?11
      optionalFiniteNumber(battle.player_victories),  // ?12
      optionalTrimmedString(battle.opponent_name),    // ?13
      opponentAccountId,                          // ?14 ← 对手；WHERE 成员判断复用
      optionalTrimmedString(battle.opponent_hero),    // ?15
      optionalTrimmedString(battle.opponent_rank),    // ?16
      optionalFiniteNumber(battle.opponent_rating),   // ?17
      optionalFiniteNumber(battle.opponent_level),    // ?18
      optionalFiniteNumber(battle.opponent_prestige), // ?19
      optionalFiniteNumber(battle.opponent_victories),// ?20
      optionalTrimmedString(battle.result),       // ?21
      optionalTrimmedString(battle.winner_combatant_id), // ?22
      optionalTrimmedString(battle.loser_combatant_id),  // ?23
      isFinalBattle,                              // ?24
      nowUtc,                                     // ?25
    ),
  );
}

// 紧跟 battle 循环之后、env.DB.batch(statements) 之前。放末尾以保持 battle 计数切片不变。
statements.push(
  env.DB.prepare(
    "INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc) VALUES (?, ?)",
  ).bind(playerAccountId, nowUtc),
);
```

`battles_projected` 计数天然正确:被过滤的条件 INSERT 写 0 行 → `meta.changes = 0`;命中 `ON CONFLICT` 写 1 行。现有 reduce([upload.ts:673-676](../src/features/runBundles/upload.ts))无需改。建议日志加一行 `battles_filtered: battleProjections.length - skippedBattleProjections - battlesActuallyWritten` 增强可观测性。

### 5.3 更新 seen 表的时机与方式

- **时机**:每个**新** run 成功入库的同一 batch(幂等短路命中的重传不写,[upload.ts:517-529](../src/features/runBundles/upload.ts))。
- **方式**:`INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc) VALUES (?, ?)`,绑定 `playerAccountId` 与 `nowUtc`。
- **只写上传者,绝不写对手**。
- **原子性**:在 batch 内,batch 失败随之回滚,无孤儿。

---

## 6. 性能考量与优化

- **每条 battle**:多一次 `opponent IN (SELECT player_account_id FROM seen_player_accounts)` 的 PK 探查,`O(log n)`,微秒级;`?14 = ?6` 字面量比较几乎免费。
- **每请求**:多一条 `INSERT OR IGNORE` 到窄表。
- **净效应是写入下降**:被过滤的 battle 不写 `battles` 主表、不写 `idx_battles_opponent_recorded`。D1 按写入行计费 → 直接省成本 + 表与索引更小 → ghost 读路径更快。
- **索引优化**:`seen_player_accounts` 只要 PK;用 `x IN (SELECT pk FROM t)` 形态触发索引成员判断,避免阻止索引使用的写法。
- **上线前**用 `sqlite3 :memory:` + `EXPLAIN QUERY PLAN` 验证条件 INSERT 的 SELECT 子句对 `seen_player_accounts` 命中 PK(审计报告同款取证;CLAUDE.md "热路径 SQL 先估算扫描形状"硬要求)。
- **大数据量**:回填小表放迁移、大表用部署后分批脚本;未来若清存量须分批 `DELETE ... LIMIT` 避免大事务锁表。

---

## 7. 数据一致性与错误处理

- **强一致由单一 batch 事务保证**:`runs` INSERT、N 条 battle 条件 INSERT、seen upsert 都在 `env.DB.batch(statements)`([upload.ts:613](../src/features/runBundles/upload.ts))这一个隐式事务里,全成功或全回滚——不会"标了 seen 但 battle/run 没落库"或反之。
- **与 R2 编排不变**:`putThenProject`([putThenProject.ts](../src/storage/putThenProject.ts))"先复查再清理"不变量继续生效;batch 失败 → seen 行随事务回滚 + R2 按既有逻辑清理,无新增孤儿路径。
- **批内可见性陷阱(关键)**:D1 不保证 batch 内 read-after-write,故本请求上传者的 seen 行不可被本请求 battle 子查询依赖 → 自战必须走 `?14 = ?6` 字面量。固化进规则。
- **并发/冷启动入库**:`seen_player_accounts` 只增不删 + `INSERT OR IGNORE` 幂等 → 无需锁。A 打 X 的 bundle 与 X 自己的 bundle 并发,若 A 的事务快照早于 X 的 seen 提交,A 这条被丢;同理 X 首次上传前被别人打到的 battle 也会丢弃且不回补。D5 已接受该窗口损失;一致性目标是"seen 提交后的新 battle 会被保留",不是历史补录。
- **异常处理**:沿用现有 `logWarn` 分支(`d1_batch_failed_*`,[upload.ts:630-666](../src/features/runBundles/upload.ts));**无新错误码,response/error shape 不变**。`POST /run-bundles` 的 battle projection 入库语义会改变,按 §8.4 同步 API doc / 规则 / 测试。

---

## 8. 迁移与部署方案

### 8.1 现有系统影响评估

- **wire 契约**:`opponent_account_id` 从"全量写入"变"过滤门" → **必须**同步改 [api-reference.md:91](api-reference.md)、:135 与 [CLAUDE.md](../CLAUDE.md) 的 full-ingest 规则(CLAUDE.md 明令的前置条件)。
- **跨仓 analyzers**:D2 已确认**不消费** D1 `battles` → 无指标口径影响,阻塞解除。
- **跨仓 mod 客户端**:mod 按 `opponent` 读,自己上传的 battle 不按同 key 读回,预计无影响;开 PR 时只读核对 `../bazaarplusplus-mod/tests/GhostBattleSync.Tests`。
- **R2 / BazaarDB / `runs` 投影 / `GET /ghost-battles` 读路径**:零影响。

### 8.2 平滑迁移步骤

1. PR:迁移 0003(建表+从 `runs` 回填)+ `upload.ts` + 测试 + 文档/规则。`npm run check && npm run test` 全绿。
2. **先显式应用远端 D1 迁移**:`wrangler d1 migrations apply DB --remote`。不能依赖 `wrangler deploy` 自动执行 D1 migration;当前 `package.json` 的 deploy 脚本只是 `wrangler deploy`([package.json:11](../package.json)),`wrangler.toml` 只声明 `migrations_dir`([wrangler.toml:25-29](../wrangler.toml))。
3. **再部署 Worker**:`wrangler deploy --keep-vars`。这样新代码引用 `seen_player_accounts` 前,线上 D1 已有表和历史上传者回填。
4. **部署后立即补一次 catch-up 回填**:

   ```sql
   INSERT OR IGNORE INTO seen_player_accounts (player_account_id, first_seen_at_utc)
   SELECT player_account_id, MIN(created_at_utc)
   FROM runs
   GROUP BY player_account_id;
   ```

   目的:覆盖"远端迁移回填完成后、Worker 新代码生效前"这段窗口里的上传者。否则这些上传者的 run 已存在,但后续同 `run_id` + 同 artifact 的幂等重传会在 [upload.ts:517-529](../src/features/runBundles/upload.ts) 直接返回,不会补写 seen。
5. 观察 `battles_projected/battles_in_payload` 与 ghost 查询延迟。

### 8.3 回滚方案

- **代码回滚(秒级、低爆炸半径)**:`git revert` upload.ts,恢复无条件 `VALUES` 全量入库。过滤是纯入库期行为,**存量行不受影响**,回滚后新上传立刻恢复全量。
- **表处理**:回滚代码后 `seen_player_accounts` 成无害未用表,**先留着别删**;彻底放弃时再发 `DROP TABLE` 前向迁移(D1 迁移前向,"回滚"=新迁移)。
- **零存量删除 → 无不可逆动作**,这是本方案刻意保持的低风险特性。

### 8.4 文档/规则同步清单(CLAUDE.md 硬要求,以"建议修改"提交,人确认后落)

| 文件 | 改动 |
|---|---|
| [api-reference.md:91](api-reference.md) | `opponent_account_id` 行改为过滤门语义:`row written only if it equals the uploader, or the opponent is in seen_player_accounts; NULL opponent rows are dropped` |
| [api-reference.md:135](api-reference.md) | 把"Former seen_player_accounts ... fully ingested"改为现行过滤语义 + 最终一致性说明 |
| [bazaarplusplus-server/CLAUDE.md](../CLAUDE.md) | 用新过滤规则替换 full-ingest 规则,并固化两条不变量:① seen upsert 必须是 batch 最后一条;② 自战走字面量 `?14=?6`,不依赖批内可见性 |

---

## 9. 测试验证方案

### 9.1 会被破坏、必须改的现有测试(CLAUDE.md "tests together" 落点)

| 测试 | 现状断言 | 新断言 |
|---|---|---|
| [runBundles.battles.test.ts:61-74](../test/runBundles.battles.test.ts) "opponent not seen before → projected" | `battles == 1` | 对手未 seen → `battles == 0`(改测试名/语义) |
| [runBundles.battles.test.ts:204-217](../test/runBundles.battles.test.ts) "NULL opponent → projected" | `battles == 1` | D1=丢弃 → `battles == 0`(改测试名/语义) |
| [runBundles.battles.test.ts:189-202](../test/runBundles.battles.test.ts) "self-battle → projected" | `battles == 1` | 仍 `== 1`,**显式注释**它现在靠 `?14=?6` 字面量分支成立(回归保护批内可见性不变量) |
| [ghostBattles.query.test.ts:57-91](../test/ghostBattles.query.test.ts) "returns battles where opponent = param" | 直接上传 opponent=`ghost-target` | 过滤后这条会被丢 → 需**先让 `ghost-target` 进 seen**(旧版正是这么做的,a9539ba 删了那行 seed),否则结果为空误失败 |
| [ghostBattles.query.test.ts](../test/ghostBattles.query.test.ts) sticky 测试 | opponent=`ghost-target`(uploader-A/B) | 同上,需先 seed `ghost-target` |

### 9.2 测试基建改动

- [test/helpers/seed.ts](../test/helpers/seed.ts):`resetTestState` 的 DELETE batch 加 `DELETE FROM seen_player_accounts`;`countRows` 联合类型加 `"seen_player_accounts"`;重新引入 `insertSeenPlayerAccount(db, {playerAccountId, firstSeenAtUtc})` 助手(旧版有,被 a9539ba 删,照抄改名)。
- [test/schema.test.ts](../test/schema.test.ts):加断言 `seen_player_accounts` 表存在、`player_account_id` 为 PK。

### 9.3 新增功能/场景测试(只测真实分支,避免覆盖率剧场)

1. 对手在 seen → 入库;对手不在 seen → 丢弃。
2. NULL 对手 → 丢弃(D1)。
3. 上传者首次上传后被写入 `seen_player_accounts`(count==1、player_account_id 正确)。
4. **最终一致性**:先 A 打 X(X 未 seen)→ 丢;再 X 自己上传(X 入 seen);再 A 打 X → 入库。
5. 自战(opponent==uploader)即使 uploader 此前不在 seen 仍入库(字面量分支)。
6. 同 batch 多条 battle、对手有 seen 有不 seen → 部分入库,`battles_projected` 计数正确。
7. 回填:迁移后,历史 `runs` 每个唯一 uploader 都进了 `seen_player_accounts`。
8. `ON CONFLICT(battle_id)` 仍防批内回滚(保留旧回归用例)。

### 9.4 正确性 + 性能验证

- `npm run check`(双 tsconfig)+ `npm run test`(vitest workers pool)全绿,基线 33/33。
- `sqlite3 :memory:` + `EXPLAIN QUERY PLAN` 验证条件 INSERT 的 `IN (SELECT player_account_id ...)` 命中 PK。
- 部署后看 `battles_projected/battles_in_payload` 与 ghost 查询 `phase_ms.d1_read`。

---

## 10. 实施清单(可勾选)

- [ ] 新增 `migrations/0003_add_seen_player_accounts.sql`(建表 + 从 `runs` 回填)。
- [ ] 改 `src/features/runBundles/upload.ts`:`BATTLE_INSERT_SQL` → 条件 INSERT(`?1..?25` + `WHERE ?14=?6 OR ?14 IN (...)`);循环后追加上传者 seen upsert(数组末尾);可选加 `battles_filtered` 日志。
- [ ] 改测试:9.1 的 5 处现有断言 + 9.2 基建 + 9.3 新增 8 例。
- [ ] 文档/规则:8.4 的 api-reference.md ×2 + CLAUDE.md(以"建议修改"提交)。
- [ ] `npm run check && npm run test` 全绿;`EXPLAIN QUERY PLAN` 取证。
- [ ] 部署顺序按 8.2 执行:先 `wrangler d1 migrations apply DB --remote`,再 `wrangler deploy --keep-vars`,最后跑一次 post-deploy catch-up 回填。
- [ ] 部署后观测比值与延迟。

---

### 一句话总结

低风险、可秒级回滚、复用已验证旧实现(`5f598a0`)的改动;唯一高风险点(analyzers 口径)已被 D2 排除。主要工程量在"按 CLAUDE.md 要求把 schema + API doc + 规则 + 测试一起改"。
