# BPP 数据管线 V5 跨仓联合设计（mod / modapiv5 / analyzers / BazaarDB）

日期：2026-08-02

状态：已实现；本文是跨仓最终契约

范围：`bazaarplusplus-mod` / `bazaarplusplus-server` / `bazaarplusplus-analyzers` / BazaarDB 消费接口

modapiv5 的 route、错误、模块、D1 transaction、R2 与定时维护细节见 [`2026-08-02-v5-server-implementation.md`](./2026-08-02-v5-server-implementation.md)。本文保留跨仓契约与整体拓扑；两者有不同细化程度时，以 server 实现设计的 HTTP / SQL 定义为准。

## 0. 已冻结的架构决策

1. 新建独立 Worker 与存储：
   - Worker：`bazaarplusplus-mod-api-v5`
   - 域名：`mod-api-v5.bazaarplusplus.com`
   - D1：`bazaarplusplus-mod-api-v5-db`
   - R2：`bazaarplusplus-bundle-v5`
2. V5 不复用 V4 Worker、D1 schema、R2 对象布局或 wire contract，不做原地迁移。
3. **Bundle 是最小的上传、R2 存储和交付单位。一个 Bundle 恰好包含一个 Run，并可选包含一张 Screenshot。**
4. Screenshot 为 `0..1`：未开启 BazaarDB、截图失败或压缩失败时，Bundle 仍然有效，Run 必须照常上传。
5. V5 不存在 Pack、独立 screenshot upload、snapshot object 或第二条图片上传状态机。
6. mod 每个 completed Run 生成一个不可变 Bundle；Worker 每个新 Bundle 只做一次 R2 PUT 和一次 D1 transaction。
7. Bundle 是最小交付单位；ghost、analyzers 与 BazaarDB 都下载完整 Bundle，存在 Screenshot 时无需为任何调用方裁剪。
8. BazaarDB 一次取得 Run 与 Screenshot；交付身份和幂等键统一为 `bundle_id`。
9. Bundle collection 与 BazaarDB control routes 是 service-token 内部接口；`GET /ghost-battles` 是开放接口，先做 per-IP rate limit。三条发现路径都返回有效期 7 天的 R2 presigned GET URL；客户端绕过 Worker 直接从 R2 S3 endpoint 下载。
10. mod 的 V5 运行时数据根目录为 `<GameRoot>/BazaarPlusPlusV5/`，不复用 `<GameRoot>/BazaarPlusPlusV4/`。
11. V4 Worker 保持运行至存量排空，然后整体下线。

---

## 1. 领域语言与统一命名

### Bundle

单局不可变数据产品，也是最小上传和持久化对象。它包含：

- exactly one Run；
- zero or one Screenshot。

统一命名：

- Content-Type：`application/x-bpp-bundle-v5`
- identity：`bundle_id`
- upload route：`POST /bundles`
- R2 bucket：`bazaarplusplus-bundle-v5`
- object key：`bundles/<yyyy-mm-dd>/<bundle_id>.bundle`
- D1 root table：`bundles`
- 本地 sealed 文件扩展名：`.bundle`

Bundle 不是多局批次，不包含第二个 Run，也不会在上传后追加 Screenshot。

### Run

一次 completed game run 的不可变事实，包括 run facts、battles、card snapshots 与 replay。Run 不包含 Screenshot。

统一命名：

- nested Content-Type：`application/x-bpp-run-v5`
- identity：`run_id`
- format discriminator：`run_format_version = 5`
- ownership：恰好属于一个 `bundle_id`

Run 是 Bundle 内的必填子对象，不是独立 R2 对象，也没有独立上传接口。

### Screenshot

Run 结束时为 BazaarDB 生成的可选图片。它只存在于 Bundle 内，不拥有独立 server identity、D1 row、R2 key 或上传状态。

wire 中 Screenshot 字段缺失表示没有图片；不得用空 byte array、占位图片或失败 JSON 伪装存在。

### BazaarDB Delivery

“把一个含 Screenshot 的 Bundle 交付给 BazaarDB”的可领取义务。完成交付只消费 delivery，不删除 Bundle。

### 禁用名称

- `boundle`
- `pack`
- `ingest pack`
- `run artifact`（指 V5 顶层对象时）
- `run bundle`
- `snapshot upload`
- `snapshot delivery`
- `snapshot_id`

`application/x-bpp-ingest-pack` 与 `application/x-bpp-boundle-pack-v5` 均不是 V5 contract。顶层请求只使用 `application/x-bpp-bundle-v5`。

---

## 2. 最终拓扑

```text
mod
  completed Run
       │
       ├─ Screenshot disabled / failed ───────────────┐
       └─ optional compressed Screenshot ─────────────┤
                                                      ▼
                                      BundleBuilder seals one Bundle
                                      1 Run + 0..1 Screenshot
                                                      │
                                                      │ POST /bundles
                                                      ▼
modapiv5 Worker
  bounded manifest validation → streaming hashes → one R2 PUT
       → one D1 transaction: Bundle + Ghost Battle projection + optional BazaarDB delivery
                                                      │
        ┌─────────────────────────────────────────────┼────────────────────────────┐
        ▼                                             ▼                            ▼
GET /ghost-battles                       GET /bundles               POST /bazaardb/deliveries/claim
  open + per-IP rate limit                 Bundle Sync token           BazaarDB token
  R2 presigned GET URL                     R2 presigned GET URLs       R2 presigned GET URLs
        └──────────────────────────────────┴────────────────────────────┘
                                      direct R2 download
  Run + optional Screenshot                Run + optional Screenshot   Run + Screenshot
```

V4 与 V5 是两个独立部署：

```text
mod-api-v4.bazaarplusplus.com → V4 Worker → V4 D1 + V4 buckets
mod-api-v5.bazaarplusplus.com → modapiv5 → fresh V5 D1 + bazaarplusplus-bundle-v5
```

强更后的 mod 只发送 V5 Bundle。发布 mod 前，必须先部署并验证完整支持 V5 interface 的 modapiv5、analyzers 与 BazaarDB client。

---

## 3. mod 本地目录与持久化

### 3.1 V5 根目录

所有 V5 runtime data 从同一个 path provider 解析到：

```text
<GameRoot>/BazaarPlusPlusV5/
  database/
  replays/
  screenshots/
  uploads/
    bundles/
      ready/
      dead-letter/
```

具体数据库文件名可沿用模块内部约定，但不得越过 `BazaarPlusPlusV5` 根目录。V5 的 SQLite schema、replay payload、截图工作文件、sealed Bundle、重试状态和 dead letter 都在这个根下。

以下名称不变：

- BepInEx plugin / assembly：`BazaarPlusPlus`
- namespace：`BazaarPlusPlus.*`
- config：`BazaarPlusPlus.cfg`

`BazaarPlusPlusV5` 只表示 V5 runtime data directory，不要求重命名程序集或源码目录。

### 3.2 与 V4 隔离

- 不自动移动、删除、升级或写入 `<GameRoot>/BazaarPlusPlusV4/`。
- V5 启动不得扫描 V4 upload queue，也不得把 V4 gzip/contractless artifact 当作 V5 Run。
- 若需要补传 V4 数据，使用显式、只读的 backfill importer：读取 V4，解码后重新生成 V5 Bundle，再写入 V5 根目录。
- V5 SQLite 使用独立 schema lineage；不对 V4 database 执行 in-place migration。

### 3.3 本地 Bundle 队列

最小状态：

- `upload_bundles(bundle_id, run_id, sha256, file_path, state, attempts, next_attempt_at_ms, last_error)`
- `state ∈ ready | uploading | retry_wait | stored | dead_letter`

Bundle seal 后，成员、manifest、字节和 SHA-256 永久固定。网络重试必须复用同一个 `.bundle` 文件，禁止重新截图或重新序列化。

只有 server 返回 `stored` 或 `duplicate` 后，才能清理该 Run 的 dirty upload state。永久坏 Bundle 进入可导出的 dead letter，不能静默丢弃。

---

## 4. Bundle V5 wire contract

### 4.1 Bundle 形成条件

候选 Run 必须是 completed、Ranked、非 PTR。Screenshot workflow 必须先进入终态：

- 未开启 BazaarDB opt-in：不等待截图，生成无 Screenshot Bundle。
- 已开启且截图成功：压缩后把 Screenshot 放入 Bundle。
- 已开启但截图或压缩在有界尝试后失败：记录本地可见失败，生成无 Screenshot Bundle。
- Screenshot workflow 超时：按失败处理，不能无限阻塞 Run。

opt-in 在截图开始与 Bundle seal 前各检查一次。seal 前已关闭 opt-in 时丢弃 derivative，Bundle 只保留 Run。Bundle seal 后不可变；后续设置变化只影响尚未 seal 的 Bundle 和未来 Run。

一个 Run 只能形成一个被 server 接受的 Bundle。`bundle_id` 与 `run_id` 都在第一次 seal 时生成并持久化。

### 4.2 二进制布局

```text
+----------------------+---------------------------------------------+
| fixed prefix         | magic, bundle_version, manifest_length      |
+----------------------+---------------------------------------------+
| manifest JSON        | ids, projections, Run/Screenshot locators   |
+----------------------+---------------------------------------------+
| Run payload          | deterministic gzip + explicit MessagePack   |
+----------------------+---------------------------------------------+
| optional Screenshot  | compressed image bytes; absent when missing |
+----------------------+---------------------------------------------+
```

Bundle 不做外层压缩：

- ghost、analyzers 与 BazaarDB 使用同一份完整 Bundle bytes；
- Screenshot 已经是压缩图片，不再重复 gzip；
- Worker 可在不解压 Run 的情况下验证各 segment 并写索引。

fixed prefix 固定为 16 bytes：offset `0..7` 是 ASCII `BPPBNDL5`，offset `8..11` 是 u32 big-endian `bundle_version`，offset `12..15` 是 u32 big-endian `manifest_length`。所有 segment offset 相对 manifest 后的第一个 payload byte。

manifest 最小形状：

```json
{
  "bundle_id": "01K...",
  "bundle_version": 5,
  "created_at_ms": 1785628800000,
  "run": {
    "run_id": "run-id",
    "player_account_id": "account-id",
    "run_format_version": 5,
    "projection": {
      "run": {},
      "battles": []
    },
    "payload": {
      "offset": 0,
      "length": 123456,
      "sha256": "...",
      "content_type": "application/x-bpp-run-v5"
    }
  },
  "screenshot": {
    "offset": 123456,
    "length": 456789,
    "sha256": "...",
    "content_type": "image/jpeg",
    "width": 1600,
    "height": 900,
    "quality": 80,
    "captured_at_ms": 1785628800000
  }
}
```

无 Screenshot 时，`screenshot` key 整体缺失。offset 相对 payload 区起点，只用于 Bundle decoder 和 ingest 完整性校验，不写入 D1 download locator。

请求必须带 `Content-Length` 与标准 `Content-Digest`。digest 覆盖完整 Bundle；manifest 不内嵌 bundle digest，避免自引用。

### 4.3 Run V5

V5 Run 是全新 contract，不兼容 V4 contractless MessagePack：

- Content-Type：`application/x-bpp-run-v5`。
- wire：deterministic gzip 包裹显式 schema 的 MessagePack map。
- 根节点自带 `run_format_version: 5` 与 `run.id`。
- key 固定为 snake_case 字符串；C# 使用显式 `[MessagePackObject]` / `[Key("...")]`，禁止 `ContractlessStandardResolver`。
- 时间统一为 UTC Unix milliseconds。
- replay message 使用 MessagePack binary values，不做 base64。
- 未知字段可忽略；缺 required 字段、错误类型和未知 format version 必须失败。

逻辑形状：

```json
{
  "run_format_version": 5,
  "run": {
    "id": "run-id",
    "player_account_id": "account-id",
    "player_display_name": "player",
    "status": "completed",
    "started_at_ms": 1785620000000,
    "ended_at_ms": 1785628800000,
    "hero": { "id": null, "name": "Vanessa" },
    "final": {
      "day": 10,
      "wins": 10,
      "losses": 2,
      "rank": "Gold",
      "rating": 1234,
      "position": null
    }
  },
  "battles": [
    {
      "id": "battle-id",
      "recorded_at_ms": 1785628700000,
      "day": 10,
      "hour": 18,
      "encounter_id": null,
      "combat_kind": "pvp",
      "result": "win",
      "winner_combatant_id": "...",
      "loser_combatant_id": "...",
      "player": {},
      "opponent": {},
      "card_sets": [],
      "replay": {
        "protocol_version": 1,
        "spawn_message": "<MessagePack bin>",
        "combat_message": "<MessagePack bin>",
        "despawn_message": "<MessagePack bin>"
      }
    }
  ]
}
```

Run 内不再放 `bazaardb`、Screenshot 或 base64 image。完整 schema 位于 `contracts/v5/run-v5.yaml`；codegen 产出 C# model/serializer、Python model/decoder 与 BazaarDB fixtures。

manifest `projection` 是 Worker 不解压 Run 仍能写 ghost SQL 所需的最小派生物。projection 必须由同一个生成模型的纯函数产生；golden test 断言 projection 与解码 Run 一致。

### 4.4 Screenshot V5

Screenshot 是 Bundle 的可选 binary segment，逻辑 metadata 在 Bundle manifest 中。V5 对所有 opt-in 图片生成独立 derivative，本地原始图片不被改写：

1. 删除 metadata；移除 alpha，并在固定背景色上合成。
2. 最长边限制为 1600 px。
3. 首选 JPEG quality 80。
4. 超过 768 KiB 时依次尝试 quality 72、64；仍超限则把最长边降到 1280、1024 px。
5. 目标不超过 768 KiB，硬上限 1 MiB。
6. 无法满足硬上限时视为 Screenshot 失败，Bundle 只包含 Run。
7. 记录输出尺寸、quality、content type 和 byte length，用于质量回归。

不生成 BazaarDB base64 JSON，不生成 `snapshot_id`，不单独 PUT Screenshot。

### 4.5 硬限制

| 项 | V5 限制 |
|---|---:|
| Run / Bundle | exactly 1 |
| Screenshot / Bundle | 0..1 |
| Battle projection / Bundle | 0..30 |
| manifest | ≤2 MiB |
| Run payload | <2 MiB |
| Screenshot binary | ≤1 MiB |
| Bundle total | <8 MiB |
| Run projection | ≤512 KiB |

Worker 只缓冲 fixed prefix 与 manifest。Run 和 Screenshot 通过有界 stream 同时计算 segment digest 与 Bundle digest，并直接写 R2；禁止对整个请求调用 `arrayBuffer()`、`formData()` 或 JSON decode。

### 4.6 segment 与 manifest 校验

PUT 前或流式 PUT 期间必须拒绝：

- `Content-Length >= 8388608`，直接返回 413，不开始 R2 PUT；
- prefix magic、版本或长度非法；
- manifest 超限或不是严格 JSON；
- Run segment 缺失、为空、达到 2 MiB、越界或 Content-Type 错误；
- Screenshot segment 存在但为空、越界、类型不受支持或超过 1 MiB；
- segment 重叠、顺序错误、留下未声明尾部 bytes；
- `bundle_id`、`run_id`、account identity 或时间字段格式非法；
- projection 超限；
- segment SHA-256 或 Bundle digest 不匹配；
- 未知 Bundle / Run version。

Worker 不信任客户端提供的 R2 key，也不接受 caller-provided absolute offsets。

### 4.7 幂等与冲突

- object key 固定为 `bundles/<manifest-date>/<bundle_id>.bundle`。
- 同 `bundle_id`、同 Bundle digest：200 `duplicate`，不重复 PUT 或写 projection。
- 同 `bundle_id`、不同 digest：409 `bundle_id_conflict`。
- 同 `run_id` 已属于另一个 `bundle_id`：409 `run_already_bundled`。
- Worker 不解压 Run，因此 ingest 只校验 manifest 声明的 `run_id` 与 `run_format_version`；Analyzer 与 BazaarDB decoder 下载解压后必须把 Run 根节点 identity/version 与 manifest 比较，不一致时 quarantine。
- R2 PUT 后 digest 不匹配：删除对象，不写 D1，返回 422。
- R2 PUT 后、D1 commit 前中断：相同 Bundle 的客户端重试重新 GET 并验证完整对象后补写 D1；未重试的 object 由 14 天 R2 lifecycle 删除。

`contracts/v5/versions.yaml` 是 `bundle_version`、`run_format_version` 与 accepted sets 的唯一登记处。追加可忽略字段不 bump；删除、改名或改语义才 bump。

---

## 5. modapiv5 HTTP interface

新域名已经表达代际，path 不重复 `/v5`。interface 按调用方能完成的领域动作设计，不暴露 D1/R2 实现。

| 调用方 | Method + path | 语义 |
|---|---|---|
| mod | `POST /bundles` | 上传一个 sealed Bundle |
| mod | `GET /ghost-battles` | 开放、per-IP rate limit；返回 ghost facts 与 7 天 signed Bundle URL |
| analyzers | `GET /bundles?available_from_ms=&available_before_ms=` | Bundle Sync token；按可用时间窗口无状态枚举 Bundles |
| BazaarDB | `POST /bazaardb/deliveries/claim` | BazaarDB token；租约领取一批含 Screenshot 的 Bundles |
| BazaarDB | `POST /bazaardb/deliveries/settle` | BazaarDB token；一次提交逐 Bundle 处理结果 |

V5 没有：

- `/capabilities`
- `/installations`
- installation bearer token
- `/snapshots/*`
- `/bazaardb/snapshots/*`
- 独立 Screenshot upload
- 独立 `/runs/:run_id` download
- Worker `/bundles/:bundle_id` download proxy
- `/ghost-battles/:id/replay-link`

Worker 不实现 per-install authentication、long-lived download token issuance 或 D1 token table。它使用两个 service tokens 和一组只读 R2 S3 credentials：

- `BUNDLE_SYNC_TOKEN`：只允许 Bundle collection。
- `BAZAARDB_DELIVERY_TOKEN`：只允许 BazaarDB claim/settle。
- `R2_PRESIGN_ACCESS_KEY_ID` / `R2_PRESIGN_SECRET_ACCESS_KEY`：只用于对 `bazaarplusplus-bundle-v5` bucket 的 `GetObject` presign。

两个 service tokens 与 `R2_PRESIGN_SECRET_ACCESS_KEY` 作为 Cloudflare Workers secrets 注入；`R2_ACCOUNT_ID`、bucket name 与 Access Key ID 是非 secret config。它们全部在 `Env` interface 中声明，不写入 D1。两个 service tokens 必须不同，按原始 bytes 做 constant-time compare，不能跨 scope 使用。缺失或无效 token 统一返回 401；token 有效但 scope 错误返回 403。R2 credential 必须由只授予目标 bucket Object Read 的专用 API token 生成，不能拥有 write/delete 或其他 bucket 权限。Access Key ID 会出现在 presigned URL 的 `X-Amz-Credential` 中；Secret Access Key 永不记录或返回。

所有 contract version 和 size limit 编译进 mod 与 consumers，不做运行时 capability negotiation。`POST /bundles` 与 `GET /ghost-battles` 不验证 service token。Worker 不接收 Bundle bytes download request。

### 5.1 Bundle upload

`POST /bundles`：

- `Content-Type: application/x-bpp-bundle-v5`
- `Content-Length` 必填
- `Content-Digest` 必填
- 不需要 Authorization header

成功回执：

```json
{
  "bundle_id": "01K...",
  "run_id": "run-id",
  "outcome": "stored",
  "bazaardb_delivery": "created"
}
```

`outcome ∈ stored | duplicate`。`bazaardb_delivery`：

- Screenshot 存在：`created | existing`
- Screenshot 不存在：`not_applicable`

统一错误 envelope：

```json
{
  "error": {
    "code": "bundle_id_conflict",
    "message": "...",
    "retryable": false,
    "request_id": "..."
  }
}
```

4xx 永久错误进入本地 dead letter；408、429 与 5xx 按带 jitter 的指数退避重试，并尊重 `Retry-After`。

由于没有 uploader authentication，manifest 的 `player_account_id` 是 caller assertion，不能被其他模块当作已验证身份或安全授权依据。公开 ingest 仍必须保留 WAF/rate limit、严格大小限制、并发限制和异常流量告警。

### 5.2 Bundle collection：无状态时间窗口同步

Analyzer 按 Bundle 首次进入可下载索引的时间同步，不按 `run.ended_at_ms` 或 client `created_at_ms` 同步：

```http
GET /bundles?available_from_ms=1785628800000&available_before_ms=1785632400000&limit=200
Authorization: Bearer <BUNDLE_SYNC_TOKEN>
```

参数：

- `available_from_ms`：必填、inclusive。
- `available_from_ms` 不得早于 `server_now_ms - 14 days`；更老的 window 返回 410 `window_expired`，因为已经超出 R2 Bundle retention。
- `available_before_ms`：可选、exclusive；省略时 Worker 使用 `server_now_ms - 60_000`，并在 response 中返回这个固定值。显式值晚于该 settle point 时返回 400 `window_not_settled`。
- `limit`：可选，默认 200，范围 1～500。
- `after_available_at_ms` 与 `after_bundle_id`：后续页成对出现，表示上一页最后一项；它们是显式 keyset position，不是 server-side cursor。

`available_from_ms` 必须小于 `available_before_ms`；`next_after` position 必须落在同一窗口内。非法组合返回 400，不做自动交换或静默截断。

response：

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
      "download_url": "https://bazaarplusplus-bundle-v5.<ACCOUNT_ID>.r2.cloudflarestorage.com/bundles/...bundle?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800&X-Amz-Signature=...",
      "download_expires_at_ms": 1786233800000
    }
  ],
  "next_after": {
    "available_at_ms": 1785629000000,
    "bundle_id": "01K..."
  }
}
```

没有下一页时 `next_after` 为 `null`。排序固定为 `available_at_ms ASC, bundle_id ASC`；同一毫秒的 Bundle 由 `bundle_id` 打破平局。

Analyzer sync 流程：

1. 首次同步选择 14 天 R2 retention 内的 `available_from_ms`；后续同步使用 `max(0, last_completed_before_ms - 60_000)`，保留一分钟重叠窗口。
2. 第一页可省略 `available_before_ms`，并保存 response 中固定的 `window.available_before_ms`。
3. 后续页带回相同的时间窗口与 `next_after` 两个字段。
4. 只有 `next_after = null` 时才持久化新的 `last_completed_before_ms`。
5. 进程中断后重放整个未完成窗口，以 `bundle_id` 去重。

Worker 不保存 analyzer session、watermark、cursor 或完成状态。60 秒 settle lag 与下一窗口的 60 秒 overlap 防止并发 D1 commit 落在分页切面上；重复项由 analyzer 按 `bundle_id` 去重。`available_at_ms` 在 D1 commit 时生成；R2-only object 经相同上传重试补写时使用重试 commit time，因此不会被塞回 analyzer 已经完成的旧窗口。

`download_expires_at_ms` 只表示 SigV4 授权期限，不延长 R2 object lifecycle。Analyzer 必须枚举后立即下载；watermark 接近 14 天 retention 时告警，不能把 presigned URL 当作额外保留承诺。

### 5.3 Ghost Battle discovery

`GET /ghost-battles` 是开放接口，不需要 service token。它是唯一调用 rate-limit binding 的 route：

1. 在任何 D1 query 前调用 `GHOST_BATTLE_RATE_LIMITER.limit({ key: CF-Connecting-IP })`；header 缺失时使用固定 `unknown` key。
2. 初始阈值为每 IP 每 60 秒 60 次。
3. binding 报告超限时返回 429 和 `Retry-After: 60`，不执行 D1 query 或 URL signing。
4. 未超限时查询 ghost facts，并为每个返回项签发有效期 7 天的 Bundle download URL。

`GHOST_BATTLE_RATE_LIMITER` 使用 Cloudflare Worker Rate Limiting binding，必须在 wrangler 与 `Env` interface 中声明。该能力是最终一致的软限制，测试只断言调用顺序、key、429 和 `Retry-After`，不假设分布式计数绝对精确。实现约束参见 [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

Bundle collection、BazaarDB claim/settle 与 R2 presigner 都不得调用 `GHOST_BATTLE_RATE_LIMITER`；实际 Bundle download 直接发生在 R2。

### 5.4 R2 presigned Bundle download

Ghost feed、Bundle collection 与 BazaarDB claim 把内部 `object_key` 交给同一个 presigner module：

```text
presignGet(object_key, expires_in_seconds = 604800) -> r2_presigned_url
```

返回 URL 形如：

```text
https://bazaarplusplus-bundle-v5.<ACCOUNT_ID>.r2.cloudflarestorage.com/
  bundles/<yyyy-mm-dd>/<bundle_id>.bundle
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=...
  &X-Amz-Date=...
  &X-Amz-Expires=604800
  &X-Amz-Signature=...
```

presign contract：

- 只允许 S3 `GetObject`，默认有效期 7 天。
- 使用 AWS Signature Version 4，在 Worker 内本地计算，不向 R2 发起签名请求。
- endpoint 固定为 R2 S3 API domain；R2 presigned URL 不支持自定义域名。
- bucket 固定为 `bazaarplusplus-bundle-v5`，object key 只来自 D1/R2 index，caller 不能提交任意 key。
- `R2_ACCOUNT_ID`、bucket name 与 Access Key ID 是非 secret config；只有 Secret Access Key 是 Workers secret。
- URL 是 bearer capability，可在过期前重复 GET；不得记录完整 URL 或 `X-Amz-*` query。
- 不创建 download-token D1 row，不存在 Worker Bundle download/proxy route。

客户端直接向 R2 下载。R2 自行验证 SigV4、检查 expiry 并返回 object bytes 或 S3 error；modapiv5 不参与数据传输、rate limiting、Content-Type/ETag 处理或 download status 映射。Ghost、analyzers 与 BazaarDB 获得相同的 Bundle bytes。

实现与测试以 [Cloudflare R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) 为准。生产 adapter 使用 SigV4 presigner；测试 adapter 返回可断言 bucket、key、method 与 expiry 的 fake URL。

### 5.5 BazaarDB claim / settle

只有 `has_screenshot = 1` 的 Bundle 创建 delivery。

claim 与 settle 都必须携带：

```http
Authorization: Bearer <BAZAARDB_DELIVERY_TOKEN>
```

`POST /bazaardb/deliveries/claim`：

```json
{
  "limit": 50
}
```

```json
{
  "claim_id": "claim-id",
  "expires_at_ms": 1785629400000,
  "items": [
    {
      "bundle_id": "01K...",
      "run_id": "run-id",
      "download_url": "https://bazaarplusplus-bundle-v5.<ACCOUNT_ID>.r2.cloudflarestorage.com/bundles/...bundle?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800&X-Amz-Signature=...",
      "download_expires_at_ms": 1786233800000,
      "content_type": "application/x-bpp-bundle-v5",
      "sha256": "..."
    }
  ]
}
```

多 consumer 可并发 claim；同一个 Bundle 同时只能属于一个有效租约。默认租约 10 分钟，delivery attempt 上限 3。领取时把 `active_claim_id` 写为新 claim，并把 `claimable_at_ms` 推到租约到期时间；到期后无需 cron 改状态即可重新进入 claim query。

`POST /bazaardb/deliveries/settle`：

```json
{
  "claim_id": "claim-id",
  "results": [
    { "bundle_id": "bundle-a", "outcome": "accepted" },
    { "bundle_id": "bundle-b", "outcome": "retryable_failure", "reason": "timeout" },
    { "bundle_id": "bundle-c", "outcome": "permanent_failure", "reason": "invalid_data" }
  ]
}
```

- `accepted` → done。
- `retryable_failure` → 清 `active_claim_id`，按 backoff 更新 `claimable_at_ms`；本次 claim 已计 attempt。
- `permanent_failure` → failed，保留内部人工 replay 能力。
- 未 settle item 等待租约过期。
- 同一个 `claim_id + bundle_id + outcome + reason` 重复 settle 必须幂等 200；每次 claim 的 attempt receipt 独立保留，不能被后续 claim 覆盖。
- settle 不删除 R2 Bundle。

BazaarDB 以 `bundle_id` 幂等。一次 Bundle GET 同时获得 Run 与 Screenshot，不再发起 snapshot/run 两次下载。

---

## 6. 全新 D1 schema

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE bundles (
  bundle_id               TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL UNIQUE,
  uploader_account_id     TEXT NOT NULL,
  object_key              TEXT NOT NULL UNIQUE,
  bundle_sha256           TEXT NOT NULL CHECK (
    length(bundle_sha256) = 64
    AND bundle_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  bundle_version          INTEGER NOT NULL CHECK (bundle_version = 5),
  manifest_bytes          INTEGER NOT NULL CHECK (manifest_bytes BETWEEN 1 AND 2097152),
  object_bytes            INTEGER NOT NULL CHECK (object_bytes BETWEEN 1 AND 8388607),
  client_created_at_ms    INTEGER NOT NULL,
  stored_at_ms            INTEGER NOT NULL,
  available_at_ms         INTEGER NOT NULL,
  run_format_version      INTEGER NOT NULL CHECK (run_format_version = 5),
  run_bytes               INTEGER NOT NULL CHECK (run_bytes BETWEEN 1 AND 2097151),
  run_sha256              TEXT NOT NULL CHECK (
    length(run_sha256) = 64
    AND run_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  has_screenshot          INTEGER NOT NULL CHECK (has_screenshot IN (0, 1)),
  screenshot_content_type TEXT,
  screenshot_bytes       INTEGER,
  screenshot_sha256      TEXT,
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
      AND screenshot_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  )
);
CREATE INDEX idx_bundles_available
  ON bundles(available_at_ms, bundle_id, object_key);

CREATE INDEX idx_bundles_stored_retention
  ON bundles(stored_at_ms, bundle_id);

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
CREATE TABLE bundle_uploaders (
  player_account_id  TEXT PRIMARY KEY,
  first_bundle_at_ms INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE bazaardb_deliveries (
  bundle_id              TEXT PRIMARY KEY REFERENCES bundles(bundle_id) ON DELETE CASCADE,
  delivery_state         TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'done', 'failed')),
  active_claim_id        TEXT,
  active_claim_order     INTEGER CHECK (
    active_claim_order IS NULL
    OR (
      typeof(active_claim_order) = 'integer'
      AND active_claim_order BETWEEN 0 AND 49
    )
  ),
  claimable_at_ms        INTEGER NOT NULL,
  delivery_attempts      INTEGER NOT NULL DEFAULT 0
    CHECK (delivery_attempts BETWEEN 0 AND 3),
  created_at_ms          INTEGER NOT NULL,
  state_updated_at_ms    INTEGER NOT NULL,
  delivered_at_ms        INTEGER,
  failed_at_ms           INTEGER,
  failure_reason         TEXT,
  CHECK (
    (active_claim_id IS NULL AND active_claim_order IS NULL)
    OR (
      active_claim_id IS NOT NULL
      AND active_claim_order IS NOT NULL
      AND delivery_state = 'pending'
    )
  ),
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
CREATE INDEX idx_bazaardb_active_claim_order
  ON bazaardb_deliveries(active_claim_id, active_claim_order, bundle_id)
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
    OR (outcome = 'accepted' AND settled_at_ms IS NOT NULL AND reason IS NULL)
    OR (
      outcome IN ('retryable_failure', 'permanent_failure')
      AND settled_at_ms IS NOT NULL
      AND reason IS NOT NULL
    )
  )
) WITHOUT ROWID;

```

### 6.1 SQL 设计理由

- D1 不包含 `installations` 或 `service_tokens`；service-token verification 在执行任何受保护 query 前完成。
- `bundles` 同时是 R2 object index、Run one-to-one index 和 analyzer time-window source；不需要 `packs` 或独立 `runs` table。
- `available_at_ms + bundle_id` 是稳定的无状态 sync order；server 不持久化 analyzer cursor。
- `idx_bundles_available` 包含时间、identity 与 presign 所需的 `object_key`，使 Bundle collection query 成为 covering index scan；不把 hash、size 或 Screenshot 字段复制进索引。
- `client_created_at_ms` 来自 Bundle，`stored_at_ms` 记录 R2 PUT，`available_at_ms` 记录 D1 首次可查询时间；Analyzer 只使用最后一个字段。
- Run 与 Screenshot 都没有独立 download locator；Worker 使用 `bundles.object_key` presign，consumer 通过生成的 R2 URL 下载完整对象。
- `run_id UNIQUE` 保证一个 Run 不会被装入两个 Bundle。
- `has_screenshot` 只决定是否创建 BazaarDB delivery；图片 bytes 只存在 R2 Bundle。
- `bazaardb_deliveries` 以 `bundle_id` 为身份，避免 snapshot/run 两套关联。
- `claimable_at_ms` 同时表示下一次可领取时间和 active lease 的 expiry；`bazaardb_delivery_attempts` 为每次领取保留 receipt，使旧 settle 在后续 attempt 发生后仍可幂等识别。
- `ghost_battles` 是可从 Bundle manifest 重建的查询投影，不是 Battle 权威数据；它以 `(uploader_account_id, battle_id)` 为主键，双方上传同一 battle 时保留两个方向。
- `bundle_uploaders` 只记录成功向 V5 上传过 Bundle 的账号。V5 从空表重新记录，不迁移 V4 player 数据。
- 只有 `opponent_account_id = uploader_account_id` 或 opponent 已存在于 `bundle_uploaders` 的 projection 才进入 `ghost_battles`，从源头降低无效 rows 与 index writes。
- opponent 首次上传前被过滤的历史 projection 不回填；这是降低 D1 写入量的明确取舍。
- `projection_json` 代替大量易漂移的展示列；SQL 只显式索引查询真正需要的字段。

### 6.2 Bundle commit

`projection.battles` 作为一个 JSON 参数交给单条 `json_each(?)` SQL，避免每场 battle 拼接大量位置参数。

一次 Bundle commit 是一个 D1 transaction：

1. 以执行 transaction 前取得的同一个 server clock 写 `available_at_ms` 并 insert `bundles`；
2. 用一条 `json_each` statement 把 eligible projection insert 到 `ghost_battles`；
3. `has_screenshot = 1` 时 insert `bazaardb_deliveries`；
4. 最后使用 `INSERT ... ON CONFLICT DO NOTHING` 把 uploader 加入 `bundle_uploaders`。

任何一步失败都不留下半套逻辑索引。Ghost insert 使用 `opponent = uploader OR opponent IN bundle_uploaders`；显式 self branch 避免依赖同 transaction 内 `bundle_uploaders` 的写后读。

应用层在进入 transaction 前限制 manifest projection 的 UTF-8 bytes 不超过 512 KiB，并限制单个 D1 string/row 低于平台上限。Run facts 不重复存成 `run_projection_json`；Analyzer 直接下载 Bundle，Ghost 所需事实存于 `ghost_battles.projection_json`。

### 6.3 Bundle collection query

每一页只需要同一条 keyset query：

```sql
SELECT
  bundle_id,
  available_at_ms,
  object_key
FROM bundles
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

`?1/?2` 是固定窗口，`?3/?4` 是可选的 `next_after` position，`?5 = requested_limit + 1`。第 `limit + 1` row 只用于判断是否有下一页，不签名也不返回。该 query 只读取 `idx_bundles_available`，无需回表；presigner 根据 `object_key` 生成有效期 7 天的 R2 `download_url`。response 不返回单独的 `object_key` 字段，但 key 会出现在 presigned URL path 中。分页期间有新 Bundle 写入也不会改变已经固定的 `available_before_ms`。

### 6.4 查询与索引矩阵

| 查询 | 过滤与排序 | 使用的索引 |
|---|---|---|
| Bundle upload 幂等 / download | `bundle_id = ?` | `bundles` primary key |
| Run 跨 Bundle 冲突 | `run_id = ?` | `bundles(run_id)` implicit UNIQUE index |
| Bundle collection sync | `available_at_ms` window，随后 `bundle_id` | `idx_bundles_available` |
| Ghost discovery | `opponent_account_id = ?`；按 `recorded_at_ms, battle_id` 倒序 | `idx_ghost_battles_query` + `bundles` primary key join |
| BazaarDB claim | `claimable_at_ms <= now`，按 `claimable_at_ms, created_at_ms, bundle_id` | `idx_bazaardb_claimable` |
| BazaarDB active settle / lease lookup | `active_claim_id = ?` | `idx_bazaardb_active_claim` |
| BazaarDB active claim response order | `active_claim_id = ?`；按 `active_claim_order, bundle_id` | `idx_bazaardb_active_claim_order` |
| BazaarDB settle receipt / 幂等 | `claim_id = ? AND bundle_id = ?` | `bazaardb_delivery_attempts` primary key |
| Claim-time Bundle expiry | `stored_at_ms < cutoff` | `idx_bundles_stored_retention` |

BazaarDB claim 的候选查询固定为：

```sql
SELECT bundle_id
FROM bazaardb_deliveries
WHERE delivery_state = 'pending'
  AND delivery_attempts < 3
  AND claimable_at_ms <= ?1
ORDER BY claimable_at_ms ASC, created_at_ms ASC, bundle_id ASC
LIMIT ?2;
```

claim transaction 把选中 rows 的 `active_claim_id` 写为新 claim，持久化候选顺序到 `active_claim_order`，并把 `claimable_at_ms` 推到 lease expiry。租约自然过期后，同一索引会让 row 再次可领取；`retryable_failure` 可以把它设置为带 backoff 的下一次时间。

不创建 `(player_account_id, ended_at_ms)` 索引，因为 V5 没有按玩家列举 Bundle 的 interface。将来出现真实查询后再增加，避免当前每次 ingest 支付无消费者的 D1 index write。

---

## 7. R2 与请求预算

变量：

- `N_r`：每日 accepted Runs；V5 不采样。
- `N_s`：每日含 Screenshot 的 Bundles，`N_s ≤ N_r`。
- `N_g`：每日 ghost Run downloads。

| 路径 | V4 当前 | V5 |
|---|---:|---:|
| Run ingest Class A | `0.5·N_r + ε` | `N_r` Bundle PUTs |
| Screenshot ingest Class A | `N_s` | `0` independent PUTs |
| analyzers Class B | `0.5·N_r` | `N_r` Bundle GETs |
| BazaarDB Class B | snapshot GET + run GET + HEAD | `N_s` full Bundle GETs |
| ghost Class B | GET + HEAD | `N_g` full Bundle GETs |

V5 选择“一局一个 Bundle”的简单不变量，不使用跨 Run 聚合降低 PUT/GET 次数。收益是：

- Run 接收率从采样提升为 100%；
- Screenshot 不再产生额外 R2 object 和 Class A operation；
- BazaarDB 从两份对象、两次下载变为一个 Bundle、一次下载；
- 单局重试、冲突、保留和删除不再影响其他 Run；
- Analyzer 请求数随完整 Run 数增长，需要单独纳入预算与监控。

图片压缩主要降低存储与 egress bytes，不降低 Bundle PUT 数。

---

## 8. 一致性、恢复、安全与保留

### 8.1 R2 / D1 顺序

固定顺序：R2 PUT 成功后再 D1 transaction。

- R2 失败：D1 无记录，本地 sealed Bundle 重试。
- R2 成功、D1 失败：确定性 key 不产生额外对象；相同 Bundle 重试完整校验后重做 transaction。
- D1 成功、response 丢失：同 bundle_id 重试返回 duplicate。

R2 custom metadata 只允许写 `bundle_version`、`manifest_length`、`bundle_sha256`。完整 Run/Screenshot index 只存在 Bundle manifest 与 D1。

### 8.2 Request-driven recovery and manual D1 maintenance

- R2-only object 只由相同 `POST /bundles` 重试恢复；重试完整校验既有 object 后提交 D1。客户端未重试时，R2 bucket lifecycle 在 14 天后删除 object。
- BazaarDB `claim` 在选取候选前惰性标记越过 R2 retention 的 pending Bundle 和租约已过期的第三次 attempt。
- Worker 只导出 `fetch`，不配置 cron 或 `scheduled()`，不自动删除任何 D1 row。
- Ghost 与 Bundle collection 的时间窗口只限制 API 可见性；D1 cleanup 由 operator 在 Worker 之外显式执行。

### 8.3 Download 行为

- 仅知道 `bundle_id` 不能下载；caller 必须持有尚未过期的 R2 presigned URL。
- Bundle collection 与 BazaarDB claim/settle 是 token-protected internal routes；Ghost feed 是开放且 rate-limited 的 route。
- Ghost feed 只为其查询结果签发 URL；两个内部接口只为各自返回的 Bundle 签发 URL。
- 三条发现路径共用同一个 R2 presigner module，不自行拼接 SigV4 query。
- `GHOST_BATTLE_RATE_LIMITER` 只保护 `GET /ghost-battles`；内部接口与 presigner 不调用它，R2 download 完全不经过 Worker。
- presigned URL 会暴露 R2 S3 endpoint、bucket name 与 object key；Access Key Secret 永不进入 client-visible payload。
- Worker 只记录发现 route、认证 scope、bundle_id 与签发结果；不记录 Bearer token、R2 credentials 或完整 presigned URL，也无法记录实际 download status/bytes。

### 8.4 Retention

- R2 Bundle：14 天。
- `ghost_battles`：API 只查询 5 天窗口；row 保留时间由人工 D1 maintenance 决定。
- `bundle_uploaders`：V5 deployment lifetime 内单调记录 uploader；V5 上线时从空表开始。
- D1 `bundles` 及其依赖的 Ghost/delivery/attempt rows：不自动过期，由 operator 明确选择并删除；删除 Bundle 时外键级联清理依赖记录。
- pending delivery 越过 14 天 R2 retention 后，在下一次 claim 时转 failed `bundle_expired`；从未再次访问的 row 保留到人工清理。
- BazaarDB accepted 后 Bundle 仍按统一 14 天 policy 保留，不提前删除。
- 隐私说明必须明确：opt-in Screenshot 会随完整 Bundle 提供给 ghost 对手客户端、BazaarDB 和 analyzers。

---

## 9. 跨仓职责

### bazaarplusplus-mod

- 把所有 V5 runtime data 放在 `<GameRoot>/BazaarPlusPlusV5/`。
- 生成显式 schema 的 Run V5。
- 在 opt-in 时生成压缩 Screenshot derivative；失败时继续构建无 Screenshot Bundle。
- `BundleBuilder.Build(run, screenshot?) -> SealedBundle` 是唯一 Bundle 构建 interface。
- 持有本地 sealed Bundle queue、重试与 dead letter。
- 强更后只访问 `mod-api-v5.bazaarplusplus.com`。

### bazaarplusplus-server / modapiv5

- V5 orphan 分支以仓库根目录为独立 Worker package，拥有独立 wrangler、migrations 和 tests，不创建嵌套工程。
- ingest 只解析 bounded Bundle manifest，不解压 Run。
- 用一个 service-token verifier module 保护 Bundle collection 与 BazaarDB control routes；两个 scope 不共享 token。
- 拥有 Bundle ingest、D1 projection、R2 GET presigner、ghost feed、analyzer time-window sync 与 BazaarDB delivery；不代理 Bundle download bytes，也不运行 scheduled maintenance。
- `contracts/v5/` 是 Bundle/Run schema、accepted versions、projection 与 golden vectors 的权威登记处。

### bazaarplusplus-analyzers

- 通过 `available_at_ms` 时间窗口无状态同步，每 Bundle 一次下载。
- Bundle collection 请求携带 `BUNDLE_SYNC_TOKEN`；下载单个 Bundle 时直接 GET response 中的 R2 presigned URL。
- 作为受信任内部 consumer 取得完整 Bundle，包括可选 Screenshot。
- 分析逻辑只依赖 Run；Screenshot 缺失不是 decode failure。
- 双源期按 Content-Type 选择 V4/V5 decoder，以 `run_id` 去重。
- 未知 Run format 进入可重放 quarantine，不推进该 item 的完成状态。

### BazaarDB

- 使用 claim/settle interface，不再处理 snapshot API。
- claim/settle 请求携带 `BAZAARDB_DELIVERY_TOKEN`；下载单个 Bundle 时直接 GET claim response 中的 R2 presigned URL。
- 下载并解码 `application/x-bpp-bundle-v5`，一次取得 Run 与 Screenshot。
- Screenshot 对 BazaarDB item 是必有字段，因为只有 screenshot-bearing Bundle 会进入 delivery queue。
- 以 `bundle_id` 幂等；过渡期并行消费 V4 snapshot flow 与 V5 Bundle delivery。

---

## 10. 发布、切换与回滚

### 10.1 发布顺序

1. V4 `RUN_BUNDLE_KEEP_PERCENT` 调至 100；analyzers V4 decoder 接受当前 legacy schema。
2. 提交 Bundle/Run schemas、C#/Python/BazaarDB golden vectors、图片质量样本和 SQL tests。
3. 创建 V5 Worker、D1、R2、域名、两个 service-token secrets、bucket-read-only R2 S3 credentials 与 Ghost Battle rate-limit binding；验证鉴权矩阵、R2 presign、Ghost 防刷、Bundle upload、时间窗口 sync 和故障恢复。
4. analyzers 先上线 V5 Bundle source，继续读取 V4，并验证一周去重。
5. BazaarDB 上线 Bundle V5 decoder 与 claim/settle client，双源消费。
6. mod 强更：runtime root 切换到 `BazaarPlusPlusV5`，首次上传随机延迟 0～30 分钟。
7. 最后一个 V4 upload 后至少 14 天，停止 V4 analyzer/BazaarDB source。
8. 吊销 V4 credentials 并归档 V4 Worker；资源删除另做带备份的显式运维任务。

不复制 V4 R2 objects。需要补传时，只读解码本地 V4 数据并在 `BazaarPlusPlusV5` 下重新构建 V5 Bundle。

### 10.2 回滚

- mod 强更不能回到 V4 wire；回滚目标只能是已支持 Bundle V5 的 modapiv5 版本。
- D1 migration 只前滚；代码回滚必须兼容已有 schema。
- BazaarDB 故障时关闭 claim，不关闭 Bundle ingest；修复后从 pending deliveries 重放。
- analyzers 故障时不提交未完成窗口的 `available_before_ms`，恢复后重放该时间窗口并按 `bundle_id` 去重。
- Screenshot pipeline 故障时降级为无 Screenshot Bundle，不能停 Run ingest。

---

## 11. 跨仓模块边界

1. `contracts/v5`：Bundle prefix/manifest、Run schema、versions、golden vectors、恶意 segment fixtures。
2. mod paths/storage：`BazaarPlusPlusV5` path provider、全新 local schema、Bundle queue 与 dead letter。
3. mod contract：Run serializer、Screenshot derivative、`BundleBuilder`、digest 与 atomic file seal。
4. modapiv5 ingest：bounded manifest parser、streaming hashes、R2 PUT、D1 transaction 与幂等。
5. modapiv5 presign：从 query result 取得 object key，生成 7 天 R2 `GetObject` presigned URL；无 Worker download handler。
6. modapiv5 reads：service-token verifier、Ghost Battle per-IP rate limiter、ghost feed、Bundle collection time-window sync、BazaarDB claim/settle。
7. modapiv5 ops：metrics、dashboards 与独立的人工 D1 maintenance runbook。
8. analyzers：Bundle feed/cache、Run V5 decoder、双源去重与 quarantine。
9. BazaarDB：claim/settle、Bundle V5 decoder、bundle_id 幂等与双源 drain。

测试只跨模块的 interface；不依赖 D1 列顺序、R2 key 拼接或 handler 内部函数。

---

## 12. 上线验收标准

- 一个 Run 恰好生成一个 Bundle 和一个 R2 object；任何代码路径都不会把多局合并。
- 未开启 opt-in 时，Bundle 只有 Run，上传、analyzer 和 ghost 全部成功，且不创建 BazaarDB delivery。
- 截图成功时，同一 Bundle 同时包含 Run 与 Screenshot，只产生一次 R2 PUT。
- 截图 capture、encode、压缩或超时失败时，Run 仍在有界时间内上传。
- Bundle seal 后重试 100 次复用完全相同 bytes；server 只保留一个 object 和一套 D1 rows。
- 同 `bundle_id` 不同 digest 返回 409；同 `run_id` 换另一个 `bundle_id` 返回 409。
- Run payload 达到 2 MiB 或 Bundle 达到 8 MiB 时被拒绝；边界以下的 Bundle 正常接收。
- 接近 8 MiB 的合法 Bundle 不被 Worker 整体缓冲，内存压力测试通过。
- R2 PUT 后、D1 commit 前注入故障，相同 Bundle 重试能恢复全部索引。
- C# serializer/decoder、Python decoder、BazaarDB decoder 对同一 golden vector 得到相同逻辑对象。
- Analyzer 与 BazaarDB decoder 对 Run 根节点和 manifest 的 `run_id/run_format_version` 做一致性检查；不一致 Bundle 进入 quarantine。
- V4 decoder 拒绝 Run V5，V5 decoder 拒绝 V4 contractless artifact；双源按 Content-Type 分派。
- BazaarDB 每个 claim item 只需一次 Bundle GET，即同时获得 Run 与 Screenshot。
- Screenshot 缺失的 Bundle 永远不会进入 BazaarDB delivery queue。
- settle 的 accepted/retryable/permanent 与重复请求满足状态机和幂等测试。
- ghost、analyzers 与 BazaarDB 对同一 Bundle 下载到完全相同的 bytes。
- 含 Screenshot 的 ghost Bundle 可被对手客户端下载并解码。
- Analyzer 使用固定 `[available_from_ms, available_before_ms)` 与显式 `next_after` position 完成多页同步；Worker 不保存 cursor 或 session。
- Analyzer 请求早于 14 天 R2 retention 的 window 时得到 410 `window_expired`，不会收到已知不可用 object 的签名 URL。
- `/capabilities`、`/installations`、installation token 和持久化 download-token table 均不存在。
- Bundle Sync token 只能访问 Bundle collection；BazaarDB token 只能访问 claim/settle；缺失、互换或错误 token 均被拒绝。
- `POST /bundles` 与 `GET /ghost-battles` 不要求 service token；Worker 不存在 `GET /bundles/:bundle_id` download route。
- Ghost feed、Bundle collection 与 BazaarDB claim 都生成限定单个 object、GET method、7 天 expiry 的 R2 SigV4 URL。
- 修改 object key、method、expiry 或 `X-Amz-Signature`，以及使用过期 URL，均由 R2 拒绝；Worker 不参与该请求。
- presigned URL 可在 7 天内重复使用；Worker 不创建 download-token row，日志不包含完整 URL。
- `GET /ghost-battles` 在 D1 query 前执行 per-IP rate limit；binding 报告超限时返回 429 与 `Retry-After: 60`，不查询 D1 或签发 URL。
- 测试断言 Bundle collection、BazaarDB claim/settle 与 R2 presigner 均不会调用 `GHOST_BATTLE_RATE_LIMITER`。
- 图片样本满足 1 MiB 硬上限，关键文字/OCR 可读性通过人工验收。
- 双方上传同一 battle 后保留两个 uploader 方向，双方 ghost feed 均不丢失。
- `EXPLAIN QUERY PLAN` 证明 Bundle collection、ghost、claimable delivery 与 settle lookup 使用目标索引。
- Windows 与 macOS 均把 V5 runtime files 写入 `<GameRoot>/BazaarPlusPlusV5/`，不修改 V4 root。
- V5 public identifiers 与 schema names 不使用 `boundle`、`pack`、`snapshot_id`，也不存在独立 Screenshot endpoint。
