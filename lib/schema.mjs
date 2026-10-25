/**
 * dsh-bili-reader —— 工具 schema（模型可见）与子代理 JSON 的解析/归一化。
 *
 * 这里直接用**原生 JSON Schema**，不走 @deepseek-ai/dsh-tools 的 defineTool：
 * defineTool 需要 import 该包，而 link 安装的裸目录解析不到它。原生 schema 正是
 * 注册表最终要的那一层，所以没有任何损失。
 *
 * ⚠️ 约束来自注册表实现（dsh-tools/json-schema）：
 *   - 只认 type / oneOf / properties / required / additionalProperties / items /
 *     enum / const + 注解（description/title/default/examples）；
 *   - 没有 minimum/maxItems 之类，所以 0–4 的范围只能在代码里夹；
 *   - `output.schema` 会**校验 execute 的返回值**，对不上直接报 ToolOutputError。
 * 因此下面每个字段都与 toItem()/failureItem() 的实际返回值严格对齐。
 */

/** score_hint 的五个维度，顺序固定。 */
export const SCORE_KEYS = ['info', 'pref', 'novel', 'emotion', 'craft']

const SCORE_ITEM = { type: 'integer', description: '0-4 整数（0 = 极低，4 = 极高）。' }

const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    info: SCORE_ITEM,
    pref: SCORE_ITEM,
    novel: SCORE_ITEM,
    emotion: SCORE_ITEM,
    craft: SCORE_ITEM,
  },
  required: [...SCORE_KEYS],
}

/** 一条视频的读取结果（bili_read 的出参，也是 batch 里 items 的元素）。 */
export const READ_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bv: { type: 'string', description: '视频 BV 号；失败时原样回填请求里的 BV。' },
    title: { type: 'string', description: '视频标题；失败时空字符串。' },
    up: { type: 'string', description: 'UP 主昵称；失败时空字符串。' },
    duration: { type: 'integer', description: '时长（秒）；未知时 0。' },
    summary: {
      type: 'string',
      description: '150-250 字人话摘要：这是什么 + 讲了什么 + 值不值得看；失败时空字符串。',
    },
    highlights: {
      type: 'array',
      description: '3-5 条带时间点的看点；失败时空数组。',
      items: { type: 'string' },
    },
    ad_segments: {
      type: 'array',
      description: '广告/带货时间段（"mm:ss–mm:ss"）；没有就是空数组。',
      items: { type: 'string' },
    },
    score_hint: SCORE_SCHEMA,
    error: {
      description: '失败原因；成功为 null。',
      oneOf: [{ type: 'string' }, { type: 'null' }],
    },
  },
  required: ['bv', 'title', 'up', 'duration', 'summary', 'highlights', 'ad_segments', 'score_hint', 'error'],
}

/** batch 里失败项的形状：只带原因，不编内容。 */
const FAILED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bv: { type: 'string', description: '失败的 BV。' },
    error: { type: 'string', description: '失败原因。' },
  },
  required: ['bv', 'error'],
}

export const BATCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description: '每个 BV 一条结果（成功的 error 为 null，失败的 error 非空）。',
      items: READ_OUTPUT_SCHEMA,
    },
    failed: {
      type: 'array',
      description: 'items 里 error 非空的那些，单独列一份便于直接处理。',
      items: FAILED_SCHEMA,
    },
  },
  required: ['items', 'failed'],
}

/** bili_read 入参。 */
export const READ_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    bv: {
      type: 'string',
      description: 'B 站视频 BV 号，例如 BV1DubxzVEPB。',
    },
    frames: {
      type: 'boolean',
      description: '是否连画面一起抽样理解（会下载视频 + ffmpeg 抽帧，慢，可能超过读取超时）。省略 = 用插件配置的 defaultFrames。',
    },
  },
  required: ['bv'],
}

/** bili_read_batch 入参。 */
export const BATCH_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    bvs: {
      type: 'array',
      description: 'BV 号数组（1-10 条，重复的只读一次）。',
      items: { type: 'string' },
    },
    concurrency: {
      type: 'integer',
      description: '同时在跑的子代理数，1-3；省略 = 用插件配置（默认 2）。',
    },
    frames: {
      type: 'boolean',
      description: '是否连画面一起抽样理解（慢）。省略 = 用插件配置的 defaultFrames。',
    },
  },
  required: ['bvs'],
}

/**
 * 只接受 BV1 + 9 位的形状；首尾空白与 `bv1` 前缀宽松处理。
 *
 * ⚠️ 后面 9 位**必须保持原样大小写**：BVID 用的是区分大小写的字母表，
 * 统一转大写会把 BV1DubxzVEPB 变成另一个（不存在的）号。
 */
export function normalizeBv(raw) {
  if (typeof raw !== 'string') return null
  const matched = /^bv1([0-9A-Za-z]{9})$/i.exec(raw.trim())
  return matched ? `BV1${matched[1]}` : null
}

function finiteInt(value, fallback = 0) {
  const n = Number(value)
  if (Number.isFinite(n)) {
    const i = Math.round(n)
    return i < 0 ? 0 : i
  }
  // 子代理有时会把 "02:55" / "1:02:55" 直接抄进 duration，顺手认掉。
  if (typeof value === 'string') {
    const parts = value.trim().split(':')
    if (parts.length >= 2 && parts.length <= 3 && parts.every((part) => /^\d+$/.test(part))) {
      const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0)
      if (Number.isSafeInteger(seconds)) return seconds
    }
  }
  return fallback
}

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return ''
  const s = value.trim()
  return maxLen && s.length > maxLen ? s.slice(0, maxLen) : s
}

function cleanList(value, { max, maxLen }) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const s = cleanText(entry, maxLen)
    if (s.length === 0) continue
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/** 全部 0：失败时的占位分值。error 非空时它没有意义。 */
function zeroScores() {
  return { info: 0, pref: 0, novel: 0, emotion: 0, craft: 0 }
}

/** 失败结果：结构必须完整（出参 schema 会校验），但除 bv/error 外不编内容。 */
export function failureItem(bv, message) {
  return {
    bv: typeof bv === 'string' ? bv : '',
    title: '',
    up: '',
    duration: 0,
    summary: '',
    highlights: [],
    ad_segments: [],
    score_hint: zeroScores(),
    error: cleanText(String(message ?? 'unknown error'), 600) || 'unknown error',
  }
}

/**
 * 把子代理给的 JSON 归一成出参。
 *
 * 两种"不完整"区别对待：
 *   - 子代理**报错**（error 非空）→ 接受它，摘要等字段留空占位，保留它写的具体原因
 *     （不能再要求它同时给摘要，否则一条真实的失败会被我们改写成"summary 为空"）；
 *   - 子代理**声称成功**却缺关键字段 → 抛错（触发重试），而不是补零假装成功。
 * @param {string} bv 请求里的 BV（以它为准，防止子代理抄错）。
 * @param {unknown} raw 子代理返回的已解析 JSON。
 */
export function toItem(bv, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('子代理返回的 JSON 不是对象')
  }

  const childError = cleanText(raw.error, 600)
  const summary = cleanText(raw.summary, 4000)
  if (childError.length === 0 && summary.length === 0) {
    throw new Error('子代理声称成功但 summary 为空')
  }

  const scores = raw.score_hint
  const usable = scores !== null && typeof scores === 'object' && !Array.isArray(scores)
  const scoreHint = {}
  for (const key of SCORE_KEYS) {
    const n = usable ? Number(scores[key]) : Number.NaN
    if (Number.isFinite(n)) {
      scoreHint[key] = Math.max(0, Math.min(4, Math.round(n)))
      continue
    }
    if (childError.length === 0) throw new Error(`子代理返回的 score_hint.${key} 不是数字`)
    scoreHint[key] = 0
  }

  return {
    bv,
    title: cleanText(raw.title, 300),
    up: cleanText(raw.up, 200),
    duration: finiteInt(raw.duration, 0),
    summary,
    highlights: cleanList(raw.highlights, { max: 6, maxLen: 300 }),
    ad_segments: cleanList(raw.ad_segments, { max: 8, maxLen: 40 }),
    score_hint: scoreHint,
    error: childError.length > 0 ? childError : null,
  }
}

function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 从子代理的收尾消息里抠出 JSON：容忍 ``` 围栏和前后废话，
 * 但不容忍"根本没有 JSON"。
 */
export function parseChildJson(text) {
  let s = typeof text === 'string' ? text.trim() : ''
  if (s.length === 0) throw new Error('子代理没有返回任何内容')

  const fenced = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fenced && fenced[1]) {
    const inner = fenced[1].trim()
    const parsed = tryParse(inner)
    if (parsed !== undefined) return parsed
    s = inner
  }

  const direct = tryParse(s)
  if (direct !== undefined) return direct

  // 2026-10-25：取「第一个配对完整」的对象，而不是从第一个 { 到最后一个 } 硬切
  //   （子代理偶尔会回两个 JSON，硬切会把两段拼在一起解析失败）
  const start = s.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          const balanced = tryParse(s.slice(start, i + 1))
          if (balanced !== undefined) return balanced
          break
        }
      }
    }
  }
  throw new Error(`子代理返回的不是 JSON：${s.slice(0, 160)}`)
}

/** 从 SubagentResult.output（ContentBlock[]）里取纯文本。 */
export function outputText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}
