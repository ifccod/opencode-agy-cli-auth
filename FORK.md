# agy-cli 分叉：视频输入

本仓库 fork 自 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `packages/agy-cli`，npm 包名是 `@magpie-community/opencode-agy-cli-auth`。上游的 LICENSE（MIT）和 NOTICE.md 原样保留。

和上游相比多三处改动，都在 `index.mjs` 里：

1. **视频输入**：Gemini 能原生看视频，画面和声音都能处理。代码里搜 `Video (local patch)`。
2. **容量不足报错改为 503**：agy 重试多次仍拿不到 Google 的容量时，会在结尾写一行 `⚠ Our servers are experiencing high traffic right now…`。上游插件把这行当正文、以 200 返回，客户端和外层网关都以为请求成功了。这里改成 503 `overloaded_error`，客户端会重试，外层网关会换下一个。选 503 而不是 429，是因为没容量的是这个模型，不是账号额度用完，Magpie 不应该让这个账号休息。代码里搜 `Busy ending (local patch)`。
3. **工具被拒后不再回空**：开放 `read_file` 以后，模型有时会拿它去读客户端机器上的路径，比如 ZCode 用户 Mac 上的 `~/.zcode/...`。这个工具在服务器上跑，读媒体目录以外的路径要先申请权限，插件会拒绝；agy 被拒后就直接结束这一轮。上游插件把这样的结束原样交给客户端，结果是空正文、没有工具调用，客户端看上去就是卡住不动。现在改成两处：
   - agent 说明里写明 `read_file` 只能读附带的视频，其他文件用客户端的工具读。
   - 一轮在被拒的工具上结束、之后既没有正文也没有客户端工具调用时，返回 `api_error`，错误信息写明是哪个工具被拒、为什么被拒。
   代码里搜 `Denied ending (local patch)`。

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

- `upstream-sync.yml`：每 6 小时检查一次上游，有新版本就开一个 `sync/<版本>` PR。合并干净时，PR 里写上测试结果；有冲突时，把冲突标记原样提交进 PR，并在 PR 里说明哪里需要解决。
- `release.yml`：main 上的插件文件有变化时，跑测试、打 tag、发 Release。
- `test.yml`：PR 上有人（或 AI）推了提交时，跑 `fork/fork.sh test`，并检查有没有残留的冲突标记。Actions 自己开的 PR、自己推的提交不会触发它。

人或 AI（例如 ChatGPT dots）只需要处理同步 PR：看上游改了什么，解决冲突，然后合并。
