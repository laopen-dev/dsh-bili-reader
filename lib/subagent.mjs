/**
 * dsh-bili-reader —— 子代理编排。
 *
 * 一次读取 = 起一个子代理（ctx.subagents.startActivation，delivery: 'caller'），
 * 让它在自己的上下文里跑 `bili.mjs debrief`，看完只回一段 JSON，然后主会话拿
 * 这段 JSON 当工具结果返回。原始字幕/弹幕/热评永远不进入主会话上下文。
 *
 * 关键取舍（都对着 dsh-subagent 的实现确认过）：
 *   - `delivery: 'caller'`：结果只回到这里的 `activation.result`，**不**往父会话
 *     塞一条 settlement notice —— 否则同一份摘要会在主会话出现两次。
 *   - 超时/取消用 `activation.dispose()` 真的把子代理停掉（startActivation 的
 *     signal 只覆盖"发布之前"，发布之后必须 dispose）。
 *   - 不传 `maxDepth`：本插件不在宿主 `subagent` 的深度策略里再插一层，
 *     bili_read 在任意嵌套层级都能用；子代理自己再往下派仍受宿主设置约束。
 *
 * 超时 180 秒、失败最多重试一次（重试是新的子代理，不是让它继续）。
 */

import { buildCommand, buildPrompt } from './cli.mjs'
import { failureItem, outputText, parseChildJson, toItem } from './schema.mjs'

/** 一次读取最多尝试几次（1 次正常 + 1 次重试）。 */
const ATTEMPTS = 2

/** 收尾（dispose）等太久就不等了：子代理已经被 cancel，资源会自己释放。 */
const DISPOSE_GRACE_MS = 15_000

class TimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TimeoutError'
    this.code = 'BILI_READ_TIMEOUT'
  }
}

/**
 * 给 promise 加一个真上限，超时后**不**留下未处理的 rejection。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new TimeoutError(message))
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 让等待也能被取消：子代理一旦发布，startActivation 的 signal 就管不到它了，
 * 只有 dispose 能让它停。所以在等 result 的时候也要盯着 signal，否则用户取消
 * 工具调用后我们还要傻等到超时。
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<T>}
 */
function raceAbort(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      promise.then(() => {}, () => {})
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      return
    }
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** 单行化的错误描述；带上结构化 code，方便主人一眼看出是深度/权限/服务缺失。 */
function describeError(error) {
  if (!error) return '未知错误'
  const message = String(error.message ?? error).replace(/\s+/g, ' ').trim()
  const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : ''
  const text = code && !message.startsWith(code) ? `${code}: ${message}` : message
  return text.slice(0, 400) || '未知错误'
}

async function closeQuietly(activation) {
  try {
    await withTimeout(activation.dispose(), DISPOSE_GRACE_MS, 'dispose timeout')
  } catch {
    /* 已经 cancel 了；资源由 subagent 服务自己兜底 */
  }
}

/**
 * 尝试一次：起子代理 → 等结果 → 解析成一条 item。
 * 失败一律抛错，由 readOne 决定要不要重试。
 * @param {object} ctx 插件 ctx
 * @param {{ cfg: object, template: string, runtime: object }} plan
 * @param {{ bv: string, frames: boolean, parent: object, signal: AbortSignal|undefined }} spec
 */
async function attemptOnce(ctx, plan, spec) {
  const { cfg, template, runtime } = plan
  const { bv, frames, parent, signal } = spec

  if (signal?.aborted) throw new TimeoutError('调用已被取消')

  const subagents = ctx.get?.('subagents') ?? ctx.subagents
  if (!subagents) throw new Error('subagents 服务不可用（宿主没有挂 @deepseek-ai/dsh-subagent）')
  if (typeof subagents.getProvider === 'function' && !subagents.getProvider(cfg.provider)) {
    throw new Error(`subagent provider "${cfg.provider}" 未注册（检查 dsh-subagent-spawn-in-process 的 providerName）`)
  }

  const command = buildCommand(runtime, bv, frames)
  const prompt = buildPrompt(template, { command, bv, frames })

  // 自己的 controller：既能被父 signal 打断，也能在超时后单独 abort 这次启动。
  const controller = new AbortController()
  const forwardAbort = () => {
    try {
      controller.abort(signal?.reason)
    } catch {
      controller.abort()
    }
  }
  signal?.addEventListener?.('abort', forwardAbort, { once: true })

  let activation = null
  try {
    activation = await subagents.startActivation({
      provider: cfg.provider,
      label: `bili_read ${bv}`.slice(0, 80),
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent,
      },
      signal: controller.signal,
      delivery: 'caller',
    })

    const result = await withTimeout(
      raceAbort(activation.result, controller.signal),
      cfg.timeoutSec * 1000,
      `读取超时：${cfg.timeoutSec} 秒内子代理没有读完 ${bv}`,
    )

    if (!result || result.stopReason !== 'completed') {
      const reason = String(result?.stopReason ?? 'unknown')
      const diagnostic = outputText(result?.output)
      const detail = diagnostic.length > 0 ? `；它最后一句：${diagnostic.slice(0, 200)}` : ''
      throw new Error(`子代理没有正常结束（stopReason=${reason}）${detail}`)
    }

    const text = outputText(result.output)
    return toItem(bv, parseChildJson(text))
  } finally {
    signal?.removeEventListener?.('abort', forwardAbort)
    if (activation) await closeQuietly(activation)
  }
}

/**
 * 读一条：最多两次尝试，第二次是干净重来。
 * @returns {Promise<object>} 一条满足 READ_OUTPUT_SCHEMA 的结果（失败时 error 非空）
 */
export async function readOne(ctx, plan, spec) {
  const { bv } = spec

  if (plan.runtime.missing.length > 0) {
    return failureItem(bv, plan.runtime.missing.join('；'))
  }

  let lastError = null
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await attemptOnce(ctx, plan, spec)
    } catch (error) {
      if (spec.signal?.aborted) return failureItem(bv, '调用被取消（aborted），没有读完')
      lastError = error
      if (attempt >= ATTEMPTS) break
      try {
        console.warn(`[bili-reader] ${bv} 第 ${attempt} 次失败，重试一次：${describeError(error)}`)
      } catch {
        /* 日志失败不影响结果 */
      }
    }
  }
  return failureItem(bv, describeError(lastError))
}

/**
 * 读一批：去重 + 有上限的并发 + 结果按入参顺序返回。
 * @param {{ cfg: object, template: string, runtime: object }} plan
 * @param {{ bvs: string[], frames: boolean, concurrency: number, parent: object, signal: AbortSignal|undefined }} spec
 */
export async function readMany(ctx, plan, spec) {
  const { bvs, frames, concurrency, parent, signal } = spec
  const unique = [...new Set(bvs)]

  if (plan.runtime.missing.length > 0) {
    const message = plan.runtime.missing.join('；')
    const items = unique.map((bv) => failureItem(bv, message))
    return { items, failed: items.map((item) => ({ bv: item.bv, error: item.error })) }
  }

  const items = new Array(unique.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= unique.length) return
      items[index] = await readOne(ctx, plan, {
        bv: unique[index],
        frames,
        parent,
        signal,
      })
    }
  })
  await Promise.all(workers)

  const failed = []
  for (const item of items) {
    if (item && typeof item.error === 'string' && item.error.length > 0) {
      failed.push({ bv: item.bv, error: item.error })
    }
  }
  return { items, failed }
}

/**
 * 这个工具声明给注册表的超时：只是兜底（真正控制在这里的 withTimeout）。
 * 要比 try-once 的预算宽，否则会先被宿主 policy 切掉。
 */
export function toolTimeoutMs(cfg, { videos = 1, concurrency = cfg.concurrency } = {}) {
  const waves = Math.max(1, Math.ceil(videos / Math.max(1, concurrency)))
  return (waves * ATTEMPTS * cfg.timeoutSec + 120) * 1000
}
