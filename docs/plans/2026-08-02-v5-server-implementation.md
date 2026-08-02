# BPP V5 Server 实现设计（modapiv5）

日期：2026-08-02

状态：已决策，待实现

范围：`bazaarplusplus-server/workers/mod-api-v5` 及其独立 D1、R2、HTTP interface、定时维护和测试

本文是 [`2026-08-02-v5-cross-repo-joint-design.md`](./2026-08-02-v5-cross-repo-joint-design.md) 的 server 落地设计。跨仓文档负责 Bundle / Run / Screenshot 契约与调用方职责；本文负责把 modapiv5 的 route、错误、模块、SQL、R2 和故障语义定义到可直接实现的程度。

---

## 0. 实现边界

modapiv5 是一个全新的 Cloudflare Worker，不在 V4 根目录的 `src/`、migrations 或 bindings 上增量改造。

固定资源：

| 项 | 值 |
|---|---|
| Worker | `bazaarplusplus-mod-api-v5` |
| Host | `mod-api-v5.bazaarplusplus.com` |
| D1 | `bazaarplusplus-mod-api-v5-db` |
| R2 bucket | `bazaarplusplus-bundle-v5` |
| R2 object Content-Type | `application/x-bpp-bundle-v5` |
| R2 key | `bundles/<yyyy-mm-dd>/<bundle_id>.bundle` |
| R2 presigned GET 有效期 | 7 天，即 `604800` 秒 |
| Bundle R2 retention | 14 天 |

Worker 只做六个领域动作：

1. 接收一个不可变 Bundle；
2. 按可用时间窗口枚举 Bundle；
3. 查询 ghost battles；
4. 为查询结果签发 R2 presigned GET URL；
5. 领取与结算 BazaarDB deliveries；
6. 定时修复 R2 / D1 orphan 并执行 D1 TTL。

Worker 不做：

- installation 注册或 per-install 鉴权；
- 独立 Run / Screenshot upload；
- Pack；
- Worker download proxy；
- `GET /bundles/:bundle_id`；
- download-token D1 row；
- analyzer cursor、session 或 watermark 存储；
- Bundle 内容裁剪；
- Run payload 解压或 MessagePack decode。

---

## 1. 代码布局

V4 继续留在仓库根目录。V5 使用独立 package、wrangler 配置、migration lineage 和测试环境：

```text
bazaarplusplus-server/
  src/                              # V4，保持不动
  migrations/                       # V4，保持不动
  workers/
    mod-api-v5/
      package.json
      package-lock.json
      tsconfig.json
      vitest.config.ts
      wrangler.toml
      migrations/
        0001_v5_initial.sql
      docs/
        api-reference.md
      src/
        index.ts                     # fetch/scheduled entrypoints
        env.ts                       # V5 bindings/secrets 唯一声明处
        http/
          router.ts
          auth.ts
          errors.ts
          json.ts
          request.ts
        modules/
          bundleIngest.ts
          bundleCollection.ts
          ghostBattleDiscovery.ts
          bazaardbDelivery.ts
          maintenance.ts
        bundle/
          prefix.ts
          manifest.ts
          streamValidator.ts
          projection.ts
        storage/
          bundleObject.ts
          bundleIndex.ts
          deliveryStore.ts
        r2/
          presigner.ts
        observability.ts
      test/
        contract/
        integration/
        fixtures/
```

不建立 `controller → service → repository` 的逐层转发结构。HTTP route 只负责协议解析和 response 映射；复杂行为集中在以下四个深模块：

```ts
interface BundleIngest {
  accept(input: BundleUploadInput): Promise<BundleReceipt>;
}

interface BundleCollection {
  listWindow(input: BundleWindowInput): Promise<BundleWindowPage>;
}

interface GhostBattleDiscovery {
  discover(input: GhostBattleQuery): Promise<GhostBattlePage>;
}

interface BazaarDbDelivery {
  claim(input: ClaimInput): Promise<ClaimResult>;
  settle(input: SettleInput): Promise<SettleResult>;
}
```

每个模块的 interface 同时是 caller 和测试使用的 seam。D1 与 R2 binding 直接作为模块内部依赖，不再包一层只有同名 CRUD 方法的浅接口。真正变化的 presigner、clock、ID generator 和 rate limiter 使用 production adapter 与 test adapter。

---

## 2. Env 与固定常量

`src/env.ts` 是 bindings、vars 和 secrets 的唯一声明处：

```ts
export interface Env {
  DB: D1Database;
  BUNDLE_BUCKET: R2Bucket;
  GHOST_BATTLE_RATE_LIMITER: RateLimit;

  BUNDLE_BUCKET_NAME: "bazaarplusplus-bundle-v5";
  R2_ACCOUNT_ID: string;
  R2_PRESIGN_ACCESS_KEY_ID: string;

  R2_PRESIGN_SECRET_ACCESS_KEY: string;
  BUNDLE_SYNC_TOKEN: string;
  BAZAARDB_DELIVERY_TOKEN: string;
}
```

Cloudflare secrets：

- `R2_PRESIGN_SECRET_ACCESS_KEY`
- `BUNDLE_SYNC_TOKEN`
- `BAZAARDB_DELIVERY_TOKEN`

非 secret vars：

- `BUNDLE_BUCKET_NAME`
- `R2_ACCOUNT_ID`
- `R2_PRESIGN_ACCESS_KEY_ID`

R2 presign credential 只能读取 `bazaarplusplus-bundle-v5` 的 objects，不授予 write、delete 或其他 bucket 权限。Worker 自己的 R2 PUT/GET/LIST/DELETE 使用 `BUNDLE_BUCKET` binding，不使用这组 S3 credential。

业务限制编译为代码常量，不通过可漂移的环境变量调整：

| 常量 | 值 |
|---|---:|
| `MAX_BUNDLE_BYTES` | `8388607` |
| `MAX_MANIFEST_BYTES` | `2097152` |
| `MAX_RUN_BYTES` | `2097151` |
| `MAX_SCREENSHOT_BYTES` | `1048576` |
| `MAX_PROJECTION_BYTES` | `524288` |
| `MAX_BATTLES_PER_BUNDLE` | `30` |
| `PRESIGNED_GET_TTL_SECONDS` | `604800` |
| `SYNC_SETTLE_LAG_MS` | `60000` |
| `SYNC_MAX_LOOKBACK_MS` | `1209600000` |
| `SYNC_DEFAULT_LIMIT` | `200` |
| `SYNC_MAX_LIMIT` | `500` |
| `GHOST_LOOKBACK_MS` | `432000000` |
| `GHOST_DEFAULT_LIMIT` | `200` |
| `GHOST_MAX_LIMIT` | `200` |
| `CLAIM_LEASE_MS` | `600000` |
| `CLAIM_DEFAULT_LIMIT` | `50` |
| `CLAIM_MAX_LIMIT` | `50` |
| `MAX_DELIVERY_ATTEMPTS` | `3` |
| `SETTLE_MAX_RESULTS` | `50` |

`GHOST_BATTLE_RATE_LIMITER` 在 wrangler 中配置为每 key 每 60 秒 60 次。它是 permissive、最终一致的软限制，不用于计费或精确配额。

---

## 3. 通用 HTTP contract

### 3.1 Route 表

| Method | Path | Auth | Body |
|---|---|---|---|
| `GET` | `/health` | 无 | 无 |
| `POST` | `/bundles` | 无 | raw Bundle V5 |
| `GET` | `/bundles` | `BUNDLE_SYNC_TOKEN` | 无 |
| `GET` | `/ghost-battles` | 无；per-IP rate limit | 无 |
| `POST` | `/bazaardb/deliveries/claim` | `BAZAARDB_DELIVERY_TOKEN` | JSON |
| `POST` | `/bazaardb/deliveries/settle` | `BAZAARDB_DELIVERY_TOKEN` | JSON |

同一路径存在但 method 错误时返回 405，并带 `Allow`；未知路径返回 404。`OPTIONS` 只回答已存在 route 的 preflight，不把不存在的 route 伪装成可用。

### 3.2 JSON 与 request ID

所有 Worker JSON response 使用：

```http
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
X-Request-Id: <request-id>
```

request ID 优先使用可信的 Cloudflare Ray ID；本地测试或 Ray ID 缺失时生成 UUID。caller 提供的 `X-Request-Id` 不作为权威 ID。

统一错误 envelope：

```json
{
  "error": {
    "code": "invalid_query",
    "message": "available_from_ms must be a non-negative safe integer",
    "retryable": false,
    "request_id": "request-id",
    "details": {
      "field": "available_from_ms"
    }
  }
}
```

规则：

- client 只以 `code`、HTTP status 和 `retryable` 决策；`message` 用于诊断，不做字符串匹配；
- `details` 可省略，只放不敏感的字段名或 reason code；
- 任何 response、log 或 trace 都不得包含 Bearer token、R2 secret 或完整 presigned URL；
- 429、503 与 500 中的 `retryable` 分别为 `true`、`true`、`true`；语义 4xx 默认为 `false`；
- 429 带 `Retry-After: 60`；临时 503 可带整数秒 `Retry-After`。

### 3.3 JSON request

claim / settle 必须使用 `Content-Type: application/json`，body 上限 64 KiB。空 body、非法 JSON、非 object 根节点、重复 `bundle_id` 或越界数组都返回 400。未知字段忽略，以允许向后兼容地增加字段。

所有 `*_ms` 都是 JSON safe integer 的 UTC Unix milliseconds。禁止字符串数字、浮点数、负数、`NaN` 或超出 `Number.MAX_SAFE_INTEGER` 的值。

### 3.4 Service-token 鉴权

受保护 route 使用：

```http
Authorization: Bearer <token>
```

鉴权必须在 JSON parsing、D1、R2 和 presign 前完成：

- header 缺失、scheme 错误、空 token、未知 token：401 `unauthorized`；
- token 是另一已配置 scope 的有效 token：403 `insufficient_scope`；
- token 正确：继续执行。

verifier 同时对两个配置 token 做固定长度、constant-time bytes compare，再决定 scope；不能遇到第一个匹配就留下可测的明显时间差。启动配置校验必须拒绝空 token 或两个 token 相同的部署。

两个 token 都使用 32 random bytes 的无 padding base64url 表示，wire 长度固定为 43 个 ASCII 字符；不接受 trim 后仍含空白或其他长度的 token。

### 3.5 CORS

`GET /health` 与 `GET /ghost-battles` 可返回 `Access-Control-Allow-Origin: *`。内部 token routes 与 `POST /bundles` 不面向浏览器，不返回 credentialed CORS。CORS 不参与鉴权。

---

## 4. `GET /health`

这是纯 liveness probe，不访问 D1、R2、presigner 或 secrets。

response 200：

```json
{
  "status": "ok",
  "server_time_ms": 1785628800000
}
```

没有 readiness 含义。D1 或 presign 配置错误时 `/health` 仍可为 200，真实 dependency 状态由 synthetic probes 和 route metrics 判断。

---

## 5. `POST /bundles`

### 5.1 Request

```http
POST /bundles HTTP/1.1
Content-Type: application/x-bpp-bundle-v5
Content-Length: 1234567
Content-Digest: sha-256=:<base64-encoded 32-byte SHA-256>:

<raw Bundle bytes>
```

要求：

- media type 必须精确为 `application/x-bpp-bundle-v5`；不接受 multipart、JSON 或 V4 type；
- `Content-Length` 必填，只接受十进制整数 `1..8388607`；缺失返回 411；
- body 实际长度必须等于声明长度；
- `Content-Digest` 必须恰好包含一个 RFC 9530 `sha-256` digest，值解码后必须为 32 bytes；
- Bundle prefix、manifest、segment layout 和 digest 使用跨仓 V5 contract；
- 无 Authorization 要求；即使 caller 带了 Authorization，也不把它当 uploader identity。

### 5.2 Success

首次把逻辑索引提交到 D1：201。

```json
{
  "bundle_id": "01K...",
  "run_id": "run-id",
  "outcome": "stored",
  "bazaardb_delivery": "created"
}
```

已存在且完整 digest 相同：200。

```json
{
  "bundle_id": "01K...",
  "run_id": "run-id",
  "outcome": "duplicate",
  "bazaardb_delivery": "existing"
}
```

字段枚举：

- `outcome`: `stored | duplicate`
- `bazaardb_delivery`:
  - 有 Screenshot：`created | existing`
  - 无 Screenshot：`not_applicable`

`stored` 也包括“R2 orphan 已存在、校验通过、本次补齐 D1”的情况。response 不返回 `object_key`，避免 caller 把存储布局当成上传 interface。

### 5.3 Errors

| Status | code | 条件 |
|---:|---|---|
| 400 | `invalid_content_length` | header 非十进制整数或 body 长度不等于声明 |
| 400 | `invalid_content_digest` | digest 语法、算法数量或 digest 长度错误 |
| 409 | `bundle_id_conflict` | 同 `bundle_id` 已对应不同 Bundle digest |
| 409 | `run_already_bundled` | 同 `run_id` 已属于另一个 `bundle_id` |
| 411 | `content_length_required` | 缺 `Content-Length` |
| 413 | `bundle_too_large` | 声明或实际 bytes 达到 8 MiB |
| 415 | `unsupported_content_type` | media type 不是 Bundle V5 |
| 422 | `invalid_bundle` | prefix、manifest、字段、layout、offset 或 projection 非法；`details.reason` 给稳定 reason |
| 422 | `unsupported_bundle_version` | Bundle version 不在 accepted set |
| 422 | `unsupported_run_format` | Run format version 不在 accepted set |
| 422 | `bundle_digest_mismatch` | 实际 Bundle digest 与 `Content-Digest` 不一致 |
| 422 | `segment_digest_mismatch` | Run 或 Screenshot digest 不一致 |
| 503 | `storage_unavailable` | R2 或 D1 临时失败，logical commit 未完成 |
| 500 | `internal_error` | 未分类实现错误 |

`invalid_bundle.details.reason` 至少包括：

- `invalid_prefix`
- `manifest_too_large`
- `manifest_not_json`
- `manifest_schema_invalid`
- `too_many_battles`
- `projection_too_large`
- `run_missing`
- `run_too_large`
- `screenshot_too_large`
- `screenshot_type_unsupported`
- `segment_out_of_bounds`
- `segment_overlap`
- `undeclared_trailing_bytes`

### 5.4 Ingest 执行顺序

`BundleIngest.accept()` 隐藏完整 ingest 状态机：

1. route 校验 Content-Type、Content-Length、Content-Digest；
2. 有界读取 fixed prefix 与 manifest，只缓冲这两部分；
3. manifest validator 生成不可变 `ValidatedBundleDescriptor`，包含 ids、R2 key、segments、projection 和预期 digests；
4. 查 D1 的 `bundle_id` 与 `run_id`：相同 digest 直接返回 duplicate，冲突立即返回 409；
5. 把已缓冲 prefix/manifest 与剩余 request stream 重新串成单一流；
6. stream validator 在每个 chunk 上累计实际 byte count、Bundle SHA-256 和 segment SHA-256，同时把 bytes 送入 `FixedLengthStream(Content-Length)`；
7. R2 使用条件写入：

   ```ts
   BUNDLE_BUCKET.put(objectKey, stream, {
     onlyIf: { etagDoesNotMatch: "*" },
     httpMetadata: { contentType: "application/x-bpp-bundle-v5" },
     customMetadata: {
       bundle_version: "5",
       manifest_length: "...",
       bundle_sha256: "<lowercase hex>"
     }
   });
   ```

8. 只有 R2 PUT 与全部 stream validation 都成功后才执行 D1 batch；
9. D1 batch 原子写 Bundle、`ghost_battles` 查询投影、可选 delivery、`bundle_uploaders`；
10. 返回 stored receipt。

R2 条件 PUT 失败时返回 `null`，表示 key 已存在。此时不得覆盖对象：

- 读取既有 object 并用同一个 Bundle validator 完整校验；
- digest 相同且合法：把它作为 orphan recovery，继续 D1 commit；
- digest 不同：409 `bundle_id_conflict`；
- object 不合法：记录 critical alert，返回 503，不自动覆盖证据。

清理规则：

- 本次新建 R2 object 后发现 body / segment digest 非法：删除本次 object，不写 D1；
- 本次新建 object 后出现确定性的 `run_already_bundled`：删除本次 object；
- R2 已成功但 D1 发生未知或临时错误：保留 orphan，返回 503，由重试或 reconciler 补写；
- D1 已成功但 response 丢失：重试走 duplicate；
- 任何清理只能针对本次条件 PUT 明确创建的 key；不能删除“key 已存在”分支的 object。

应用代码不得对整个 request 调用 `arrayBuffer()`、`bytes()`、`text()` 或 `formData()`。峰值业务缓冲上限是 fixed prefix + manifest + 小型 stream chunks，不能接近 Bundle 总大小。

Worker 不解压 Run segment，因此 `run_id` 与 `run_format_version` 的 ingest 校验对象是 manifest 声明，不是 gzip MessagePack 内部字段。Analyzer 与 BazaarDB decoder 下载后必须比较 Run 根节点 `run.id/run_format_version` 与 manifest；不一致时 quarantine，不能把该 Bundle 当作成功解码。server 不声明一个无法在“不解压 Run”前提下执行的 `run_identity_mismatch` error。

---

## 6. `GET /bundles`：Analyzer 无状态同步

### 6.1 Request

```http
GET /bundles?available_from_ms=1785628800000&available_before_ms=1785632400000&limit=200
Authorization: Bearer <BUNDLE_SYNC_TOKEN>
```

query 参数：

| 参数 | 必填 | 语义 |
|---|---|---|
| `available_from_ms` | 是 | inclusive window start |
| `available_before_ms` | 否 | exclusive window end |
| `limit` | 否 | 默认 200，范围 1..500 |
| `after_available_at_ms` | 分页时是 | 上一页最后位置的时间 |
| `after_bundle_id` | 分页时是 | 上一页最后位置的 Bundle identity |

规则：

- 所有参数只能出现一次；未知参数、重复参数和非 safe integer 返回 400 `invalid_query`；
- `available_from_ms < available_before_ms`；
- `available_from_ms` 不得早于 `server_now_ms - 14 days`；更老的 R2 object 已不在下载保留承诺内；
- 省略 `available_before_ms` 时取 `floor(server_now_ms - 60000)`；
- 显式 `available_before_ms` 晚于该 settle point 时返回 400 `window_not_settled`；
- 两个 `after_*` 必须同时出现或同时缺失；
- position 必须满足 `available_from_ms <= after_available_at_ms < available_before_ms`；
- `after_bundle_id` 必须通过 V5 `bundle_id` validator；
- position 是 caller 持有的 keyset，不是 server cursor。

### 6.2 Response 200

```json
{
  "window": {
    "available_from_ms": 1785628800000,
    "available_before_ms": 1785632400000
  },
  "items": [
    {
      "bundle_id": "01K...",
      "available_at_ms": 1785629000000,
      "download_url": "https://bazaarplusplus-bundle-v5.<ACCOUNT_ID>.r2.cloudflarestorage.com/bundles/...bundle?X-Amz-Expires=604800&...",
      "download_expires_at_ms": 1786233800000
    }
  ],
  "next_after": {
    "available_at_ms": 1785629000000,
    "bundle_id": "01K..."
  }
}
```

没有下一页时 `next_after` 为 `null`。实现查询 `limit + 1` rows，只为前 `limit` rows 签名；第 `limit + 1` row 只决定是否存在下一页。这样不会为了判断末页再发一次 D1 query，也不会为未返回 row 生成 URL。

排序固定为 `available_at_ms ASC, bundle_id ASC`。response 不返回 R2 `object_key`、Bundle digest 或 Screenshot 信息；analyzer 下载并解码 Bundle 本身。

### 6.3 Errors

| Status | code | 条件 |
|---:|---|---|
| 400 | `invalid_query` | 缺字段、类型、范围、重复参数或 position 非法 |
| 400 | `window_not_settled` | window end 晚于 server settle point |
| 401 | `unauthorized` | token 缺失或无效 |
| 403 | `insufficient_scope` | 使用 BazaarDB token |
| 410 | `window_expired` | window start 早于 14 天 Bundle retention |
| 503 | `storage_unavailable` | D1 或 presigner 不可用 |

Worker 不保存 analyzer 状态。caller 只在 `next_after = null` 时提交新的 completed watermark；中断时重放固定窗口并按 `bundle_id` 去重。

`download_expires_at_ms` 表示 SigV4 授权期限，不延长 R2 object lifecycle。Analyzer 必须在枚举后立即下载，不能把 URL 当作延长 14 天 Bundle retention 的保留凭证；watermark 落后接近 14 天时必须告警。

---

## 7. `GET /ghost-battles`

### 7.1 Request 与限速

```http
GET /ghost-battles?player_account_id=account-id&limit=200
```

route 命中后首先执行：

```ts
GHOST_BATTLE_RATE_LIMITER.limit({
  key: request.headers.get("CF-Connecting-IP") ?? "unknown"
});
```

超限立即返回：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

被限速时不解析业务 query、不访问 D1、不生成 presigned URL。该 binding 只允许在本 route 调用。

query 参数：

| 参数 | 必填 | 语义 |
|---|---|---|
| `player_account_id` | 是 | 查询“该账号作为 opponent”的 battles |
| `limit` | 否 | 默认 200，范围 1..200；越界拒绝，不 clamp |

未知参数、重复参数、空 account id 或非法 limit 返回 400 `invalid_query`。lookback 固定为 server time 前 5 天。

### 7.2 Response 200

```json
{
  "battles": [
    {
      "battle_id": "battle-id",
      "bundle_id": "01K...",
      "recorded_at_ms": 1785628700000,
      "day": 10,
      "hour": 18,
      "encounter_id": null,
      "combat_kind": "pvp",
      "result": "win",
      "winner_combatant_id": "combatant-a",
      "loser_combatant_id": "combatant-b",
      "is_final_battle": true,
      "player": {
        "account_id": "uploader-account",
        "display_name": "player",
        "hero_id": null,
        "hero_name": "Vanessa",
        "rank": "Gold",
        "rating": 1234,
        "level": 10,
        "prestige": 2,
        "victories": 9
      },
      "opponent": {
        "account_id": "account-id",
        "display_name": "opponent",
        "hero_id": null,
        "hero_name": "Pygmalien",
        "rank": "Gold",
        "rating": 1200,
        "level": 10,
        "prestige": 3,
        "victories": 8
      },
      "download_url": "https://bazaarplusplus-bundle-v5.<ACCOUNT_ID>.r2.cloudflarestorage.com/bundles/...bundle?X-Amz-Expires=604800&...",
      "download_expires_at_ms": 1786233800000
    }
  ]
}
```

`player` 与 `opponent` 必须存在；其中 optional scalar 用 `null`，不省略。整个 `battles` 按 `recorded_at_ms DESC, battle_id DESC` 排序。

每个 row 的 `download_url` 指向包含该 battle 的完整 Bundle。同一 Bundle 命中多个 battle 时可以出现相同 URL；server 不裁剪 Bundle，也不创建 replay-link route。查询不做 R2 HEAD，14 天 Bundle retention 覆盖 5 天 ghost window。

同一 response 以一个固定 `issued_at_ms` 签名，并按 `object_key` memoize；同一 Bundle 命中多个 battle 时只执行一次 SigV4 计算。

`projection_json` 的结构必须与上述 battle fields 一致；`battle_id`、`bundle_id`、`recorded_at_ms`、`is_final_battle`、`download_url` 和 `download_expires_at_ms` 使用 D1 columns 或 presigner 的 server-owned 值覆盖，不能相信 manifest projection 中的同名输入。

### 7.3 Errors

| Status | code | 条件 |
|---:|---|---|
| 400 | `invalid_query` | account 或 limit 非法 |
| 429 | `rate_limited` | binding 报告超限 |
| 503 | `storage_unavailable` | D1 或 presigner 不可用 |

未知账号不是 404，而是 200 `{ "battles": [] }`。`ghost_battles` 只接收 opponent 已存在于 `bundle_uploaders`，或 opponent 就是当前 uploader 的 projection；后者会在同一 transaction 成功后进入 `bundle_uploaders`。该记录只代表“曾向 V5 上传 Bundle”，不是已验证身份或授权。

V5 不迁移 V4 player 记录，`bundle_uploaders` 从空表重新累计。opponent 首次上传之前被过滤的 Battle 不回填；这是用 ingest 完整性换取更低 D1 写入量的明确取舍。

---

## 8. `POST /bazaardb/deliveries/claim`

### 8.1 Request

```http
POST /bazaardb/deliveries/claim
Authorization: Bearer <BAZAARDB_DELIVERY_TOKEN>
Content-Type: application/json

{
  "limit": 50
}
```

`limit` 可省略，默认 50，范围 1..50。只有含 Screenshot 的 Bundle 会创建 delivery。

### 8.2 Response 200

有结果：

```json
{
  "claim_id": "clm_550e8400-e29b-41d4-a716-446655440000",
  "expires_at_ms": 1785629400000,
  "items": [
    {
      "bundle_id": "01K...",
      "run_id": "run-id",
      "download_url": "https://bazaarplusplus-bundle-v5.<ACCOUNT_ID>.r2.cloudflarestorage.com/bundles/...bundle?X-Amz-Expires=604800&...",
      "download_expires_at_ms": 1786233800000,
      "content_type": "application/x-bpp-bundle-v5",
      "sha256": "<64 lowercase hex chars>"
    }
  ]
}
```

没有 claimable delivery：

```json
{
  "claim_id": null,
  "expires_at_ms": null,
  "items": []
}
```

claim 规则：

- lease 固定 10 分钟；
- attempt 在成功领取时计数，不在 settle 时计数；
- 最多 3 次 attempt；
- 一个 Bundle 同时只属于一个未过期 claim；
- 多 consumer 可以并发调用，单条 delivery 不会同时出现在两个有效 claim；
- 返回顺序为 `claimable_at_ms ASC, created_at_ms ASC, bundle_id ASC`；
- 不做 R2 HEAD；consumer 的一次 R2 GET 同时取得 Run 与 Screenshot；
- response 丢失时，items 在 lease 到期后重新可领取；server 不维护 consumer session。

presigner 配置必须在修改 claim rows 前完成校验。若签名阶段仍发生异常，server 用一个 compensation batch 删除本次未返回的 attempt receipts，并仅对仍满足 `active_claim_id = 本次 claim` 的 rows 清 claim、把 attempt 计数减一、立即恢复 claimable；若 compensation 失败，lease 自然到期且该次 attempt 保留供运维审计。

### 8.3 Claim transaction

一次 `DB.batch()` 完成：

1. 把“第 3 次 lease 已过期仍未 settle”的 pending rows 转为 failed；
2. 单条 `UPDATE ... WHERE bundle_id IN (SELECT ... LIMIT ?)` 原子领取候选并 `RETURNING`；
3. 为每个领取 row 插入不可变 attempt receipt；
4. join `bundles` 读取 `run_id`、`object_key` 与 `bundle_sha256`。

batch 中任何 statement 失败都整体 rollback。D1 batch 是本模块的 transaction seam，不在 route 中散落多个写操作。

### 8.4 Errors

| Status | code | 条件 |
|---:|---|---|
| 400 | `invalid_json` | body 或 media type 非法 |
| 400 | `invalid_limit` | limit 非整数或越界 |
| 401 | `unauthorized` | token 缺失或无效 |
| 403 | `insufficient_scope` | 使用 Bundle Sync token |
| 503 | `storage_unavailable` | D1 或 presigner 不可用 |

---

## 9. `POST /bazaardb/deliveries/settle`

### 9.1 Request

```http
POST /bazaardb/deliveries/settle
Authorization: Bearer <BAZAARDB_DELIVERY_TOKEN>
Content-Type: application/json

{
  "claim_id": "clm_550e8400-e29b-41d4-a716-446655440000",
  "results": [
    { "bundle_id": "bundle-a", "outcome": "accepted" },
    { "bundle_id": "bundle-b", "outcome": "retryable_failure", "reason": "timeout" },
    { "bundle_id": "bundle-c", "outcome": "permanent_failure", "reason": "invalid_data" }
  ]
}
```

规则：

- `claim_id` 必须是 server 生成的格式；
- `results` 长度为 1..50；
- 同一 request 内 `bundle_id` 必须唯一；
- `outcome ∈ accepted | retryable_failure | permanent_failure`；
- failure outcome 必须带 `reason`；reason 是 `^[a-z0-9_]{1,64}$` 的机器可读 code；
- `accepted` 不允许 reason，避免把非契约文本写入日志和 D1。

### 9.2 状态变化

| outcome | delivery 结果 |
|---|---|
| `accepted` | `done`，清 active claim，写 `delivered_at_ms` |
| `retryable_failure`，attempt < 3 | `pending`，清 active claim，设置 server-side backoff |
| `retryable_failure`，attempt = 3 | `failed`，reason 为 `delivery_attempts_exhausted` |
| `permanent_failure` | `failed`，保存 caller reason |

retry backoff 固定为：第一次失败后 60 秒，第二次失败后 5 分钟；第三次不再领取。caller 不能指定下一次时间。

lease 到期后尚未被重新领取的旧 settle 也返回 `stale_claim`，不再修改 delivery；这样不会与同一时刻的新 claim 竞争。已经成功应用过的相同 settle 则始终返回 duplicate，即使 lease 已过期或 delivery 后续又发生其他 attempt。

### 9.3 Response 200

语法合法的 settle 使用逐 item 结果，不因一个 stale item 回滚其他有效 item：

```json
{
  "claim_id": "clm_550e8400-e29b-41d4-a716-446655440000",
  "items": [
    {
      "bundle_id": "bundle-a",
      "status": "applied",
      "state": "done",
      "next_claim_at_ms": null
    },
    {
      "bundle_id": "bundle-b",
      "status": "duplicate",
      "state": "pending",
      "next_claim_at_ms": 1785629460000
    },
    {
      "bundle_id": "bundle-c",
      "status": "stale_claim",
      "state": "pending",
      "next_claim_at_ms": null
    }
  ],
  "summary": {
    "applied": 1,
    "duplicate": 1,
    "rejected": 1
  }
}
```

`status`：

- `applied`：本次改变了 delivery；
- `duplicate`：相同 `claim_id + bundle_id + outcome + reason` 已应用；
- `stale_claim`：claim 不再拥有该 Bundle或 lease 已过期；
- `outcome_conflict`：同一个 attempt 已用不同 outcome / reason settle；
- `unknown_item`：不存在该 `claim_id + bundle_id` attempt。

`state` 在能确定 delivery 时为 `pending | done | failed`，unknown item 时为 `null`。`next_claim_at_ms` 只在本次结果对应 pending 且没有 active lease 时返回。

settle 不删除 R2 object。Bundle 始终服从统一 14 天 retention。

### 9.4 Settle idempotency

delivery 主表只保存当前状态，不用 `last_claim_id + last_outcome` 覆盖历史。每次 claim 都写 `bazaardb_delivery_attempts` receipt；settle 以 `(claim_id, bundle_id)` 定位 attempt。

这保证：

- response 丢失后重复 settle 得到 duplicate；
- Bundle 进入第二或第三次 claim 后，第一 claim 的重复 settle 仍能识别为 duplicate；
- 第一 claim 的迟到首次 settle 不会覆盖新的 active claim；
- 相同 attempt 改 outcome 会得到 `outcome_conflict`；
- idempotency 保留到 delivery row 的 30 天 D1 TTL，而不是只保留“最近一次结果”。

### 9.5 Request-level errors

| Status | code | 条件 |
|---:|---|---|
| 400 | `invalid_json` | body 或 media type 非法 |
| 400 | `invalid_settle_request` | claim id、results、outcome、reason 或重复 bundle id 非法 |
| 401 | `unauthorized` | token 缺失或无效 |
| 403 | `insufficient_scope` | 使用 Bundle Sync token |
| 503 | `storage_unavailable` | D1 不可用；本次 transaction 未完成 |

---

## 10. R2 presigner module

唯一 public interface：

```ts
interface BundleDownloadSigner {
  sign(objectKey: string, issuedAtMs: number): Promise<{
    url: string;
    expiresAtMs: number;
  }>;
}
```

caller 不能传 bucket、method 或 TTL。implementation 固定：

- bucket：`bazaarplusplus-bundle-v5`
- method：S3 `GetObject`
- endpoint：`https://bazaarplusplus-bundle-v5.<ACCOUNT_ID>.r2.cloudflarestorage.com`
- region：`auto`
- `X-Amz-Expires=604800`
- object key 必须由 D1 row 提供并满足 `bundles/<date>/<bundle_id>.bundle` validator

生产 adapter 使用 SigV4；测试 adapter 生成 fake URL 并记录被签名的 key。所有发现 route 复用该模块。没有 HEAD presign、PUT presign 或 caller-controlled arbitrary object key。

URL 是 bearer capability，可以在 7 天内重复 GET。日志只写 `bundle_id`、签名成功/失败和 expiry seconds，不写 URL query。R2 presigned URL 只能使用 S3 API domain，不能使用 custom domain。

---

## 11. D1 初始 schema

V5 migration 从 `0001_v5_initial.sql` 开始，不复制 V4 migration history。

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE bundles (
  bundle_id               TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL UNIQUE,
  uploader_account_id     TEXT NOT NULL,
  object_key              TEXT NOT NULL UNIQUE,
  bundle_sha256           TEXT NOT NULL CHECK (length(bundle_sha256) = 64),
  bundle_version          INTEGER NOT NULL CHECK (bundle_version = 5),
  manifest_bytes          INTEGER NOT NULL CHECK (manifest_bytes BETWEEN 1 AND 2097152),
  object_bytes            INTEGER NOT NULL CHECK (object_bytes BETWEEN 1 AND 8388607),
  client_created_at_ms    INTEGER NOT NULL,
  stored_at_ms            INTEGER NOT NULL,
  available_at_ms         INTEGER NOT NULL,

  run_format_version      INTEGER NOT NULL CHECK (run_format_version = 5),
  run_bytes               INTEGER NOT NULL CHECK (run_bytes BETWEEN 1 AND 2097151),
  run_sha256              TEXT NOT NULL CHECK (length(run_sha256) = 64),

  has_screenshot          INTEGER NOT NULL CHECK (has_screenshot IN (0, 1)),
  screenshot_content_type TEXT,
  screenshot_bytes        INTEGER,
  screenshot_sha256       TEXT,

  CHECK (
    (
      has_screenshot = 0
      AND screenshot_content_type IS NULL
      AND screenshot_bytes IS NULL
      AND screenshot_sha256 IS NULL
    )
    OR
    (
      has_screenshot = 1
      AND screenshot_content_type IS NOT NULL
      AND screenshot_content_type IN ('image/jpeg', 'image/webp')
      AND screenshot_bytes IS NOT NULL
      AND screenshot_bytes BETWEEN 1 AND 1048576
      AND screenshot_sha256 IS NOT NULL
      AND length(screenshot_sha256) = 64
    )
  )
);

CREATE INDEX idx_bundles_available
  ON bundles(available_at_ms, bundle_id, object_key);

CREATE TABLE ghost_battles (
  uploader_account_id  TEXT NOT NULL,
  battle_id             TEXT NOT NULL,
  bundle_id             TEXT NOT NULL REFERENCES bundles(bundle_id) ON DELETE CASCADE,
  opponent_account_id   TEXT NOT NULL,
  recorded_at_ms        INTEGER NOT NULL,
  is_final_battle       INTEGER NOT NULL DEFAULT 0 CHECK (is_final_battle IN (0, 1)),
  projection_json       TEXT NOT NULL CHECK (json_valid(projection_json)),
  PRIMARY KEY (uploader_account_id, battle_id)
) WITHOUT ROWID;

CREATE INDEX idx_ghost_battles_query
  ON ghost_battles(opponent_account_id, recorded_at_ms DESC, battle_id DESC);

CREATE INDEX idx_ghost_battles_ttl
  ON ghost_battles(recorded_at_ms, uploader_account_id, battle_id);

CREATE TABLE bundle_uploaders (
  player_account_id  TEXT PRIMARY KEY,
  first_bundle_at_ms INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE bazaardb_deliveries (
  bundle_id           TEXT PRIMARY KEY REFERENCES bundles(bundle_id) ON DELETE CASCADE,
  delivery_state      TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'done', 'failed')),
  active_claim_id     TEXT,
  claimable_at_ms     INTEGER NOT NULL,
  delivery_attempts   INTEGER NOT NULL DEFAULT 0
    CHECK (delivery_attempts BETWEEN 0 AND 3),
  created_at_ms       INTEGER NOT NULL,
  state_updated_at_ms INTEGER NOT NULL,
  delivered_at_ms     INTEGER,
  failed_at_ms        INTEGER,
  failure_reason      TEXT,
  CHECK (active_claim_id IS NULL OR delivery_state = 'pending'),
  CHECK (
    (
      delivery_state = 'pending'
      AND delivered_at_ms IS NULL
      AND failed_at_ms IS NULL
      AND failure_reason IS NULL
    )
    OR (
      delivery_state = 'done'
      AND delivered_at_ms IS NOT NULL
      AND failed_at_ms IS NULL
      AND failure_reason IS NULL
    )
    OR (
      delivery_state = 'failed'
      AND failed_at_ms IS NOT NULL
      AND delivered_at_ms IS NULL
      AND failure_reason IS NOT NULL
    )
  )
);

CREATE INDEX idx_bazaardb_claimable
  ON bazaardb_deliveries(claimable_at_ms, created_at_ms, bundle_id)
  WHERE delivery_state = 'pending' AND delivery_attempts < 3;

CREATE INDEX idx_bazaardb_active_claim
  ON bazaardb_deliveries(active_claim_id, bundle_id)
  WHERE delivery_state = 'pending' AND active_claim_id IS NOT NULL;

CREATE INDEX idx_bazaardb_exhausted_lease
  ON bazaardb_deliveries(claimable_at_ms, bundle_id)
  WHERE delivery_state = 'pending'
    AND delivery_attempts = 3
    AND active_claim_id IS NOT NULL;

CREATE TABLE bazaardb_delivery_attempts (
  claim_id       TEXT NOT NULL,
  bundle_id      TEXT NOT NULL REFERENCES bazaardb_deliveries(bundle_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  claimed_at_ms  INTEGER NOT NULL,
  expires_at_ms  INTEGER NOT NULL,
  settled_at_ms  INTEGER,
  outcome        TEXT CHECK (
    outcome IS NULL OR outcome IN (
      'accepted', 'retryable_failure', 'permanent_failure'
    )
  ),
  reason         TEXT,
  PRIMARY KEY (claim_id, bundle_id),
  UNIQUE (bundle_id, attempt_number),
  CHECK (
    (outcome IS NULL AND settled_at_ms IS NULL AND reason IS NULL)
    OR
    (outcome = 'accepted' AND settled_at_ms IS NOT NULL AND reason IS NULL)
    OR
    (
      outcome IN ('retryable_failure', 'permanent_failure')
      AND settled_at_ms IS NOT NULL
      AND reason IS NOT NULL
    )
  )
) WITHOUT ROWID;

CREATE TABLE maintenance_state (
  job_name      TEXT PRIMARY KEY,
  cursor_json   TEXT,
  last_start_ms INTEGER,
  last_ok_ms    INTEGER,
  last_error    TEXT
) WITHOUT ROWID;
```

不存 `run_projection_json`：当前 server 没有 Run facts query，analyzer 直接下载 Bundle。Ghost 所需 projection 只存于 `ghost_battles.projection_json`。`ghost_battles` 是可从 Bundle manifest 重建的查询投影，不是 Battle 权威数据；R2 Bundle 才是权威数据。

`bundle_uploaders` 只记录 V5 成功提交的 Bundle uploader。新 D1 部署时为空，不从 V4 `seen_player_accounts` 导入；`first_bundle_at_ms` 使用 server time。后续 Bundle 使用 `ON CONFLICT DO NOTHING`，不为维护未被查询的 last-seen 时间产生额外 row write。

`bundle_sha256`、`run_sha256`、`screenshot_sha256` 在 D1 和 JSON response 中统一为 64 字符 lowercase hex；HTTP `Content-Digest` 的 base64 值在 request parsing 时转换一次。

---

## 12. SQL 与索引

### 12.1 Bundle commit

一次 D1 batch 顺序固定：

1. `INSERT bundles`；
2. 一条 `json_each(?)` statement 把 eligible projection 写入 `ghost_battles`；
3. `has_screenshot = 1` 时 `INSERT bazaardb_deliveries`；
4. 最后使用 `INSERT ... ON CONFLICT DO NOTHING` 把 uploader 加入 `bundle_uploaders`。

Battle ingest 规则：

- manifest 内 battle ID 必须唯一；
- 只写 `opponent_account_id = uploader_account_id` 或 opponent 已在 `bundle_uploaders` 的 row；当前 uploader 在 transaction 成功后必然属于 `bundle_uploaders`，显式 self branch 避免依赖同 transaction 的写后读；
- NULL opponent 或尚未进入 `bundle_uploaders` 的 opponent 不写，从源头降低 `ghost_battles` rows 与 index writes；
- 双方各自上传同一 battle 时，由 `(uploader_account_id, battle_id)` 保留两个方向；
- 同一 uploader 跨 Bundle 重复 battle 属于异常输入；`ON CONFLICT(uploader_account_id, battle_id) DO NOTHING` 保留首条 projection 并记录异常 metric，不做跨 Bundle 字段合并；
- `bundle_uploaders` insert 与 Ghost projection 在同一 transaction 内提交，并继续作为单调增长的 uploader set；
- opponent 首次上传前被过滤的 projection 不回填；后续新 Bundle 才开始为该 opponent 建立 Ghost rows。

`available_at_ms` 使用执行 D1 batch 前取得的 server clock，整批 statement 绑定同一值。client `created_at_ms` 不参与 sync order。

### 12.2 Bundle collection

```sql
SELECT bundle_id, available_at_ms, object_key
FROM bundles INDEXED BY idx_bundles_available
WHERE available_at_ms >= ?1
  AND available_at_ms < ?2
  AND (
    ?3 IS NULL
    OR available_at_ms > ?3
    OR (available_at_ms = ?3 AND bundle_id > ?4)
  )
ORDER BY available_at_ms ASC, bundle_id ASC
LIMIT ?5;
```

`?5 = requested_limit + 1`。该查询由 `idx_bundles_available` covering，不回表。

### 12.3 Ghost discovery

```sql
SELECT
  g.battle_id,
  g.bundle_id,
  g.recorded_at_ms,
  g.is_final_battle,
  g.projection_json,
  x.object_key
FROM ghost_battles AS g INDEXED BY idx_ghost_battles_query
JOIN bundles AS x ON x.bundle_id = g.bundle_id
WHERE g.opponent_account_id = ?1
  AND g.recorded_at_ms >= ?2
ORDER BY g.recorded_at_ms DESC, g.battle_id DESC
LIMIT ?3;
```

查询使用 `idx_ghost_battles_query` 定位与排序，并按 Bundle primary key join。opponent eligibility 已在 ingest 时处理，read path 不再 join `bundle_uploaders`。不能把大 `projection_json` 塞进索引只为了 covering。

### 12.4 BazaarDB claim

候选更新是单条原子 statement，outer predicate 重复 claimable 条件：

```sql
UPDATE bazaardb_deliveries
SET active_claim_id = ?2,
    claimable_at_ms = ?3,
    delivery_attempts = delivery_attempts + 1,
    state_updated_at_ms = ?1
WHERE bundle_id IN (
  SELECT bundle_id
  FROM bazaardb_deliveries INDEXED BY idx_bazaardb_claimable
  WHERE delivery_state = 'pending'
    AND delivery_attempts < 3
    AND claimable_at_ms <= ?1
  ORDER BY claimable_at_ms ASC, created_at_ms ASC, bundle_id ASC
  LIMIT ?4
)
  AND delivery_state = 'pending'
  AND delivery_attempts < 3
  AND claimable_at_ms <= ?1
RETURNING bundle_id, delivery_attempts;
```

随后在同一个 D1 batch 内从 `active_claim_id = ?2` 插入 attempt receipts，并 join `bundles` 返回 items。并发 claim 由 D1 transaction serialize，不依赖进程内 mutex 或 Durable Object。

### 12.5 查询与索引矩阵

| 动作 | 索引 |
|---|---|
| upload bundle idempotency | `bundles` primary key |
| upload run conflict | `bundles(run_id)` implicit unique index |
| analyzer sync | `idx_bundles_available` |
| ghost query | `idx_ghost_battles_query` + `bundles` primary key join |
| claim candidates | `idx_bazaardb_claimable` |
| active settle | `idx_bazaardb_active_claim` |
| settle receipt / idempotency | `bazaardb_delivery_attempts` primary key |
| attempt number uniqueness | `bazaardb_delivery_attempts(bundle_id, attempt_number)` unique index |

每个目标 query 都要有 `EXPLAIN QUERY PLAN` test；测试断言目标 index 名称与“不使用 TEMP B-TREE 排序”等关键 plan 属性，不断言完整 plan 文本。

---

## 13. Scheduled maintenance

`scheduled()` 调用单一 `Maintenance.run()` 模块。每个 job 有独立日志、预算和 `maintenance_state` heartbeat；一个 job 失败不能阻止后续 job 尝试。

### 13.1 Orphan reconcile

- 分页 LIST `bundles/`，cursor 写 `maintenance_state`；不能只扫 server 当前日期，因为离线补传的 Bundle key 可能使用更早的 manifest date；
- 对 R2 有、D1 无的 object 使用同一个 Bundle validator 完整 GET/校验；
- 合法 object 重放 D1 commit，`available_at_ms` 使用恢复 commit 的 server time；
- 非法 object 不自动覆盖或删除，记录 object key、reason 与 critical alert；
- D1 有、R2 无且仍在 14 天 retention window 内时告警，不伪造新 object；
- 正常 ingest 与 reconciler 共用 `BundleIngest.commitValidatedDescriptor()`，避免两套 projection 逻辑。

### 13.2 Delivery maintenance

- pending delivery 已完成 3 次且最后 lease 过期：标记 failed `delivery_attempts_exhausted`；
- pending delivery 的 Bundle 已越过 14 天 object retention：标记 failed `bundle_expired`；
- 不删除 done/failed Bundle object；R2 lifecycle 统一处理。

### 13.3 D1 TTL

按小批量循环删除：

- `ghost_battles.recorded_at_ms < now - 7 days`；
- `bundles.available_at_ms < now - 30 days`，其 deliveries 必须已经 terminal；
- Bundle 删除通过 FK cascade 删除 delivery attempts；
- 每批限制 rows 与执行时间，达到单次 cron 预算后保存进度，下次继续。

R2 14 天 lifecycle 在 Cloudflare 配置中管理，并由 deployment checklist 验证；Worker 不逐 object 模拟 lifecycle。

---

## 14. 一致性与故障矩阵

| 故障点 | 可见状态 | 恢复 |
|---|---|---|
| header / manifest reject | 无 R2、无 D1 | client permanent failure |
| R2 PUT 失败 | 无 D1 | client retry |
| stream validation 失败 | 删除本次 R2、无 D1 | client permanent failure |
| R2 成功、D1 失败 | R2 orphan | client retry或 reconciler |
| D1 成功、response 丢失 | 完整 stored | retry 返回 duplicate |
| collection response 丢失 | server 无状态 | caller 重放同 window/page |
| ghost presign 失败 | D1 不变 | 整个 route 503 |
| claim transaction 失败 | 无部分 claim | caller retry |
| claim response 丢失 | rows leased | lease 到期后重新领取 |
| settle transaction 失败 | 无部分状态变化 | caller 重试同 settle |
| settle response 丢失 | receipt 已保存 | retry 返回 duplicate |
| BazaarDB download 失败 | delivery 仍 leased | settle retryable或等待 lease 过期 |
| R2 object 提前缺失 | signed GET 返回 S3 error | BazaarDB settle failure + reconciler alert |

所有可重试写入都由 `bundle_id` 或 `(claim_id, bundle_id)` 提供幂等身份，不能依赖单个 Worker isolate 的内存状态。

---

## 15. Observability

结构化 event 至少包括：

| Event | 关键字段 |
|---|---|
| `bundle.ingest` | request_id, bundle_id, run_id, bytes, has_screenshot, outcome, phase_ms |
| `bundle.ingest.reject` | request_id, bundle_id?, code, reason, declared_bytes |
| `bundle.collection` | request_id, window, row_count, has_next, d1_ms, presign_ms |
| `ghost.discovery` | request_id, account_hash, row_count, limited, d1_ms, presign_ms |
| `bazaardb.claim` | request_id, claim_id, item_count, lease_ms, d1_ms, presign_ms |
| `bazaardb.settle` | request_id, claim_id, applied, duplicate, rejected, d1_ms |
| `maintenance.reconcile` | scanned, restored, invalid, missing, cursor, duration_ms |
| `maintenance.ttl` | table, deleted, cutoff_ms, duration_ms |

`player_account_id` 在公开 route 日志中只写稳定 hash，不写原值。可以记录 `bundle_id`、`run_id`、`claim_id` 和 object key，但不能记录：

- Authorization header；
- configured tokens；
- R2 Secret Access Key；
- 完整 presigned URL；
- Screenshot bytes；
- Bundle body 或 projection JSON。

告警：

- ingest 5xx / 503 rate；
- `bundle_id_conflict` 异常增长；
- R2 orphan 数量与最老年龄；
- analyzer sync last-success；
- pending delivery 最老年龄与 attempts-exhausted 数量；
- presigner failure；
- maintenance heartbeat 缺失；
- ghost 429 rate。

---

## 16. 测试策略

### 16.1 HTTP contract tests

所有 route 通过 `worker.fetch()` 测试真实 status、headers 和 JSON shape：

- method/path 匹配、404、405、OPTIONS；
- auth 401/403 scope matrix，且 auth failure 时 D1/R2 未调用；
- request ID 与统一 error envelope；
- query duplicate/unknown/边界值；
- success response 不泄露 object key 或 secret。

### 16.2 Bundle fixtures

跨仓 golden vectors 加入 V5 worker tests：

- Run only；
- Run + JPEG Screenshot；
- 每个 size 边界的 below/equal/above；
- prefix、manifest length、offset、overlap、trailing bytes；
- Bundle / Run / Screenshot digest mutation；
- unknown version；
- manifest / Run identity mismatch；
- 30 battle limit 与 duplicate battle ID；
- malicious JSON depth、huge strings、invalid UTF-8。

测试必须证明接近 8 MiB 的合法请求不调用全体 buffering helper。

### 16.3 Storage and concurrency

- 首次 stored、相同 digest duplicate、bundle conflict、run conflict；
- R2 conditional PUT race；
- R2 orphan recovery；
- D1 failure 后 object 保留；
- invalid stream 后只删除本次创建的 object；
- 双方上传同一 battle 保留两个方向；
- `ghost_battles` 只接收 opponent 已存在于 `bundle_uploaders` 或等于当前 uploader 的 projection；
- `bundle_uploaders` 从空表单调记录 V5 uploader，不读取 V4 player 表；opponent 首次上传前过滤的历史 row 不回填；
- 跨 Bundle 重复 battle 保留首条 projection 并记录异常 metric；
- collection 固定窗口、`limit + 1`、同毫秒 tie-break；
- 两个并发 claim 不重叠；
- lease expiry、三次 attempt、retry backoff；
- settle applied / duplicate / stale / outcome conflict / unknown；
- 第一 attempt 的 duplicate settle 在第二 attempt 后仍可识别。

### 16.4 Adapter tests

- production presigner 只生成 GET、固定 bucket、固定 key、`X-Amz-Expires=604800`；
- 修改 key、method、expiry 或 signature 后，集成环境由 R2 拒绝；
- fake presigner 不访问网络并记录调用；
- Ghost limiter 在 D1 前执行，429 时无 query/presign；
- collection、claim、settle、presigner 都不调用 Ghost limiter；
- wrangler config 与 `Env` declarations 一致。

### 16.5 SQL plan tests

对第 12 节每条 query 运行 `EXPLAIN QUERY PLAN`。migration test 同时验证：

- foreign keys；
- CHECK constraints；
- partial indexes；
- unique identities；
- D1 batch 中任一 statement 失败会 rollback 全部 projection。

---

## 17. 实现顺序

1. 建立 `workers/mod-api-v5` 独立 package、wrangler、Env、router 和统一错误 contract。
2. 提交 `contracts/v5` Bundle prefix/manifest validator 与 golden fixtures。
3. 建立 `0001_v5_initial.sql` 和 schema / query-plan tests。
4. 实现固定 R2 presigner production/test adapters。
5. 实现 Bundle streaming validator、conditional R2 PUT、D1 commit 与 orphan recovery。
6. 实现 Analyzer Bundle collection 与 keyset tests。
7. 实现 Ghost discovery、projection mapping 与 rate limiter tests。
8. 实现 BazaarDB claim、attempt receipts、settle state machine 与并发 tests。
9. 实现 scheduled reconciler、delivery maintenance、TTL 和 heartbeat。
10. 生成 `workers/mod-api-v5/docs/api-reference.md`；其 wire 内容必须与本文第 3～9 节逐字段一致。
11. 创建独立 Cloudflare resources、secrets、read-only R2 credentials 和 lifecycle rule。
12. 通过 synthetic upload → collection / ghost / claim → direct R2 GET → settle 的生产 smoke test 后，再允许 mod V5 发布。

---

## 18. Server 验收标准

- V5 Worker 可以独立部署、回滚和删除，不读取 V4 D1/R2。
- route 表之外没有隐藏 download、installation、snapshot 或 Pack interface。
- POST `/bundles` 对合法 Bundle 只产生一个 R2 object 和一个原子 D1 logical commit。
- Run-only Bundle 不创建 BazaarDB delivery；含 Screenshot Bundle 恰好创建一个。
- 同 Bundle 重试返回 duplicate；冲突身份不会覆盖 R2 object。
- 接近 8 MiB 的上传通过 streaming path，未整体缓冲。
- Analyzer 通过固定时间窗口与显式 keyset 完成同步，Worker 不保存 session。
- Ghost route 是唯一调用 rate limiter binding 的 route，并在 D1 前限速。
- Ghost、Analyzer 和 BazaarDB 拿到同一个 Bundle bytes 的 7 天 R2 presigned GET URL。
- Worker 不提供 Bundle download proxy，实际 download 不经过 Worker rate limiter。
- 多 BazaarDB consumer claim 不重叠；重复 settle 在后续 attempt 发生后仍幂等。
- D1 schema 中没有 installation、download token、Run object、Screenshot object 或 Pack table。
- `EXPLAIN QUERY PLAN` 证明 collection、ghost、claim 和 settle 使用预期索引。
- 日志、错误和 traces 不包含 token、secret、Screenshot、Bundle body 或完整 presigned URL。
- R2 orphan、过期 delivery、D1 TTL 和 maintenance heartbeat 都有可测试恢复路径。

---

## 19. Cloudflare 实现依据

- [R2 Workers API：streaming 与 conditional PUT](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 presigned URLs：SigV4、S3 endpoint 与 7 天上限](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [D1 `batch()` transaction 语义](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers Streams 与 `FixedLengthStream`](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/)
