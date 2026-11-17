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
- 解决原则：上游的改动全部保留，再把这 6 处接回去。上游如果改了函数名或结构，就按新结构找等价的位置。
- 解决完执行 `git add -A && git commit --no-edit`，再跑 `fork/fork.sh test`。

测试判定：

- 先跑 `fork/video-selfcheck.mjs`，再跑上游的 `bun test`，要 2–3 分钟，用后台跑，不要干等。
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

```sh
magpie plugin add github:ifccod/opencode-agy-cli-auth#<tag>
magpie plugin off @magpie-community/opencode-agy-cli-auth && magpie plugin on @magpie-community/opencode-agy-cli-auth
```

- ecomspy 容器的操作规矩（用 abc 用户、`/config/.local/bin/magpie`、改完还原属主）见 `/Users/cuican/Downloads/python/magpie-agy/AGENTS.md`。
- 部署完的验证用 `/Users/cuican/Downloads/python/magpie-agy/memory/video-input.md` 里的测试法：用 OpenAI 协议的 `image_url` 发 `data:video/mp4;base64` 或公网链接，看能不能答出画面内容和人声。
- 换安装来源前先确认登录还在：`magpie plugin` 里 `agy-cli` 应该显示 `signed in`。

## 5. 自动化

- `.github/workflows/upstream-sync.yml`：每 6 小时跑一次 check；有新版本时，执行 sync 并开 PR。有冲突时，把冲突标记原样提交进 PR，PR 正文里写明需要处理什么。
- `.github/workflows/release.yml`：main 上的插件文件有变化时，自动 test + release。
- 交给 AI（ChatGPT dots、Codex）处理时，只让它在 sync PR 上工作：解决冲突、补测试、合并。它不需要服务器权限，GitHub 授权也只给这一个仓库。
