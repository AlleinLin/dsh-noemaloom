import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where playwright-core lives, and which Chrome to drive.
 *
 * Both were absolute paths into one machine's checkout, so the script died with
 * ERR_MODULE_NOT_FOUND everywhere else. A checkout is not a place a script may
 * assume: the browser driver is resolved from the dsh checkout next to this
 * repository, and the browser itself from the environment, falling back to the
 * usual Linux install.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const playwrightCandidates = [
  process.env.PLAYWRIGHT_CORE,
  join(repoRoot, 'dsh', 'node_modules', 'playwright-core', 'index.mjs'),
  join(repoRoot, 'dsh', 'node_modules', '.pnpm', 'playwright-core@1.61.1', 'node_modules', 'playwright-core', 'index.mjs'),
].filter(path => path !== undefined)
const playwrightPath = playwrightCandidates.find(path => existsSync(path))
if (playwrightPath === undefined) {
  throw new Error(
    `playwright-core not found. Looked in:\n  ${playwrightCandidates.join('\n  ')}\n` +
    'Set PLAYWRIGHT_CORE to the module path, or install it in the dsh checkout.',
  )
}
const { chromium } = await import(playwrightPath)

const chromePath = process.env.CHROME_PATH ?? '/opt/google/chrome/chrome'
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', error => errors.push(error.message))
let fixture = false
let id
try {
  await page.goto(process.argv[2])
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-dshell-terminal-view]') ?? [...document.querySelectorAll('span')].find(node => node.textContent === '新建终端会话')
    if (!el) return false
    let fiber = el[Object.keys(el).find(key => key.startsWith('__reactFiber$'))]
    for (; fiber; fiber = fiber.return) {
      const props = fiber.memoizedProps
      if (props?.pty && props.openConversation) { window.__uiOwner = props; return true }
    }
    return false
  })
  id = 'session-d99ef49b-bd23-4a23-8ce3-c80962b53ee6'
  await page.evaluate(id => window.__uiOwner.openConversation(id), id)
  await page.waitForFunction(id => window.__DSHELL_PTY__.session() === id && document.querySelector('[data-dshell-block="agent"]'), id)
  await page.evaluate(() => {
    const el = document.querySelector('[data-dshell-terminal-view]')
    let fiber = el[Object.keys(el).find(key => key.startsWith('__reactFiber$'))]
    let props
    for (; fiber; fiber = fiber.return) {
      if (fiber.memoizedProps?.sessions && fiber.memoizedProps?.pty) { props = fiber.memoizedProps; break }
    }
    if (!props) throw new Error('BlockView owner missing')
    const id = String(props.sessionId)
    const source = props.sessions.binding(props.sessionId).eventSource
    const original = source.getSnapshot()
    const blocks = props.pty.blocks
    window.__uiProbe = { id, source, original, pty: props.pty, blocks }
    const time = Date.now() - 15000
    props.pty.blocks = function (sid) {
      return String(sid) === id ? [{ seq: 901, kind: 'agent', turn: 901, startedAt: time, text: '' }] : blocks.call(this, sid)
    }
    let seq = 1000
    const event = (type, data, offset = 0) => ({ type: 'event', event: { type, seq: ++seq, time: time + offset, data } })
    const call = (id, command) => ({ type: 'tool-call', id, name: 'bash', arguments: JSON.stringify({ command }) })
    const message = (step, content) => event('assistant/message', { turn: 901, step, message: { role: 'assistant', content } }, step * 1000)
    const result = (id, text, step) => event('tool/result', { turn: 901, step, message: { role: 'user', source: { kind: 'tool-result', callId: id }, content: [{ type: 'text', text }] } }, step * 1000 + 500)
    const entries = [
      event('turn/start', { turn: 901 }),
      event('user/message', { id: 'ui-probe-question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '检查目录，然后根据结果继续验证。' }] }, 100),
      message(1, [{ type: 'text', text: '先读取目录和文件状态。' }, call('ui-a', 'pwd'), call('ui-b', 'ls -la')]),
      result('ui-b', 'file.txt', 1), result('ui-a', '/tmp/ui-probe', 1),
      message(2, [{ type: 'reasoning', text: '第一批结果已经返回，接下来需要核对文件。' }, { type: 'text', text: '目录已确认，接下来检查文件内容。' }, call('ui-c', 'cat file.txt')]),
      result('ui-c', 'verified', 2),
      message(3, [{ type: 'text', text: '检查完成，文件内容已确认。' }]),
    ]
    source.replace(entries, false)
    window.__uiProbe.seq = seq
  })
  fixture = true
  const card = page.locator('[data-dshell-block="agent"]')
  await card.getByText('检查完成，文件内容已确认。', { exact: true }).waitFor()
  assert.equal(await card.locator('[data-dshell-step-kind="answer"]').count(), 3)
  assert.equal(await card.locator('[data-dshell-step-kind="tool"],[data-dshell-step-kind="group"]').count(), 0)
  const mask = await page.evaluate(async () => {
    const animated = document.querySelector('[data-dshell-whale-animated]')
    const src = animated.style.maskImage.slice(5, -2)
    const image = new Image()
    image.src = src
    await image.decode()
    const icon = document.querySelector('[data-dshell-whale-tail]')
    const box = icon.getBoundingClientRect()
    return { image: [image.naturalWidth, image.naturalHeight], box: [box.width, box.height], animated: getComputedStyle(animated).display, still: getComputedStyle(document.querySelector('[data-dshell-whale-still]')).display }
  })
  assert.deepEqual(mask.image, [28, 28])
  assert.deepEqual(mask.box, [14, 14])
  assert.equal(mask.animated, 'block')
  assert.equal(mask.still, 'none')
  await card.screenshot({ path: '/tmp/dshell-ui-collapsed.png' })
  await card.locator(':scope > [data-dshell-fold]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-dshell-step-kind]').length === 6)
  const order = await card.locator('[data-dshell-step-kind]').evaluateAll(nodes => nodes.map(node => node.dataset.dshellStepKind))
  assert.deepEqual(order, ['answer', 'group', 'text', 'answer', 'tool', 'answer'])
  await card.locator('[data-dshell-step-kind="group"] [data-dshell-fold]').first().click()
  await card.locator('[data-dshell-step-kind="group"]').getByText('pwd', { exact: true }).waitFor()
  await card.locator('[data-dshell-step-kind="group"] [data-dshell-fold]').nth(1).click()
  await page.waitForFunction(() => document.querySelector('[data-dshell-step-kind="group"]')?.innerText.includes('/tmp/ui-probe'))
  await card.screenshot({ path: '/tmp/dshell-ui-expanded.png' })
  await page.evaluate(() => {
    const p = window.__uiProbe
    p.source.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq: p.seq + 0.5, time: Date.now(), data: { attemptId: 'ui-stream', turn: 901, step: 4, chunk: { type: 'text-delta', text: '补充确认中。' } } } })
  })
  await page.locator('[data-dshell-stream]').getByText('补充确认中。▍', { exact: true }).waitFor()
  assert.deepEqual(await card.locator('[data-dshell-step-kind]').evaluateAll(nodes => nodes.map(node => node.dataset.dshellStepKind)), order)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await page.evaluate(() => ({ animated: getComputedStyle(document.querySelector('[data-dshell-whale-animated]')).display, still: getComputedStyle(document.querySelector('[data-dshell-whale-still]')).display }))
  assert.equal(reduced.animated, 'none')
  assert.notEqual(reduced.still, 'none')
  await card.screenshot({ path: '/tmp/dshell-ui-reduced-motion.png' })
  await page.evaluate(() => {
    const p = window.__uiProbe
    p.source.settleAssistant('ui-stream', { type: 'event', event: { type: 'assistant/message', seq: ++p.seq, time: Date.now(), data: { turn: 901, step: 4, message: { role: 'assistant', content: [{ type: 'text', text: '补充确认完成。' }] } } } })
    p.source.append({ type: 'event', event: { type: 'turn/end', seq: ++p.seq, time: Date.now(), data: { turn: 901, reason: { kind: 'completed' } } } })
  })
  await card.getByText('补充确认完成。', { exact: true }).waitFor()
  assert.equal(await card.locator('[data-dshell-stream]').count(), 0)
  assert.equal(await card.locator('[data-dshell-whale-animated]').count(), 0)
  assert.equal(await card.locator('[data-dshell-step-kind="answer"]').count(), 4)
  await card.locator(':scope > [data-dshell-fold]').click()
  assert.equal(await card.locator('[data-dshell-step-kind="answer"]').count(), 4)
  assert.equal(await card.locator('[data-dshell-step-kind="tool"],[data-dshell-step-kind="group"]').count(), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ order, mask, reduced, collapsedAnswers: 4, streamSettled: true, pageErrors: errors }, null, 2))
} finally {
  if (fixture) await page.evaluate(async () => {
    const p = window.__uiProbe
    p.pty.blocks = p.blocks
    p.source.replace(p.original.entries, p.original.hasMore)
    const modes = p.pty.ctx.get('dshellTerminalMode')
    for (const id of [p.id, 'session-69050176-657a-44d6-a54b-d40bbec67bc0', 'session-3f3e528b-f4a1-4c79-b774-7183989cc6c4']) {
      if (modes.getSnapshot().records.some(record => record.sessionId === id)) await modes.setArchived(id, true)
    }
  }).catch(error => console.error('fixture cleanup:', error.message))
  await browser.close()
  if (id) console.log('Archived UI test session:', id)
}
