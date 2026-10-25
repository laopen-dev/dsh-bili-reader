/**
 * dsh-bili-reader —— 配置归一化。
 *
 * 插件不导出 schemastery 的 `Config`：本包是 link 安装的裸目录，解析不到
 * @deepseek-ai/schemastery，硬依赖会让插件在加载阶段就失败。所以配置走
 * 「普通对象 + 这里的手工归一化」：越界值一律夹到合法区间，而不是抛错
 * （配置写坏了也不该让整个插件起不来）。
 */

import os from 'node:os'
import path from 'node:path'

/** DSH 数据目录：桌面端通常是 %USERPROFILE%\.dsh */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.round(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/**
 * 把行内 config 归一化成插件内部使用的形状。
 * @param {unknown} raw package/Cordis 行里的 config 对象，可能是 undefined。
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    cliPath: str(input.cliPath),
    nodePath: str(input.nodePath),
    defaultFrames: input.defaultFrames === true,
    concurrency: clampInt(input.concurrency, 2, 1, 3),
    timeoutSec: clampInt(input.timeoutSec, 180, 30, 900),
    provider: str(input.provider) || 'spawn',
  }
}

/** 批量工具一次最多接多少个 BV（防手滑把上下文打爆）。 */
export const MAX_BATCH = 10

/** 生效的并发数：调用参数优先，其次配置，最后 2；上限 3。 */
export function effectiveConcurrency(requested, configured) {
  const n = Number(requested)
  if (!Number.isFinite(n)) return clampInt(configured, 2, 1, 3)
  return clampInt(n, configured, 1, 3)
}
