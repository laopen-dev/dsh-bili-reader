# dsh-bili-reader

把「读 B 站视频」的活交给子代理，主会话只收一份结构化摘要。

一条 25 分钟的视频，`debrief` 会把字幕、弹幕热区、热评全吐出来 —— 几千到上万 token。直接在主会话读三五条，上下文就满了。这个插件把这件事固化成两个工具：

```
bili_read <BV>              → 一两百字摘要 + 3-5 条带时间点的看点 + 评分提示
bili_read_batch [<BV>...]   → 一批一起读（有并发上限），失败的单独列出来
```

工具里起一个子代理，子代理在自己的上下文里跑 `bili.mjs debrief`，把原始材料吃掉，只回一段 JSON。主会话拿到的是那段 JSON —— 通常 500–900 token。

## 它依赖什么

- DSH `0.2.1-rc.3`（桌面端 profile `desktop`，Windows 实测）。
- 已安装并配置好的 [`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale)（本插件只调用它的 CLI，**不自己实现抓取**）。
- 宿主的 subagent 能力：`@deepseek-ai/dsh-subagent` + `@deepseek-ai/dsh-subagent-spawn-in-process`（provider 名 `spawn`，DSH 默认已装）。
- 一个大小写区分得住的 B 站 BV 号；不需要把 cookie 给这个插件（cookie 是 bili-whale 的事）。

## 安装

先确认 CLI 能用（在 DSH 的会话里跑，或让 agent 跑）：

```
"C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" ^
  "C:\Users\<你>\.dsh\plugins\dsh-bili-whale\tools\bili.mjs" debrief BV1DubxzVEPB --no-frames
```

然后把插件装进 profile（**由你自己执行**，插件不会自己装）：

```
dsh plugin --profile desktop add "link:<你的用户目录>\.dsh\plugins\dsh-bili-reader"
```

装完刷新页面。插件是 host-only：**没有设置页**，配置写在 profile 的 `cordis.patch.yml` 里（见下）。

> ⚠️ 安装前**先完全退出 DSH Desktop**，再执行 `dsh plugin add`——桌面端运行时文件可能被占用。
>
> 装好之后，插件会自动往系统提示里注入一小段「读视频优先用 `bili_read_batch`」的说明；不接受的话把 `index.js` 里 `systemPrompt.section` 那段删掉即可。

也可以从 Git 地址装（发布到 GitHub 之后）：

```
dsh plugin --profile desktop add "https://github.com/laopen-dev/dsh-bili-reader"
```

想放 npm 上再装也可以：`dsh plugin --profile desktop add dsh-bili-reader`。

### 路径

`cliPath` / `nodePath` 留空时按顺序自动找：

| 配置 | 默认推导 |
|---|---|
| `cliPath` | `<DSH_HOME>/plugins/dsh-bili-whale/tools/bili.mjs` |
| `nodePath` | `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe`，再退到 `process.execPath`（只在它确实是 node 时） |

`DSH_HOME` 默认是 `%USERPROFILE%\.dsh`。找不到时工具**不会假装成功**：直接返回 `error` 说明缺哪个路径、该在哪儿配。

## 配置

写在 `~/.dsh/profiles/desktop/cordis.patch.yml`（或安装时生成的 patch 层里）：

```yaml
- id: dsh-bili-reader
  name: dsh-bili-reader
  config:
    cliPath: '<你的用户目录>\.dsh\plugins\dsh-bili-whale\tools\bili.mjs'
    nodePath: '<你的用户目录>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    defaultFrames: false
    concurrency: 2
    timeoutSec: 180
    provider: spawn
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `cliPath` | 自动 | `bili.mjs` 绝对路径 |
| `nodePath` | 自动 | 跑 CLI 的 node 绝对路径（PATH 里通常没有 node） |
| `defaultFrames` | `false` | 每次读是否默认抽帧（慢：下视频 + ffmpeg） |
| `concurrency` | `2` | 批量默认并发，夹到 1–3 |
| `timeoutSec` | `180` | 单次子代理等待上限，夹到 30–900 |
| `provider` | `spawn` | subagent provider 名 |

越界值一律夹到合法区间，写坏了也不会让插件起不来。

## 用法

直接跟 agent 说就行：

- 「用 `bili_read BV1DubxzVEPB` 看这条」→ 拿回摘要。
- 「这三条一起读：BV1xx BV1yy BV1zz」→ agent 自己会调 `bili_read_batch`。
- 「只读口播，不要抽帧」→ 就是默认行为；抽帧要显式 `frames: true`。

`bili_read` 入参 / 出参：

```jsonc
// 入参
{ "bv": "BV1DubxzVEPB", "frames": false }

// 出参
{
  "bv": "BV1DubxzVEPB",
  "title": "…",
  "up": "…",
  "duration": 175,
  "summary": "150–250 字，人话：这是什么 + 讲了什么 + 值不值得看",
  "highlights": ["[01:20] 具体发生了什么", "…"],
  "ad_segments": ["01:25–01:50"],
  "score_hint": { "info": 3, "pref": 4, "novel": 2, "emotion": 2, "craft": 3 },
  "error": null
}
```

`bili_read_batch`：`{ bvs: [...], concurrency: 2, frames: false }` → `{ items: [...同 bili_read...], failed: [{ bv, error }] }`。一次最多 10 条（`MAX_BATCH`），重复的 BV 只读一次，结果按入参顺序返回。

### 失败长什么样

**没有"看起来成功"这种情况。**

- 单个读取失败（超时 / 子代理崩了 / 返回的不是 JSON / 命令报错）→ 结果对象里 `error` 是一句具体原因，`summary` 为空字符串、`highlights` 为空数组、`score_hint` 全 0。**`error` 非空时那些空字段是占位，不是摘要。**
- `bili_read_batch` → 失败项同时出现在 `items`（带 `error`）和 `failed` 里。
- 入参就不对（BV 形状不对、`bvs` 超过 10 条）→ 直接抛 `Error:`，不会返回半个对象。
- 配置的路径不存在 → 不会去起子代理，直接返回 `error` 说明缺什么。

## 边界

- **纯只读**。只发 GET 请求：不发评论、不发私信、不关注/取关、不点赞、不投币、不收藏、不充电。不注册任何定时任务，不写日记。
- **只调用现成的 CLI**，不自己实现抓取逻辑。B 站接口变了只需要修 `dsh-bili-whale` 一处。
- **不改 `dsh-bili-whale` 的任何文件**。CLI 自己会往 `~/.dsh/shots/` 写封面和字幕 txt，那是它本来的行为。
- **不要和 `dsh-bili-whale` 给同一个 B 站号同时高频跑**：会双倍请求、互相踢 cookie。要一起用就串行、低频。
- **不要和 `dsh-bili-scroll` / `dsh-bili-subagent` 同装**：工具名会撞。
- 子代理是**新起的独立上下文**，不继承主会话的对话；它能用的工具取决于当前 agent preset（需要能跑 `pwsh`）。

## 已知问题 / 没做完的事

1. **抽帧（`frames: true`）很容易超时。** `debrief` 会下载整条视频再抽帧，25 分钟的视频实测要十几分钟，超过默认的 180 秒。要么把 `timeoutSec` 调大，要么就用默认的 `--no-frames`。这是"已知会失败"的路径，不是 bug 掩盖。
2. **需要会话能无审批执行 `pwsh`。** 子代理的权限范围在启动时固定、不能中途放宽，审批请求会被自动拒绝。所以 profile 的权限模式要是 `danger-full-access`（本机就是），否则子代理跑不动 CLI。另外 `debrief` 会写 `~/.dsh/shots/`，在 `workspace-write` 沙箱下属于工作区外写入，也会被拦。
3. **子代理的耗时是真实的 LLM 时间。** 一次读 = 一次子代理对话（通常 3-5 步：跑 `debrief` → `read` 官方字幕 txt → 抽帧时看一眼九宫格 → 交 JSON）。批量 3 条并发 2，实际等待大约 2 个"单条时间"。
4. **`debrief` 只打印字幕文件路径，不打印全文。** 所以 prompt 里要求子代理再去 `read` 那个 txt（那才是整片台词）。这依赖 bili-whale 的输出格式（`有字幕：N 行（…）→ <路径>`）；哪天它改了这个格式，摘要质量会退化成"只靠弹幕和热评"，但插件本身不会崩。
5. **`score_hint` 是模型自评，不是可复现的分数。** 它只是给"值不值得发"当参考；跨模型/跨次不一定稳定。
6. **没有设置页 / 没有 client 半。** 配置只能改 `cordis.patch.yml`；改完要重启（或等 profile 配置重载）。
7. **没有自动清理 bili-whale 的缓存。** `~/.dsh/shots/{covers,subs}` 会一直长，那是 bili-whale 的事。
8. **超时重试的代价：** 失败最多重试一次，所以最坏情况是 2 × `timeoutSec` 的等待。批量里每个视频各自计时。
9. **未在他人机器上验证。** 只在 `desktop` profile + Windows + DSH `0.2.1-rc.3` 上做过语法、schema 与"假 ctx 装配"自检；真实的端到端（装进 profile 后真读一条）需要装完由主人跑一次确认。

## 自检

```
"C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" ^
  "C:\Users\<你>\.dsh\plugins\dsh-bili-reader\tools\selfcheck.mjs"
```

查：schema 是否在注册表强制的 JSON Schema 子集里、出参 schema 与真实返回值是否一致、子代理 JSON 的脏输入解析、BV/配置规整、包结构与 patch 引用，最后用**假 ctx** 把插件真的装配一遍（注册工具、跑一次 `bili_read`/`bili_read_batch`、走一遍失败重试路径），确认返回值与 schema 对得上。全部离线，不需要 DSH 在跑。

## 文件

```
dsh-bili-reader/
├─ package.json          # name/main/exports/dsh.bundle.patch
├─ cordis.patch.yml      # 只插一行插件（config 就在这里）
├─ index.js              # 插件入口：注册两个工具 + 渲染
├─ lib/
│  ├─ config.mjs         # 配置归一化 + DSH_HOME
│  ├─ cli.mjs            # 找 node/bili.mjs、拼命令行、拼 prompt
│  ├─ schema.mjs         # 工具 schema + 子代理 JSON 的解析/归一化
│  └─ subagent.mjs       # 起子代理、等结果、超时/重试/取消
├─ prompts/reader.md     # 子代理的任务说明（只读、只交 JSON）
├─ locale/{en,zh}.json   # Plugin Manager 里显示的名字与描述
├─ icon.svg              # 列表图标
├─ tools/selfcheck.mjs   # 离线自检
└─ README.md
```
