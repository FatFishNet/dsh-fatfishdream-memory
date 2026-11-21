/**
 * 最小 Node 全局 + 内置模块声明。
 *
 * 为什么手写而不是装 @types/node：
 *   这个项目**零依赖**是卖点（见 AGENTS.md 与 README）。
 *   为类型检查引入 @types/node 会带来 node_modules + lockfile，
 *   与「只该用 Node 内置模块」的设计相冲突。
 *
 * 边界（重要）：
 *   这里只声明插件**实际用到**的部分。用到新的就补一条，
 *   不要试图覆盖整个 Node API —— 那样迟早会和真实 @types/node 漂移，
 *   而且漂移是静默的（类型对不上只会报错，不会提醒你「声明过时了」）。
 *
 * 2026-11-15 加：没有 jsconfig 时 tsserver 只给 5 条「找不到 Buffer」的 Hint；
 * 开 checkJs 后，`node:fs` 等导入会报 TS2307（找不到模块），
 * 必须在这里补 declare module 才能把那批**假错误**消掉，
 * 让真正的问题（TS2353 / TS2339）露出来。
 */

// ---------------------------------------------------------------- 全局

/** 字节缓冲。插件里主要用 Buffer.byteLength 算 UTF-8 字节数。 */
declare class Buffer extends Uint8Array {
  static byteLength(input: string | Buffer | ArrayBuffer | ArrayBufferView, encoding?: string): number
  static from(input: string | ArrayBuffer | ArrayBufferView | number[], encoding?: string): Buffer
  static alloc(size: number, fill?: number): Buffer
  static concat(list: readonly Uint8Array[], totalLength?: number): Buffer
  static isBuffer(obj: unknown): boolean
  toString(encoding?: string, start?: number, end?: number): string
}

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined
  }
  interface Process {
    env: ProcessEnv
    argv: string[]
    cwd(): string
    exit(code?: number): never
    pid: number
    platform: string
    versions: Record<string, string>
    on(event: string, listener: (...args: any[]) => void): void
  }
}

declare var process: NodeJS.Process

// ---------------------------------------------------------------- 内置模块
//
// 用 `any` 而不是精确类型，是刻意的取舍：
//   精确声明文件系统的每个重载要几百行，而插件对 fs 的用法很窄。
//   这里的目标是**消掉 TS2307 假错误**，让 checkJs 的真收益（对象形状、
//   undefined 访问）能露出来，不是把整个 Node 类型化。
//   想更严格时，优先补**插件真正依赖的那几个函数签名**，别整体替换。

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string
  export function readFileSync(path: string): Buffer
  export function writeFileSync(path: string, data: string, encoding?: string): void
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void
  export function statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean }
  export function existsSync(path: string): boolean
  export function readdirSync(path: string, options?: { withFileTypes?: boolean }): any[]
  export function statfsSync(path: string): { bavail: number; bsize: number }
  export function createWriteStream(path: string, options?: any): any
  export function appendFileSync(path: string, data: string, encoding?: string): void
  const fs: any
  export default fs
}

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: string): Promise<string>
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  export function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>
  export function readdir(path: string, options?: { withFileTypes?: boolean }): Promise<any[]>
  export function stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean }>
  export function access(path: string): Promise<void>
  export function copyFile(from: string, to: string): Promise<void>
  export function rename(from: string, to: string): Promise<void>
  export function unlink(path: string): Promise<void>
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(p: string): string
  export function basename(p: string, ext?: string): string
  export function extname(p: string): string
  export function relative(from: string, to: string): string
  export function isAbsolute(p: string): boolean
  export function sep(): string
  const path: any
  export default path
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
  export function platform(): string
  export function cpus(): any[]
  export function totalmem(): number
  export function freemem(): number
  export function type(): string
  export function release(): string
}

declare module 'node:crypto' {
  export function createHash(algo: string): { update(data: string | Buffer): any; digest(enc: string): string }
  export function randomUUID(): string
  export function randomBytes(size: number): Buffer
}

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean })
    prepare(sql: string): {
      run(...params: any[]): { changes: number; lastInsertRowid: number | bigint }
      get(...params: any[]): any
      all(...params: any[]): any[]
    }
    exec(sql: string): void
    close(): void
  }
}
