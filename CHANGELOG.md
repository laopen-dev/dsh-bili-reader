# Changelog

## 0.2.0 — 2026-10-25

- 两个工具：`bili_read`（单条）、`bili_read_batch`（批量，并发上限 3，单批上限 10 条）。
- 子代理编排：每个视频起一个子代理读 `bili.mjs debrief`，主会话只收结构化摘要（约 500–900 token）。
- 超时 180 秒、失败重试一次；失败条目返回 `error` 字段，不编造摘要。
- 自动注入系统提示：装好之后，会话会优先用 `bili_read_batch` 而不是逐条 `debrief`。
- 修：显式 `frames:false` 不再被 `defaultFrames:true` 覆盖。
- 离线自检 `tools/selfcheck.mjs`（65 项）。

## 0.1.0 — 2026-10-25

- 首个可用版本：`bili_read` / `bili_read_batch`、host-only、无设置页。
