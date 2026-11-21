# agy-cli 分叉：视频输入

本仓库 fork 自 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `packages/agy-cli`，npm 包名是 `@magpie-community/opencode-agy-cli-auth`。上游的 LICENSE（MIT）和 NOTICE.md 原样保留。

和上游相比多四处改动，都在 `index.mjs` 里（“容量不足报错改为 503”上游 0.1.95 已经自带，分叉里那份已删除）：

1. **视频输入**：Gemini 能原生看视频，画面和声音都能处理。代码里搜 `Video (local patch)`。
2. **重发的请求接上原来那一轮**：客户端等不到首字就断开，把同一份请求再发一遍，而原请求还在跑；或者原请求的回复（一次工具调用）在路上丢了。上游插件对这种重发返回错误（0.1.106 之前一律是 409 `no active MCP call matches these tool results`，0.1.106 起原请求还在出流时是 503），要等原来那一轮结束才变，而原请求照常跑完并计费，产出没人收。现在重发的请求会等原请求出结果，拿到同一份回复，用量记 0，不重复计费。原请求失败或被取消时，重发的请求收到 503，客户端再发一次就会重新跑。已经正常结束、没有待答工具调用的回复不走这条路，再发一遍仍然重新生成。代码里搜 `Retry attach (local patch)`。
3. **工具被拒后不再回空**：开放 `read_file` 以后，模型有时会拿它去读客户端机器上的路径，比如 ZCode 用户 Mac 上的 `~/.zcode/...`。这个工具在服务器上跑，读媒体目录以外的路径要先申请权限，插件会拒绝；agy 被拒后就直接结束这一轮。上游插件把这样的结束原样交给客户端，结果是空正文、没有工具调用，客户端看上去就是卡住不动。现在改成两处：
   - agent 说明里写明 `read_file` 只能读附带的视频，其他文件用客户端的工具读。
   - 一轮在被拒的工具上结束、之后既没有正文也没有客户端工具调用时，返回 `api_error`，错误信息写明是哪个工具被拒、为什么被拒。
   代码里搜 `Denied ending (local patch)`。
4. **同一对话的并行线各用各的 agy 进程**：插件按“user_id + system + 第一条消息”认对话，一个对话只有一个 agy 进程。有的客户端在同一个会话里同时跑两条线，比如 ZCode 带着整份主对话另跑一个有工具调用的后台任务，两条线这三样都一样。上游会让后到的那条抢掉对方挂着的工具轮，或者让它等对方出完流（503 `this conversation still has an unfinished response`）；被抢的一方送回工具结果时，0.1.106 之前收到 409 `no active MCP call matches these tool results`；0.1.106 起改为重放，但会反过来抢掉对方挂着的那一轮，对方正在出流时则回 503。两条线来回互抢，每抢一次都要重放整份历史。现在：
   - 对方正在出流时，新来的另一条线（不带对方的工具调用）直接另开一个进程（一条“通道”），不等也不抢；
   - 对方挂着工具轮、没在出流时，仍按上游的规则抢占；被抢的那一轮的工具结果回来时，不抢回对方、也不回 503，而是开一条通道用请求里的历史重放，并把这个对话记为“并行”；
   - 记为并行的对话（10 分钟内），挂着工具轮的一方也当成另一条线，不再被抢；
   - 之后每个请求按历史接续回到自己的通道，工具结果本来就按调用 id 找回原进程；
   - 带着本机没有的工具结果回来（会话被网关换到别的 Magpie 后又切回来），而这里正有一条线在出流时，也开通道重放，不回 503（0.1.106 之前是 409）。

   一个对话最多 `AGY_BRIDGE_MAX_LANES` 个进程（默认 3，设成 1 就是上游行为），满了就复用最久没用的空闲通道；全机进程上限仍是 `AGY_BRIDGE_MAX_PROCS`，闲置 10 分钟的进程照常回收。代码里搜 `Parallel lanes (local patch)`。

## 为什么要绕一圈

agy 1.5.9 的 ACP 不收视频：用 image 块发会报 `unsupported mimeType`，用 resource blob 发会被 `unsupported blob type` 丢掉。agy 自带的 `read_file` 却能把视频文件原生交给 Gemini。补丁的做法：

1. 客户端把视频当作图片发过来。OpenAI 协议写 `image_url`，值可以是 `data:video/mp4;base64,…`，也可以是 http(s) 链接。Magpie 会原样转成 `image` 块交给插件。
2. 插件把视频写到 `~/.local/state/magpie-agy-bridge/media/<sha256>.<ext>`，并在 prompt 里告诉模型“视频在这个路径，用 read_file 读”。
3. agent 改成 `tools: [read_file]`，用 `--add-dir` 把 media 目录加进工作区。这样读文件不会弹权限请求。
4. agy 读完时会发出 `tool_call completed`，插件收到后马上删掉自己写的文件。agy 会在 `brain/<会话>/.system_generated/logs/media/` 里留一份副本，多轮对话靠它继续。

## 用法

```json
{"type": "image_url", "image_url": {"url": "data:video/mp4;base64,AAAA..."}}
{"type": "image_url", "image_url": {"url": "https://example.com/clip.mp4"}}
```

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `AGY_BRIDGE_VIDEO` | 开启 | 设为 `0` 时退回上游行为（`tools: []`，不处理视频） |
| `AGY_BRIDGE_VIDEO_PRIVATE` | 关闭 | 设为 `1` 时允许下载内网或本机地址的视频链接。只在可信内网里用 |
| `AGY_BRIDGE_MAX_LANES` | 3 | 一个对话最多同时用几个 agy 进程（并行通道）。设为 `1` 退回上游的一个对话一个进程 |

限制：
- 单个视频最大 100 MB，这是 agy `read_file` 的上限。下载超时 120 秒，最多跟 3 次重定向。
- 链接只允许 http(s)，解析出的 IP 是内网、回环或链路本地地址时一律拒绝（400）。
- 下载前会检查一次 DNS，但检查完到真正下载之间如果 DNS 被改指（DNS rebinding），这种情况防不住。
- 开启后，模型可以用 `read_file` 直接读 agy 工作区里的文件，包括客户端的项目目录。上游插件“只桥接客户端工具”的隔离因此变宽了。
- agy 的副本插件不会清理。

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
fork/fork.sh test       # fork/video-selfcheck.mjs + fork/patch-e2e.mjs（补丁打开时）+ 上游测试（AGY_BRIDGE_VIDEO=0）
fork/fork.sh release    # 在 main 上打 v<版本>-video.<n> 标签，发 Release
```

自动化（`.github/workflows/`）：

- `upstream-sync.yml`：每 6 小时检查一次上游，有新版本就开一个 `sync/<版本>` PR。合并干净且测试通过时，自动用 merge commit 合并、触发 `release.yml` 发版，并关掉被它取代的旧 sync PR；部署到 Magpie 容器仍是人工。有冲突或测试没过时，把冲突标记原样提交进 PR（或写明哪些测试没过），等人处理。
- `release.yml`：main 上的插件文件有变化时，跑测试、打 tag、发 Release。
- `test.yml`：PR 上有人（或 AI）推了提交时，跑 `fork/fork.sh test`，并检查有没有残留的冲突标记。Actions 自己开的 PR、自己推的提交不会触发它。

人或 AI（例如 ChatGPT dots）只需要处理没能自动合并的同步 PR：看上游改了什么，解决冲突，然后合并。
