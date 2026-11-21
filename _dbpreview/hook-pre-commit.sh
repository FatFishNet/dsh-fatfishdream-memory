#!/bin/sh
#
# 提交前守卫 —— 拦住不该进公开仓库的东西（记忆库 / 备份 / 超大文件 / 本机用户名）。
#
# ## 安装
#
# 本文件由安装脚本复制到 `.git/hooks/pre-commit`，并 `chmod +x`。
# **它不进 git**（`.git/` 不被跟踪），所以每个 clone 都要装一次。
#
# ## 跳过方式
#
#   git commit --no-verify              ← 跳过所有 hook
#   DSH_SKIP_STAGED_CHECK=1 git commit  ← 只跳过这一个检查
#
# ## 为什么这里要自己找 node
#
# 本机 `node` **不在 PATH 里**（DSH 把它装在运行时目录下），
# 而那个目录含本机用户名（`C:\Users\<名字>\.dsh\...`）——
# **不能把它写死进这个文件**，否则守卫自己就成了路径泄露源。
# 所以按顺序探测，找不到就放行（并打印说明，不假装检查过）。

set -u

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
CHECKER="$REPO_ROOT/_dbpreview/tool-check-staged.mjs"

# 检查脚本本身不在（比如还没 checkout 出来）→ 放行，不阻断提交
[ -f "$CHECKER" ] || exit 0

# ---- 找 node ----
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  # DSH 运行时：从常见根目录探测，不写死用户名
  for base in "$HOME/.dsh" "$USERPROFILE/.dsh" "$LOCALAPPDATA/Programs"; do
    [ -n "$base" ] || continue
    for cand in \
      "$base/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
      "$base"/dsh-runtimes/*/dependencies/node/bin/node.exe
    do
      if [ -x "$cand" ]; then NODE_BIN="$cand"; break 2; fi
    done
  done
fi

# 找不到 node → 放行（守卫不该因为环境问题阻断所有提交）
if [ -z "$NODE_BIN" ]; then
  echo "[pre-commit] ⚠️ 找不到 node，跳过暂存区检查（这不是「检查通过」）"
  exit 0
fi

exec "$NODE_BIN" "$CHECKER"
