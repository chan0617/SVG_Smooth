// 헤드리스 Chrome으로 tests/harness.html을 열어 실제 엔진 테스트를 실행한다.
// 사용: npm run test:e2e  (개발 서버를 자동으로 띄운다)
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean)
const executablePath = chromeCandidates.find((p) => existsSync(p))
if (!executablePath) {
  console.error('Chrome을 찾을 수 없습니다. CHROME_PATH 환경 변수로 경로를 지정해 주세요.')
  process.exit(2)
}

const server = await createServer({ root, server: { port: 5188, strictPort: false }, logLevel: 'error' })
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('[pageerror]', e.message))
await page.goto(new URL('tests/harness.html', url).href)
await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 })
const { cases, fixtures } = await page.evaluate(() => window.runAllTests())

const outDir = join(root, 'tests', 'fixtures')
mkdirSync(outDir, { recursive: true })
for (const f of Object.values(fixtures)) {
  writeFileSync(join(outDir, f.name), Buffer.from(f.dataUrl.split(',')[1], 'base64'))
}

let failed = 0
for (const c of cases) {
  const nodes = c.nodesBefore != null ? `노드 ${c.nodesBefore}→${c.nodesAfter}` : `노드 ${c.nodesAfter}`
  const sub = c.subpathsBefore != null ? `서브패스 ${c.subpathsBefore}→${c.subpathsAfter}` : `서브패스 ${c.subpathsAfter}`
  console.log(`\n[${c.id}] ${c.title}  (${nodes}, ${sub}${c.diffPercent != null ? `, 형태차 ${c.diffPercent}%, IoU ${c.iou}` : ''}, ${c.ms}ms)`)
  for (const k of c.checks) {
    if (!k.pass) failed++
    console.log(`  ${k.pass ? '✔' : '✘'} ${k.name} — ${k.detail}`)
  }
}
writeFileSync(join(root, 'tests', 'last-report.json'), JSON.stringify(cases, null, 2))
console.log(`\n총 ${cases.reduce((n, c) => n + c.checks.length, 0)}개 검사 중 실패 ${failed}개. 테스트 이미지는 tests/fixtures/에 저장됨.`)
await browser.close()
await server.close()
process.exit(failed ? 1 : 0)
