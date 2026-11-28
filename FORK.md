# agy-cli 分叉：视频输入

本仓库 fork 自 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `packages/agy-cli`，npm 包名是 `@magpie-community/opencode-agy-cli-auth`。上游的 LICENSE（MIT）和 NOTICE.md 原样保留。

和上游相比多五处改动，都在 `index.mjs` 里（“容量不足报错改为 503”上游 0.1.95 已经自带，分叉里那份已删除）：

1. **视频输入（OpenAI 写法和链接）**：上游 0.1.155 起自带视频/音频输入，但只收 `video`/`audio` 块里的 base64，链接一律 400。补丁把 `image_url` 里的视频（`data:video/…` 或 http(s) 链接）和链接形式的 `video` 块转成上游的 base64 `video` 块，之后全走上游。代码里搜 `Video (local patch)`。
2. **重发的请求接上原来那一轮**：客户端等不到首字就断开，把同一份请求再发一遍，而原请求还在跑；或者原请求的回复（一次工具调用）在路上丢了。上游插件对这种重发返回错误（0.1.106 之前一律是 409 `no active MCP call matches these tool results`，0.1.106 起原请求还在出流时是 503），要等原来那一轮结束才变，而原请求照常跑完并计费，产出没人收。现在重发的请求会等原请求出结果，拿到同一份回复，用量记 0，不重复计费。原请求失败或被取消时，重发的请求收到 503，客户端再发一次就会重新跑。已经正常结束、没有待答工具调用的回复不走这条路，再发一遍仍然重新生成。带工具结果的请求、原请求已经结束时，交给上游 0.1.131 的 `replay_tool_step`（比对整份请求的摘要，回放同一个消息 id）；本补丁只接原请求还在跑的重发，以及不带工具结果的请求丢了回复的重发。代码里搜 `Retry attach (local patch)`。
3. **工具被拒后不再回空**：带视频的会话开放 `view_file` 以后，模型有时会拿它去读客户端机器上的路径，比如 ZCode 用户 Mac 上的 `~/.zcode/...`。这个工具在服务器上跑，读会话目录以外的路径要先申请权限，插件会拒绝；agy 被拒后就直接结束这一轮。上游插件把这样的结束原样交给客户端，结果是空正文、没有工具调用，客户端看上去就是卡住不动。现在改成两处：
   - 带视频的会话，agent 说明里写明 `view_file` 只能读附带的视频或音频，其他文件用客户端的工具读。
   - 一轮在被拒的工具上结束、之后既没有正文也没有客户端工具调用时，返回 `api_error`，错误信息写明是哪个工具被拒、为什么被拒。
   代码里搜 `Denied ending (local patch)`。
4. **同一对话的并行线各用各的 agy 进程**：插件按“user_id + system + 第一条消息”认对话，一个对话只有一个 agy 进程。有的客户端在同一个会话里同时跑两条线，比如 ZCode 带着整份主对话另跑一个有工具调用的后台任务，两条线这三样都一样。上游会让后到的那条抢掉对方挂着的工具轮，或者让它等对方出完流（503 `this conversation still has an unfinished response`）；被抢的一方送回工具结果时，0.1.106 之前收到 409 `no active MCP call matches these tool results`；0.1.106 起改为重放，但会反过来抢掉对方挂着的那一轮，对方正在出流时则回 503。两条线来回互抢，每抢一次都要重放整份历史。现在：
   - 对方正在出流时，新来的另一条线（不带对方的工具调用）直接另开一个进程（一条“通道”），不等也不抢；
   - 对方挂着工具轮、没在出流时，仍按上游的规则抢占；被抢的那一轮的工具结果回来时，不抢回对方、也不回 503，而是开一条通道用请求里的历史重放，并把这个对话记为“并行”；
   - 记为并行的对话（10 分钟内），挂着工具轮的一方也当成另一条线，不再被抢；
   - 之后每个请求按历史接续回到自己的通道，工具结果本来就按调用 id 找回原进程；
   - 带着本机没有的工具结果回来（会话被网关换到别的 Magpie 后又切回来），而这里正有一条线在出流时，也开通道重放，不回 503（0.1.106 之前是 409）。

   一个对话最多 `AGY_BRIDGE_MAX_LANES` 个进程（默认 3，设成 1 就是上游行为），满了就复用最久没用的空闲通道；全机进程上限仍是 `AGY_BRIDGE_MAX_PROCS`，闲置 10 分钟的进程照常回收。代码里搜 `Parallel lanes (local patch)`。
5. **thinking 关闭时照样转发思考**：有的网关会给没提 thinking 的请求补上 `"thinking": {"type": "disabled"}`。上游插件见到 disabled 就丢掉所有思考片段，可 agy 关不掉思考：它没有关闭思考的档位，上游的 `requestedEffort()` 遇到 disabled 不设档位，于是选了这个模型的默认档（有 high 就是 high），想得最久，常常 8–12k token、两分钟以上。这期间流里只有 `message_start` 和 ping，网关等不到真正的内容就一直扣着流（最长 4 分钟），只发 `: keepalive` 注释；ZCode 这类 ai-sdk 客户端大约 155 秒就放弃，这次生成白做了。思考片段一到网关，网关就放行，插件 15 秒一次的 ping 也就能到客户端。现在 disabled 的请求也照常转发思考（`thinking_delta`），思考块带插件平时的签名（`thinkingSignature`），和要了 thinking 的请求一样（插件回放历史时不校验这个签名）。非流式回复由同一个流拼出来，同样带思考块。设 `AGY_BRIDGE_THINKING_WHEN_DISABLED=0` 退回上游行为。另外 disabled 的请求改选最低档（`disabledEffort()`）：请求带了 `output_config.effort` 就用它，否则用 low（只有一档的模型选最接近的那档）。本机实测 gemini-4-carbon 同一道长题，high 档首字 87–90 秒，low 档 7 秒。模型名带档位后缀（`-high`）时仍按后缀。设 `AGY_BRIDGE_DISABLED_EFFORT=0` 退回上游的默认档，设成别的档位名就用那一档。代码里搜 `Thinking when disabled (local patch)`。

## 为什么要绕一圈

agy 的 ACP 不收视频（image 块报 `unsupported mimeType`，resource blob 被 `unsupported blob type` 丢掉），只有它自己读文件的工具能把视频原生交给 Gemini。上游 0.1.155 的做法：把 `video`/`audio` 块写到会话工作区的 `attachments/<sha256>.<ext>`，prompt 里叫模型去读，只有带媒体的会话才有 `tools: [view_file]`，并且不加 `--add-dir`、把 TMPDIR 指到会话工作区，`view_file` 读不到别的目录。

补丁只在这之前做转换：

1. 客户端把视频当作图片发过来。OpenAI 协议写 `image_url`，值可以是 `data:video/mp4;base64,…`，也可以是 http(s) 链接。Magpie 会原样转成 `image` 块交给插件。
2. base64 的直接改成 `video` 块。链接先下载（只认识别得出的视频，或 `Content-Type: video/*`），缓存在 `~/.local/state/magpie-agy-bridge/media/<sha256(链接)>`，同一个链接在后面的历史里再出现时读缓存，一小时没用的缓存在下次下载时清掉。
3. 之后由上游写文件、开 `view_file`、拒绝非 Gemini 模型。

## 用法

```json
{"type": "image_url", "image_url": {"url": "data:video/mp4;base64,AAAA..."}}
{"type": "image_url", "image_url": {"url": "https://example.com/clip.mp4"}}
```

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `AGY_BRIDGE_VIDEO` | 开启 | 设为 `0` 时退回上游行为（只收 `video`/`audio` 块的 base64） |
| `AGY_BRIDGE_VIDEO_PRIVATE` | 关闭 | 设为 `1` 时允许下载内网或本机地址的视频链接。只在可信内网里用 |
| `AGY_BRIDGE_MAX_LANES` | 3 | 一个对话最多同时用几个 agy 进程（并行通道）。设为 `1` 退回上游的一个对话一个进程 |
| `AGY_BRIDGE_THINKING_WHEN_DISABLED` | 开启 | 请求写了 `thinking: {type: "disabled"}` 时仍转发思考。设为 `0` 退回上游行为（丢掉思考） |
| `AGY_BRIDGE_DISABLED_EFFORT` | `low` | `thinking: {type: "disabled"}` 且没带 `output_config.effort` 时选的档位。设为 `0` 退回上游行为（模型默认档，通常是 high） |

限制：
- 链接下载的视频最大 100 MB。下载超时 120 秒，最多跟 3 次重定向。
- 链接只允许 http(s)，解析出的 IP 是内网、回环或链路本地地址时一律拒绝（400）。
- 下载前会检查一次 DNS，但检查完到真正下载之间如果 DNS 被改指（DNS rebinding），这种情况防不住。
- 下载缓存插件按一小时清理；上游写在会话工作区的 `attachments/` 随会话走。

## 安装

```sh
magpie plugin add github:ifccod/opencode-agy-cli-auth#<tag>   # 例如 v0.1.87-video.1
```

可用的 tag 见 Releases。每个 Release 也附了 `npm pack` 打出的 tgz 包。

## 分支

| 分支 | 内容 |
|---|---|
| `upstream` | 上游 `packages/agy-cli` 的原样快照，每个版本一个提交，提交标题带上游 sha。不要手改 |
| `main` | upstream 快照 + 视频补丁 + 维护工具（`fork/`、`.github/`、`.claude/`，这些不打进 npm 包） |
| `sync/<版本>` | 合并某个上游版本用的临时分支，对应一个 PR |

## 维护

```sh
fork/fork.sh check      # 上游有没有新版本
fork/fork.sh sync       # 导入上游快照，在 sync/<版本> 分支上合并，并跑测试
fork/fork.sh test       # fork/video-selfcheck.mjs + fork/patch-e2e.mjs（补丁打开时）+ 上游测试（AGY_BRIDGE_VIDEO=0、AGY_BRIDGE_MAX_LANES=1、AGY_BRIDGE_THINKING_WHEN_DISABLED=0、AGY_BRIDGE_DISABLED_EFFORT=0）
fork/fork.sh release    # 在 main 上打 v<版本>-video.<n> 标签，发 Release
```

自动化（`.github/workflows/`）：

- `upstream-sync.yml`：每 6 小时检查一次上游，有新版本就开一个 `sync/<版本>` PR。合并干净且测试通过时，自动用 merge commit 合并、触发 `release.yml` 发版，并关掉被它取代的旧 sync PR；部署到 Magpie 容器仍是人工。有冲突或测试没过时，把冲突标记原样提交进 PR（或写明哪些测试没过），等人处理。
- `release.yml`：main 上的插件文件有变化时，跑测试、打 tag、发 Release。
- `test.yml`：PR 上有人（或 AI）推了提交时，跑 `fork/fork.sh test`，并检查有没有残留的冲突标记。Actions 自己开的 PR、自己推的提交不会触发它。

人或 AI（例如 ChatGPT dots）只需要处理没能自动合并的同步 PR：看上游改了什么，解决冲突，然后合并。
