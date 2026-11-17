#!/usr/bin/env bash
# 维护 agy-cli 分叉。上游：magpie-community/plugins 的 packages/agy-cli。
#
#   fork/fork.sh check          上游有没有新版本（有：退出码 10，并列出提交和改到的文件）
#   fork/fork.sh import [ref]   把上游 ref（默认 main）的 packages/agy-cli 原样快照提交到 upstream 分支
#   fork/fork.sh sync [ref]     import，然后在 sync/<版本> 分支上合并 upstream，并跑测试
#   fork/fork.sh test           上游测试 + 视频补丁自检
#   fork/fork.sh release        在 main 上打 v<版本>-video.<n> 标签，推送，发 GitHub Release（附 npm pack 包）
#
# upstream 分支只放上游原样快照，每个提交的标题是 "upstream agy-cli <版本> (magpie-community/plugins@<sha>)"；
# main = 上游快照 + 我们的补丁。合并上游就是普通的 git 三方合并。
set -euo pipefail

UP_REPO=magpie-community/plugins
UP_DIR=packages/agy-cli
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

die() { echo "fork.sh: $*" >&2; exit 1; }

json_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1; }

# The agy-cli version at an upstream commit.
upstream_version() {
  gh api "repos/$UP_REPO/contents/$UP_DIR/package.json?ref=$1" --jq .content | base64 --decode | json_version
}

# "<version> <sha>" of the last snapshot on the upstream branch, empty before the first.
imported() {
  git log -1 --format=%s upstream 2>/dev/null | sed -n 's/^upstream agy-cli \([^ ]*\) (.*@\([0-9a-f]*\))$/\1 \2/p'
}

check() {
  local have="" have_sha="" new_sha new
  read -r have have_sha <<<"$(imported)" || true
  new_sha=$(gh api "repos/$UP_REPO/commits/main" --jq .sha)
  new=$(upstream_version "$new_sha")
  echo "已导入: ${have:-无} ${have_sha:0:9}   上游 main: $new ${new_sha:0:9}"
  [ "$have" = "$new" ] && { echo "已是最新"; return 0; }
  echo
  echo "上游 agy-cli 的新提交："
  gh api "repos/$UP_REPO/commits?path=$UP_DIR&per_page=50" \
    --jq '.[] | .sha + " " + (.commit.message | split("\n")[0])' |
    while read -r sha msg; do
      [ -n "$have_sha" ] && [ "$sha" = "$have_sha" ] && break
      echo "  ${sha:0:9} $msg"
    done
  if [ -n "$have_sha" ]; then
    echo
    echo "改到的文件："
    gh api "repos/$UP_REPO/compare/$have_sha...$new_sha" \
      --jq ".files[] | select(.filename | startswith(\"$UP_DIR/\")) | \"  \" + .status + \" \" + (.filename | ltrimstr(\"$UP_DIR/\")) + \" +\" + (.additions|tostring) + \" -\" + (.deletions|tostring)"
    echo "（我们的补丁只改 index.mjs；它改动多时合并可能有冲突。）"
  fi
  return 10
}

import_ref() {
  local ref=${1:-main} sha ver wt
  sha=$(gh api "repos/$UP_REPO/commits/$ref" --jq .sha)
  ver=$(upstream_version "$sha")
  git fetch -q --depth=1 upstream "$sha"
  wt=$(mktemp -d)
  if git rev-parse -q --verify refs/heads/upstream >/dev/null; then
    git worktree add -q "$wt" upstream
  else
    git worktree add -q --orphan -b upstream "$wt"
  fi
  git -C "$wt" rm -rq --ignore-unmatch . >/dev/null
  git archive "$sha" "$UP_DIR" | tar -x -C "$wt" --strip-components=2
  git -C "$wt" add -A
  if git -C "$wt" diff --cached --quiet; then
    echo "upstream 分支已经是 agy-cli $ver，没有新快照"
  else
    git -C "$wt" commit -qm "upstream agy-cli $ver ($UP_REPO@$sha)"
    echo "已导入上游 agy-cli $ver (${sha:0:9}) 到 upstream 分支"
  fi
  git worktree remove --force "$wt"
}

fails() { grep -E '^\(fail\)' "$1" | sed 's/ \[[0-9.]*m*s\]$//' | sort -u; }
fail_count() { local n; n=$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$1" | tail -1); echo "${n:-0}"; }

# Upstream tests with the video patch off (AGY_BRIDGE_VIDEO=0: the plugin must
# then behave as upstream's, and upstream's tests say so; smoke.mjs checks
# "tools: []"), plus the video selfcheck for the patch itself. A failure counts
# only when the upstream snapshot passes it in the same environment (a missing
# or mismatched Go fails both).
run_tests() {
  command -v bun >/dev/null || die "需要 bun（上游测试用 bun test）"
  node fork/video-selfcheck.mjs
  local log base wt added
  log=$(mktemp)
  echo "bun test（约 2–3 分钟）…"
  AGY_BRIDGE_VIDEO=0 bun test >"$log" 2>&1 || true
  grep -E '^ *[0-9]+ (pass|fail)$' "$log" || true
  [ -z "$(fails "$log")" ] && [ "$(fail_count "$log")" = 0 ] && return 0
  echo "有失败，对照上游快照在同一环境再跑一遍…"
  wt=$(mktemp -d)
  git worktree add -q --detach "$wt" upstream
  base=$(mktemp)
  (cd "$wt" && bun test >"$base" 2>&1) || true
  git worktree remove --force "$wt"
  added=$(comm -23 <(fails "$log") <(fails "$base"))
  if [ -n "$added" ] || [ "$(fail_count "$log")" -gt "$(fail_count "$base")" ]; then
    echo "补丁引入的失败："
    echo "${added:-（数量多于上游：$(fail_count "$log") > $(fail_count "$base")）}"
    echo "完整输出：$log"
    return 1
  fi
  echo "这些失败上游快照也有，算环境问题，不算补丁引入："
  fails "$log"
}

sync() {
  import_ref "${1:-main}"
  local ver branch
  ver=$(imported | cut -d' ' -f1)
  branch="sync/$ver"
  git diff --quiet && git diff --cached --quiet || die "工作区不干净，先提交或暂存"
  git switch -q main
  if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then git switch -q "$branch"; else git switch -q -c "$branch"; fi
  if ! git merge --no-edit upstream; then
    echo
    echo "合并有冲突（见上）。解决后 git add + git commit，再跑 fork/fork.sh test。"
    echo "冲突里搜 videoOn / mediaDir / dropReadVideo / videoizeBody，就是我们的补丁。"
    exit 1
  fi
  run_tests
  echo
  echo "合并干净，测试通过。看过 git diff main...$branch 后："
  echo "  git switch main && git merge --ff-only $branch && fork/fork.sh release"
}

release() {
  [ "$(git branch --show-current)" = main ] || die "在 main 分支上发布"
  git diff --quiet && git diff --cached --quiet || die "工作区不干净"
  if git describe --exact-match --tags --match 'v*-video.*' HEAD >/dev/null 2>&1; then
    echo "HEAD 已经发布过：$(git describe --exact-match --tags --match 'v*-video.*' HEAD)"; return 0
  fi
  run_tests
  local ver n tag dir tgz slug
  ver=$(json_version < package.json)
  n=1
  while git rev-parse -q --verify "refs/tags/v$ver-video.$n" >/dev/null; do n=$((n + 1)); done
  tag="v$ver-video.$n"
  slug=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  git tag -a "$tag" -m "$tag"
  git push origin main upstream "$tag"
  dir=$(mktemp -d)
  npm pack --silent --pack-destination "$dir" >/dev/null
  tgz=$(ls "$dir"/*.tgz)
  gh release create "$tag" "$tgz" --title "$tag" --notes "agy-cli $ver（上游）+ 视频输入补丁，第 $n 版。

安装（Magpie）：
\`\`\`
magpie plugin add github:$slug#$tag
\`\`\`
改了什么、怎么用：见 FORK.md。"
  echo "已发布 $tag"
}

case "${1:-}" in
  check) check ;;
  import) import_ref "${2:-main}" ;;
  sync) sync "${2:-main}" ;;
  test) run_tests ;;
  release) release ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
