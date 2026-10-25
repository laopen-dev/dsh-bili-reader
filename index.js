/**
 * dsh-bili-reader —— host-only 插件入口。
 *
 * 两个工具，一次都不把原始材料放进主会话上下文：
 *
 *   bili_read       读一个 BV → 一份结构化摘要
 *   bili_read_batch 批量读（有并发上限）→ { items, failed }
 *
 * 怎么做到的：工具里用 ctx.subagents.startActivation() 起一个子代理，子代理在
 * 自己的上下文里跑 dsh-bili-whale 的 `bili.mjs debrief`，把字幕/弹幕/热评吃掉，
 * 只回一段 JSON；这里解析后当成工具结果返回。
 *
 * 边界：纯只读。不发评论、不发私信、不关注、不收藏、不投币；不改 bili-whale
 * 的任何文件；不注册定时任务；不写日记。
 *
 * 为什么没有 `export const Config`：本包是 link 安装的裸目录，无法 import
 * @deepseek-ai/schemastery。配置改由 lib/config.mjs 手工归一化（见那里的说明）。
 */

import { effectiveConcurrency, MAX_BATCH, normalizeConfig } from './lib/config.mjs'
import { loadPromptTemplate, resolveRuntime } from './lib/cli.mjs'
import {
  BATCH_OUTPUT_SCHEMA,
  BATCH_TOOL_PARAMETERS,
  normalizeBv,
  READ_OUTPUT_SCHEMA,
  READ_TOOL_PARAMETERS,
} from './lib/schema.mjs'
import { readMany, readOne, toolTimeoutMs } from './lib/subagent.mjs'

export const name = 'dsh-bili-reader'

// 硬依赖：没有 tools 注册不了工具，没有 subagents 派不出子代理。
export const inject = ['tools', 'subagents']

/** 渲染统一走紧凑但可读的 JSON —— 主会话拿到的就是这段文本。 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function logWarn(message) {
  try {
    console.warn(message)
  } catch {
    /* 没有 console 就算了 */
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig 行内 config（可能省略）
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const template = loadPromptTemplate(import.meta.dirname, logWarn)

  const plan = () => ({ cfg, template, runtime: resolveRuntime(cfg) })

  /** bili_read：单个 BV。 */
  const readDefinition = {
    name: 'bili_read',
    description:
      'Read one Bilibili video and return a structured digest: title, uploader, duration, a 150-250 character plain-language summary, 3-5 timestamped highlights, ad segments, and a 0-4 score hint. Subtitles, danmaku, and comments are read outside this conversation, so the answer costs about one page instead of tens of thousands of tokens. Read-only: it never posts comments, sends messages, follows, or likes. When `error` is non-null the digest fields are empty placeholders — do not treat them as a summary. Long: expect tens of seconds, occasionally minutes.',
    parameters: READ_TOOL_PARAMETERS,
    output: { schema: READ_OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: toolTimeoutMs(cfg),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const bv = normalizeBv(args?.bv)
      if (bv === null) throw new Error('`bv` must be a Bilibili video id such as BV1DubxzVEPB')
      const parent = exec.agent
      if (!parent) throw new Error('bili_read requires a calling agent (exec.agent was undefined)')
      // 2026-10-25 修（审查 P1）：显式 frames:false 不能被 defaultFrames:true 覆盖
      const frames = typeof args?.frames === 'boolean' ? args.frames : cfg.defaultFrames
      return readOne(ctx, plan(), { bv, frames, parent, signal: exec.signal })
    },
  }

  /** bili_read_batch：批量，带并发上限。 */
  const batchDefinition = {
    name: 'bili_read_batch',
    description:
      'Read several Bilibili videos through subagents in one call and return their digests together, with bounded concurrency. Prefer this over calling `bili_read` repeatedly: one call covers the whole set. Each entry in `items` has the same fields as `bili_read`; entries that failed also appear in `failed` with their `bv` and `error`. Read-only. Videos run in parallel, so a batch of N can take as long as about ceil(N / concurrency) single reads.',
    parameters: BATCH_TOOL_PARAMETERS,
    output: { schema: BATCH_OUTPUT_SCHEMA, render: renderJson },
    timeoutMs: toolTimeoutMs(cfg, { videos: MAX_BATCH, concurrency: 1 }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('bili_read_batch requires a calling agent (exec.agent was undefined)')

      const raw = Array.isArray(args?.bvs) ? args.bvs : []
      if (raw.length === 0) throw new Error('`bvs` must be a non-empty array of Bilibili video ids')
      const bvs = []
      for (const entry of raw) {
        const bv = normalizeBv(entry)
        if (bv === null) throw new Error(`\`bvs\` contains a value that is not a Bilibili video id: ${String(entry).slice(0, 40)}`)
        bvs.push(bv)
      }
      if (bvs.length > MAX_BATCH) {
        throw new Error(`\`bvs\` accepts at most ${MAX_BATCH} videos per call; split the set`)
      }

      const concurrency = effectiveConcurrency(args?.concurrency, cfg.concurrency)
      const frames = typeof args?.frames === 'boolean' ? args.frames : cfg.defaultFrames
      return readMany(ctx, plan(), { bvs, frames, concurrency, parent, signal: exec.signal })
    },
  }

  const disposers = []
  try {
    disposers.push(ctx.tools.register(readDefinition))
    disposers.push(ctx.tools.register(batchDefinition))
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 回滚失败也只记录 */
      }
    }
    throw error
  }

  // 2026-10-25：把「怎么用」也塞进同一个包 —— 一个包 = 工具 + 使用规则。
  //   这样别人的鱼装上就自动优先走 bili_read_batch，不用再改 bili-whale 的提示词。
  //   systemPrompt 是可选依赖：没有这个服务时静默跳过，工具照常可用。
  try {
    const promptService = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (promptService && typeof promptService.section === 'function') {
      const usage = [
        '## 读 B 站视频的方式',
        '',
        '需要读视频时，**优先调用 `bili_read` / `bili_read_batch`**，不要逐条跑 `debrief`：',
        '',
        '- 每轮选题后，用 `bili_read_batch` 一次读 2–3 条（`concurrency: 2`），主会话只收摘要；',
        '- 只有需要看画面（封面 / 九宫格 / 字幕带）时，才对个别视频单独跑 `debrief --frames` 或 `--substrip`；',
        '- `bili_read` 返回的 `error` 非空时，摘要字段是占位符，不要当成内容；',
        '- 这些工具是只读的：不会发评论、私信、关注或点赞。',
      ].join('\n')
      disposers.push(promptService.section({ name: 'bili-reader-usage', order: 45, text: usage }))
    }
  } catch {
    /* 提示词段落注册失败不影响工具 */
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* HMR 重载时的清理失败不该拖垮进程 */
      }
    }
  })

  try {
    const runtime = resolveRuntime(cfg)
    const where = runtime.missing.length > 0 ? `⚠️ ${runtime.missing.join('；')}` : `${runtime.cliPath} · ${runtime.nodePath}`
    console.log(`[bili-reader] 已注册 bili_read / bili_read_batch → ${where}`)
  } catch {
    /* 日志失败不影响工具可用 */
  }
}
