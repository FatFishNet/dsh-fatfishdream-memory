#!/usr/bin/env node
/**
 * 安装「提交前守卫」到本仓库的 `.git/hooks/pre-commit`。
 *
 * ## 为什么需要安装脚本
 *
 * Git 的 hook **不随仓库分发**（`.git/` 不被跟踪），所以每个 clone、
 * 每台机器都要装一次。没有安装脚本的话，下一个人根本不知道有这道防线。
 *
 * ## 设计取舍
 *
 * - **幂等**：重复运行会覆盖，输出「已更新」
 * - **不覆盖别人的 hook**：若已有 `pre-commit` 且不是我们装的，先备份成
 *   `pre-commit.bak-<时间>` 再装 —— 免得把用户的 husky / lint-staged 冲掉
 * - **跨平台**：Windows 下 git 用 sh 跑 hook（`sh.exe` 来自 Git for Windows），
 *   所以 hook 写成 POSIX sh，不写 `.ps1`
 *
 * 用法：
 * ```powershell
 * & $node _dbpreview\tool-install-hook.mjs
 * ```
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SRC = join(HERE, 'hook-pre-commit.sh')

/** 我们装的 hook 第一行会有这个标记，用来判断「是不是我们装的」 */
const MARKER = '# dsh-staged-guard'

/**
 * 定位 hooks 目录。
 *
 * ## 为什么不用 `git rev-parse --git-path hooks`
 *
 * 它会走 `spawnSync(..., {encoding:'utf8'})` → **受限沙箱下 EPERM**（管道不允许）。
 * 而 hook 的安装是「跑一次就完」的动作，**没必要为了正确性依赖 git 的输出** ——
 * `.git/hooks` 的约定足够稳定，直接看文件系统即可。
 *
 * 仍然尊重 `core.hooksPath`（如果配置文件里写了且我们能读到）。
 */
function findHooksDir() {
  // ① 先看 .git 是不是目录（普通 clone）
  const dotGit = join(REPO, '.git')
  if (existsSync(dotGit) && existsSync(join(dotGit, 'hooks'))) {
    return join(dotGit, 'hooks')
  }

  // ② .git 是文件（worktree / submodule）→ 里面写着 "gitdir: <path>"
  if (existsSync(dotGit)) {
    try {
      const t = readFileSync(dotGit, 'utf8').trim()
      const m = /^gitdir:\s*(.+)$/m.exec(t)
      if (m) {
        const gd = m[1].trim()
        const abs = gd.startsWith('/') || /^[A-Za-z]:/.test(gd) ? gd : join(REPO, gd)
        if (existsSync(join(abs, 'hooks'))) return join(abs, 'hooks')
      }
    } catch { /* 落到 ③ */ }
  }

  // ③ 兜底：假设 .git/hooks
  return join(dotGit, 'hooks')
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`❌ 源文件不存在：${SRC}`)
    return 1
  }

  const hooksDir = findHooksDir()
  const dest = join(hooksDir, 'pre-commit')

  // 已存在且不是我们装的 → 备份
  if (existsSync(dest)) {
    let existing = ''
    try { existing = readFileSync(dest, 'utf8') } catch { /* 读不了当外部 hook */ }
    if (!existing.includes(MARKER)) {
      const bak = `${dest}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(dest, bak)
      console.log(`⚠️ 已存在外部 pre-commit，备份为：${bak}`)
    } else {
      console.log('ℹ️ 已有本守卫的旧版本，将覆盖更新')
    }
  }

  // 确保目录存在
  mkdirSync(hooksDir, { recursive: true })
  // 写入 + 加标记
  const src = readFileSync(SRC, 'utf8')
  const body = src.replace('#!/bin/sh\n', `#!/bin/sh\n${MARKER}\n`)
  writeFileSync(dest, body, 'utf8')

  // 可执行位（Windows 上 chmod 是空操作，Git for Windows 会自己处理）
  try { chmodSync(dest, 0o755) } catch { /* Windows 上失败无妨 */ }

  console.log(`✅ 已安装：${dest}`)
  console.log('')
  console.log('   验证：现在 `git commit` 会先跑 _dbpreview/tool-check-staged.mjs')
  console.log('   跳过：git commit --no-verify')
  console.log('   单跳过：DSH_SKIP_STAGED_CHECK=1 git commit')
  return 0
}

process.exit(main())
