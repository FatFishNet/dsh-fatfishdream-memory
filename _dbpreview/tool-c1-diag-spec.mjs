/**
 * 查清 C1-A 失败的真正原因：`missing 2071` 到底是谁。
 *
 * ## 背景
 *
 * turn 8 那次 C1-A 真实触发了，但 session.append(..., surfaceOp replace)
 * 被 DSH 拒绝：
 *
 *     surface replace: sourceEventSeqs must include every shadowed surface node; missing 2071
 *
 * 官方契约里有一处**自相矛盾**：
 *   · SurfaceIntent 的 assistant/message 分支写着 sourceEventSeqs: never
 *   · 而 SurfaceOp 又说 replace 的节点 must include every shadowed surface node
 *
 * ## 这个脚本干什么
 *
 * **只读**。把当前真实库里那个报错 turn 的归档形态打出来，
 * 并打印「要加进 turn-stopping 的只读探针」的规格。
 *
 * 它能回答的问题有限 —— 2071 是运行时 seq，库里不存 seq（archive 表没有 seq 列）。
 * 所以真正的答案要靠探针在运行时取。这里先把能确定的部分固定下来。
 */
import { DatabaseSync } from 'node:sqlite'

const SPEC = [
  '=== C1-A 诊断探针规格 ===',
  '',
  '要加进 turn-stopping 的只读代码（绝不 append）：',
  '',
  '  const session = agent?.session',
  '  if (typeof session?.snapshotEvents === "function") {',
  '    const events = session.snapshotEvents() ?? []',
  '    const surfaceNodes = session.surface?.nodes ?? []',
  '    const nodeSet = new Set(surfaceNodes)',
  '',
  '    const mine = events.filter((e) => e.type === "assistant/message" && e.data?.turn === turn)',
  '    const target = events.find((e) => e.seq === 2071)',
  '',
  '    diag("c1-diag", {',
  '      turn,',
  '      mineSeqs: mine.map((e) => e.seq),',
  '      mineInSurface: mine.map((e) => nodeSet.has(e.seq)),',
  '      seq2071Type: target?.type ?? null,',
  '      seq2071Turn: target?.data?.turn ?? null,',
  '      seq2071InSurface: target ? nodeSet.has(target.seq) : null,',
  '      surfaceTail: surfaceNodes.slice(-8),',
  '      replaceGeneration: session.surface?.replaceGeneration ?? null,',
  '    })',
  '  }',
  '',
  '## 关键判据',
  '',
  '看 seq2071InSurface：',
  '  · true  → 2071 是 surface 节点，确实被 replace 区间遮蔽了，',
  '            而我传的 startSeq=endSeq 只覆盖一个节点 → 区间算错了',
  '  · false → 2071 不是 surface 节点，那错误信息里的 surface node 另有含义',
  '',
  '再看 mineSeqs 与 mineInSurface：',
  '  · 若同 turn 有多条 assistant/message 都在 surface 里，',
  '    那单点替换必然只遮蔽一个、漏掉其它的',
].join('\n')

console.log(SPEC)

console.log('\n=== 真实库里那个报错 turn 的 assistant 归档 ===')
try {
  const db = new DatabaseSync('D:\\dsh-fatfishdream-memory\\memory.db', { readOnly: true })
  const rows = db
    .prepare(
      `SELECT id, step, ts, length(text) AS len, substr(text, -40) AS tail
       FROM archive
       WHERE role='assistant' AND turn=8
       ORDER BY id`,
    )
    .all()
  for (const r of rows) {
    console.log(`  id=${r.id} step=${r.step} len=${r.len} ts=${r.ts}`)
    console.log(`    尾: ${String(r.tail).replace(/\n/g, ' ')}`)
  }
  console.log(`\n（archive 表没有 seq 列，所以 2071 的具体身份只能在运行时取）`)
  db.close()
} catch (e) {
  console.log('读库失败：' + e.message)
}
