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

function boot(store, plugins) {
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
    Promise,
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
  if (plugins) sandbox.Capacitor = { Plugins: plugins }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'www/index.html' })
  vm.runInContext(
    'globalThis.__api = { get S(){return S}, get DB(){return DB}, get store(){return localStorage}, get OCR(){return OCR}, dstr, catchUp, parseText, quickTpl, seed, parseBankSms, parseInvoiceText, openOcr, ocrTake, ocrConfirm, ocrField, ocrType };',
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

/* ---------------- 记录的删除体验（v1.4.0 交互补充层） ---------------- */
/* ---------------- 发票 / 小票 拍照识别（解析层） ---------------- */
console.log('\n== 发票 / 小票 拍照识别（解析）==')

const VAT_TEXT = [
  '电子发票（普通发票）',
  '发票号码：24312000000012345678',
  '开票日期：2026年10月08日',
  '购买方信息 名称：张三',
  '销售方信息 名称：上海某某餐饮管理有限公司',
  '纳税人识别号：91310000MA1XXXXXXX',
  '项目名称 规格型号 单位 数量 单价 金额 税率/征收率 税额',
  '*餐饮服务*餐饮费 1 100.00 100.00 6% 6.00',
  '合 计 ¥100.00 ¥6.00',
  '价税合计（大写）壹佰零陆圆整 （小写）¥106.00'
].join('\n')

const RECEIPT_TEXT = ['某某便利店', '2026-10-08 12:30', '可乐 3.00', '面包 8.50', '合计 11.50', '实收 20.00', '找零 8.50'].join('\n')
const CASH_TEXT = ['王记小吃', '2026-10-07', '实收 20.00', '找零 8.50'].join('\n')
const TRAIN_TEXT = ['中国铁路电子客票', '2026-10-08', 'G1234 上海虹桥 - 苏州北', '票价 ¥39.50', '身份证 3205**********1234'].join('\n')
const HOTEL_TEXT = [
  '增值税电子普通发票',
  '发票号码：12345678901234567890',
  '开票日期：2026年10月05日',
  '销售方信息 名称：苏州某某酒店管理有限公司',
  '*住宿服务*住宿费 1 380.00 380.00 6% 22.80',
  '价税合计（大写）肆佰零贰圆捌角整 （小写）¥402.80'
].join('\n')

step('增值税发票：金额取「价税合计（小写）」而不是不含税合计', () => {
  const d = api.parseInvoiceText(VAT_TEXT)
  if (!d.ok) throw new Error('未识别：' + d.reason)
  if (d.amount !== 106) throw new Error('金额取错，应为 106，实际 ' + d.amount)
  if (d.date !== '2026-10-08') throw new Error('日期错误：' + d.date)
  if (d.dateGuessed) throw new Error('日期来自票面，不该标为猜测')
  if (d.docName !== '增值税发票') throw new Error('票种错误：' + d.docName)
  if (d.category !== 'canyin') throw new Error('分类错误：' + d.category)
  if (d.seller.indexOf('餐饮') < 0) throw new Error('未取到销售方：' + d.seller)
  if (d.invoiceNo !== '24312000000012345678') throw new Error('发票号码错误：' + d.invoiceNo)
})
step('小票：合计优先于实收，找零不参与', () => {
  const d = api.parseInvoiceText(RECEIPT_TEXT)
  if (!d.ok) throw new Error('未识别：' + d.reason)
  if (d.amount !== 11.5) throw new Error('应取「合计 11.50」，实际 ' + d.amount)
  if (d.seller !== '某某便利店') throw new Error('商户错误：' + d.seller)
  if (d.category !== 'gouwu') throw new Error('分类错误：' + d.category)
  if (d.date !== '2026-10-08') throw new Error('日期错误：' + d.date)
})
step('小票只有「实收 + 找零」时自动做减法', () => {
  const d = api.parseInvoiceText(CASH_TEXT)
  if (d.amount !== 11.5) throw new Error('未用实收减找零，实际 ' + d.amount)
  if (d.seller !== '王记小吃') throw new Error('商户错误：' + d.seller)
})
step('火车票：票种与分类都归交通', () => {
  const d = api.parseInvoiceText(TRAIN_TEXT)
  if (d.docName !== '火车票') throw new Error('票种错误：' + d.docName)
  if (d.amount !== 39.5) throw new Error('未取到票价，实际 ' + d.amount)
  if (d.category !== 'jiaotong') throw new Error('分类错误：' + d.category)
})
step('住宿发票按品目归入旅行', () => {
  const d = api.parseInvoiceText(HOTEL_TEXT)
  if (d.amount !== 402.8) throw new Error('金额错误：' + d.amount)
  if (d.category !== 'lvxing') throw new Error('分类错误：' + d.category)
  if (d.docName !== '增值税发票') throw new Error('票种错误：' + d.docName)
})
step('与票据无关的照片必须被拒绝，不能生成糊涂账', () => {
  const d = api.parseInvoiceText('今天天气不错\n随便拍的一张照片\n没有金额也没有日期')
  if (d.ok) throw new Error('不该识别成功')
  if (!d.reason) throw new Error('缺少原因说明')
})
step('识别不到金额时不判失败，而是给出手填提醒', () => {
  const d = api.parseInvoiceText('某某超市\n合计 谢谢惠顾')
  if (!d.ok) throw new Error('应进入确认卡让用户补金额：' + d.reason)
  if (d.amount !== 0) throw new Error('金额应为 0，实际 ' + d.amount)
  if (d.warnings.join('').indexOf('金额') < 0) throw new Error('缺少金额提醒')
})
step('首页「拍票入账」入口与识别模块都在正式版里', () => {
  sandbox.switchTab('index')
  if (!els.main._html.includes('onclick="openOcr()"')) throw new Error('首页入口缺失')
  if (!els.main._html.includes('拍票入账')) throw new Error('首页入口文案缺失')
  if (!html.includes('function parseInvoiceText')) throw new Error('解析模块未注入')
  if (!html.includes('parseInvoiceText(text)')) throw new Error('识别结果未接入解析')
  if (!html.includes('LedgerOCR') || !html.includes('OcrReader')) throw new Error('原生插件探测缺失')
  if (!html.includes("source: 'ocr'")) throw new Error('入账来源未标记')
})

console.log('\n== 记录的删除体验 ==')
step('保存后的提示延长到 9 秒，且按钮直接叫「删除」', () => {
  if (!/}, 9000\);/.test(html)) throw new Error('提示未延长到 9 秒')
  if (!/已记账：/.test(html)) throw new Error('提示文案缺失')
  if (!/>删除<\/span>';/.test(html)) throw new Error('提示上的删除按钮缺失')
})
step('长按记录弹出「编辑 / 删除」菜单', () => {
  if (!html.includes('window.openRowMenu')) throw new Error('缺少长按菜单')
  if (!/openRowMenu\(uxBillIdOf\(row\)\)/.test(html)) throw new Error('长按未接到菜单')
  if (!/uxFind\(e\.target, 'brow'\)/.test(html)) throw new Error('未按记录行识别长按')
  if (!/550\)/.test(html)) throw new Error('长按时间阈值缺失')
})
step('删除必须二次确认，编辑弹层的删除也走确认', () => {
  if (!html.includes('window.askDelBill') || !html.includes('confirmDelBill')) throw new Error('缺少删除确认')
  if (!/delBill = function\(id\)\{ window\.askDelBill\(id\); \}/.test(html)) {
    throw new Error('编辑弹层的删除未走二次确认')
  }
})
step('长按菜单与删除确认弹层真实可用', () => {
  const a = boot({})
  a.api.DB.bills.push({
    _id: 'x1', type: 'expense', amount: 12, category: 'canyin',
    note: '测试记录', date: '2026-10-09', time: '12:00', ts: Date.now()
  })
  a.sandbox.openRowMenu('x1')
  if (a.els.sheet._html.indexOf('这笔记录') < 0) throw new Error('长按菜单未渲染')
  if (a.els.sheet._html.indexOf('删除') < 0) throw new Error('菜单里没有删除入口')
  a.sandbox.askDelBill('x1')
  if (a.els.sheet._html.indexOf('确定删除这笔') < 0) throw new Error('未弹出二次确认')
  if (!a.api.DB.bills.some((b) => b._id === 'x1')) throw new Error('确认前就被删除了')
  a.sandbox.confirmDelBill('x1')
  if (a.api.DB.bills.some((b) => b._id === 'x1')) throw new Error('确认后仍未删除')
})
step('数字键盘 ⌫ 长按可一次清空金额', () => {
  if (!/closest\('\.key\[data-key="del"\]'\)/.test(html)) throw new Error('键盘长按清空缺失')
  if (!/S\.buf = '0'/.test(html)) throw new Error('清空逻辑缺失')
})
step('列表里注入「长按可编辑或删除」提示', () => {
  if (!html.includes('window.uxDecorate')) throw new Error('提示注入函数缺失')
  if (!/长按任一记录，可编辑或删除/.test(html)) throw new Error('提示文案缺失')
})

/* ---------------- 存储加固层（四副本互备） ---------------- */
function mockPrefs(seed) {
  const m = Object.assign({}, seed || {})
  return {
    _m: m,
    set(o) { m[o.key] = String(o.value); return Promise.resolve() },
    get(o) { return Promise.resolve({ value: o.key in m ? m[o.key] : null }) },
    remove(o) { delete m[o.key]; return Promise.resolve() },
    keys() { return Promise.resolve({ keys: Object.keys(m) }) }
  }
}
const mockFs = {
  _w: {},
  writeFile(o) { mockFs._w[o.path] = o.data; return Promise.resolve({ uri: 'file:///docs/' + o.path }) },
  readFile(o) { return Promise.resolve({ data: mockFs._w[o.path] || null }) },
  readdir() { return Promise.resolve({ files: [] }) }
}
const mockShare = { share() { return Promise.resolve() } }
/* 相机桩：模拟 @capacitor/camera 的 getPhoto（result 传 Error 表示用户取消） */
function mockCamera(result) {
  return {
    _calls: 0,
    _opt: null,
    getPhoto(o) {
      this._calls++
      this._opt = o
      if (result instanceof Error) return Promise.reject(result)
      return Promise.resolve(result)
    }
  }
}
/* 原生 OCR 桩：模拟 LedgerOCR.recognize，记录收到的图片路径 */
function mockOcr(text) {
  return {
    _path: null,
    recognize(o) {
      this._path = o && o.path
      return Promise.resolve({ text: text, lines: String(text).split('\n').length })
    },
    available() {
      return Promise.resolve({ available: true })
    }
  }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 25))
/* 钥匙串保险柜桩：模拟 iOS LedgerVault 原生插件 */
function mockVault(seed) {
  const m = { v: seed || '' }
  return {
    _m: m,
    readVault() { return Promise.resolve({ value: m.v || '' }) },
    writeVault(o) { m.v = String(o.value); return Promise.resolve({ ok: true }) },
    clearVault() { m.v = ''; return Promise.resolve({ ok: true }) }
  }
}
function payload(rev, n, tag) {
  return JSON.stringify({
    app: '随手记账', v: 1, rev,
    bills: Array.from({ length: n }, (_, i) => ({
      _id: tag + i, type: 'expense', amount: 10 + i, category: 'canyin',
      note: tag + i, date: '2026-10-0' + ((i % 9) + 1), time: '12:00', ts: rev + i
    })),
    rules: [], budgets: {}
  })
}
async function asteP(name, fn) {
  try {
    await fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    console.error = origError
    console.error(`  ✗ ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`)
    failed = 1
  }
}

;(async () => {
  console.log('\n== 存储加固层（四副本互备）==')

  await asteP('钥匙串保险柜：卸载重装后账本自动恢复（最强副本）', async () => {
    const vault = mockVault(payload(6000, 9, 'kv'))
    const a = boot({}, { LedgerVault: vault })   // 全新安装：镜像 / 主存储 / 文件全空
    if (a.api.DB.bills.length !== 0) throw new Error('前置条件错误：新装机应为空账本')
    await a.sandbox.storeSync()
    if (a.api.DB.bills.length !== 9) throw new Error('未从钥匙串恢复，实际 ' + a.api.DB.bills.length + ' 笔')
    if (!a.api.DB.bills.some((b) => b.note === 'kv0')) throw new Error('恢复的数据不对')
  })

  await asteP('副本缺失时启动自动补齐（自愈：钥匙串被清也能补回）', async () => {
    const st = {}
    st['ledger_h5_v1'] = payload(8000, 4, 'heal')
    const vault = mockVault('')
    const a = boot(st, { LedgerVault: vault })
    await a.sandbox.storeSync()
    if (a.api.DB.bills.length !== 4) throw new Error('镜像数据丢失')
    if (!vault._m.v) throw new Error('钥匙串副本未自动补写')
    if (JSON.parse(vault._m.v).bills.length !== 4) throw new Error('补写内容不对')
  })

  await asteP('保存时同时写入钥匙串与文档目录副本', async () => {
    const prefs = mockPrefs({})
    const vault = mockVault('')
    const fs2 = {
      _w: {},
      writeFile(o) { fs2._w[o.path] = o.data; return Promise.resolve({ uri: 'file:///docs/' + o.path }) },
      readFile() { return Promise.resolve({ data: null }) },
      readdir() { return Promise.resolve({ files: [] }) }
    }
    const a = boot({}, { Preferences: prefs, LedgerVault: vault, Filesystem: fs2 })
    a.sandbox.Capacitor.getPlatform = () => 'ios'
    ;['1', '9', '.', '9'].forEach((k) => a.sandbox.onKey(k))
    a.sandbox.onNote('地铁')
    a.sandbox.saveBill()
    if (!vault._m.v) throw new Error('钥匙串副本未写入')
    if (JSON.parse(vault._m.v).bills.length !== 1) throw new Error('钥匙串内容不对')
    if (!fs2._w['随手记账-自动备份.json']) throw new Error('文档目录常驻副本未写入')
  })

  await asteP('存储诊断能列出四份副本的实时状态', async () => {
    const prefs = mockPrefs({ ledger_native_v1: payload(9000, 3, 'dg') })
    const vault = mockVault(payload(9001, 3, 'kv'))
    const a = boot({}, { Preferences: prefs, LedgerVault: vault })
    const rows = await a.sandbox.storeDiag()
    if (rows.length !== 4) throw new Error('诊断项数 ' + rows.length + '（应为 4）')
    const kv = rows.filter((r) => r.k === 'vault')[0]
    if (!kv || kv.count !== 3) throw new Error('钥匙串副本未被统计')
    const names = rows.map((r) => r.name).join('/')
    if (names.indexOf('钥匙串') < 0 || names.indexOf('系统级存储') < 0) throw new Error('诊断名称缺失：' + names)
  })

  await asteP('首次升级：旧镜像数据自动搬进系统级主存储', async () => {
    const prefs = mockPrefs({})
    const st = {}
    st['ledger_h5_v1'] = payload(1000, 3, 'old')
    const a = boot(st, { Preferences: prefs })
    await a.sandbox.storeSync()
    const saved = prefs._m['ledger_native_v1']
    if (!saved) throw new Error('未写入主存储')
    if (JSON.parse(saved).bills.length !== 3) throw new Error('迁移的数据条数不对')
  })

  await asteP('镜像被清空时从系统级主存储恢复（本次丢数据的核心场景）', async () => {
    const prefs = mockPrefs({ ledger_native_v1: payload(2000, 5, 'sys') })
    const a = boot({}, { Preferences: prefs })
    if (a.api.DB.bills.length !== 0) throw new Error('前置条件错误：镜像应为空')
    await a.sandbox.storeSync()
    if (a.api.DB.bills.length !== 5) throw new Error('未从主存储恢复，实际 ' + a.api.DB.bills.length + ' 笔')
    if (!a.api.DB.bills.some((b) => b.note === 'sys0')) throw new Error('恢复的数据不对')
  })

  await asteP('主存储与镜像都空时自动从最近快照恢复', async () => {
    const prefs = mockPrefs({ ledger_snap_v1_1700000000000: payload(3000, 7, 'snap') })
    const a = boot({}, { Preferences: prefs })
    await a.sandbox.storeSync()
    if (a.api.DB.bills.length !== 7) throw new Error('未从快照恢复，实际 ' + a.api.DB.bills.length + ' 笔')
  })

  await asteP('多副本冲突时取写入时间更新的一份', async () => {
    const prefs = mockPrefs({ ledger_native_v1: payload(5000, 6, 'new') })
    const st = {}
    st['ledger_h5_v1'] = payload(4000, 2, 'old')
    const a = boot(st, { Preferences: prefs })
    await a.sandbox.storeSync()
    if (a.api.DB.bills.length !== 6) throw new Error('未取最新副本，实际 ' + a.api.DB.bills.length + ' 笔')
  })

  await asteP('保存时三层同时落盘并生成快照', async () => {
    const prefs = mockPrefs({})
    const st = {}
    const a = boot(st, { Preferences: prefs, Filesystem: mockFs })
    ;['1', '2', '.', '5', '0'].forEach((k) => a.sandbox.onKey(k))
    a.sandbox.onNote('星巴克')
    a.sandbox.saveBill()
    if (!st['ledger_h5_v1']) throw new Error('镜像未写入')
    if (!prefs._m['ledger_native_v1']) throw new Error('主存储未写入')
    const snaps = Object.keys(prefs._m).filter((k) => k.indexOf('ledger_snap_v1_') === 0)
    if (!snaps.length) throw new Error('未生成快照')
    if (JSON.parse(prefs._m['ledger_native_v1']).bills.length !== 1) throw new Error('主存储内容不对')
  })

  await asteP('导出备份写成 .json 文件', async () => {
    const prefs = mockPrefs({})
    Object.keys(mockFs._w).forEach((k) => delete mockFs._w[k])
    const a = boot({}, { Preferences: prefs, Filesystem: mockFs, Share: mockShare })
    a.sandbox.onKey('9')
    a.sandbox.onKey('9')
    a.sandbox.saveBill()
    a.sandbox.exportData()
    await new Promise((r) => setTimeout(r, 30))
    const files = Object.keys(mockFs._w).filter((f) => /^随手记账备份-\d{8}-\d{4}\.json$/.test(f))
    if (!files.length) throw new Error('未生成备份文件，实际：' + Object.keys(mockFs._w).join('/'))
    if (!JSON.parse(mockFs._w[files[0]]).bills.length) throw new Error('备份内容为空')
  })

  console.log('\n== 拍票入账（端到端）==')

  await asteP('没有原生能力时给出降级提示（浏览器 / 预览页）', async () => {
    const a = boot({}, {})
    a.sandbox.openOcr()
    if (!a.els.sheet._html.includes('此功能需要在 App 内使用')) throw new Error('缺少降级提示')
  })

  await asteP('拍照 → 原生识别 → 确认卡，参数与草稿都正确', async () => {
    const cam = mockCamera({ path: '/var/mobile/tmp/fapiao.jpg' })
    const ocr = mockOcr(VAT_TEXT)
    const a = boot({}, { Camera: cam, LedgerOCR: ocr })
    a.sandbox.openOcr()
    a.sandbox.ocrTake('camera')
    await tick()
    if (a.api.OCR.step !== 'result') throw new Error('未进入确认卡：' + a.api.OCR.step + ' ' + a.api.OCR.err)
    if (ocr._path !== '/var/mobile/tmp/fapiao.jpg') throw new Error('图片路径未传给原生：' + ocr._path)
    if (cam._opt.source !== 'Camera') throw new Error('没有指定用相机拍')
    if (cam._opt.resultType !== 'uri') throw new Error('应使用文件路径模式而不是 base64')
    if (a.api.OCR.draft.amount !== 106) throw new Error('草稿金额错误：' + a.api.OCR.draft.amount)
    if (!a.els.sheet._html.includes('确认入账')) throw new Error('确认卡未渲染')
    if (!a.els.sheet._html.includes('106')) throw new Error('确认卡未带出金额')

    a.api.ocrField('note', '客户招待')
    a.api.ocrConfirm()
    const bill = a.api.DB.bills[0]
    if (!bill) throw new Error('未写入账单')
    if (bill.amount !== 106) throw new Error('入账金额错误：' + bill.amount)
    if (bill.category !== 'canyin') throw new Error('分类错误：' + bill.category)
    if (bill.source !== 'ocr') throw new Error('未标记拍照来源')
    if (bill.note !== '客户招待') throw new Error('手工修改的备注未生效：' + bill.note)
    if (bill.date !== '2026-10-08') throw new Error('日期错误：' + bill.date)
  })

  await asteP('小票走同一套流程，file:// 路径自动归一化', async () => {
    const ocr = mockOcr(RECEIPT_TEXT)
    const a = boot({}, { Camera: mockCamera({ path: 'file:///var/mobile/tmp/piao.jpg' }), LedgerOCR: ocr })
    a.sandbox.openOcr()
    a.sandbox.ocrTake('photos')
    await tick()
    if (ocr._path !== '/var/mobile/tmp/piao.jpg') throw new Error('file:// 未归一化：' + ocr._path)
    if (a.api.OCR.draft.amount !== 11.5) throw new Error('金额错误：' + a.api.OCR.draft.amount)
    a.api.ocrConfirm()
    if (!a.api.DB.bills.some((b) => b.amount === 11.5 && b.source === 'ocr')) throw new Error('未入账')
  })

  await asteP('用户取消拍照不报错，回到拍摄选择页', async () => {
    const cam = mockCamera(new Error('User cancelled photos app'))
    const a = boot({}, { Camera: cam, LedgerOCR: mockOcr('') })
    a.sandbox.openOcr()
    a.sandbox.ocrTake('camera')
    await tick()
    if (a.api.OCR.step !== 'pick') throw new Error('取消后状态错误：' + a.api.OCR.step)
    if (!a.els.sheet._html.includes('拍照识别')) throw new Error('未回到选择页')
  })

  await asteP('识别失败时展示失败原因与重拍入口', async () => {
    const a = boot({}, { Camera: mockCamera({ path: '/tmp/x.jpg' }), LedgerOCR: mockOcr('') })
    a.sandbox.openOcr()
    a.sandbox.ocrTake('camera')
    await tick()
    if (a.api.OCR.step !== 'fail') throw new Error('未进入失败态：' + a.api.OCR.step)
    if (!a.els.sheet._html.includes('重拍一张')) throw new Error('缺少重拍入口')
    if (!a.els.sheet._html.includes('改用粘贴账单导入')) throw new Error('缺少兜底入口')
  })

  await asteP('拍票入账同样写入持久化（与手工记账同一条链路）', async () => {
    const st = {}
    const a = boot(st, { Camera: mockCamera({ path: '/tmp/y.jpg' }), LedgerOCR: mockOcr(VAT_TEXT) })
    a.sandbox.openOcr()
    a.sandbox.ocrTake('camera')
    await tick()
    a.api.ocrConfirm()
    if (!st['ledger_h5_v1']) throw new Error('未写入本机镜像')
    const saved = JSON.parse(st['ledger_h5_v1'])
    if (!saved.bills.length || saved.bills[0].source !== 'ocr') throw new Error('持久化内容不对')
  })

  console.log('\n运行期错误日志：' + errors.length + ' 条')
  if (errors.length) errors.slice(0, 5).forEach((e) => console.log('  ! ' + e))
  process.exit(errors.length || failed ? 1 : 0)
})()
