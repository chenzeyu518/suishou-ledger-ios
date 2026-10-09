/**
 * iOS 版 www/index.html 冒烟测试（CI 与本地通用：node scripts/test-www.js）
 *
 * 用最小 DOM 桩把页面里的 <script> 在 Node 里真实跑一遍：
 *   1. 首次启动为空账本，不注入演示数据
 *   2. 遍历四个 Tab 与主要弹层，捕获任何运行时报错
 *   3. 完整记账流程（键盘输入 / 智能归类 / 保存）
 *   4. 重启（二次加载）后数据从 localStorage 恢复
 *   5. 校验「正式版」差异：无预览徽标、含原生外壳适配
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const html = fs.readFileSync(path.join(__dirname, '..', 'www', 'index.html'), 'utf8')
const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) {
  console.error('未找到 <script> 块')
  process.exit(1)
}
const code = m[1]

/* ---------------- 正式版标记检查 ---------------- */
let failed = 0
function check(name, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '  ' + (detail || '')))
  if (!ok) failed = 1
}
console.log('== 正式版标记 ==')
check('无「预览版」徽标', !html.includes('navBadge') && !html.includes('预览版'))
check('首次启动不注入演示数据', !/return \{ bills: seed\(\)/.test(html))
check('含原生外壳适配', html.includes('nativeShell') && html.includes('Capacitor'))
check('含数据持久化', html.includes('localStorage.setItem'))
check('演示数据为按需载入', html.includes('doLoadDemo'))
check('含常驻数字键盘元素', html.includes('<div class="keypad" id="keypad"></div>'))
check(
  '按键序列与小程序端一致',
  html.includes(`const KEYS = ['1','2','3','4','5','6','7','8','9','.','0','del']`)
)
check('完成按钮已绑定到 saveBill', html.includes('onclick="saveBill()"'))
check('键盘渲染已接入 render()', /renderTabbar\(\);\s*\n\s*renderKeypad\(\);/.test(html))

/* ---------------- 最小 DOM 桩 ---------------- */
const noop = () => {}
const ctxStub = new Proxy({}, { get: () => noop, set: () => true })
const renderLog = {}

function fakeEl(id) {
  const el = {
    id,
    _html: '',
    _text: '',
    value: '',
    style: new Proxy(
      {},
      { get: (t, k) => (k in t ? t[k] : ''), set: (t, k, v) => { t[k] = v; return true } }
    ),
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    clientWidth: 320,
    clientHeight: 220,
    offsetHeight: 203, // 数字键盘实测高度（4 行 44px + 间隙 + 内边距）
    offsetWidth: 375,
    width: 0,
    height: 0,
    getContext: () => ctxStub,
    appendChild: noop,
    remove: noop,
    focus: noop,
    setSelectionRange: noop,
    select: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    get innerHTML() {
      return this._html
    },
    set innerHTML(v) {
      this._html = v
      renderLog[id] = (renderLog[id] || 0) + 1
    },
    get textContent() {
      return this._text
    },
    set textContent(v) {
      this._text = v
    }
  }
  return el
}

function boot(store) {
  const els = {}
  const cssVars = {}
  const document = {
    getElementById: (id) => (els[id] = els[id] || fakeEl(id)),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeEl('tmp'),
    body: { appendChild: noop },
    execCommand: () => true,
    documentElement: {
      style: {
        setProperty: (k, v) => {
          cssVars[k] = v
        },
        getPropertyValue: (k) => cssVars[k] || ''
      }
    }
  }
  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    isNaN,
    parseFloat,
    parseInt,
    document,
    navigator: {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k]
    },
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => {
      fn(Date.now() + 10000)
      return 1
    }
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'www/index.html' })
  vm.runInContext(
    'globalThis.__api = { get S(){return S}, get DB(){return DB}, get store(){return localStorage}, dstr, catchUp, parseText, quickTpl, seed };',
    sandbox
  )
  return { sandbox, els, api: sandbox.__api, cssVars }
}

/* ---------------- 第一次启动：空账本 ---------------- */
console.log('\n== 首次启动 ==')
const store = {}
let errors = []
const origError = console.error
console.error = (...a) => {
  errors.push(a.map(String).join(' '))
  origError('[捕获]', ...a)
}

let app
try {
  app = boot(store)
} catch (e) {
  console.error = origError
  console.error('✗ 加载阶段报错：', e.stack)
  process.exit(1)
}
const { sandbox, els, api, cssVars } = app

function step(name, fn) {
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    console.error = origError
    console.error(`  ✗ ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`)
    failed = 1
  }
}

step('空账本空态渲染', () => {
  if (!els.main._html.includes('本月还没有记录')) throw new Error('空态未渲染')
})
step('localStorage 为空（无演示数据）', () => {
  if (store['ledger_h5_v1']) throw new Error('启动即写入了数据')
})

console.log('\n== 数字键盘（记账入口）==')
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del']
step('首页渲染 12 键 + 完成按钮', () => {
  const h = els.keypad._html
  if (!h) throw new Error('键盘未渲染')
  KEYS.forEach((k) => {
    if (!h.includes(`data-key="${k}"`)) throw new Error('缺少按键 ' + k)
    if (!h.includes(`onclick="onKey('${k}')"`)) throw new Error('按键未绑定 onKey: ' + k)
  })
  if (!h.includes('⌫')) throw new Error('删除键未显示为 ⌫')
  if (!h.includes('onclick="saveBill()"')) throw new Error('完成按钮未绑定保存')
  if (!h.includes('完成')) throw new Error('完成按钮文案缺失')
})
step('首页键盘可见且高度写入 --kp-h', () => {
  if (els.keypad.style.display !== 'flex') throw new Error('首页键盘未显示')
  if (cssVars['--kp-h'] !== '203px') throw new Error('--kp-h 异常: ' + cssVars['--kp-h'])
})
step('切到其它 Tab 键盘隐藏，回到首页恢复', () => {
  sandbox.switchTab('bill')
  if (els.keypad.style.display !== 'none') throw new Error('明细页键盘未隐藏')
  if (cssVars['--kp-h'] !== '0px') throw new Error('隐藏后 --kp-h 未归零')
  sandbox.switchTab('index')
  if (els.keypad.style.display !== 'flex') throw new Error('返回首页键盘未恢复')
})

console.log('\n== 记账流程 ==')
step('键盘输入 + 智能归类 + 保存', () => {
  ;['2', '8', '.', '5', '0'].forEach((k) => sandbox.onKey(k))
  if (api.S.buf !== '28.50') throw new Error('输入缓冲异常: ' + api.S.buf)
  sandbox.onNote('瑞幸咖啡')
  if (api.S.catIndex !== 0) throw new Error('未归入餐饮')
  sandbox.saveBill()
  if (api.DB.bills.length !== 1) throw new Error('未写入账单')
})
step('保存后已持久化到 localStorage', () => {
  const saved = JSON.parse(store['ledger_h5_v1'])
  if (!saved.bills || saved.bills.length !== 1) throw new Error('未持久化')
  if (saved.bills[0].amount !== 28.5) throw new Error('金额异常')
})
step('收入记账', () => {
  sandbox.setType('income')
  sandbox.onKey('5')
  sandbox.onKey('0')
  sandbox.onNote('工资')
  sandbox.saveBill()
  if (!api.DB.bills.some((b) => b.type === 'income')) throw new Error('收入未写入')
})

console.log('\n== Tab 遍历 ==')
step('明细 / 统计 / 我的', () => {
  sandbox.switchTab('bill')
  sandbox.billTab('expense')
  sandbox.switchTab('stats')
  if (!els.main._html.includes('分类构成')) throw new Error('统计页异常')
  sandbox.statTab('income')
  sandbox.trendRange(12)
  sandbox.switchTab('mine')
  if (!els.main._html.includes('累计笔数')) throw new Error('我的页异常')
  sandbox.switchTab('index')
})
step('预算弹层', () => {
  sandbox.openBudget()
  if (!els.sheet._html.includes('月度预算')) throw new Error('预算弹层未渲染')
  sandbox.saveBudget()
})
step('周期规则新建（工资自动入账）', () => {
  sandbox.openRecurring()
  sandbox.editRule()
  sandbox.rf('name', '房租', 1)
  sandbox.rf('amount', '3500', 1)
  sandbox.rf('category', 'juzhu', 1)
  sandbox.rf('cycle', 'monthly', 1)
  sandbox.rf('day', '1', 1)
  const before = api.DB.rules.length
  sandbox.saveRule()
  if (api.DB.rules.length !== before + 1) throw new Error('规则未保存')
})

console.log('\n== 演示数据（按需载入） ==')
step('载入演示数据为追加、不清空', () => {
  const before = api.DB.bills.length
  sandbox.resetDemo()
  if (!els.sheet._html.includes('载入演示数据')) throw new Error('确认弹层未渲染')
  sandbox.doLoadDemo()
  if (api.DB.bills.length <= before) throw new Error('演示数据未追加')
  const ids = new Set(api.DB.bills.map((b) => b._id))
  if (ids.size !== api.DB.bills.length) throw new Error('存在重复 ID')
})

console.log('\n== 批量导入 ==')
step('解析示例文本并导入', () => {
  sandbox.openImport()
  sandbox.loadSample()
  if (!api.S.importItems || !api.S.importItems.length) throw new Error('未解析出条目')
  const n = api.S.importItems.length
  sandbox.doImport()
  if (!api.DB.bills.some((b) => b.source === 'import')) throw new Error('未标记导入来源')
  console.log('      识别 ' + n + ' 笔')
})

console.log('\n== 重启恢复 ==')
let app2
step('重新加载后账单完整恢复', () => {
  const before = api.DB.bills.length
  app2 = boot(store)
  if (app2.api.DB.bills.length !== before) {
    throw new Error(`恢复后 ${app2.api.DB.bills.length} 笔，应为 ${before}`)
  }
  if (!app2.api.DB.bills.some((b) => b.note === '瑞幸咖啡')) throw new Error('首笔账单丢失')
})
step('重启后周期规则自动补账且幂等', () => {
  const n1 = app2.sandbox.catchUp()
  const n2 = app2.sandbox.catchUp()
  console.log(`      补账 ${n1} 笔（重复执行 ${n2} 笔）`)
  if (n2 !== 0) throw new Error('重复补账')
})

console.log('\n运行期错误日志：' + errors.length + ' 条')
if (errors.length) errors.slice(0, 5).forEach((e) => console.log('  ! ' + e))
process.exit(errors.length || failed ? 1 : 0)
