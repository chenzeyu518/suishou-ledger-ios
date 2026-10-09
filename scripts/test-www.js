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
    'globalThis.__api = { get S(){return S}, get DB(){return DB}, get store(){return localStorage}, dstr, catchUp, parseText, quickTpl, seed, parseBankSms };',
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

/* ---------------- 银行短信文本解析（iOS：从「信息」复制后粘贴导入） ---------------- */
console.log('\n== 银行短信文本解析 ==')
const sms = app2.sandbox
const api2 = app2.api
const SMS_CASES = [
  {
    name: '招行消费·带商户+余额',
    body: '您尾号1234的信用卡09月10日15:40在星巴克消费人民币32.00元，余额5,231.66元。【招商银行】',
    type: 'expense', amount: 32, cat: 'canyin', note: '星巴克', date: '2026-09-10', time: '15:40'
  },
  {
    name: '工行消费·无商户只认金额',
    body: '【工商银行】您尾号5678卡09月11日08:12消费28.50元，可用额度18,000.00元。',
    type: 'expense', amount: 28.5, cat: 'qita', date: '2026-09-11'
  },
  {
    name: '工资入账·走摘要',
    body: '您账户1234于09月12日10:00收入人民币12,000.00元，摘要：工资。',
    type: 'income', amount: 12000, cat: 'gongzi', note: '工资', date: '2026-09-12'
  },
  {
    name: '退款到账',
    body: '【招商银行】您尾号1234的信用卡09月13日20:10退款人民币28.50元。',
    type: 'income', amount: 28.5, cat: 'qita', date: '2026-09-13'
  },
  {
    name: '转出·余额不能当金额',
    body: '【招商银行】您尾号1234的储蓄卡09月15日18:00转出人民币500.00元，余额9,231.66元。',
    type: 'expense', amount: 500, cat: 'qita', date: '2026-09-15'
  },
  {
    name: '滴滴消费归交通',
    body: '【建设银行】您尾号8888的储蓄卡09月16日22:10在滴滴出行消费23.50元。',
    type: 'expense', amount: 23.5, cat: 'jiaotong', note: '滴滴出行', date: '2026-09-16'
  }
]
SMS_CASES.forEach((c) => {
  step('识别：' + c.name, () => {
    /* iOS 版不传 date：日期时间从短信正文里抽 */
    const r = sms.parseBankSms({ body: c.body })
    if (!r) throw new Error('未识别出账单')
    if (r.type !== c.type) throw new Error(`类型 ${r.type}，应为 ${c.type}`)
    if (r.amount !== c.amount) throw new Error(`金额 ${r.amount}，应为 ${c.amount}`)
    if (c.cat && r.category !== c.cat) throw new Error(`分类 ${r.category}，应为 ${c.cat}`)
    if (c.note && r.note !== c.note) throw new Error(`备注 ${r.note}，应为 ${c.note}`)
    if (c.date && r.date !== c.date) throw new Error(`日期 ${r.date}，应为 ${c.date}`)
    if (c.time && r.time !== c.time) throw new Error(`时间 ${r.time}，应为 ${c.time}`)
    /* 正文里写明发卡行的，必须把发卡行带出来（工资短信正文没写银行名，允许为空） */
    if (/银行/.test(c.body) && !/银行$/.test(r.bank)) {
      throw new Error('未带出发卡行：' + r.bank)
    }
  })
})

console.log('\n== 短信噪声必须被挡掉 ==')
const SMS_JUNK = [
  ['验证码短信', '【招商银行】验证码123456，您正在支付28.50元，请勿泄露。'],
  ['纯余额提醒', '【建设银行】您尾号1234的储蓄卡余额为5,231.66元。'],
  ['营销短信', '【中信银行】信用卡账单分期手续费5折，最高额度200,000元，回复TD退订。'],
  ['登录通知', '【微信】您于09月10日在新设备登录，若非本人操作请及时修改密码。']
]
SMS_JUNK.forEach(([n, body]) => {
  step('丢弃：' + n, () => {
    const r = sms.parseBankSms({ body })
    if (r) throw new Error('误判为账单：' + r.note + ' ¥' + r.amount)
  })
})

console.log('\n== 粘贴短信走批量导入 ==')
step('多条短信粘贴后逐条拆分，普通账单行不受影响', () => {
  const text = [SMS_CASES[0].body, SMS_CASES[5].body, '', '2026-10-08 12:30:15  微信支付  沙县小吃  -¥15.00  已支付'].join('\n')
  const r = sms.parseText(text)
  if (r.items.length !== 3) throw new Error('解析 ' + r.items.length + ' 条，应为 3 条：' + r.items.map((x) => x.note).join('/'))
  const sbx = r.items.find((x) => x.note === '星巴克')
  if (!sbx) throw new Error('短信未走专项解析：' + r.items.map((x) => x.note).join('/'))
  if (sbx.date !== '2026-09-10' || sbx.category !== 'canyin') throw new Error('短信日期或分类异常：' + sbx.date + '/' + sbx.category)
  if (r.stats.expense !== 70.5) throw new Error('支出合计 ' + r.stats.expense + '，应为 70.50')
  if (!r.items.some((x) => x.note === '沙县小吃')) throw new Error('普通账单行被短信解析吞掉')
})
step('粘贴的短信可正常导入账本', () => {
  const before = api2.DB.bills.length
  sms.openImport()
  sms.loadSample()
  sms.doImport()
  if (api2.DB.bills.length <= before) throw new Error('导入未写入账单')
})

/* ---------------- 微信 / 支付宝官方账单 CSV ---------------- */
console.log('\n== 微信官方账单 CSV ==')
const WX_CSV = [
  '微信支付账单明细',
  '起始时间：[2026-09-01 00:00:00] 终止时间：[2026-09-30 23:59:59]',
  '导出时间：[2026-10-01 10:00:00]',
  '共6笔记录',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2026-09-02 08:12:33,商户消费,瑞幸咖啡,瑞幸咖啡,支出,¥16.90,零钱,支付成功,4200001,10001,/',
  '2026-09-03 12:30:00,商户消费,美团,美团外卖,支出,¥38.00,招商银行(1234),支付成功,4200002,10002,/',
  '2026-09-05 19:20:11,转账,张三,/,收入,¥200.00,零钱,已存入零钱,4200003,10003,/',
  '2026-09-08 09:00:00,零钱提现,/,提现到招商银行,不计收支,¥500.00,零钱,提现成功,4200004,10004,/',
  '2026-09-10 15:40:02,商户消费,天猫超市,天猫超市,支出,¥128.00,零钱,已全额退款,4200005,10005,/',
  '2026-09-12 18:02:59,商户消费,滴滴出行,滴滴出行,支出,¥23.50,零钱,支付成功,4200006,10006,/',
  '收入合计：200.00元 支出合计：206.40元'
].join('\n')
step('跳过不计收支行与已全额退款行', () => {
  const r = sms.parseText(WX_CSV)
  if (r.items.length !== 4) throw new Error('识别 ' + r.items.length + ' 条，应为 4 条')
  if (r.stats.expense !== 78.4) throw new Error('支出合计 ' + r.stats.expense + '，应为 78.40')
  if (r.stats.income !== 200) throw new Error('收入合计 ' + r.stats.income + '，应为 200')
})
step('微信账单能带出商户与分类', () => {
  const r = sms.parseText(WX_CSV)
  const luckin = r.items.find((x) => x.note === '瑞幸咖啡')
  if (!luckin) throw new Error('未带出商户名，实际：' + r.items.map((x) => x.note).join('/'))
  if (luckin.category !== 'canyin') throw new Error('分类 ' + luckin.category + '，应为 canyin')
  if (luckin.date !== '2026-09-02') throw new Error('日期 ' + luckin.date)
})

console.log('\n== 支付宝官方账单 CSV ==')
const ALI_CSV = [
  '支付宝交易记录明细查询',
  '账号:[zhangsan@example.com]',
  '---------------------------------交易记录明细列表------------------------------------',
  '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
  '2026-09-02 08:12:33,餐饮美食,瑞幸咖啡(北京)有限公司,ruixing@example.com,瑞幸咖啡,支出,16.90,余额宝,交易成功,2026090222001,3001,',
  '2026-09-04 10:00:00,交通出行,滴滴出行,didiglobal,滴滴出行,支出,23.50,花呗,交易成功,2026090422002,3002,',
  '2026-09-06 15:00:00,转账,张三,zhangsan@example.com,转账,收入,200.00,余额,交易成功,2026090622003,3003,',
  '2026-09-15 09:30:00,购物,天猫超市,tmall,天猫超市,支出,128.00,余额宝,交易关闭,2026091522004,3004,'
].join('\n')
step('跳过交易关闭行，金额与收支方向正确', () => {
  const r = sms.parseText(ALI_CSV)
  if (r.items.length !== 3) throw new Error('识别 ' + r.items.length + ' 条，应为 3 条')
  if (r.stats.expense !== 40.4) throw new Error('支出合计 ' + r.stats.expense + '，应为 40.40')
  if (r.stats.income !== 200) throw new Error('收入合计 ' + r.stats.income + '，应为 200')
})
step('支付宝账单能带出商户与分类（公司后缀已清洗）', () => {
  const r = sms.parseText(ALI_CSV)
  const ddt = r.items.find((x) => x.note === '滴滴出行')
  if (!ddt) throw new Error('未带出商户名，实际：' + r.items.map((x) => x.note).join('/'))
  if (ddt.category !== 'jiaotong') throw new Error('分类 ' + ddt.category + '，应为 jiaotong')
  const luckin = r.items.find((x) => x.note === '瑞幸咖啡')
  if (!luckin) throw new Error('公司后缀未清洗，实际：' + r.items.map((x) => x.note).join('/'))
  if (luckin.category !== 'canyin') throw new Error('分类 ' + luckin.category + '，应为 canyin')
})

console.log('\n运行期错误日志：' + errors.length + ' 条')
if (errors.length) errors.slice(0, 5).forEach((e) => console.log('  ! ' + e))
process.exit(errors.length || failed ? 1 : 0)
