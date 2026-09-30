# Mailbox SQL and process baseline

## Question

Which measured local overheads justify bounded optimization before adding replay and a diagnostic console?

## Sources

AgentMBX base revision 324a2864b85ff6abfb3c5a8ba51af3bffcfc05b3; source inspected src/store.ts schema, src/node.ts inbox/thread visibility, src/cli.ts sender outbox COUNT DISTINCT, src/identity-control.ts pending control query, src/proc.ts native inventory/cache. No graph index exists; source coverage is explicit rather than a complete runtime impact graph.

Reproduce from repo root: `node scripts/benchmark-mailbox.mjs > results.json`. Requires Node24+. Optional positional sizes replace default 1000 10000 100000 (bounded to1million). Each run creates and deletes isolated temp Store, never opens configured MBX_HOME or user DB. Candidate indexes exist only in synthetic databases. Current schema and FTS triggers initialize through actual Store. CPU timings are process CPU, not child ps CPU.

## Workload and method

100 sender/recipient personas, 100 message threads, 224-byte synthetic bodies, two queued peer deliveries for20% of messages, two-thirds recipient rows unacked, N archived identity-request JSON records with one pending. Transactions batch inserts. Prepared statements,3 warmups,30 observations per query; median/p95 wall and accumulated process CPU. Store row projections match current SQL, but authority/signature parsing and MCP transport are excluded. Thread history is unbounded current SQL,1000rows at100k; future bounded replay must be benchmarked separately. Sender/recipient distribution is correlated and synthetic; do not present it as a production traffic estimate.

Assertions verify exact sender COUNT DISTINCT across2peers; inbox bounded<=50 and correct recipient/state; history exact count; candidate pending query equal one row. Fresh and cached inventory must contain current PID. This does not establish concurrency, malformed legacy JSON migration safety or crash behavior.

## Environment and results

{"node": "v24.21.0", "platform": "darwin", "arch": "arm64", "cpu": "Apple M5 Pro"}

|Mail/receipt rows|Outbox median/p95 ms|Sender index median/p95|Control scan median/p95|Pending index median/p95|Inbox median|History median|Insert ms|RSS MiB|DB+WAL MiB|
|---|---|---|---|---|---|---|---|---|---|
|1000|0.061/0.090|0.004/0.005|0.131/0.138|0.001/0.004|0.018|0.009|14.4|91.0|1.1|
|10000|1.328/1.656|0.020/0.049|1.409/1.602|0.001/0.001|0.080|0.082|143.4|94.0|16.7|
|100000|18.748/22.779|0.389/0.625|22.602/26.346|0.001/0.014|2.704|2.729|3219.2|131.0|165.7|

RSS is process high-water-influenced resident memory, not per-mailbox delta; DB+WAL sampled before checkpoint and include synthetic receipt/FTS storage. Index insert overhead not separately measured. Warm-cache timings are not cold disk benchmarks.

Fresh versus cached process inventory (10/100 observations):

```json
{
  "fresh": {
    "median_ms": 35.83837499999936,
    "p95_ms": 41.405791000000136,
    "cpu_us": {
      "user": 6250,
      "system": 10572
    },
    "iterations": 10
  },
  "cached": {
    "median_ms": 0.00016599999980826396,
    "p95_ms": 0.0004170000001977314,
    "cpu_us": {
      "user": 50,
      "system": 8
    },
    "iterations": 100
  }
}
```

## Query plans and CPU evidence

- Baseline outbox: `['SCAN o USING COVERING INDEX sqlite_autoindex_outbox_1', 'SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?)']`;30-run CPU `{'user': 294482, 'system': 252045}`.
- Baseline inbox: `['SEARCH d USING INDEX deliveries_agent (agent=?)', 'SEARCH m USING INDEX sqlite_autoindex_messages_1 (id=?)', 'USE TEMP B-TREE FOR ORDER BY']`;30-run CPU `{'user': 25190, 'system': 50047}`.
- Baseline history: `['SEARCH messages USING INDEX messages_thread (thread=?)']`;30-run CPU `{'user': 38122, 'system': 35998}`.
- Baseline control_poll: `['SEARCH kv USING INDEX sqlite_autoindex_kv_1 (k>? AND k<?)']`;30-run CPU `{'user': 466162, 'system': 146924}`.
- Sender index outbox: `['USE TEMP B-TREE FOR count(DISTINCT)', 'SEARCH m USING COVERING INDEX benchmark_messages_sender (from_addr=?)', 'SEARCH o USING COVERING INDEX sqlite_autoindex_outbox_1 (msg_id=?)']`; CPU `{'user': 10187, 'system': 887}`.
- Pending index: `['SEARCH kv USING INDEX benchmark_pending_control (<expr>=?)']`; CPU `{'user': 56, 'system': 25}`.

## Candidates, limits and rollback

1. `messages(from_addr,id)` converts the sender outbox query from global queue scanning into sender lookup and peer membership lookup. Preserve COUNT DISTINCT; never count peer rows as messages. Before production migration, measure insertion/space cost and skew where one sender owns most mail, and validate remote sender names. Add via schema migration with stale-runtime fencing; rollback performance optimization by dropping index only, no mail mutation.
2. Partial index on `kv(json_extract(v,'$.target.control_key'))` where key is identity-request and CASE-guarded valid JSON has pending status, paired with equivalent predicate in query, removes scanning completed receipts. SQL predicate must retain malformed-JSON safety; benchmark generated KV contains valid JSON only. Existing legacy/malformed KV and expires_at transitions need dedicated tests. Avoid making expiry/read diagnostic a write. Index creation must occur atomically via schema migration, with disk-cost assessment. Rollback drop index/query change; preserve all receipts.
3. Current process cache is hugely cheaper than fresh macOS ps inventory, but freshness is authorization-sensitive. Keep birth verification and existing cache bounds; do not extend cache TTL or backoff claim proof from these numbers. Measure batching of fresh snapshots outside transactions under real multiconnector load before change. Child ps CPU not included, so reported snapshot CPU undercounts systemwide cost.
4. History/inbox bounded pagination needed for memory guarantees, independent of present milliseconds. Existing unbounded thread query is not a cursor implementation. Integrate T117 and rerun skewed high-volume-thread/cursor baselines.

No production indexes, TTLs, poll intervals or schema changed. Safe immediate reuse is repeatable benchmark, not speculative backend replacement. Notification storms, live wake adapters, provider session heartbeat/control timers, concurrent WAL readers/writers, disk size per retained receipt, index creation and Windows/Linux timings remain unmeasured. T119 stays partial; benchmark script can run on those platforms but results here are macOS only. Coordinate provider reliability with T113 and retain fail-closed liveness.

## Atomic follow-ups and acceptance

- P1 sender index migration experiment: compare before/after latency,p95,insert throughput and disk at uniform/skewed workloads; exact sender distinct counts must match; migration old runtime refusal tested.
- P2 bounded pending-control lookup: malformed/legacy valid KV and mixed expired/pending/completed receipt fixtures must produce identical valid controls; repeat100k retained receipts and concurrent transitions; preserve atomic receipt commits.
- P3 provider/process baseline: isolated fake sessions and no live-user wakeups; measure idle CPU/wall wake latency and notification dedup bursts across1/10/100sessions; cached liveness never authorizes reused PID.
- P4 bounded replay latency: depends T117; 100k/1million thread-heavy mailbox with hidden-recipient rows and equal timestamps; exact authorized order,no leaks,no omissions/duplicates, bounded allocation.