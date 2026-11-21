---
name: agy-cli-fork
description: 维护 agy-cli 视频分叉（ifccod/opencode-agy-cli-auth）。用于：检查上游 magpie-community/plugins 的 agy-cli 有没有新版本、判断值不值得合并、合并并解决冲突、跑测试、发布 GitHub Release、把新版本装到 Magpie 服务器。用户说“看看上游更新”“同步上游”“发版”“部署插件”时使用。
---

# agy-cli 分叉维护

仓库结构和补丁原理先读 `FORK.md`。所有操作都在仓库根目录用 `fork/fork.sh` 做，不要手改 `upstream` 分支。

## 1. 看上游

```sh
fork/fork.sh check
```

退出码含义：0 是已是最新；10 是有新版本，会列出上游的新提交和改到的文件。

判断值不值得合并：

- 上游的提交标题就是 changelog，格式是 `agy-cli 0.1.xx: <改了什么>`。修 bug、跟进 agy 新版本、修 429/403 处理的，一般都要。
- 新提交里改了 `index.mjs` 时，合并可能和补丁冲突，但冲突本身不是不合并的理由。
- 拿不准时，先看具体 diff：`gh api repos/magpie-community/plugins/compare/<旧sha>...<新sha>`，或者导入以后 `git diff <旧upstream提交> upstream`。

## 2. 合并

```sh
fork/fork.sh sync          # 默认合并上游 main；也可以指定 ref：fork/fork.sh sync <sha>
```

脚本会做三件事：把上游快照导入 `upstream` 分支；在 `sync/<版本>` 分支上合并；跑测试。

有冲突时：

- 补丁的标记是 `Video (local patch)`、`videoOn`、`mediaDir`、`videoizeBody`、`dropReadVideo`、`sniffVideo`、`privateAddress`，以及 `fetchVideo`、`videoBlock`。
- 补丁一共挂在上游的 6 个位置：
  1. `import dns from "node:dns"`
  2. `FORWARD_THINKING` 后面的整段 helper
  3. `agentDefinition()` 里的 `tools:` 那一行
  4. `#spawn` 里 `--add-dir` 那一行后面
  5. `#onNotification` 开头那一行
  6. fetch 里 `body = await videoizeBody(JSON.parse(raw))`
- 重发接上原回合（`Retry attach (local patch)`），挂在五个位置：
  1. `streamResponse` 前面的 `retryKey`、`retryResponse` 两个函数，以及 `streamResponse` 里给 `turn.retry` 赋值的那一行；
  2. `makeAnthropicStream` 开头取 `const retry = turn.retry`；
  3. 它的 `detach` 里唤醒等待者的那一行；
  4. `tool_use` 和 `result` 两处 `recordAssistantResponse` 后面记下 `retry.reply`；
  5. fetch 里 `let keptSession = false` 后面、匹配工具结果之前的入口判断。

  `fork/patch-e2e.mjs` 的两个 retry 用例可以验证。容量不足改 503 的补丁上游 0.1.95 已自带，不再是我们的补丁；`patch-e2e.mjs` 里的 busy 用例留着当回归测试。
- 工具被拒后回空的修复（`Denied ending (local patch)`），挂在四个位置：
  1. `agentDefinition()` 末尾，`videoOn()` 时多加一行，说明 `read_file` 只能读媒体目录；
  2. `#onRequest` 的拒绝分支，在 `deniedPermissions++` 后面记下 `turn.denied`；
  3. `Turn.emitText` 开头清掉 `this.denied`；
  4. `#runTurn` 里 `turn.flushText()` 之后：`turn.denied` 还在、并且这期间没有新的客户端工具调用时，抛出 `AgentTurnError`。

  `fork/patch-e2e.mjs` 的两个 denied 用例可以验证这几处接得对不对。
- 并行通道（`Parallel lanes (local patch)`），挂在六个位置：
  1. `acquireProcLocked` 前面的整段 helper（`LANE_TAG` 到 `heldFor`）；
  2. `acquireProcLocked` 开头用 `pickLane` 取 `existing` 和 `key`（原来是 `pool.get(convKey)`，`key` 原来在后面才 `let key = convKey`，那一行已删）；
  3. 同一函数里，上游 `lineageVerdict` 那段之前插入的 `laneWanted` 分支，以及上游 `superseded` 事件后面的 `noteSuperseded`；`findLiveContinuedProc` 的条件多了 `key === convKey`，`why` 先取 `laneWhy`，`takeParked` 用 `key`；
  4. `recoverStaleTurn` 里 `current` 按 `ctx.proc.convKey` 取，重放时带 `laneKey`；
  5. fetch 里 Retry attach 的入口：在整组通道里找正在跑的那一轮；
  6. fetch 里 409 分支的 `held` 改用 `heldFor(convKey, acquireOpts, resultBlocks)`。

  `fork/patch-e2e.mjs` 的四个 lanes 用例可以验证；设 `LANES_PROBE=1` 再跑这几个用例，它们应该失败（409、503、409），说明用例确实能抓到上游行为。上游测试经 `test/testkit.mjs` 跑，那里的环境变量是隔离的；分叉在 testkit 里放行了 `AGY_BRIDGE_VIDEO`、`AGY_BRIDGE_MAX_LANES`、`AGY_BRIDGE_THINKING_WHEN_DISABLED` 三个开关（用例自己的 `env` 优先），`fork/fork.sh test` 跑上游测试时把它们都设成上游行为。上游 0.1.106 的 `test/unmatched-results.mjs` 要求“对方正在出流时，对不上的工具结果回 503”，并行通道打开时这里会开通道重放（200），所以上游测试要在 `AGY_BRIDGE_MAX_LANES=1` 下跑。改 `test/testkit.mjs` 的那几行合并上游时可能冲突，按原样接回。
- thinking 关闭时照样转发思考（`Thinking when disabled (local patch)`），挂在两个位置：
  1. `makeAnthropicStream` 前面的 `thinkingWhenDisabled()`；
  2. `makeAnthropicStream` 开头 `forwardThinking` 的条件：`body.thinking?.type !== "disabled"` 之外再加 `|| thinkingWhenDisabled()`。

  `fork/patch-e2e.mjs` 的两个 thinking 用例可以验证。上游 `test/smoke.mjs` 检查 disabled 时不出思考，所以 `fork/fork.sh test` 跑上游测试时设了 `AGY_BRIDGE_THINKING_WHEN_DISABLED=0`。
- 解决原则：上游的改动全部保留，再把上面这些位置接回去。上游如果改了函数名或结构，就按新结构找等价的位置。
- 解决完执行 `git add -A && git commit --no-edit`，再跑 `fork/fork.sh test`。

测试判定：

- 先跑 `fork/video-selfcheck.mjs` 和 `fork/patch-e2e.mjs`（补丁打开时的端到端测试，用 testkit 的假 agy，几秒钟就跑完），再在 `AGY_BRIDGE_VIDEO=0`、`AGY_BRIDGE_MAX_LANES=1`、`AGY_BRIDGE_THINKING_WHEN_DISABLED=0` 下跑上游的 `bun test`，要 2–3 分钟，用后台跑，不要干等。
- `fork/patch-e2e.mjs` 不能改名为 `*.test.mjs`，否则 `bun test` 会在视频关闭的状态下把它扫进去跑，导致失败。
- 有失败时，脚本会在同一环境对照上游快照再跑一遍。只有上游快照通过、我们这边失败的用例才算补丁引入的问题。
- 本机 `re2-pattern-unit` 会因为 Go 工具链版本不匹配而失败，上游快照也一样，算环境问题。

## 3. 发布

先看一遍 `git diff main...sync/<版本>`，然后：

```sh
git switch main && git merge --ff-only sync/<版本>
fork/fork.sh release
```

这会打 `v<上游版本>-video.<n>` 标签，推送 main、upstream 和标签，并创建 GitHub Release，附上 `npm pack` 打的包。

如果 main 已经推到 GitHub、Actions 也装好了，推送 main 后 `release.yml` 会自动发布，就不用再本地执行 `release`。

## 4. 部署到 Magpie

### ecomspy 上批量升级（12 个容器）

装了 agy-cli 的容器名单，和 2026-11-17 各容器登录的账号，记在 `/Users/cuican/Downloads/python/magpie-agy/memory/environment.md`。动手前要重新清点一遍：只有 webtop 容器里有 `abc` 用户，看 `/config/.local/bin/magpie plugin list --json` 里有没有 `agy-cli-auth`。

`fork/swap-agy-cli.sh <新spec>` 在容器里以 abc 身份运行，它会：

- 备份插件配置，rm 旧来源，add 新来源。add 失败时自动把旧来源装回去。
- 检查四项：来源对不对、登录状态和换之前是否一致、四处补丁是否都在（按 Video、Retry attach、Denied ending、Parallel lanes、Thinking when disabled 五种标记数）、插件进程是否重启（最多等 60 秒）。
- 任何一项不符就以非 0 退出。

```sh
scp fork/swap-agy-cli.sh ecomspy:/tmp/ && ssh ecomspy 'NEW="github:ifccod/opencode-agy-cli-auth#<tag>"
for c in <容器…>; do
  docker cp /tmp/swap-agy-cli.sh $c:/tmp/ && docker exec $c chmod 755 /tmp/swap-agy-cli.sh
  line=$(docker exec -u abc -e HOME=/config $c /tmp/swap-agy-cli.sh "$NEW"); code=$?
  docker exec $c rm -f /tmp/swap-agy-cli.sh; echo "$c [$code] $line"
  [ $code = 0 ] || break
done'
```

逐台串行执行，出问题就停下。先单独跑一台验证，再跑剩下的。插件进程重启时会打断这台容器上正在进行的 agy-cli 请求。

台数多时，把上面的循环写成宿主机上的脚本，用 `nohup` 在后台跑，日志写到 `/tmp/agy-rollout.log`，最后一行是 `ALLDONE` 或 `STOPPED`；本机轮询这个日志就行。直接在 ssh 里跑长循环，本机的工具一旦转到后台，命令可能一次都没执行。跑完删掉宿主机上的 `/tmp/agy-rollout.sh`、`/tmp/swap-agy-cli.sh`。

### 单台

已在本机和 ecomspy 的 `wt-default-codingart-5` 上验证过（2026-11-17）：

```sh
# 先备份 ~/.config/magpie 下的 plugin-auth.json、plugins.json、plugins.yml、plugin-providers.json、plugins/package.json
magpie plugin rm <旧 spec>          # 旧 spec 可以是 @magpie-community/opencode-agy-cli-auth@latest，也可以是 github:…#<旧tag>
magpie plugin add "github:ifccod/opencode-agy-cli-auth#<新tag>"
magpie plugin                        # agy-cli 应该仍然是 signed in
```

- 登录信息按 provider id `agy-cli` 存在 `plugin-auth.json` 里，换安装来源不会丢。
- 插件固定在某个 tag 上，`magpie plugin update` 不会自动升级。升级就按上面的步骤，先 rm 旧来源，再 add 新 tag。
- 正在运行的网关会自己重启插件进程，加载新代码，不用重启 Magpie 服务。可以看 `plugin-host` 进程的启动时间来确认。

- ecomspy 容器的操作规矩（用 abc 用户、`/config/.local/bin/magpie`、改完还原属主）见 `/Users/cuican/Downloads/python/magpie-agy/AGENTS.md`。
- 在容器里执行时用 `docker exec -u abc -e HOME=/config <容器> bash -c '…'`，命令里一律写绝对路径 `/config/.local/bin/magpie`。`bash -lc` 会重置 PATH，裸写 `magpie` 会跑到镜像自带的旧版 0.1.3369。
- 部署完的验证用 `/Users/cuican/Downloads/python/magpie-agy/memory/video-input.md` 里的测试法：用 OpenAI 协议的 `image_url` 发 `data:video/mp4;base64` 或公网链接，看能不能答出画面内容和人声。
- 换安装来源前先确认登录还在：`magpie plugin` 里 `agy-cli` 应该显示 `signed in`。

## 5. 自动化

- `.github/workflows/upstream-sync.yml`：每 6 小时跑一次 check；有新版本时，执行 sync 并开 PR。合并干净且测试通过就自动合并（merge commit）、用 `gh workflow run release.yml` 发版（Actions 自己推 main 不会触发 release），并关掉旧的 sync PR。有冲突时，把冲突标记原样提交进 PR，PR 正文里写明需要处理什么。部署到容器不自动，按第 4 节做。
- `.github/workflows/release.yml`：main 上的插件文件有变化时，自动 test + release。
- `.github/workflows/test.yml`：PR 上有人推了提交时，跑测试并检查冲突标记。解决冲突后，等它变绿再合并。
- 交给 AI（ChatGPT dots、Codex）处理时，只让它在 sync PR 上工作：解决冲突、补测试、合并。它不需要服务器权限，GitHub 授权也只给这一个仓库。
