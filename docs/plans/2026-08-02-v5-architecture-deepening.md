# V5 架构深化实施方案（六项候选整合）

日期：2026-08-02

状态：待实施

范围：V5 orphan 分支 `v5`（Worker 代号 modapiv5）的 `src/`、`test/`、`docs/`；不改 wire 契约、不加路由、不加依赖、不改 `contracts/v5/`

前置阅读：`AGENTS.md`、`CONTEXT.md`、`docs/api-reference.md`、[`2026-08-02-v5-server-implementation.md`](./2026-08-02-v5-server-implementation.md)（历史记录，本方案不改写它）

本方案把六项架构深化候选整合为 9 个顺序阶段（Phase 0–8），每阶段一个 commit、一个统一验收门槛。候选之间的接口冲突已全部裁决，裁决结果写在 §2「统一集成决定」，对所有阶段有约束力。

---

## 1. 总原则（硬约束）

1. **线上 HTTP 字节不变。** 所有 status code、error code、message 文本、header 集合、JSON 字段集在重构前后逐字节一致。仅有两条获批修复（均为恢复文档契约的缺陷修复）：
   - **修复 (1)**：所有路由的错误路径一律转发 `HttpError.headers`（今天 `GET /bundles` 会丢弃，导致 `Retry-After` 丢失）。
   - **修复 (2)**：所有路由的未分类异常一律先 `logError("worker.internal_error", …)` 再返回 500（今天只有 `POST /bundles` 记录）。仅新增 console 侧效应，HTTP body/status 本就一致。
2. **统一验收门槛（每个阶段结束都执行，全绿才 commit）：**
   ```sh
   npm test        # 基线：14 个文件 / 66 个测试；数量只允许因本阶段"计划内新增"而增长
   npm run check   # 两个 tsconfig 项目都过
   git diff --exit-code -- contracts/v5/fixtures/checksums.json test/golden-fixtures.test.ts
   ```
   最后一条证明 golden 锁没有被"改测试凑通过"。任何阶段若发现只有改变线上字节或改 golden fixtures 才能过门槛：**停止，报告，不得硬闯**。
3. **AGENTS.md 规则重申（与本方案直接相关的几条）：** `src/env.ts` 是绑定唯一声明处；测试打公开模块接口（仅当 migration/SQL 本身是被测接口时允许看 schema 与 query plan，即规则 16）；不加公开路由；受保护路由先认证后解析；`GET /ghost-battles` 先限流后解析业务参数；Worker 不解压 Run；Bundle 前缀布局固定。**本方案不编辑 AGENTS.md**（如需修订须先获用户批准）。
4. **领域词汇**：Bundle / Run / Screenshot / BazaarDB Delivery / Ghost Battle。**设计词汇**：模块 (module) / 接口 (interface) / 实现 (implementation) / 深浅 (deep/shallow) / 缝 (seam) / 适配器 (adapter) / 杠杆 (leverage) / 局部性 (locality)。
5. 不新增 npm 依赖；aws4fetch 仍是唯一生产签名适配器。
6. 提交信息：祈使句，前缀沿用仓库历史风格（`feat:` / `refactor:` / `test:` / `docs:`）。

---

## 2. 统一集成决定（对所有阶段有约束力）

以下决定来自六份设计的交叉核查裁决，任何阶段不得偏离：

**D1 — 唯一的 deps 通道。** 全仓只有一个 deps 接口，住在 `src/http/deps.ts`：

```ts
export interface HandlerDeps {
  readonly signer: BundleDownloadSigner;
  now(): number;                     // 方法，不是快照值
}

export function createHandlerDeps(env: Env): HandlerDeps {
  let cached: BundleDownloadSigner | undefined;
  return {
    get signer() { return (cached ??= createBundleDownloadSigner(env)); },  // 惰性 + 记忆化
    now: () => Date.now(),
  };
}
```

- 禁止出现 `RouteDeps`（快照式 now）与 `DeliveryDeps`（模块私有克隆）这类第二通道。
- signer 必须惰性：`createHandlerDeps` 本身**永不抛错**，settle、/health 等不签名的路径永远不触碰 R2 presign 配置（保持 `test/health.test.ts` 用 `{} as Cloudflare.Env` 的活性探针契约）。
- **now 不能用请求开始时的快照**：`bundle-ingest.ts:464` 在 R2 PUT 之后才采样 `available_at_ms`，`ghost-battle-discovery.ts:95` 在限流与参数解析之后、D1 查询之前采样 issuedAt（该值还绑入五天窗口下界）；快照会把这些时间戳前移、挪动 Ghost 五天窗口边界。

**D2 — handler 签名（Phase 1 定形，Phase 2 起穿线）。**

```ts
interface HandlerContext { readonly request: Request; readonly env: Env;
                           readonly requestId: string; readonly deps: HandlerDeps }
interface HandlerResult  { readonly status: number; readonly body: unknown }
type RouteHandler = (ctx: HandlerContext) => Promise<HandlerResult>;
interface RouteDefinition { readonly path: string; readonly method: "GET" | "POST";
                            readonly auth?: ServiceScope; readonly cors?: boolean;
                            readonly handler: RouteHandler }
createFetchHandler(routes: readonly RouteDefinition[],
                   options?: { createDeps?: (env: Env) => HandlerDeps })
```

领域层保持位置参数、对壳无感知：五个模块入口（`collectBundles` / `discoverGhostBattles` / `claimDeliveries` / `settleDeliveries` / `ingestBundle`）自 Phase 2 起统一为 `(request, env, requestId, deps: HandlerDeps)`，**必填第 4 参、无默认值**（默认值是绕过缝的隐藏第二时钟源）。只有 `src/http/routes.ts` 知道 `HandlerContext` 存在。

**D3 — signer 读取位置是契约，不是细节。** 各模块在**今天调用 `createBundleDownloadSigner` 的那一行**执行 `const signer = deps.signer;`（collection ~124、ghost ~120、claim ~71），再把局部变量传给签发实现。特别是 claim：**必须在 D1 claim batch 之前读取**——presign 配置非法时今天是"batch 前 500 internal_error、零 D1 写入"；若延迟到签名循环里才首次读取，会变成"已认领、已计一次 attempt、触发 compensateClaim、返回 503 storage_unavailable"，属违规线上行为变更。

**D4 — 时钟契约。** 每次模块调用恰好采样一次 `deps.now()`，位置在今天各自的 `Date.now()` 行（`bundle-collection.ts:65`、`ghost-battle-discovery.ts:95`、`bazaardb-delivery.ts:72`、`:240`、`bundle-ingest.ts:464`），采样值向下穿透（窗口校验、issuedAtMs、lease、compensateClaim、CommitTimes）。`/health` 用 `ctx.deps.now()`。

**D5 — deps 构造点。** 壳在认证成功之后、handler 之前、**在映射异常的同一个 try 里**执行 `options.createDeps ?? createHandlerDeps`。未认证的请求不构造 deps。

**D6 — 共享 hex 助手。** `src/bundle/hex.ts` 导出 `toHex(bytes: ArrayBuffer | ArrayBufferView): string`，Phase 4 创建。消费方：`open.ts` 内部、ingest 的 `parseContentDigest`、ghost 的 `accountHash`。`test/fixtures/bundle.ts` 保留自己的本地 hex——夹具不得 import 它要检验的实现。

**D7 — 三条 503 失败文案是线上字节。** `"Bundle URL signing failed"` / `"Ghost Battle URL signing failed"` / `"BazaarDB claim URL signing failed"` 逐字保留，作为 `signDownloadPage` 的 `failureMessage` 参数逐调用点传入，不得统一。

**D8 — 投影 metric 归属。** Phase 5 把 `logEvent("bundle.projection.duplicate", {bundle_id, dropped})` 从 ingest 挪进 `commitBundle`（经 `CommitObserver`，默认适配器调 `logEvent`）。此后全仓恰好一个发射点；Phase 7 的清单按**事件名 + 字段键**记录，不引用 file:line。

**D9 — 测试缝夹具。** `test/fixtures/deps.ts` 导出唯一的 `createTestDeps({ signer?, now? }): HandlerDeps` 工厂；`test/fixtures/clock.ts` 放 `FakeClock { ms; now: () => this.ms; advance(delta) }`；`test/fixtures/presigner.ts` 在既有 `RecordingBundleDownloadSigner` 旁新增 `RejectingBundleDownloadSigner`。时钟注入的 delivery 测试必须从真实 `Date.now()` 起步、只向前推进（行数据是经 worker.fetch 用真实挂钟写入的）。

**D10 — 常量归属。** `src/domain/limits.ts` 的增改由 Phase 6 独占；claim SQL 中位于 `INDEXED BY` 之下的 attempt 谓词永远保持编译期字面量（`${MAX_DELIVERY_ATTEMPTS}` 插值），**绝不绑参**——D1 对部分索引 + `INDEXED BY` + 绑参谓词直接报 `no query solution`。`test/query-plans.test.ts` 的 SQL 镜像与模块 SQL 在同一 commit 更新。

**D11 — 文档一次收口。** 全部散文改动（CONTEXT.md、api-reference、README、ADR）集中在 Phase 8 一个 commit，之前任何阶段不碰文档。

---

## 3. 已定案的决策（执行时不再讨论）

| 决策 | 依据 |
| --- | --- |
| 过期/耗尽收敛保持 **claim-only**，settle 只做 lease 守卫；修文档不改行为 | 实现设计 §8 把收敛放在 claim；`api-reference.md:442` 已写 "when the next claim request runs"；`CONTEXT.md:19` 属措辞失准 |
| `duplicateReceipt` 的 `bazaardb_delivery:"existing"` 继续从 `has_screenshot` 派生，不读 `bazaardb_deliveries` | 与 `api-reference.md` §ingest 一致，故意为之；在模块注释里写明 |
| CORS `*` 范围维持 `/health` 与 `/ghost-battles`，且不出现在 404/405/认证拒绝上 | 与今天逐字节一致 |
| 预签 7 天 vs R2 保留 14 天的"越期尾巴"**不处理** | 属行为变更，超出本次重构范围 |
| `schema.test.ts` 既有手写 SQL 约束测试**保留**（规则 16 允许），只**新增** commitBundle 回滚测试 | 旧的 batch 中段失败回滚证明不可被替换掉 |
| 历史方案文档（两份 2026-08-02 计划）不改写，漂移用 ADR 记录 | 计划是历史记录 |

---

## 4. 阶段计划

### Phase 0 — 先立门槛（仅测试，commit 0）

现状核查发现：**方案赖以验收的门槛本身还不存在**——没有任何测试读取 `contracts/v5/fixtures/checksums.json`；`test/golden-fixtures.test.ts:24-44` 只断言 status、`error.code`、三个 receipt 字段与 run-only 解码长度 399，从不校验 sha256 或 `details.reason`。

改动（全部是新增测试，零 src 变更）：

1. 新增 `test/golden-checksums.test.ts`：解码 `contracts/v5/fixtures/` 三个 `.bundle.b64`，逐一断言与 `checksums.json` 记录一致——`decoded_bytes`（run-only 为 399）、`manifest_bytes`（374）、两个 sha256 值，以及 corrupt-magic 的 `expected_error` + `expected_reason: "invalid_prefix"`。不走 `worker.fetch`。
2. `test/ghost-battles.test.ts` 的 429 用例（~128-130 行）补一条 `expect(response.headers.get("access-control-allow-origin")).toBe("*")`——Ghost 限流 429 是**唯一**携带 headers 的生产 HttpError，正是 Phase 1 要重写的 `index.ts:241-252` CORS+headers 合并路径，必须先上锁。
3. 补 `test/env.d.ts` 漂移守卫：在测试侧加类型断言。注意 `Cloudflare.Env` 比 `Env` 多一个测试专用绑定 `TEST_MIGRATIONS`，反向断言必须豁免它，否则 `npm run check` 编译失败：`const _a: Env = {} as Cloudflare.Env; const _b: Omit<Cloudflare.Env, "TEST_MIGRATIONS"> = {} as Env;`。

门槛：§1.2（此后每阶段同，不再重复）。

### Phase 1 — c1 路由壳（commit 1）

**目标**：四份互相矛盾的信封抄本 → 一个深的路由壳；路由知识只声明一次。两条获批修复在此落地且只在此落地。

**文件**：新增 `src/http/route-shell.ts`、`src/http/routes.ts`、`src/http/deps.ts`（§2 D1 形状）、`test/route-shell.test.ts`；重写 `src/index.ts`；`src/http/auth.ts`、`json.ts`、`errors.ts` 不动。

**壳的不变量**（`createFetchHandler` 的接口承诺）：

- 处理顺序：requestId 派生（`CF-Ray ?? crypto.randomUUID()`）→ path 缺失 404 → OPTIONS → method 缺失 405（带 `Allow`）→ 认证 → 构造 deps → handler → 信封。
- 路由表是 path/method/auth/cors 的**唯一**编码；构造期索引成 `Map<path, {cors, allow, byMethod}>`，重复 path+method 或同 path CORS 冲突直接 throw；`createFetchHandler(V5_ROUTES)` 在 `index.ts` **模块作用域**求值，坏表启动即失败。
- `V5_ROUTES` 声明序保持 GET 在 POST 前（`/bundles` 的 `Allow` 必须是 `"GET, POST"`，`http.test.ts` 精确相等断言）。
- 认证在 handler 之前（保持先认证后解析）；认证拒绝映射（`authDenial`）**私有于壳**：`insufficient_scope→403`、`invalid_configuration→500 internal_error retryable:true "Service token configuration is invalid"`、其余 `→401`——消息逐字沿用今天 `index.ts:37-78`。`auth.ts` 继续返回纯四值结果。
- 信封唯一一份：HttpError → 转发 `error.headers` 并按今天的顺序合并 CORS（先 `new Headers(error.headers)` 再 set `Access-Control-Allow-Origin`）；未分类异常 → `logError("worker.internal_error", {request_id, route: <仅 path>, error_name, reason: "unclassified_exception"})` 后 500 `"An internal error occurred"`。
- CORS `*`：OPTIONS（当 path cors）+ handler 成功与 handler 信封错误（当 route cors）；**404/405/认证拒绝不加**（含 cors path 上的 405）。OPTIONS 的 204 响应 body 为 null，头集合**逐项等于今天**：`Allow`、`Access-Control-Allow-Methods`、`Access-Control-Allow-Headers`、`Access-Control-Max-Age` 四个头（cors path 另加 `Access-Control-Allow-Origin`），**不得**因走统一信封而多出 `X-Request-Id` / `Content-Type` / `Cache-Control`（今天的 `optionsResponse` 是裸 Response，不经 `jsonError`）。
- `/health` 成为普通 handler：`{ status: "ok", server_time_ms: ctx.deps.now() }`；惰性 signer 保证空 env 探针不触 R2 配置。
- 本阶段适配器仍以 `(request, env, requestId)` 调领域模块——**不动模块签名**。
- 删除不可达的 `"The route table is internally inconsistent"` 兜底与 `startsWith("/bazaardb/")` 三元式。已 grep 验证无测试引用该文案；在 commit message 里记录这一验证。

**测试**：`test/http.test.ts`、`test/health.test.ts` 及全部领域集成测试零改动通过。新增 `test/route-shell.test.ts` 用**夹具路由表**（不得注册进 `V5_ROUTES`）打壳接口，一次性断言信封不变量：① 两类异常的 body 都带 `error.request_id` 且与 `X-Request-Id` 一致；② HttpError 携带 `Retry-After: 60` 必被转发（获批修复 (1) 的壳级证明——`GET /bundles` 今天没有带 header 的生产错误，此夹具测试是该修复的唯一锁，属已接受的记录在案缺口）；③ CORS 策略全矩阵（成功/HttpError/500/OPTIONS 有 `*`，405/404/cors:false 无），并断言 OPTIONS 头集合恰为上述 4（cors path 5）个头、body 为 null；④ 500 形状 + `logError` 载荷断言（获批修复 (2)）；⑤ 认证先于 handler（handler 侧旗标不置位）+ 三种拒绝映射；⑥ `invalid_configuration → 500`；⑦ `Allow` 聚合 `"GET, POST"`。

### Phase 2 — c2a：deps 穿线（commit 2，纯机械）

五个领域函数统一加必填第 4 参 `deps: HandlerDeps`；每处 `Date.now()` 在原行变 `deps.now()`（§2 D4 列出的五处）；每处 `createBundleDownloadSigner(env)` 在原行变 `const signer = deps.signer;`（§2 D3，claim 保持在 D1 batch 之前）；`routes.ts` 适配器传 `ctx.deps`。新增 `test/fixtures/deps.ts` 与 `test/fixtures/clock.ts`（§2 D9）。

不含任何逻辑变更——签名循环、503 包装、dedupe 一律不动，留给 Phase 3。门槛额外确认：`test/ingest-recovery.test.ts:41` 的 `Date.now` spy 与 `test/health.test.ts` 空 env 仍绿。

### Phase 3 — c2b：signDownloadPage 深签发（commit 3）

**接口**（加进 `src/r2/presigner.ts`，`BundleDownloadSigner` 不动）：

```ts
export function signDownloadPage(
  signer: BundleDownloadSigner,
  objectKeys: readonly string[],
  issuedAtMs: number,
  failureMessage: string,
): Promise<SignedBundleDownload[]>;
```

承诺：结果与 `objectKeys` 1:1 对齐；每个不同 key 至多签一次（in-flight Promise 复用，即今天 ghost 的 `signedByKey` 模式）；任一 `sign` 拒绝 → `HttpError(503, "storage_unavailable", failureMessage, true)`，永不返回半页；不读 Env、不打日志。

- 三个模块的"逐行签名 + 503"块收拢为对它的一次调用；dedupe 全局开启是行为保持的：`migrations/0001_v5_initial.sql` 中 `bundles.run_id`、`bundles.object_key` UNIQUE，collection/claim 每页一行一 Bundle，只有 ghost 可能重复 key（且今天已 dedupe，`api-reference` 原话 "signs each distinct object key once"）。
- **ghost 的 `JSON.parse(projection_json)` 必须留在映射到 503 `"Ghost Battle URL signing failed"` 的外层 catch 内**，否则 parse 失败会从 503 漂成 500。
- claim 失败路径保持：`await compensateClaim(env, claimId, now).catch(() => undefined)` 后按今天的分类重抛。
- `test/fixtures/presigner.ts` 新增 `RejectingBundleDownloadSigner`。

**测试**：模块级注入测试（collection/ghost/claim × Recording signer + FakeClock：issuedAtMs === clock 值、`download_expires_at_ms === issuedAtMs + 604_800_000`、ghost 多 battle 同 Bundle 只签一次）；**首个 compensateClaim 测试**（Rejecting signer → 503 后经 D1 断言：attempt 收据删除、`active_claim_id` 清空、`delivery_attempts` 回退、`claimable_at_ms === clock 值`、状态仍 pending）；`signDownloadPage` 的 dedupe 与 503 映射单测。既有 worker.fetch 集成测试全保留。

### Phase 4 — c3：openBundle 开箱模块（commit 4）

**目标**：五文件严格顺序 + digest promise 握手 → 一个深接口；全部 `invalid_bundle` reason 获得唯一出生地。

**文件**：新增 `src/bundle/open.ts`、`src/bundle/hex.ts`、`test/open-bundle.test.ts`；**删除** `src/bundle/stream-validator.ts`；`prefix.ts` 降为 `src/bundle/` 私有（不再被 `modules/` import）；`manifest.ts` 去掉写而不读的 `bundleVersion`（已验证：D1 INSERT 与 R2 customMetadata 用字面量 `5`/`"5"`）、`validateManifest` 取消导出（先 `rg` 确认 ingest 是唯一外部 importer）；重写 `bundle-ingest.ts` 解析路径；ghost `accountHash` 改用共享 `toHex`。

**接口**：

```ts
export interface OpenedBundle {
  descriptor: ValidatedBundleDescriptor;
  body: ReadableStream<Uint8Array>;   // 完整 Bundle 字节，可直接 R2 PUT
  digest: Promise<string>;            // body 成功走完后才 resolve
}
export function openBundle(
  source: ReadableStream<Uint8Array>,
  contentLength: number,
  expectedDigest: string | null,      // null = 跳过全体摘要比对（orphan 复验路径）
): Promise<OpenedBundle>;
```

接口承诺：① resolve 即前缀+受限清单有效、descriptor 完整；② `body` 无错走完 ⇒ 长度/分段边界/分段摘要/（如给）全体摘要全部成立；③ 消费中任何校验失败 ⇒ body 消费方与 `digest` 拒绝**同一个** HttpError，code/message/`details.reason` 与今天逐字节一致（含两条不同文案的 `segment_out_of_bounds`、`run_missing` 的原文）；④ 调用方永不触碰 TransformStream/pump 内部；⑤ 模块无存储（无 R2/D1/Env）；⑥ 只缓冲 16 字节前缀 + 受限清单，永不解压 Run。

实现要点：双体 `BoundedBodyReader`（byob + fallback）成为模块私有内部缝；`void digest.catch(() => undefined)` 防未处理拒绝；**校验 TransformStream 必须在返回前接好**，使 duplicate 路径 cancel `opened.body` 时 digest 经 `cancel()` 干净拒绝。R2 条件 PUT 与 `FixedLengthStream` 握手**留在 ingest**（`putConditionally(env, opened, headerDigest)` 改从 `opened.body`/`opened.digest` 取流与摘要）；PUT 失败分诊契约收窄为一句话：pipe promise 以 HttpError 落定 = 校验失败（转发 + 视情况删对象），否则 = `storage_unavailable`。`validateExistingObject` 改为 `openBundle(object.body, object.size, null)` + 黑洞 WritableStream 排空。不再单独动 `commitDescriptor` 的默认参数（Phase 5 会删除整个函数）。

**测试**：新增 `test/open-bundle.test.ts` 直打模块接口（不走 worker.fetch），用 `contracts/v5/fixtures/` 三个 `.b64`：corrupt-magic 在 resolve 前拒绝（422 `invalid_bundle` reason `invalid_prefix`）；segment-digest-mismatch 的 descriptor 成功、body 排空时与 `digest` 双双拒绝同一 `segment_digest_mismatch`；run-only 全绿并断言 descriptor 字段与 `digest`；错误 expectedDigest → `bundle_digest_mismatch`。**断言完整 code+reason+message 锁文本**（golden 测试锁不住"同 code 换文案"）。`golden-fixtures` / `bundle-contract` / `bundle-ingest` / `ingest-recovery` 保持端到端、**零断言修改**通过。不再为 prefix/stream-validator/validateManifest 单独立单测——接口即测试面（replace, don't layer）。

### Phase 5 — c4：bundle-commit 落库模块（commit 5）

**目标**：资格谓词一份、语句具名、判定表一处、metric 不可漂移。AGENTS.md 规则 8/9/10 获得代码上的家。

**文件**：新增 `src/modules/bundle-commit.ts`、`test/bundle-commit.test.ts`；编辑 `bundle-ingest.ts`（删除 `precheck`、`commitDescriptor`、`existingByBundleId`、`bundleForRun`、`duplicateReceipt`、本地 `BundleReceipt`）；编辑 `test/schema.test.ts`（只增）、`test/bundle-ingest.test.ts`（只增）。

**接口**：

```ts
export type CommitOutcome =
  | { kind: "committed"; projection: { eligible: number; inserted: number } }
  | { kind: "duplicate"; receipt: BundleReceipt }
  | { kind: "conflict"; reason: "bundle_id_conflict" | "run_already_bundled" };
export interface CommitTimes { availableAtMs: number; storedAtMs: number }
export interface CommitObserver { projectionDuplicate(f: { bundle_id: string; dropped: number }): void }

export function inspectExistingBundle(db, descriptor, digest): Promise<CommitOutcome | null>;  // 纯读优化
export function commitBundle(db, descriptor, digest, times, observer?): Promise<CommitOutcome>;
```

实现要点：

- 私有 `ELIGIBILITY_PREDICATE` SQL 片段一份，ghost INSERT 与 eligible COUNT 共同内嵌；绑定约定统一为 `?1 = battles JSON、?2 = uploader`（ghost 另绑 `?3 = bundle_id`，只用于 SELECT 列）。**这是高危机械改动**：绑错位会静默丢掉全部 Ghost 投影且 batch 不失败——由本阶段的资格单测（self / 未知对手 / 预置对手）+ 既有 A→B→A fetch 测试双重看护。
- 具名语句构建：`insert_bundle → insert_ghost → insert_delivery → count_eligible → insert_uploader` 固定序，构建器内断言 `statements.at(-1).name === "insert_uploader"`（uploader 单调不变量首次成为断言而非巧合）；`readProjection` 按语句的 `read` 标签走，不再有 `results[1]`/`results[3]` 裸下标。
- `decideFromExisting` 判定表**唯一一份**（四条规则与今天 precheck/catch 完全一致）；`inspectExistingBundle` 与 batch 失败路径共用它；ingest 里的两份副本全部删除。
- `commitBundle` 不删 R2、不发 orphan 日志（它没有 request_id/object_key 语境）；`run_already_bundled` 冲突时由 ingest 按 `objectWrite.created` 补偿删除（与今天 :477-479 一致）；orphan 路径由 ingest 包裹：`commitBundle` 抛 503 时 `logError("bundle.ingest.orphan", {request_id, bundle_id, object_key})` 后重抛，字节一致。选择"返回足够信息、不收补偿回调"：R2 生命周期已归 ingest 所有，回调会把 D1 判定表与存储耦合、加宽接口而无第二适配器。
- ingest 将 `CommitOutcome` 映射回**逐字**相同的 HttpError 文案（`"Bundle ID already has different bytes"` / `"Run already belongs to another Bundle"` / `"Bundle index is unavailable"` / `"Bundle index commit failed"`）；times 取值 `{ availableAtMs: now, storedAtMs: objectWrite.storedAtMs }`，now 来自本请求唯一一次 `deps.now()` 采样。

**测试**：`test/bundle-commit.test.ts` 打公开提交接口 + 真 D1：(a) self 对手 eligible=1/inserted=1；(b) 未知对手过滤 0/0 且无 ghost 行；(c) 预置 `bundle_uploaders` 对手插入成功；(d) 跨 Bundle 重复 `(uploader, battle_id)`：第二次 committed 且 `{eligible:1, inserted:0}`，Recording observer 收到 `dropped:1`（metric 首次可测）；(e) Screenshot Bundle 重复提交 → duplicate receipt `bazaardb_delivery:"existing"`；(f) 判定表两种 conflict；(g) 成功提交后 uploader 在表中。`test/schema.test.ts`：**保留**既有手写 SQL 的"中段语句失败回滚"证明，**新增** commitBundle 回滚测试（用 `bundles.object_key` UNIQUE 碰撞逼 batch 失败 → 503，断言目标 `bundle_id` 行不存在；**seed 与 target 必须用不同的 `uploader_account_id`**，否则 `ON CONFLICT DO NOTHING` 的预置行会让"uploader 不存在"断言在正确回滚时也失败）。`test/bundle-ingest.test.ts` 新增线上收据锁：Screenshot Bundle 首传 201 + `"created"`，同体重传 200 + `"duplicate"` + `"existing"`（当前缺失的覆盖）。`test/ghost-battles.test.ts` 的 A→B→A 留在 fetch 层（它还锁 CORS、URL 过期与查询序）。

### Phase 6 — c5：Delivery 状态机 + 常量归位（commit 6，纯代码与测试，不碰文档）

**改动**：

1. `src/domain/limits.ts`：新增 `export const DELIVERY_RETRY_BACKOFF_MS = [60_000, 300_000] as const`（注释：长度必须等于 `MAX_DELIVERY_ATTEMPTS - 1`；migration 的 CHECK/部分索引字面量必须与 limits 一致）。
2. claim SQL：attempt 谓词改为 `${MAX_DELIVERY_ATTEMPTS}` **编译期插值**（`= 3` → `= ${MAX_DELIVERY_ATTEMPTS}`、`< 3` 同理），保持 `INDEXED BY idx_bazaardb_exhausted_lease` / `idx_bazaardb_claimable` 与语句序、WHERE 语义、绑定列表零变化（§2 D10：这里绑参是 D1 硬失败）。
3. settle：抽 `buildSettleItemPair(db, claimId, item, now)` 返回 `[attempt语句, delivery语句]` + `deliveryApplied(writes)` 读取闭包（内部闭合 `base = index*2`），调用侧的 `writes[index*2+1].meta.changes` 下标算术消失；delivery UPDATE 的 `>= 3` 绑为 `?6 = MAX_DELIVERY_ATTEMPTS`、`?4 + 60000`/`?4 + 300000` 绑为 `?4 + ?7`/`?4 + ?8`（backoff 常量）；`delivery_attempts = 1`/`= 2` 是调度位置、保持字面量；**null-reason 守卫语义逐字保留**（`a.reason = ?5 OR (a.reason IS NULL AND ?5 IS NULL)`）。已验证：绑参后的 settle CASE 仍按 PK 查询计划执行。
4. claim 内部按状态机具名化私有函数：`convergeExpiredBundles`、`convergeExhaustedAttempts`、`claimDeliveryPage`、`insertAttemptReceipts`、`loadClaimedBundles`（`compensateClaim` 既有）。单个 `DB.batch` 事务不变。claim batch 的页读取（今天 `bazaardb-delivery.ts:157` 的 `results[4]`）同步消除裸数字下标——改按语句标签读取或 `results.at(-1)`，否则 §6 的 grep 终检必挂且届时无所属阶段。**不得把收敛加进 settle**（§3 已定案）。
5. deps 沿用 Phase 2 的 `HandlerDeps`（必填、无默认），不新建任何 Delivery 私有 deps 类型。

**测试**：`test/limits.test.ts` 扩为 limits↔schema 契约测试（经 `sqlite_master.sql` 与 migration 文本断言：`delivery_attempts BETWEEN 0 AND ${MAX}`、`attempt_number BETWEEN 1 AND ${MAX}`、部分索引含 `< ${MAX}`/`= ${MAX}`、`active_claim_order BETWEEN 0 AND ${CLAIM_MAX_LIMIT - 1}`、`DELIVERY_RETRY_BACKOFF_MS.length === MAX - 1`——规则 16 授权的存储接口测试）；`test/query-plans.test.ts` 同 commit 更新镜像 SQL，继续断言 `idx_bazaardb_claimable` / `idx_bazaardb_exhausted_lease` 部分索引命中、无 TEMP B-TREE，并**新增** settle delivery UPDATE 走 PK 的 EXPLAIN 断言（今天只对 settle 的 receipt SELECT 断言过 PK，UPDATE 从未有过计划断言——"绑参后仍走 PK"的结论靠这条新断言落地）；`test/bazaardb-delivery.test.ts` 新增：同请求部分批次 settle（一 applied + 一 stale_claim/unknown_item，断言逐 item 状态与 summary）、lease 过期经注入时钟（推进 `CLAIM_LEASE_MS` 后同 claim settle → stale_claim，全程不改列）、退避窗口经注入时钟（`BACKOFF[0]-1` 不可领、`BACKOFF[0]` 可领；二次失败后 `BACKOFF[1]` 同理）。时钟从真实 `Date.now()` 起步只前进（§2 D9）。既有 worker.fetch 并发/幂等/耗尽/保留测试保留。

### Phase 7 — c6：observability 拥有脱敏红线（commit 7）

**改动**：重写 `src/observability.ts` 内部，两个导出名与签名不变：

- 私有 `sanitizeFields`：精确禁键集（`account_id`、`player_account_id`、`uploader_account_id`、`opponent_account_id`、`authorization`、`token`、`secret`、`password`、`body`、`download_url`、`presigned_url`、`url`、`projection_json`、`screenshot`、保留字 `redacted_fields` 等）∪ 后缀模式（`_account_id`、`_token`、`_secret`、`_url`）；值规则：字符串含 `"X-Amz-"` 即弃。命中即**丢弃该键**，且当有任何丢弃时追加 `redacted_fields: string[]`（丢弃键名、遭遇序）——选择"丢弃 + 标记"而非替换值：快乐路径字节不变、违规可诊断、密材不复现。
- `request_id` 保持可选字段（`bundle.projection.duplicate` 与 `bundle.orphan.invalid` 无请求语境）；公开函数不抛错、单行 JSON、`logEvent→console.log` / `logError→console.error` 不变。
- 快乐路径**逐字节不变**：现存全部发射字段键（重构后清单按事件名+字段键盘点，含壳的 `worker.internal_error` 四键与 commit 模块 metric）全部通过 allowlist 单测——特别确认 `account_hash`、`object_key`、`route`、`error_name`、`has_screenshot` 不被任何模式误伤。若冲突：**收窄模式，绝不放行密钥**。
- 不导出 `sanitizeFields`；不碰任何调用点（获批修复 (2) 已由 Phase 1 完成，本阶段不得再扩大日志面）。

**测试**：`test/observability.test.ts` 新增模块级单测（console spy 经公开接口）：单行 JSON 形状；sink 选择；现存字段集回放逐字节等于 `JSON.stringify({event, ...fields})`；精确禁键与模式禁键丢弃 + `redacted_fields` 记序；`X-Amz-` 值丢弃；无 request_id 可发射；调用方伪造 `redacted_fields` 键被视为禁键。既有 fetch 级兜底扫描测试保留。

### Phase 8 — 文档收口 + ADR（commit 8，纯散文）

1. `CONTEXT.md:19`：惰性收敛改为归属 claim 请求（settle 只守卫 lease），其余不动。
2. `docs/api-reference.md`：Common HTTP behavior（:20-30）补一句"错误响应保留路由特定 headers"（获批修复 (1) 恢复的契约）；把 Ghost 段的 "One response signs each distinct object key once"（:329）挪到 Presigned downloads 段（signDownloadPage 后它是全局签名属性）；settle 段 ~:422 的 "Before selecting a claim page, the route also marks…" 明确写为 `POST /bazaardb/deliveries/claim`。不发明字段、不改示例状态码。
3. `README.md`：补 3-4 行布局导引——`src/http/routes.ts` 是路由表、`src/http/route-shell.ts` 是唯一 HTTP 出口、`src/bundle/open.ts` 是 Bundle 开箱、`src/modules/bundle-commit.ts` 是落库判定。
4. 新增 `docs/adr/0001-v5-deepening-seams.md`：记录路由壳 + `HandlerDeps` 缝（四参签名）+ `openBundle` + `bundle-commit` 四个深化决定、claim-only 收敛的文档定案、以及两份历史实现计划中已知漂移点（`src/` 树与三参签名描述）——**历史计划文档本身不改写**。
5. 不编辑 `AGENTS.md`（如它的 "route table" 措辞需要指向新文件，先征得用户同意）。

---

## 5. 风险登记（执行时高频回看）

| 风险 | 位置 | 缓解 |
| --- | --- | --- |
| 资格谓词绑位改错 → 静默丢全部投影 | Phase 5 | 资格三单测 + A→B→A fetch 测试；merge 前双绿 |
| signer 读取点后移 → claim 从 500 漂成 503+补偿 | Phase 2 | §2 D3 写进 commit message；claim 单测覆盖 |
| ghost JSON.parse 漂出 503 catch → 500 | Phase 3 | 设计明示 + 既有 503 文案断言 |
| `INDEXED BY` 谓词绑参 → `no query solution` | Phase 6 | §2 D10；query-plans 同 commit 更新 |
| openBundle 换文案同 code → golden 测不出 | Phase 4 | open-bundle 单测锁 code+reason+message |
| 时钟快照化 → `available_at_ms` 前移 | Phase 2 | §2 D1/D4：`now()` 方法、原行采样 |
| FakeClock 用小纪元 → 查不到真实时间写入的行 | Phase 3/6 | 从 `Date.now()` 起步只前进 |
| 信封文案/Allow 序漂移 → http.test 精确断言失败 | Phase 1 | 逐字保留 + 声明序 GET 前置 |
| c6 模式误伤未来合法字段 | Phase 7 | allowlist 单测；扩精确集优先于扩模式 |

## 6. 最终验收清单

- [ ] 9 个 commit（0–8），每个独立全绿，无跨候选混提
- [ ] `npm test` 全绿；新增测试 ≈ route-shell(7) + deps/clock 夹具消费 + signDownloadPage/compensateClaim + open-bundle(4) + bundle-commit(7) + limits 契约 + delivery 时钟/部分批次(3) + observability 模块单测(≥8) + golden-checksums
- [ ] `npm run check` 全绿
- [ ] `contracts/v5/fixtures/checksums.json` 与 `test/golden-fixtures.test.ts` 自 Phase 0 起零改动（`git log --follow` 可证）
- [ ] `git grep -n "Date.now()" src/` 只剩 `src/http/deps.ts` 一处
- [ ] `git grep -n "createBundleDownloadSigner" src/` 只剩 `presigner.ts` 定义与 `deps.ts` 一处调用
- [ ] `git grep -nE "results\[[0-9]\]|writes\[index" src/modules/` 无命中
- [ ] 资格谓词 SQL 文本在 `src/` 只出现一次（`ELIGIBILITY_PREDICATE`）
- [ ] `AGENTS.md` 无改动；两份历史计划文档无改动

---

## 附录 A — 交给执行 Agent 的提示词

> 使用方式：在本仓库根目录启动一个全新的编码 Agent 会话，将下面整段作为首条指令发送。

```text
你是负责执行 V5 架构深化重构的工程 Agent。仓库根目录：
/Users/yxinyu/codes/workspaces/bpp/bazaarplusplus-server-v5（分支 v5，Cloudflare Worker + TypeScript + vitest/miniflare + D1/R2）。

## 任务
完整实施 docs/plans/2026-08-02-v5-architecture-deepening.md（下称「方案」）的 Phase 0 到
Phase 8，共 9 个 commit，顺序不可调换、阶段不可合并。方案是唯一权威：本提示词与方案冲突时以方案为准。

## 开工顺序
1. 通读方案全文，特别是 §1 硬约束、§2 统一集成决定（D1–D11）、§3 已定案决策、§5 风险登记。
2. 通读 AGENTS.md、CONTEXT.md，浏览 docs/api-reference.md 的路由表与错误码段。
3. 运行 npm test 与 npm run check，确认基线全绿（14 个测试文件 / 66 个测试），记录基线数字。
4. 逐阶段实施。每个阶段：先读该阶段涉及的全部源文件与测试文件，再动手；改完跑门槛；
   全绿后 commit；然后才进入下一阶段。

## 每阶段门槛（缺一不可）
- npm test 全绿（测试数量只允许因该阶段计划内新增而增长）
- npm run check 全绿
- git diff --exit-code -- contracts/v5/fixtures/checksums.json test/golden-fixtures.test.ts

## 硬性禁令
- 线上 HTTP 字节不变：status、error code、message 文本、header 集、JSON 字段集逐字节一致。
  仅有方案 §1.1 的两条获批修复（转发 error.headers；未分类异常一律 logError）。
- 禁止：新增公开路由；新增 npm 依赖；改 src/env.ts 绑定；编辑 AGENTS.md；改写
  docs/plans/ 下两份历史计划文档；修改 contracts/v5/ 下任何文件；为让测试通过而修改
  golden fixtures 或 checksums。
- 领域函数的 deps 参数必填、无默认值；全仓只有 src/http/deps.ts 一个 HandlerDeps 通道。
- claim 模块必须在 D1 claim batch 之前执行 const signer = deps.signer（方案 §2 D3，
  这是线上行为保持契约，写进该阶段 commit message）。
- claim SQL 里 INDEXED BY 之下的 attempt 谓词只能用 ${MAX_DELIVERY_ATTEMPTS} 编译期
  插值，绝不绑参（D1 会报 no query solution）。
- 不把收敛逻辑加进 settle（方案 §3 已定案：claim-only，修文档不改行为）。

## 卡住时的规则
- 若某阶段门槛无法在"不改变线上字节、不动 golden"的前提下通过：立即停止该阶段，
  保留工作区现场（不要 reset），输出一份报告说明冲突的具体断言/字节差异，等待人工决策。
- 若发现方案与代码现状不符（行号漂移属正常，直接按符号定位；语义不符才算），在报告中
  指出并给出你建议的最小偏差方案，经确认前不擅自扩大改动面。
- 禁止跳过失败测试、禁止 test.skip、禁止放宽断言。

## 提交规范
每阶段一个 commit。提交信息：祈使句，前缀沿用仓库历史（feat:/refactor:/test:/docs:），
正文列出该阶段的行为保持证据（如：Phase 1 需记录"已 grep 验证无测试引用被删除的
不可达兜底文案"；Phase 2 需记录 signer 读取位置契约）。

## 完成标准与结项报告
9 个 commit 全部落地后，执行方案 §6 最终验收清单逐条自检（包括三条 git grep 检查），
然后输出结项报告：每阶段 commit hash 与一句话摘要、测试数量从基线到最终的增长明细、
验收清单逐条勾选结果、以及（如有）记录在案的已接受缺口。
```
