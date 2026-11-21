/**
 * 子进程输出捕获 —— 限制模式（沙箱）安全版。
 *
 * ## 为什么需要它（2026-11-15 实测）
 *
 * 受限文件权限（`workspace-write` / `read-only`）下，程序**不能开命名管道**。
 * 而 `spawnSync(cmd, args, { encoding: 'utf8' })` 的默认 `stdio` 就是 `'pipe'`，
 * 于是直接得到：
 *
 *     r.error  = { code: 'EPERM' }
 *     r.status = null
 *     r.stdout = null
 *
 * 这本身不是错误 —— 但调用方若写成 `const code = r.status ?? -1`，
 * 就会把「**根本没跑起来**」当成「**跑了并失败**」。
 *
 * `run-all.mjs` 正是这样报出过 `TOTAL=32 FAIL=32`，
 * 而同一时刻用 pwsh 循环跑，基线是 **32/32 全绿**。
 * 那条假红会让下一个会话误判「插件全崩了」，然后去修一个不存在的问题。
 *
 * ## 边界（8 种方式实测，2026-11-15）
 *
 *     pipe + encoding（run-all 原用法）   EPERM
 *     pipe 跑 cmd.exe                     EPERM   ← 不是 node 特有，任何程序都一样
 *     execSync                            EPERM
 *     execFileSync                        EPERM
 *     spawnSync 带 input                  EPERM   ← 要写管道也一样
 *     stdio: 'inherit'                    OK（但捕获不到输出）
 *     stdio: 'ignore'                     OK（**exit code 仍然准确**）
 *     stdio: [ignore, fd, fd]             OK（重定向到临时文件，**完整捕获**）
 *
 * 结论：**只有「捕获输出」被禁**，退出码本身完全可用。
 * 所以退路很直接 —— 把子进程的 stdout/stderr 指到一个临时文件，读完删掉。
 *
 * ## 用法
 *
 *     import { runCaptured, isPipeDenied } from './lib-spawn-capture.mjs'
 *     const r = runCaptured(['_dbpreview/run-all.mjs'], { timeout: 240000 })
 *     // r.status       真实退出码（null 表示压根没启动）
 *     // r.stdout       pipe 模式是 stdout；file 模式是 stdout+stderr 合并
 *     // r.captureMode  'pipe' | 'file' —— 便于日志里说明走的是哪条路
 *     // r.error        仅有启动失败时存在
 *
 * ⚠️ **不要**再用 `r.status ?? -1` 把「没启动」归进失败计数。
 *    这正是当初那条假红的成因。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 是否是「管道被沙箱拒绝」这一类错误（区别于真正的启动失败） */
export function isPipeDenied(err) {
  return !!err && (err.code === 'EPERM' || err.code === 'EACCES')
}

/** 给调用方展示的环境提示（调用方决定打印时机，本模块不直接输出） */
export const PIPE_DENIED_HINT =
  '受限沙箱不允许捕获子进程输出（EPERM / 命名管道）。' +
  '已自动退回临时文件捕获；若这里仍失败，说明是环境限制，不是测试失败。'

/**
 * 跑一个 node 脚本并捕获输出。
 *
 * @param {string[]} nodeArgs  传给 node 的参数（第一个通常是脚本路径）
 * @param {{ cwd?: string, timeout?: number, env?: NodeJS.ProcessEnv, execPath?: string }} [opts]
 *        `execPath` 默认 `process.execPath`。**不要传字面量 'node'** ——
 *        本机 node 不在 PATH（见 AGENTS.md），那会导致「一个都没跑成却报 100% 成功」。
 * @returns {{ status: number|null, signal: string|null, stdout: string, stderr: string,
 *             error: (Error & { code?: string })|null, captureMode: 'pipe'|'file' }}
 */
export function runCaptured(nodeArgs, opts = {}) {
  const execPath = opts.execPath ?? process.execPath
  const base = {
    cwd: opts.cwd ?? process.cwd(),
    timeout: opts.timeout ?? 120000,
    env: opts.env ?? process.env,
  }

  // ① 先试正常管道（全权限下走这条，行为与以前完全一致）
  const first = spawnSync(execPath, nodeArgs, { ...base, encoding: 'utf8' })
  if (!first.error) {
    return { ...first, stdout: first.stdout ?? '', stderr: first.stderr ?? '', captureMode: 'pipe' }
  }
  if (!isPipeDenied(first.error)) {
    // 不是管道被拒（例如 ENOENT / 超时），原样交给调用方判断，不做掩盖
    return { ...first, stdout: first.stdout ?? '', stderr: first.stderr ?? '', captureMode: 'pipe' }
  }

  // ② 管道被拒 → 退回临时文件捕获
  const tmp = path.join(
    os.tmpdir(),
    `dsh-capture-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`,
  )
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    const second = spawnSync(execPath, nodeArgs, { ...base, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    fd = null

    let captured = ''
    try {
      captured = fs.readFileSync(tmp, 'utf8')
    } catch {
      // 读不到就保持空串：此时 second.status 仍然可信，调用方据此判断
    }
    return {
      status: second.status,
      signal: second.signal ?? null,
      // file 模式下两股输出合并到一个 fd，无法再区分
      stdout: captured,
      stderr: '',
      error: second.error ?? null,
      captureMode: 'file',
    }
  } catch (e) {
    // 连临时文件都开不了：这是基础设施失败，必须让调用方看见
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: e,
      captureMode: 'file',
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch { /* 已关闭 */ }
    }
    try { fs.unlinkSync(tmp) } catch { /* 没建出来或已被删 */ }
  }
}
