#!/usr/bin/env node
/**
 * dsh-bili-reader 自检（不依赖任何第三方包，也不需要 DSH 在跑）。
 *
 *   node tools/selfcheck.mjs
 *
 * 查四件事：
 *   1. 工具 schema 是否落在注册表**强制的那一层 JSON Schema 子集**里
 *      （dsh-tools 的 assertSupportedJsonSchema 只认 type/oneOf/properties/
 *       required/additionalProperties/items/enum/const + 注解）；
 *   2. 出参 schema 与真实返回值是否一致 —— 注册表会用 output.schema
 *      **校验** execute 的返回值，对不上直接报 ToolOutputError；
 *   3. 子代理那段 JSON 的解析/归一化在脏输入下是否按预期工作；
 *   4. package.json / cordis.patch.yml 引用的文件是否都在。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_BATCH, effectiveConcurrency, normalizeConfig } from '../lib/config.mjs'
import {
  BATCH_OUTPUT_SCHEMA,
  BATCH_TOOL_PARAMETERS,
  READ_OUTPUT_SCHEMA,
  READ_TOOL_PARAMETERS,
  failureItem,
  normalizeBv,
  parseChildJson,
  toItem,
} from '../lib/schema.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const SCALARS = ['string', 'number', 'integer', 'boolean', 'null']
const KEYWORD_OWNER = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: SCALARS,
  const: SCALARS,
}

let failures = 0
let checks = 0

function ok(message) {
  checks += 1
  console.log(`  ✓ ${message}`)
}

function bad(message) {
  failures += 1
  console.log(`  ✗ ${message}`)
}

function plainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 与 dsh-tools 的 assertSupportedJsonSchema 同规则（违规只记路径，不抛）。 */
function checkSchema(node, at, violations) {
  if (!plainRecord(node)) {
    violations.push(`${at} 不是 schema 对象`)
    return
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT.has(key) || ANNOTATION.has(key)) continue
    violations.push(`${at}.${key} 不是受支持的关键字`)
  }
  if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') violations.push(`${at}.description 必须是字符串`)
  if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') violations.push(`${at}.title 必须是字符串`)

  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(`${at} 不能同时声明 type 和 oneOf`)
    return
  }
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) violations.push(`${at}.${key} 需要 type 或 oneOf`)
    }
    return
  }
  if (hasOneOf) {
    const oneOf = node.oneOf
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(node, key)) violations.push(`${at}.${key} 不能和 oneOf 并列`)
    }
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      violations.push(`${at}.oneOf 至少要两个分支`)
      return
    }
    oneOf.forEach((branch, index) => checkSchema(branch, `${at}.oneOf[${index}]`, violations))
    return
  }

  const type = node.type
  if (typeof type !== 'string' || !TYPES.includes(type)) {
    violations.push(`${at}.type 必须是 ${TYPES.join('/')} 之一`)
    return
  }
  for (const [key, owner] of Object.entries(KEYWORD_OWNER)) {
    if (Object.hasOwn(node, key) && !owner.includes(type)) violations.push(`${at}.${key} 不能用在 ${type} 上`)
  }
  if (type === 'object') {
    // 注意：注册表的原始子集里 additionalProperties 是**可选**的（只有作者侧 DSL
    // 才强制要求显式声明）。工具入参普遍不写它，所以这里不能要求。
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${at}.additionalProperties 必须是布尔值`)
    }
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      const declared = plainRecord(node.properties) ? node.properties : {}
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${at}.required 必须是字符串数组`)
      } else {
        for (const key of required) {
          if (!Object.hasOwn(declared, key)) violations.push(`${at}.required 里的 "${key}" 不在 properties 中`)
        }
      }
    }
    if (Object.hasOwn(node, 'properties')) {
      if (!plainRecord(node.properties)) violations.push(`${at}.properties 必须是对象`)
      else for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${at}.properties.${key}`, violations)
    }
  }
  if (type === 'array' && Object.hasOwn(node, 'items')) checkSchema(node.items, `${at}.items`, violations)
}

function scalarMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

/** 与注册表的 validateJsonSchemaValue 同规则，用来确认返回值真的能过。 */
function checkValue(schema, value, at, violations) {
  if (Object.hasOwn(schema, 'oneOf')) {
    const hits = schema.oneOf.filter((branch) => {
      const local = []
      checkValue(branch, value, at, local)
      return local.length === 0
    })
    if (hits.length !== 1) violations.push(`${at} 必须正好匹配 oneOf 的一个分支（命中 ${hits.length} 个）`)
    return
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) violations.push(`${at} 必须等于 const`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${at} 不在 enum 中`)
  if (!Object.hasOwn(schema, 'type')) return

  const type = schema.type
  const typeOk =
    type === 'object' ? plainRecord(value) : type === 'array' ? Array.isArray(value) : scalarMatches(type, value)
  if (!typeOk) {
    violations.push(`${at} 类型应为 ${type}`)
    return
  }
  if (type === 'object') {
    const declared = plainRecord(schema.properties) ? schema.properties : {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${at}.${key} 缺失（required）`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(declared, key)) checkValue(declared[key], child, `${at}.${key}`, violations)
      else if (schema.additionalProperties === false) violations.push(`${at}.${key} 不在 properties 中（additionalProperties: false）`)
    }
  }
  if (type === 'array') {
    value.forEach((entry, index) => {
      if (schema.items) checkValue(schema.items, entry, `${at}[${index}]`, violations)
    })
  }
}

function expectSchema(label, schema) {
  const violations = []
  checkSchema(schema, label, violations)
  if (violations.length === 0) ok(`${label} 是合法的 JSON Schema 子集`)
  else bad(`${label} 不合法：\n      ${violations.join('\n      ')}`)

  if (JSON.stringify(schema) === undefined) bad(`${label} 不是可序列化 JSON`)
}

function expectValue(label, schema, value) {
  const violations = []
  checkValue(schema, value, label, violations)
  if (violations.length === 0) ok(`${label} 与 schema 一致`)
  else bad(`${label} 与 schema 不一致：\n      ${violations.join('\n      ')}`)
}

function expect(label, condition, detail = '') {
  if (condition) ok(label)
  else bad(`${label}${detail ? `：${detail}` : ''}`)
}

console.log('\n[1] 工具 schema（入参 + 出参）')
expectSchema('bili_read.parameters', READ_TOOL_PARAMETERS)
expectSchema('bili_read.output.schema', READ_OUTPUT_SCHEMA)
expectSchema('bili_read_batch.parameters', BATCH_TOOL_PARAMETERS)
expectSchema('bili_read_batch.output.schema', BATCH_OUTPUT_SCHEMA)

console.log('\n[2] 返回值与出参 schema 对齐')
const SAMPLE_CHILD_JSON = {
  bv: 'BV1DubxzVEPB',
  title: '把读视频外包给子代理',
  up: '某 UP',
  duration: 187,
  summary: '这是一条用 DSH 插件把长视频阅读外包给子代理的演示。',
  highlights: ['[00:12] 演示了插件的两个工具', '[01:40] 对比了直接读与子代理读的上下文开销'],
  ad_segments: [],
  score_hint: { info: 3, pref: 4, novel: 3, emotion: 2, craft: 3 },
  error: null,
}
const successItem = toItem('BV1DubxzVEPB', SAMPLE_CHILD_JSON)
expectValue('成功结果', READ_OUTPUT_SCHEMA, successItem)
expectValue('失败结果', READ_OUTPUT_SCHEMA, failureItem('BV1DubxzVEPB', 'view 接口 code=-404'))
expectValue(
  '批量结果',
  BATCH_OUTPUT_SCHEMA,
  {
    items: [successItem, failureItem('BV1xxxxxxxxx', 'timeout')],
    failed: [{ bv: 'BV1xxxxxxxxx', error: 'timeout' }],
  },
)

console.log('\n[3] 子代理 JSON 的解析与归一化')
expect('裸 JSON 能解析', parseChildJson('{"a":1}').a === 1)
expect('``` 围栏能解析', parseChildJson('```json\n{"a":2}\n```').a === 2)
expect('前后有废话也能解析', parseChildJson('结果如下：\n{"a":3}\n以上。').a === 3)
expect(
  '纯废话抛错',
  (() => {
    try {
      parseChildJson('我看完了，很好。')
      return false
    } catch {
      return true
    }
  })(),
)
expect(
  'score_hint 缺项要抛错（不许补零假装成功）',
  (() => {
    try {
      toItem('BV1DubxzVEPB', { summary: '有摘要', score_hint: { info: 1 } })
      return false
    } catch {
      return true
    }
  })(),
)
expect('超范围分值被夹到 0-4', toItem('BV1DubxzVEPB', { ...SAMPLE_CHILD_JSON, score_hint: { info: 9, pref: -3, novel: 2.6, emotion: 0, craft: 4 } }).score_hint.info === 4)
expect('error 字符串原样保留', toItem('BV1DubxzVEPB', { ...SAMPLE_CHILD_JSON, error: '无官方字幕' }).error === '无官方字幕')
expect('bv 以请求为准', toItem('BV1DubxzVEPB', { ...SAMPLE_CHILD_JSON, bv: 'BV1WRONGWRONG'.slice(0, 12) }).bv === 'BV1DubxzVEPB')
const reportedFailure = toItem('BV1DubxzVEPB', { bv: 'BV1DubxzVEPB', summary: '', error: 'view 接口 code=-404' })
expect('子代理自己报错时不改写原因', reportedFailure.error === 'view 接口 code=-404')
expectValue('子代理报错的结果也满足 schema', READ_OUTPUT_SCHEMA, reportedFailure)
expect('duration 认 "02:55"', toItem('BV1DubxzVEPB', { ...SAMPLE_CHILD_JSON, duration: '02:55' }).duration === 175)

console.log('\n[4] 入参规整')
expect('BV 大小写原样保留', normalizeBv('BV1DubxzVEPB') === 'BV1DubxzVEPB')
expect('bv1 前缀被规范成 BV1', normalizeBv('bv1DubxzVEPB') === 'BV1DubxzVEPB')
expect('去首尾空白', normalizeBv('  BV1DubxzVEPB  ') === 'BV1DubxzVEPB')
expect('AV 号被拒', normalizeBv('av170001') === null)
expect('过短被拒', normalizeBv('BV1abc') === null)
const cfg = normalizeConfig({ concurrency: 99, timeoutSec: 1, defaultFrames: 'yes' })
expect('concurrency 夹到 3', cfg.concurrency === 3)
expect('timeoutSec 夹到 30', cfg.timeoutSec === 30)
expect('defaultFrames 只认 true', cfg.defaultFrames === false)
expect('默认 config 可用', normalizeConfig(undefined).timeoutSec === 180)
expect('并发上限仍是 3', effectiveConcurrency(9, 2) === 3)
expect(`批量上限是 ${MAX_BATCH}`, MAX_BATCH === 10)

console.log('\n[5] 包结构')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
expect('package.json 可解析', plainRecord(pkg))
expect('main 指向 index.js', pkg.main === 'index.js')
expect('dsh.bundle.patch 指向 cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
for (const file of ['index.js', 'cordis.patch.yml', 'README.md', 'prompts/reader.md', 'lib/config.mjs', 'lib/schema.mjs', 'lib/cli.mjs', 'lib/subagent.mjs', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
  expect(`存在 ${file}`, fs.existsSync(path.join(ROOT, file)))
}
for (const file of ['locale/en.json', 'locale/zh.json']) {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  expect(`${file} 有 meta.title/description`, typeof doc.meta?.title === 'string' && typeof doc.meta?.description === 'string')
}

const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
expect('patch 里有 insert 段', /^- insert:/m.test(patch))
expect('patch 的 name 与包名一致', /name: dsh-bili-reader/.test(patch))

console.log('\n[6] 插件装配（假 ctx，不连 DSH）')
const { apply } = await import('../index.js')

function makeFakeEnv(resultFactory) {
  const registered = []
  const starts = []
  const subagents = {
    getProvider: (provider) => (provider === 'spawn' ? { name: 'spawn' } : undefined),
    async startActivation(spec) {
      starts.push(spec)
      return {
        childId: `fake-${starts.length}`,
        result: Promise.resolve(resultFactory(starts.length)),
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    tools: { register: (definition) => (registered.push(definition), () => {}) },
    effect: (callback) => {
      callback()
      return () => {}
    },
    get: (name) => (name === 'subagents' ? subagents : undefined),
  }
  return { ctx, registered, starts }
}

const successEnv = makeFakeEnv(() => ({
  output: [{ type: 'text', text: JSON.stringify(SAMPLE_CHILD_JSON) }],
  stopReason: 'completed',
}))
apply(successEnv.ctx, { concurrency: 2 })
expect('注册了两个工具', successEnv.registered.length === 2, String(successEnv.registered.length))
expect(
  '工具名是 bili_read / bili_read_batch',
  successEnv.registered.map((d) => d.name).join(',') === 'bili_read,bili_read_batch',
  successEnv.registered.map((d) => d.name).join(','),
)
expect('两个工具都声明了 output.render', successEnv.registered.every((d) => typeof d.output?.render === 'function'))

const readDef = successEnv.registered.find((d) => d.name === 'bili_read')
const batchDef = successEnv.registered.find((d) => d.name === 'bili_read_batch')
const execCtx = () => ({ agent: { id: 'fake-agent' }, signal: new AbortController().signal })

const readValue = await readDef.execute({ bv: 'bv1DubxzVEPB' }, execCtx())
expectValue('bili_read 真实返回值', READ_OUTPUT_SCHEMA, readValue)
expect('BV 已归一化（大小写保留）', readValue.bv === 'BV1DubxzVEPB', readValue.bv)
expect('子代理拿到了命令与 BV', successEnv.starts[0]?.request?.prompt?.[0]?.text?.includes('BV1DubxzVEPB') === true)
expect('子代理用 caller 交付（不留通知给父会话）', successEnv.starts[0]?.delivery === 'caller')
expect('prompt 里带 --no-frames', successEnv.starts[0]?.request?.prompt?.[0]?.text?.includes('--no-frames') === true)

const rendered = readDef.output.render({}, readValue)
expect('render 返回一个 text block', rendered.length === 1 && rendered[0].type === 'text')
expect('渲染结果 < 4000 字符（主会话开销可控）', rendered[0].text.length < 4000, `${rendered[0].text.length} 字符`)

const batchValue = await batchDef.execute({ bvs: ['BV1DubxzVEPB', 'BV1xxxxxxxxx', 'BV1DubxzVEPB'], concurrency: 2 }, execCtx())
expectValue('bili_read_batch 真实返回值', BATCH_OUTPUT_SCHEMA, batchValue)
expect('重复的 BV 只读一次', batchValue.items.length === 2, String(batchValue.items.length))

const failingEnv = makeFakeEnv(() => ({ output: [], stopReason: 'error' }))
apply(failingEnv.ctx, {})
const failingRead = failingEnv.registered.find((d) => d.name === 'bili_read')
const failedValue = await failingRead.execute({ bv: 'BV1DubxzVEPB' }, execCtx())
expectValue('失败结果仍然满足 schema', READ_OUTPUT_SCHEMA, failedValue)
expect('失败如实写进 error', typeof failedValue.error === 'string' && failedValue.error.length > 0)
expect('失败时摘要为空（不编内容）', failedValue.summary === '' && failedValue.highlights.length === 0)
expect('失败最多重试一次（共两次启动）', failingEnv.starts.length === 2, String(failingEnv.starts.length))

let rejectedInvalidArgs = false
try {
  await readDef.execute({ bv: 'not-a-bv' }, execCtx())
} catch {
  rejectedInvalidArgs = true
}
expect('非法 BV 直接抛错', rejectedInvalidArgs)

let rejectedOversize = false
try {
  await batchDef.execute({ bvs: Array.from({ length: MAX_BATCH + 1 }, () => 'BV1DubxzVEPB') }, execCtx())
} catch {
  rejectedOversize = true
}
expect(`超过 ${MAX_BATCH} 条直接抛错`, rejectedOversize)

console.log(`\n${failures === 0 ? '✅' : '❌'} 自检结束：${checks - failures}/${checks} 通过`)
if (failures > 0) process.exitCode = 1
