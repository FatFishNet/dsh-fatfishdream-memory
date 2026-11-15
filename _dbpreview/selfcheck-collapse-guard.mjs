/**
 * 回归测试：`isSafeToCollapse` 的判据是否真的能挡住「隐藏在滚动容器里」。
 *
 * ## 为什么有这个脚本（2026-11-15）
 *
 * 用户报：「每次改动功能，全局 skills 的滚动条都失效」。
 * 根因是擦除器给「擦完只剩空白」的元素打 `data-dsh-mem-blank`，
 * 而配套是一条**全局** CSS `display: none !important` —— 无法覆盖。
 * 旧判据只有 `el !== document.body`，于是滚动容器里的子元素被隐藏后，
 * 容器 scrollHeight 塌成 0，滚动条消失。
 *
 * 修复是在打标记前加 `isSafeToCollapse` 守卫。本脚本验证那个守卫。
 *
 * ## 方法：不启动浏览器，用最小 DOM 替身
 *
 * 判据只依赖 tagName / getComputedStyle / getBoundingClientRect，
 * 三者都能被替身模拟。脚本**从 client.js 源码里抽取函数体**再执行
 * （不是复制一份逻辑）—— 这样源码改了，测试跟着变，不会脱节。
 *
 * ⚠️ 如果将来判据依赖了别的浏览器 API（如 IntersectionObserver），
 *    这个替身就挡不住了，届时必须改成真浏览器测试（Playwright 之类）。
 */
import fs from 'node:fs'

// ---- 最小 DOM 替身 ----
function makeEl(tag, { overflowY = 'visible', h = 0, w = 0, parent = null, children = [], maxHeight = 'none', height = 'auto' } = {}) {
  const el = {
    tagName: tag,
    parentElement: parent,
    children,
    _overflowY: overflowY,
    _rect: { height: h, width: w },
    _maxHeight: maxHeight,
    _height: height,
    getBoundingClientRect() { return this._rect },
  }
  return el
}

const document = { body: makeEl('BODY'), documentElement: makeEl('HTML') }

function getComputedStyle(el) {
  const oy = el._overflowY ?? 'visible'
  return {
    overflowY: oy,
    overflow: oy === 'visible' ? 'visible' : oy,
    maxHeight: el._maxHeight ?? 'none',
    height: el._height ?? 'auto',
  }
}

// ---- 从 client.js 抽取判据（保持与源码一致）----
const src = fs.readFileSync('dsh-fatfishdream-memory/client.js', 'utf8')
const m = src.match(/function isSafeToCollapse\(el\) \{[\s\S]*?\n    \}/)
if (!m) { console.log('❌ 从源码抽取 isSafeToCollapse 失败'); process.exit(1) }

// eslint-disable-next-line no-new-func
const isSafeToCollapse = new Function('document', 'getComputedStyle', `
  ${m[0]}
  return isSafeToCollapse
`)(document, getComputedStyle)

let pass = 0, fail = 0
const check = (name, got, want) => {
  if (got === want) { pass++; console.log(`✅ ${name}`) }
  else { fail++; console.log(`❌ ${name}  期望 ${want}，实际 ${got}`) }
}

// ---- 用例 1：对话区里的普通段落（应允许隐藏）----
{
  const conversation = makeEl('DIV', { overflowY: 'visible' })
  const wrap = makeEl('DIV', { parent: conversation })
  const p = makeEl('P', { parent: wrap })
  check('对话区里的空 <p> → 允许隐藏', isSafeToCollapse(p), true)
}

// ---- 用例 2：滚动容器里的元素（必须拒绝 —— 本次事故场景）----
{
  const scrollHost = makeEl('DIV', { overflowY: 'auto' })
  const inner = makeEl('DIV', { parent: scrollHost })
  const p = makeEl('P', { parent: inner })
  check('滚动容器（overflow:auto）内的空 <p> → 拒绝', isSafeToCollapse(p), false)
}
{
  const scrollHost = makeEl('DIV', { overflowY: 'scroll' })
  const p = makeEl('P', { parent: scrollHost })
  check('滚动容器（overflow:scroll）内的空 <p> → 拒绝', isSafeToCollapse(p), false)
}

// ---- 用例 3：布局骨架标签（必须拒绝）----
for (const tag of ['MAIN', 'SECTION', 'UL', 'TABLE', 'NAV', 'ASIDE', 'HEADER', 'FOOTER']) {
  const el = makeEl(tag)
  check(`<${tag.toLowerCase()}> 即使为空 → 拒绝`, isSafeToCollapse(el), false)
}

// ---- 用例 4：有尺寸的块（被 flex/grid 撑开的占位）----
{
  const el = makeEl('DIV', { h: 40, w: 200 })
  check('有 40px 高度的空 <div> → 拒绝（是布局占位）', isSafeToCollapse(el), false)
}
{
  const el = makeEl('SPAN', { h: 2, w: 30 })
  check('只有行高（h=2）的空 <span> → 允许', isSafeToCollapse(el), true)
}

// ---- 用例 5：<br> 例外 ----
{
  const br = makeEl('BR', { h: 18, w: 0 })
  check('<br> 有行高但 0 宽 → 允许（天然如此）', isSafeToCollapse(br), true)
}

// ---- 用例 6：深层祖先里的滚动容器也要被找到 ----
{
  const scrollHost = makeEl('DIV', { overflowY: 'auto' })
  let cur = scrollHost
  for (let i = 0; i < 5; i++) cur = makeEl('DIV', { parent: cur })
  const p = makeEl('P', { parent: cur })
  check('滚动容器在 5 层祖先之上 → 仍拒绝', isSafeToCollapse(p), false)
}

// ---- 用例 7：限高 + overflow:hidden 的裁剪容器也要拒绝 ----
//
// 2026-11-15 补：不是所有滚动都靠 overflow:auto。
// 有些容器用 max-height/height + overflow:hidden 做裁剪，
// 内部元素显隐同样会改变可见区，必须一并拒绝。
{
  const clipHost = makeEl('DIV', { overflowY: 'hidden', maxHeight: '300px' })
  const p = makeEl('P', { parent: clipHost })
  check('限高(max-height)+overflow:hidden 的容器内 → 拒绝', isSafeToCollapse(p), false)
}
{
  const clipHost = makeEl('DIV', { overflowY: 'hidden', height: '400px' })
  const p = makeEl('P', { parent: clipHost })
  check('固定 height+overflow:hidden 的容器内 → 拒绝', isSafeToCollapse(p), false)
}

// ---- 用例 8：普通（不限高、不裁剪）的祖先不应误伤 ----
{
  const normal = makeEl('DIV', { overflowY: 'visible' })
  const inner = makeEl('DIV', { parent: normal })
  const p = makeEl('P', { parent: inner })
  check('普通祖先（visible、不限高）内的空 <p> → 允许', isSafeToCollapse(p), true)
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
