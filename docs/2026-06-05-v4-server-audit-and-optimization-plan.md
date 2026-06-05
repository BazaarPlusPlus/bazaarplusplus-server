# V4 Server 审计报告与优化方案

- **日期**:2026-06-05
- **范围**:`bazaarplusplus-server`(V4 mod-facing 后端,`mod-api-v4.bazaarplusplus.com`,Cloudflare Workers / D1 / R2 / aws4fetch)。**只读审计**,本文档不含任何代码改动。
- **方法**:代码为唯一事实来源,每条结论附 `文件:行号`;文档/CLAUDE.md 与代码冲突时以代码为准并记为漂移。多智能体审计(6 维度 finder + 对抗验证 + 完整性批判)叠加人工通读全部 `src/`、两份文档、迁移、测试,并跑了 `sqlite3 :memory:` 的 `EXPLAIN QUERY PLAN` 与 aws4fetch 1.0.20 源码取证。
- **基线**:`npm run check` ✅;`npm run test` 33/33 ✅。
- **边界**:验证仅用 `npm run check` / `npm run test`,不跑 `wrangler deploy`,不动 secret,不碰已冻结的 V3。跨仓(mod 客户端 / analyzers)默认不在范围,仅在 wire 契约受影响时提示。

---

## 目录

1. [背景与已决事项](#1-背景与已决事项)
2. [执行摘要](#2-执行摘要)
3. [决策记录](#3-决策记录)
4. [优化方案 P0–P3](#4-优化方案-p0p3)
5. [文档与规则同步清单](#5-文档与规则同步清单)
6. [执行顺序与打包](#6-执行顺序与打包)
- [附录 A：完整发现清单](#附录-a完整发现清单)
- [附录 B：幽灵回放 403 专项结论](#附录-b幽灵回放-403-专项结论)
- [附录 C：被证伪/驳回的发现](#附录-c被证伪驳回的发现)

---

## 1. 背景与已决事项

本次审计起于**幽灵回放预签名 URL 返回 403**。已查明并处置:

- **403 根因(已定位)**:服务端处理器从不返回 403——`replay-link` 只有 200 / 404 `battle_not_found` / 410 `artifact_expired`(`src/features/ghostBattles/replayLink.ts:30,35,46`),bazaardb 拉取经 `requireBearer` 返回 **401**(`src/http/auth.ts:32,38`)。用户可见的 403 来自客户端实际 GET R2 预签名 URL 时被 SigV4 拒绝。经确认,**当前 R2 API Token 仅有 bazaardb 桶权限**:
  - `peek` 正常——head/put/delete 走绑定 `env.BAZAARDB_BUCKET`(不用 token),presign 签 bazaardb 桶,token 有权。
  - `replay-link` 异常——`head()` 走绑定 `env.RUN_BUNDLE_BUCKET`(不用 token)故返回 200,但 presign 签 `run-bundles` 桶,token **无权** → 客户端 GET 该 URL → **403 AccessDenied**。
  - 关键机制:R2 绑定(`env.*_BUCKET`)是 Workers 原生绑定,不使用 S3 token;token 唯一职责是给 `presign.ts` 签 GET URL。
- **403 处置(进行中,ops)**:重新签发一个**覆盖两个桶**的 R2 API Token(**Object Read** 即足够,因 presign 只签 GET;put/delete 走绑定),scope 取 Account 级或显式两个 v4 桶,`wrangler secret put R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY`(`R2_ACCOUNT_ID` 不变)。**此项不在本方案代码范围内。**
- **不合并桶**:见 [决策记录](#3-决策记录)。

> 本文档覆盖**除 KEY 轮换之外**的所有优化项。

> **执行补记(2026-06-05)**:本文的审计段落保留原始发现口径;实现已完成 P0、P1、P3 的 repo-local 项,并额外把新 run-bundle R2 key 改为 `run-bundles/<uuid>.mpack.gz`(`src/features/runBundles/upload.ts:270`),避免 replay 预签 URL 路径泄露 `player_account_id`/`run_id` 或让不同 run 因相同 artifact hash 共享对象(`test/runBundles.parse.test.ts:62-66`,`test/runBundles.battles.test.ts:260-269`)。P2 仍是决策项:现有 mod 测试断言 replay-link 请求不带 Authorization(`../bazaarplusplus-mod/tests/GhostBattleSync.Tests/Program.cs:829-830`),当前 live `/ghost-battles` 可直达 Worker 返回 200,而可用 Wrangler OAuth token 对 WAF / Rate Limiting / Access 规则读取均返回 403,因此鉴权或边缘限流需要单独拍板/授权后再开轨。

---

## 2. 执行摘要

整体结论:**无 Critical、无存活 High**。代码基础健康(热路径 SQL 命中索引、`env.ts` 纪律达标、`presign.ts` 是干净的深模块)。需处理的集中在:

| # | 一句话 | 严重度 |
|---|---|---|
| 1 | run-bundle 并发上传竞态:败者清理删掉胜者刚提交的制品 → 该 run 回放永久 410 | Medium(数据丢失) |
| 2 | bazaardb peek 在 claim 后才构造 presigner:secret 缺失会消耗 attempts 并删快照 | Medium(数据丢失) |
| 3 | `server CLAUDE.md` 的 `is_final_battle` 规则与代码逐句相反(`945249e` 后该列已是活跃 wire 字段) | Medium(文档漂移) |
| 4 | BazaarDB 集成文档承诺 at-least-once / 无限重投,代码 3 次后永久 failed 并删对象 | Medium(文档漂移) |
| 5 | 根 `bpp/CLAUDE.md` 仍称 server "serves the BazaarDB screenshot manifest"(路由已删) | Medium(文档漂移) |
| 6 | `replay-link` 与 `/run-bundles` 均零鉴权(IDOR + ghost feed 投毒 + 无限流) | Medium(安全) |
| 7 | 桶名硬编码与绑定双源,运行时不可自检 → 未来改名会复现 head 过/签名 403 的不对称故障 | Low(防复发) |
| 8 | 一批 V3→V5 移植死代码与投机配置 | Low |
| 9 | 可观测性盲区:409 / 4xx / 404 / 410 / 未捕获 500 全部静默 | Low |
| 10 | 热路径 SQL 形状健康:ghost 查询经 EXPLAIN 验证命中部分索引、无排序、LIMIT 钳 200 | (无需改) |

---

## 3. 决策记录

> 以下为本次划范围时确认的决策,记录于此以防被反复重提。建议后续落为 `docs/adr/`。

### D-1　保留两个 R2 桶,不合并

- **决策**:保留 `bazaarplusplus-run-bundles-v4` 与 `bazaarplusplus-bazaardb-snapshots-v4` 两个桶。403 用修 token scope 解决,不合并。
- **理由(load-bearing)**:两者生命周期本质不同——run-bundle 是半持久回放制品(由 R2 lifecycle 过期删,见 `CLAUDE.md` "R2 lifecycle lives in the CF dashboard"),bazaardb 快照是 confirm 后即删的瞬时投递队列(`src/features/bazaardb/confirm.ts:68`、`src/features/bazaardb/peek.ts:39`)。合并后需用按前缀的 lifecycle 规则管两套保留策略,更易错;且不能解决 account 错配/密钥轮换类故障。修 token scope 是零代码、零迁移的最小解。
- **后果**:桶名硬编码的 footgun 仍在 → 见 P1-1(env 化防复发)。

### D-2　`is_final_battle` 已是活跃 wire 字段

- **决策**:`is_final_battle` 是 V4 wire 契约的一部分(上传 boolean 可选、sticky;查询返回 boolean),**不**恢复旧的"不暴露"行为。
- **理由**:commit `945249e`("Add final battle metadata to ghost battle API")已将其激活——`src/features/runBundles/upload.ts:77,102,323` 写入(`MAX()` sticky),`src/features/ghostBattles/query.ts:58,93` 读取返回,`docs/api-reference.md:101,179` 收录,`test/ghostBattles.query.test.ts:83,120-124` 断言其存在。`server CLAUDE.md:8` 那条"占位列/不暴露"规则未同步 → 规则漂移(P1-2 修文档,不动代码)。

---

## 4. 优化方案 P0–P3

> 每项含:动机 / 文件 / 改法 / 收益 / 风险·回滚 / 验证 / 文档同步。验证统一 `npm run check && npm run test`。

### P0 — 数据丢失,优先

#### P0-1　run-bundle 并发上传竞态删制品

- **动机(修复前)**:`object_key` 由内容哈希确定性派生(`src/features/runBundles/upload.ts:238-239`),同 `run_id` + 同字节的两个并发上传得到相同 key;败者 D1 batch 因 `runs` 主键冲突回滚(`RUNS_INSERT_SQL` 无 `ON CONFLICT`,`:60-68`),catch 块**先 delete 后复查**(`:341` 早于 `:359`)→ 删掉胜者已提交行引用的对象 → 该 run 所有 `replay-link` 此后恒 410(`replayLink.ts:33-35` head 返回 null)。
- **文件**:`src/features/runBundles/upload.ts:339-372`。
- **改法**:catch 内**先**做 `racedExistingRun` 复查,仅当"无已提交行"或"已提交行 `object_key` 与本次不同"时才 `delete`。可选更彻底:`RUNS_INSERT_SQL` 改 `ON CONFLICT(run_id) DO NOTHING` + 用 `meta.changes` 分胜负,消除 batch 因主键冲突失败的路径。
- **实际实现补充**:新上传改用 UUID object key(`src/features/runBundles/upload.ts:270`),所以并发败者只清理自己刚 put 的未提交对象;同 artifact 的不同 run 也不会共享 R2 key(`test/runBundles.battles.test.ts:260-269`)。
- **收益**:消除并发数据丢失。
- **风险·回滚**:catch 重排为最小改动,风险低;git 还原。
- **验证**:新增回归测试——先插 `runs` 行 → 触发 batch 失败 → 断言 R2 对象仍在。
- **文档同步**:无需。

#### P0-2　bazaardb peek 的 presigner 顺序

- **动机**:`createR2Presigner` 在 claim(`delivery_attempts + 1`,`src/features/bazaardb/peek.ts:90`)**之后**才构造(`:148`);env 缺失会抛普通 Error(`src/crypto/presign.ts:13-17`)→ 该请求 500,但 attempts 已消耗且行被租住。BazaarDB 每 1–5 分钟重试,租约 600s 过期后再 claim,3 次(`MaxDeliveryAttempts=3`,`delivery.ts:3`)后 `failMaxAttemptRows` 置 failed 并删 R2 对象(`:19-39`)→ 一次配置事故在约 30 分钟内烧光待投递队列,confirm 前 R2 对象是唯一存储,不可恢复。
- **文件**:`src/features/bazaardb/peek.ts`。
- **改法**:把 `createR2Presigner(env, BazaarDbBucketName)` 上移到 `requireBearer`(`:74-75`)之后、`failMaxAttemptRows`/claim(`:81`)之前 → env 缺失在消耗任何 attempts 前 fail-fast。顺带:`failMaxAttemptRows` 触发记 `logWarn`(现仅在 delete 失败才记日志),使批量失败可观测。可选:区分"服务端签名失败"与"BazaarDB 下载失败",前者不计入 `delivery_attempts`。
- **收益**:配置事故不再吃掉投递队列。
- **风险·回滚**:纯顺序调整,风险低;git 还原。
- **验证**:补"secret 缺失时不改 attempts/不删对象"单测。
- **文档同步**:无需。

> **说明**:P0-2 修的是"secret 缺失 → 500"路径。"token scope 错"那条数据丢失路径(BazaarDB GET 403 → 不 confirm → 3 次后删快照)**本地签名不报错**,只能靠修 token(已在 ops 处置)解决;但当前 403 在 replay-link、peek 正常,故 bazaardb 队列未被烧。可一次性核对历史损失:`SELECT count(*) FROM bazaardb_delivery WHERE failure_reason='max_delivery_attempts'`。

#### P0 后续(不与 P0-1/P0-2 合并):两阶段编排抽成深模块

- **动机**:`runBundles/upload.ts:241-373` 与 `bazaardb/upload.ts:89-133` 都是 "put R2 → 写 D1 → 失败清理孤儿 → 竞态复查",两份实现已开始漂移,且 P0-1 的 bug 正出在其中一份的清理顺序。
- **为什么后置**:两条路径语义不同——run-bundle 原为确定性 `object_key` + `runs.run_id` 幂等/冲突 + D1 batch(当前实现已改为 UUID object key);BazaarDB snapshot 是随机 `r2_key` + `snapshot_id` 幂等 + 单行 insert。先用最小重排修掉数据丢失,再抽象,避免把 correctness fix 和结构重构绑在一个 PR 里。
- **改法**:抽 `putThenProject(...)` 时只封装"失败后先复查、确认本次对象未被已提交行引用才删除"这条不变量;冲突判定、返回码、batch/single insert 差异仍由调用方提供。
- **验证**:P0-1/P0-2 回归测试已稳定后再加抽象层测试 + `npm run test`。

### P1 — 防复发 + 文档同步 + 边界硬化

#### P1-1　桶名 env 化 + 配置一致性测试(防 name-drift 403 复发)

- **动机**:同一桶有两个名字来源——`wrangler.toml:24-31` 的 `bucket_name`(决定绑定指向)与 src 里的硬编码常量(决定签名 URL 指向):`src/features/ghostBattles/replayLink.ts:7`、`src/features/bazaardb/delivery.ts:1`。R2 绑定运行时不暴露桶名 → 漂移不可自检。`88a76d2` 改 bazaardb 桶名时就得同步改两处,漏一处 = head 过/签名 403,日志全正常,极难查(正是本次 403 的同类结构成因)。
- **文件**:`wrangler.toml`(加 `[vars]`)、`src/env.ts:1-10`、`replayLink.ts:7,38`、`bazaardb/delivery.ts:1`、`bazaardb/peek.ts:148`。
- **改法**:`[vars] RUN_BUNDLE_BUCKET_NAME / BAZAARDB_BUCKET_NAME` → 加入 `Env`(符合"`Env` 是唯一绑定声明处"规则)→ presign 调用处读 `env`,删除 TS 硬编码常量。**必须**补测试解析 `wrangler.toml`,断言每个 presign var 与对应 `[[r2_buckets]].bucket_name` 完全一致。
- **收益**:无法在运行时从 R2 binding 反查桶名,所以严格意义上仍是配置双源;该改法的价值是把漂移从运行时 403 提前到 CI/测试暴露。
- **风险·回滚**:低,纯重构;`npm run check` 兜底。
- **验证**:`npm run check && npm run test`。
- **文档同步**:无需(配置自文档)。

#### P1-2　文档/规则漂移批量同步

- **动机**:多处文档与代码矛盾,误导后续 agent 与外部合作方。
- **文件**:见 [§5 同步清单](#5-文档与规则同步清单)。
- **风险·回滚**:零(纯文档)。按本仓规则,`CLAUDE.md` / `.rules` 改动以"建议"提交,由人确认后落,不在常规改动中内联编辑。
- **验证**:无需。

#### P1-3　边界硬化

- **动机**:几处输入边界缺失 → 非契约 500 / 404 NoSuchKey / 无界写放大 / 永不老化行。
- **文件 + 改法**:
  - **畸形 multipart**:`upload.ts:142` 的 `await request.formData()` 包 try/catch → `throw jsonError("invalid_run_bundle_request")`(现抛 TypeError → `index.ts:60` 仅转 `instanceof Response`,其余重抛成无 CORS 的通用 500)。
  - **key 点段**:`src/http/validation.ts:9` 正则排除纯点段,如 `^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$`(`.`/`..` 经 `presign.ts:38` 的 `new URL` 归一化使签名 URL 指向另一 key → 404 NoSuchKey)。注意 `objectKeySegment` 同时约束 run-bundle 的 `player_account_id`/`run_id` 和 BazaarDB snapshot path id,测试与文档要覆盖两类入口。
  - **数量上限**:`upload.ts:206-219` 校验循环前加 `battle_projections.length > 200 → 400 too_many_battle_projections`(上限取正常 run 战斗数的安全倍数)。
  - **时间上界**:`query.ts:45-47` 或投影侧校验 `recorded_at_utc <= now + skew`,防客户端写未来时间戳行永不老化。
- **收益**:堵非契约 500、404、无界写放大、脏数据。
- **风险·回滚**:更严格校验,注意阈值别误拒真实请求;逐项独立可回滚。
- **验证**:各加一条 parse/边界测试。
- **文档同步**:`api-reference.md` run-bundle 错误表补 400 / 413 / `too_many_battle_projections`;snapshot path 参数正则同步排除 `.`/`..`。

#### P1-4　幂等/合并语义固化

- **动机**:幂等键只基于 artifact 字节(`upload.ts:223`);同 `run_id` + 同 artifact 的重传在 battle upsert 前短路返回 200(`:230-237`),却不刷新任何投影 → "已成功"假象。另:`is_final_battle` 用 `MAX` 单向闩锁(`:102`),其余 23 字段 last-writer-wins,跨 run 碰撞产生拼接行(`ghostBattles.query.test.ts:120-124` 正断言该状态)。
- **文件**:`upload.ts:102,230-237`;`docs/api-reference.md`;需只读核对 `bazaarplusplus-mod` 上传器。
- **已核对 mod 上传器**:当前 `RunBundleUploadService` 收到 2xx 后调用 `MarkRunUploaded` 清 `dirty`;失败才保留重试。因此现有客户端不会在服务端返回 200 后依赖"纠正性重传"刷新投影。
- **改法**:`api-reference.md` 显式声明"同 `run_id` + 同 artifact 的幂等重传不刷新投影,客户端不得依赖重传修正已落库的 projection"+ 回归测试;`is_final_battle` 合并语义要么改 `= excluded` 与其余字段一致,要么文档说明跨 run 碰撞时可能与当前行视角错位。若要支持纠正性重传,应另开 wire contract 设计,不在本优化批次内隐式实现。
- **收益**:消除"200 假象"与 flag 错位歧义。
- **风险·回滚**:改合并语义会动 sticky 行为 → 需同步 `ghostBattles.query.test.ts:120-124` 断言;先决策再动。
- **验证**:`npm run test`。
- **文档同步**:`api-reference.md` run-bundle 节。

### P2 — 安全(需先决策 + 跨仓协调,单独成轨)

> 三项均 Medium,但**会改 wire 契约 / 需 mod 客户端配合**——第一步是决策,不是写码。

- **前置验证(只读)**:`mod-api-v4.bazaarplusplus.com` 自定义域前是否已配 Cloudflare WAF / Rate Limiting / Access(本仓不可见,`wrangler.toml` 与 `src/` 中无相关绑定)。若已有边缘防护,以下紧迫度下降。
- **P2-1 replay-link IDOR**:`replayLink.ts:9-39` 忽略调用方身份(`_request` 从不读取),`index.ts:47-56` 无 bearer → 任意 `battle_id` 可换他人完整 run 制品的 5 分钟下载 URL,且 URL 路径暴露上传者 `account_id`。
- **P2-2 /run-bundles 无鉴权 + 投毒**:`index.ts:20` 无鉴权,`player_account_id` / `opponent_account_id` 全由请求体提供(`upload.ts:294,305,313`),全量投影 + `query.ts:60` 的 `WHERE opponent_account_id = ?` → 匿名可向任意受害者 ghost feed 投喂伪造对手并毒化下游 analyzers;每请求最多 8 MiB R2 + N 条 upsert 而无配额。
- **P2-3 /ghost-battles 无鉴权回吐可识别玩家元数据**:`query.ts:70-89` 返回 player_name/account_id/rank/rating 及对手全套,与 spec(`2026-05-25-v4-server-split-design.md:62,338`)对 manifest "可识别元数据不能公开 enumerable、保留 bearer" 的结论自相矛盾,可枚举自举并为 P2-1 提供 `battle_id` 来源。
- **已完成的 server-local 缓解**:新 run-bundle R2 key 不再包含 `player_account_id`/`run_id`/artifact hash,降低 replay-link 预签 URL 路径暴露面;这不解决 IDOR、投毒或枚举本身。
- **方案选项(需拍板)**:(a) mod-facing 读/写引入轻量 token/HMAC(`auth.ts:constantTimeEquals` 已具基础);(b) 调用方-account 绑定校验;(c) 边缘 Rate Limiting + 维持现状并在 spec 显式记为"已评估可接受风险"。
- **风险·回滚**:改契约影响 mod,需协调发版;回滚需同步两端。
- **验证**:鉴权单测 + `npm run test` + mod 客户端联调。
- **待验证假设**:`battle_id` 的熵由 mod 端生成(本仓不可见);CF 边缘是否已有限流。

### P3 — 结构与性能卫生(低风险,可批量)

- **死代码清扫**(一个 PR,`npm run check` 证伪"其实有人用"):
  - 零调用方导出:`src/http/json.ts:23` `readJson`、`src/http/request.ts:112` `absolutePath`、`src/http/validation.ts:144` `hasPngMagic`、`src/observability.ts:35,39-65,67-81` `logError`/`parseErrorBody`/`logResponseWarning`(后两者解析本服务从不产生的 V3 错误形状)、`validation.ts:11-31` 的 4 个未用字段类型(`string?`/`finiteNumber?`/`base64`/`boolean?`)及连带的 `base64ToBytes` 死链、`test/helpers/crypto.ts` 孤儿。
  - 投机配置:`src/http/cors.ts:2-7` 的 `x-bpp-timestamp`/`x-bpp-content-sha256`/`x-bpp-signature`(无任何消费方;`auth.ts:16-24` 注释自承签名功能已删)——删除或在 `cors.ts` 注明"投机保留"理由。
  - 死遥测:`replayLink.ts:43` 的 `presign_key_cached: false`(指向不存在的 presign 缓存)。
- **两阶段编排抽 `putThenProject`**:后置到 P0 回归测试稳定后(见 P0 后续);`readOptionalJsonObject`(现居 `bazaardb/delivery.ts`)上提到 `http/`。
- **统一路由表**:`index.ts:18-56` 的 `StaticRoutes` 表 + 两段内联正则(snapshots `:36-45`、replay-link `:47-56`)统一为 `{ method, pattern, handle(req, env, params) }` 表,`decodeURIComponent` + `withCors` 收进单一分发循环——也是 P2 鉴权中间件的天然挂点。
- **可观测性补盲**:`index.ts:59-62`(未捕获 500)、`upload.ts:233`(409 冲突)、`replayLink.ts:30,35`(404/410)处补结构化日志(`logWarn`/`logError`)。
- **性能微优**:
  - Content-Length 预检:`upload.ts:142` 前读 `content-length`,总请求体声明超 8 MiB 早退 413(现全量缓冲后才校验 artifact bytes,`:156-166`)。这是有意保守的硬总包上限:会误拒 artifact 本身 `<= 8 MiB` 但 multipart metadata/boundary 使总包 `> 8 MiB` 的边界请求;同步 `api-reference.md` 说明 `payload_too_large` 也覆盖 declared request body 超限。
  - peek 去二次 SELECT:`peek.ts:136-146` 直接用 claim 的 `UPDATE...RETURNING` 结果做预签名,省一次读。
  - 串行 await 并行化:`peek.ts:150-156` 的 presign 循环与 `:37-48` 的 delete 循环改 `Promise.all`。
  - 删零读索引:`migrations/0001_v4_initial.sql:33-34` 的 `idx_runs_ended_at` / `idx_runs_updated_at` 无任何查询使用,纯写放大(需新迁移;先确认 analyzers 不直连)。执行中确认 analyzers 仍按 `updated_at_utc` mirror,所以仅新增迁移删除 `idx_runs_ended_at`,保留 `idx_runs_updated_at` 并补 schema test。

---

## 5. 文档与规则同步清单

> 按本仓规则,**不内联改 `.rules`/`CLAUDE.md`**;以下为"建议修改",由人确认后落。

| 文件:行 | 旧文 | 应改为 |
|---|---|---|
| `bazaarplusplus-server/CLAUDE.md:8` | `is_final_battle ... is never written by BATTLE_INSERT_SQL nor read by the ghost-battle query, and must not be exposed in the wire (test asserts its absence)` | `battles.is_final_battle 是 V4 wire 契约的一部分:由 BATTLE_INSERT_SQL 写入并以 MAX() 实现 sticky 升级(upload.ts:102),由 GET /ghost-battles 返回 boolean(query.ts:93),test/ghostBattles.query.test.ts 断言其存在与 sticky 语义;改动需同步 docs/api-reference.md、服务端测试与 mod 客户端测试。` |
| 根 `bpp/CLAUDE.md:14`(server 行) | `...serves ... and the BazaarDB screenshot manifest` | `...serves ghost battles, replay-link presigned R2 URLs, and the BazaarDB snapshot pull queue (peek/confirm)` |
| 根 `bpp/CLAUDE.md:60`(secret 说明) | secrets `required ... at the replay-link endpoint` | `R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY 供 replay-link 与 bazaardb peek 的 SigV4 预签名;BAZAARDB_PULL_TOKEN 供 bazaardb peek/confirm 的 bearer 鉴权` |
| `docs/bazaardb-snapshot-integration.md:116,148,169` | `unclaimed snapshots return to the pending queue ... will succeed` / `Delivery is at-least-once` | 补:未确认快照在租约过期后回到 pending,但每行累计至多 3 次 peek 认领(`MaxDeliveryAttempts`);超限后下次 peek 将其置为 `failed`(`failure_reason='max_delivery_attempts'`)并删除 R2 对象、不再投递。`at-least-once` → `at-least-once(至多 3 次尝试内)` |
| `docs/api-reference.md:83` | `| player_account_id | string | uploader |` | `| player_account_id | string | client-supplied value ignored; server always writes the metadata-level player_account_id |`(`upload.ts:305`) |
| `docs/api-reference.md:47` | `number (finite integer; current mod sends 5)` | `number (finite; integer not enforced — current mod sends 5)`(或在 `validation.ts` 加 `Number.isInteger` 后保留旧文) |
| `docs/api-reference.md`(replay-link 节,新增) | —— | 补:`download_url` 过期后 R2 返回 403,客户端应重新 POST replay-link、不要按 `expires_at_utc` 贴边调度(该值最多比真实签名过期晚 ~1s) |
| `bazaarplusplus-mod/docs/reference/sqlite-schema-reference.md:295,305`(跨仓提示) | `run-bundle uploads ... do not carry a final-battle marker` / `wire contract also omits the battle bundle-final flag` | 改为当前事实:`battle_projections[]` 上传 `is_final_battle`,server 写入/返回该字段,ghost sync 也持久化该字段。该行与同文档后面的 practical summary 及 mod DTO 已冲突。 |

> 经逐条核对**仍准确、无需改**的 `server CLAUDE.md` 规则:`run_id` 不可变 + 409;battle `ON CONFLICT(battle_id) DO UPDATE` 防批内回滚;全量 battle 投影无 allow-list;R2 不写 `customMetadata`;`Env` 为唯一绑定声明处。

---

## 6. 执行顺序与打包

| 批次 | 内容 | 性质 | 前置 |
|---|---|---|---|
| **PR 1** | P0-1 + P0-2 最小修复 | 数据丢失,带回归测试 | 无 |
| **PR 2** | P1-2 全部文档同步 | 零风险文档(CLAUDE.md 部分待确认) | 无 |
| **PR 3** | P1-1 桶名 env 化 + P1-3 边界硬化 | 防复发 + 健壮性 | 无 |
| **决策项** | P1-4 语义固化、P2 安全 | P1-4 已核对当前 mod 重试语义;P2 需先定鉴权策略 + 核实 CF 边缘防护,再开 PR | 决策 |
| **PR 4** | P0 后续 `putThenProject` 抽象 + P3 死代码 + 路由表统一 + 可观测性 + 性能微优 | 低风险卫生,可拆可合 | P0 回归测试稳定 |

每个 PR 遵循本仓 PR 规范:imperative、无 conventional-commit 前缀、无结尾标点的标题,正文末尾 `Release Notes:` 一条(`Added`/`Fixed`/`Improved`,后端内部改动用 `N/A`)。

---

## 附录 A:完整发现清单

> 45 条原始发现经多智能体复核去重为 27 条;严重度经"低流量爱好者后端"现实校准。

| # | 维度 | 严重度 | 证据(文件:行) | 问题 | 漂移 |
|---|---|---|---|---|---|
| 1 | 漂移/残留 | Medium | `CLAUDE.md:8`;`upload.ts:77,102,323`;`query.ts:58,93`;`ghostBattles.query.test.ts:83,120-124`;`api-reference.md:101,179` | `is_final_battle` 规则称从不写入/读取/上 wire,代码相反 | ✅ |
| 2 | 正确性 | Medium | `upload.ts:238-239,332,341,359` | 并发同 run_id+同字节:败者 catch 先删后查 → 删胜者已提交对象 → 永久 410 | ✗ |
| 3 | 正确性 | Medium | `peek.ts:85-99,148`;`presign.ts:13-17` | secret 缺失在领取后才炸 → attempts 消耗 → 3 轮后队列烧空删对象 | ✗ |
| 4 | 漂移 | Medium | `bazaardb-snapshot-integration.md:116,148,169`;`peek.ts:19-39,90`;`bazaardb.delivery.test.ts:315-341` | 文档承诺无限重投,代码 3 次后永久 failed+删对象 | ✅ |
| 5 | 安全 | Medium | `replayLink.ts:9-39`;`index.ts:47-56` | IDOR:任意 battle_id → 他人完整 run 制品预签名 URL + 泄露 account_id | ✗ |
| 6 | 安全 | Medium | `index.ts:20`;`upload.ts:294,305,313`;`query.ts:60` | 匿名可伪造 opponent 投喂受害者 ghost feed + 毒化 analyzers,无限流 | ✗ |
| 7 | 漂移 | Medium | 根 `CLAUDE.md:14`;`api-reference.md:419` | 根 CLAUDE.md 称 server serves "screenshot manifest"(已删);secret 端点归属不准 | ✅ |
| 8 | 安全 | Low | `query.ts:70-89`;`spec:62,338`;`api-reference.md:143` | GET /ghost-battles 无鉴权回吐可识别元数据,与 manifest 隐私结论矛盾,可枚举 | ✅(spec 内部矛盾) |
| 9 | 正确性 | Low | `upload.ts:138-140`;`index.ts:60` | content-type 声明 multipart 但 body 畸形 → `formData()` 抛 → 无 CORS 通用 500 | ✗ |
| 10 | 正确性 | Low | `upload.ts:223,230-237` | 同 run_id+同 artifact 纠正性重传被 200 接受却不刷新投影 | ✅(建议补文档) |
| 11 | 正确性 | Low | `upload.ts:80-103`;`query.test.ts:120-124` | 跨 run 碰撞:视角字段属后写、sticky flag 属先写,语义错位 | ✗ |
| 12 | 正确性/403 | Low | `validation.ts:9,138`;`presign.ts:38` | 正则放行 `.`/`..` 段 → URL 归一化 → 签名 URL 指向另一 key → 404 | ✗ |
| 13 | 性能/安全 | Low | `upload.ts:206-219,293,332` | `battle_projections` 无数量上限 → 单请求无界 D1 batch | ✗ |
| 14 | 性能 | Low | `upload.ts:142,156-166` | 无 Content-Length 预检,8 MiB 校验前已全量缓冲+解析 | ✗ |
| 15 | 性能 | Low | `query.ts:45-47,60-61` | 窗口谓词无 `recorded_at_utc` 上界,未来时间戳行永不老化 | ✗ |
| 16 | 性能 | Low | `peek.ts:85-119,136-146` | claim 的 RETURNING 已得 r2_key,却再 SELECT 同批行 | ✗ |
| 17 | 性能 | Low | `peek.ts:37-48,150-156` | 低频路径 R2 delete/presign 串行 await,可并行 | ✗ |
| 18 | 性能 | Low | `migration:33-34` | `idx_runs_ended_at` 无服务端读取方;`idx_runs_updated_at` 经执行期复核仍被 analyzers mirror 使用,因此只删除 ended_at 索引 | ✗ |
| 19 | 分层 | Low | `replayLink.ts:7`;`delivery.ts:1`;`config.ts:1` | 桶名双源,`config.ts` 名不副实的接缝;`88a76d2` 改名史证明 footgun 真实 | ✗ |
| 20 | 分层 | Low | `index.ts:18-24,36-56` | 路由双机制:声明式表 + 复制的命令式正则 | ✗ |
| 21 | 分层/残留 | Low | `cors.ts:2-7`;`json.ts:23`;`request.ts:112`;`validation.ts:144`;`observability.ts:35-81`;`crypto.ts` | 共享层堆积零调用方导出,解析本服务不产生的 V3 错误形状 | 部分✅ |
| 22 | 分层 | Low | `upload.ts:241-373`;`bazaardb/upload.ts:89-133` | 两阶段编排重复实现且日志已开始漂移 | ✗ |
| 23 | 可观测 | Low | `index.ts:59-62`;`upload.ts:233`;`replayLink.ts:30,35` | 409/4xx/404/410/未捕获 500 全部静默,`logError` 从未被调用 | ✗ |
| 24 | 残留 | Low | `replayLink.ts:43` | 遥测硬编码 `presign_key_cached: false` 指向不存在的缓存 | ✗ |
| 25 | 漂移 | Low | `api-reference.md:83`;`upload.ts:31,305` | 文档把 `battle_projections[].player_account_id` 列为有效输入,代码忽略 | ✅ |
| 26 | 漂移 | Low | `api-reference.md:47`;`validation.ts:93-96` | 文档称 `schema_version` 为 finite integer,5.5 也会被接受 | ✅ |
| 27 | 403 | Low | `presign.ts:32,47`;aws4fetch `:97` | `expires_at_utc` 比真实签名过期晚最多 ~1s,文档无过期处理契约 | ✅(建议补文档) |

---

## 附录 B:幽灵回放 403 专项结论

**前提**:服务端从不返回 403;用户可见的 403 来自客户端 GET R2 预签名 URL 时被 SigV4 拒绝。已确认根因为 **token scope 仅覆盖 bazaardb 桶**(H1/H5),ops 正在轮换覆盖两桶的 token。

| 假设 | 裁决 | 根因可能性 | 证据(取证) |
|---|---|---|---|
| **H1** 桶名/绑定解耦签错桶 | 代码层 refuted / 运维层证实 | medium→**已确认** | `replayLink.ts:7` 与 `wrangler.toml:26` 逐码点 29 字符全等(无拼写漂移);真正问题是 token scope——已由用户确认仅含 bazaardb 桶 |
| **H2** X-Amz-Expires 未入签名 | **refuted** | none | aws4fetch `:104` signQuery 用 `url.searchParams` 作 params;`:118` 仅在缺失时设默认;`:139` canonical query 全量构建含 `X-Amz-Expires`。`presign.test.ts:13` 已断言为 "300" |
| **H3** key 编码/双重编码/service-region | **refuted** | none | s3 分支 `:127` 先 decode 再 `:135` encode(往返一致);修复前实际 key 字符集被 `[A-Za-z0-9._-]`(`validation.ts:9`)+ `toBase64Url`(`[A-Za-z0-9-_]`)限死,全 unreserved,encodeURIComponent 恒等;当前新 run-bundle key 已改为 UUID。`presign.ts:25-26` 显式传 `service:"s3", region:"auto"` |
| **H4** 时钟/TTL 过期 | plausible | low | 真实过期由 R2 依 X-Amz-Date+Expires 判定;`expires_at_utc` 最多高估 ~1s(#27);mod 拿到 URL 立即下载、不读 expires_at_utc → "dawdle 过期"几乎不触发 |
| **H5** 凭据/权限 | **已确认** | **high** | secret 缺失 → `createR2Presigner` 抛 Error → `index.ts:61` rethrow → **500 不是 403**;403 只能是 R2 拒绝:本例为 token 无 run-bundles 桶 Object Read → `AccessDenied` |
| **H6** 客户端附加认证头 | **refuted** | none | mod 下载用裸 `HttpRequestMessage`,默认头仅 User-Agent,无 Authorization;服务端只签 `host` 头 |

**复现/定位表**(对 replay-link 与 peek 的 `download_url` 分别 `curl -v`,读 XML `<Code>`):

| XML Code (HTTP) | 结论 |
|---|---|
| 立即即 `SignatureDoesNotMatch` (403) | secret 与 key id 不配对/已轮换 |
| 立即即 `AccessDenied` (403) | token 缺 Object Read 或桶级 scope 不含该桶(**本例**) |
| 立即即 `InvalidAccessKeyId` (403) | key 不属于 `R2_ACCOUNT_ID` 账号 |
| `NoSuchBucket` (404) | 账号下无该桶 |
| `NoSuchKey` (404) | 签名有效但 key 不对(`.`/`..` 段 #12,或对象已被生命周期删) |
| 立即 200 / 超时后 `AccessDenied` (403) | 纯 TTL 过期(H4),客户端应重发 replay-link |

---

## 附录 C:被证伪/驳回的发现

复核中被对抗验证驳回、**不计入**方案的 3 条:

1. **"`jsonError` throw/return 双约定"** — 实为全仓一致约定:可复用解析/校验助手内 `throw`(`validation.ts:53-55`、`upload.ts:139-165`),handler/router 顶层 `return`。非缺陷。
2. **"幂等重传不刷新投影是文档漂移"** — 文档(`api-reference.md:101` "sticky marker")与代码(`upload.ts:102` MAX)并不矛盾;已作为建议归入 P1-4,非漂移。
3. **"ON CONFLICT 改写 `battles.run_id` 使 replay 解析错制品"** — 跨 run 碰撞后该行整体反映后写 run,解析其制品是自洽的;真问题是 #11 的 flag 错位,已单列。
