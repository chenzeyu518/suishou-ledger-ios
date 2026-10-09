/**
 * 从 H5 预览页同步生成正式版 www/index.html（开发用）。
 *
 * 预览页（随手记账-iPhone预览.html）与 iOS 客户端共用同一套交互与逻辑，
 * 本脚本负责把「预览版」差异替换为「正式版」差异，每一项替换都做断言，
 * 预览页结构变化导致任何一项匹配失败时立即报错退出，不会悄悄产出错误结果。
 *
 * v1.2.0 起与 Android 版能力对齐（受限于 iOS 沙箱，实现方式不同）：
 *   - 官方账单解析升级：识别微信 / 支付宝官方 CSV，跳过「不计收支」与已退款 / 已关闭交易
 *   - 银行消费短信解析：iOS 读不到短信收件箱，改为在「信息」中复制后粘贴导入
 *   - 导入页与「自动记账原理说明」写明 iOS 上真实可行的数据来源
 *
 * 用法：node scripts/sync-from-preview.js [预览页路径]
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
let src = process.argv[2]
if (!src) {
  const candidates = [
    path.join(root, '..', '随手记账-iPhone预览.html'),
    path.join(root, '随手记账-iPhone预览.html')
  ]
  src = candidates.find((p) => fs.existsSync(p))
}
if (!src || !fs.existsSync(src)) {
  console.error('未找到预览页源文件，请传入路径：node scripts/sync-from-preview.js <path>')
  process.exit(1)
}

let html = fs.readFileSync(src, 'utf8')
const patches = []

function patch(name, from, to) {
  const n = html.split(from).length - 1
  if (n !== 1) throw new Error(`补丁 [${name}] 匹配到 ${n} 处（应为 1 处），中止。`)
  html = html.replace(from, to)
  patches.push(name)
}

/* ---------------- 1. 头部：正式版标题与 App 元信息 ---------------- */
patch(
  'title',
  `<meta name="theme-color" content="#ffffff" />\n<title>随手记账 · 交互预览</title>`,
  `<meta name="apple-mobile-web-app-title" content="随手记账" />\n<meta name="format-detection" content="telephone=no,email=no,address=no" />\n<meta name="theme-color" content="#F5F6FA" />\n<title>随手记账</title>`
)

/* ---------------- 2. CSS：原生 App 手感 ---------------- */
patch(
  'css-native',
  `  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}\n  html,body{height:100%;max-width:100%;overflow-x:hidden}`,
  `  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}\n  html,body{height:100%;max-width:100%;overflow-x:hidden;overscroll-behavior:none}\n  body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}\n  input,textarea{-webkit-user-select:text;user-select:text}`
)

/* ---------------- 3. 顶部导航：去掉预览徽标 ---------------- */
patch(
  'header',
  `<header class="nav"><h1 id="navTitle">随手记账</h1><span class="badge" id="navBadge">预览版</span></header>`,
  `<header class="nav"><h1 id="navTitle">随手记账</h1></header>`
)
patch('header-js', `  $('navBadge').textContent = 'H5 预览版';\n`, ``)

/* ---------------- 4. 首次启动：空账本，不注入演示数据 ---------------- */
patch(
  'load-empty',
  `  return { bills: seed(), rules: seedRules(), budgets: { [S.month]: { total: 8000, categories: { canyin: 2000, jiaotong: 800 } } } };`,
  `  return { bills: [], rules: [], budgets: {} };`
)
patch(
  'boot-budget',
  `  if (!s) DB.budgets[S.month] = { total: 8000, categories: { canyin: 2000, jiaotong: 800 } };`,
  `  if (!s) DB.budgets[S.month] = { total: 0, categories: {} };`
)

/* ---------------- 5. 我的页：演示数据改为按需载入 ---------------- */
patch(
  'mine-demo-row',
  `<div class="bd"><div class="t">重置演示数据</div><div class="s">恢复初始示例账单</div></div>`,
  `<div class="bd"><div class="t">载入演示数据</div><div class="s">生成一批示例账单，查看统计图表效果</div></div>`
)
patch(
  'reset-demo-fn',
  `function resetDemo(){ DB = { bills: seed(), rules: seedRules(), budgets: DB.budgets }; save(); render(); toast('已重置演示数据'); }`,
  `function resetDemo(){
  openSheet(\`<div class="sh-h"><b>载入演示数据</b><span onclick="closeSheet()">✕</span></div>
    <div class="sh-b"><div class="note" style="padding-top:0">将生成一批示例账单与示例周期规则，用于查看统计图表效果。现有记录会保留，不会被覆盖。</div></div>
    <div class="sh-f"><div class="btn btn-g" style="flex:1" onclick="closeSheet()">取消</div>
    <div class="btn btn-p" style="flex:1" onclick="doLoadDemo()">载入</div></div>\`);
}
function doLoadDemo(){
  DB.bills = DB.bills.concat(seed());
  if (!DB.rules.length) DB.rules = seedRules();
  save(); closeSheet(); render(); toast('已载入演示数据');
}`
)

/* ---------------- 6. 版本与页脚文案 ---------------- */
patch('version', `<span class="val">v1.1.0 预览版</span>`, `<span class="val">v1.2.0</span>`)
patch(
  'footer',
  `本页为小程序交互预览，数据仅存于本机浏览器`,
  `所有数据仅保存在本机，不会上传任何服务器`
)

/* ---------------- 6b. 我的页：导入入口副标题写明数据来源 ---------------- */
patch(
  'mine-import-sub',
  `<div><div class="t">账单批量导入</div><div class="s">粘贴账单文本，自动拆分归类</div></div></div>`,
  `<div><div class="t">账单批量导入</div><div class="s">短信 / 微信 / 支付宝账单，粘贴即导入</div></div></div>`
)

/* ---------------- 6c. 导入页：写清 iOS 上「数据从哪来」的真实路径 ---------------- */
patch(
  'import-hint',
  `          <b>粘贴账单文本，自动拆分归类</b>\n          支持微信支付、支付宝、银行短信、官方导出 CSV，自动识别日期、金额、收支方向和商家。</div></div>`,
  `          <b>粘贴账单文本，自动拆分归类</b>\n          支持银行消费短信、微信 / 支付宝官方账单 CSV、支付记录文字，自动识别日期、金额、收支方向和商家。<br>iOS 读不到短信与微信明细，请这样取数据：银行短信在「信息」中长按复制；微信账单在「我 → 服务 → 钱包 → 账单 → 右上角常见问题 → 下载账单 → 用于个人对账」导出，粘贴到下面即可。</div></div>`
)

/* ---------------- 6d. 解析器：识别微信 / 支付宝官方账单 CSV ---------------- */
patch(
  'parse-csv-cols',
  `  const iT = col('交易时间','创建时间','付款时间','最近修改时间','时间'),\n        iA = col('金额'), iD = col('收/支','收支','资金状态'),\n        iN = col('商品说明','商品名称','商品','交易对方','对方','备注'), iY = col('交易类型','类型');`,
  `  const iT = col('交易时间','创建时间','付款时间','最近修改时间','时间'),\n        iA = col('金额'), iD = col('收/支','收支','资金状态'),\n        iN = col('交易对方','对方','商户','备注'), iG = col('商品说明','商品名称','商品'),\n        iY = col('交易类型','类型'), iS = col('当前状态','交易状态','状态');`
)
patch(
  'parse-csv-rows',
  `    const num = parseFloat(String(iA > -1 ? c[iA] : '').replace(/[^\\d.]/g,'')) || 0;\n    if (!num) { if (String(lines[i]).trim()) failed.push(String(lines[i]).trim()); continue; }\n    const dr = iD > -1 ? String(c[iD] || '') : '';\n    const type = (dr.indexOf('收入') > -1 || dr.indexOf('入') === 0) ? 'income' : 'expense';\n    const np = []; if (iN > -1 && c[iN]) np.push(c[iN]); if (iY > -1 && c[iY]) np.push(c[iY]);\n    const note = extractNote(np.join(' ')) || fbNote(type);`,
  `    const amtCell = iA > -1 ? String(c[iA] || '').trim() : '';\n    if (!amtCell) continue;   // 官方账单的合计行 / 空行：直接跳过，不计入「未识别」\n    const num = parseFloat(amtCell.replace(/[^\\d.]/g,'')) || 0;\n    if (!num) { if (String(lines[i]).trim()) failed.push(String(lines[i]).trim()); continue; }\n    const dr = iD > -1 ? String(c[iD] || '').trim() : '';\n    if (dr === '/' || dr.indexOf('不计') > -1) continue;   // 不计收支（提现、零钱通转入等）不入账\n    const st = iS > -1 ? String(c[iS] || '') : '';\n    if (dr.indexOf('收入') < 0 && dr.indexOf('入') !== 0 && /退款|已关闭|交易关闭|失败|未付款|待付款|已撤销/.test(st)) continue;\n    const type = (dr.indexOf('收入') > -1 || dr.indexOf('入') === 0) ? 'income' : 'expense';\n    const vN = iN > -1 ? smsTidy(c[iN] || '') : '';\n    const vG = iG > -1 ? smsTidy(c[iG] || '') : '';\n    const np = []; if (vN) np.push(vN);\n    if (vG && vG !== vN) np.push(vG);\n    if (iY > -1 && c[iY] && np.length < 2) np.push(c[iY]);\n    const note = extractNote(np.join(' ')) || fbNote(type);`
)

/* ---------------- 6e. 解析器：银行消费短信走专项解析 ---------------- */
/* iOS 读不到短信收件箱，因此短信只能由用户复制粘贴进来，这里把粘贴的短信
   交给 parseBankSms 处理（排除余额数字、抽取商户、识别「摘要」用途）。 */
patch(
  'parse-text-sms',
  `    items = []; failed = [];\n    lines.forEach(l => { const s = l.trim(); if (!s) return; const one = parseLine(s, ctx); if (one) items.push(one); else if (s.length > 6 && /[\\u4e00-\\u9fa5]/.test(s)) failed.push(s); });`,
  `    items = []; failed = [];\n    lines.forEach(l => {\n      const s = l.trim(); if (!s) return;\n      /* 银行 / 支付短信：走专项解析（自动排除余额数字、抽取商户、识别「摘要」用途） */\n      if (looksLikeSms(s)) {\n        const bs = parseBankSms({ body: s });\n        if (bs) {\n          items.push({ type: bs.type, amount: bs.amount, note: bs.note, date: bs.date, time: bs.time,\n            dateGuessed: bs.dateGuessed, category: bs.category });\n          return;\n        }\n      }\n      const one = parseLine(s, ctx); if (one) items.push(one); else if (s.length > 6 && /[\\u4e00-\\u9fa5]/.test(s)) failed.push(s);\n    });`
)

/* ---------------- 7. 原理说明：贴合 iOS 独立 App 的真实情况 ---------------- */
patch(
  'about-copy',
  `苹果的沙箱机制不允许小程序 / 网页读取系统短信、通话记录和其他 App 的通知。这不只是微信小程序做不到，任何第三方 App 都做不到。`,
  `苹果的沙箱机制不允许任何第三方 App 读取短信收件箱、通话记录，也不允许读取其他 App 的通知与聊天数据。所以本应用读不到银行短信、也读不到微信支付明细——这不是本应用没做，而是 iOS 上没有任何 App 做得到。`
)
patch(
  'about-import-item',
  `        3. <b>账单批量导入</b>：从微信 / 支付宝 / 银行 App 复制账单文本粘贴进来，自动拆分出日期、金额、收支方向和商家，并自动归类，一次导入几十笔。<br>`,
  `        3. <b>账单批量导入</b>：在「信息」里长按复制银行消费短信，或在微信「我 → 服务 → 钱包 → 账单 → 右上角常见问题 → 下载账单 → 用于个人对账」导出官方账单，粘贴进来即自动拆分日期、金额、收支方向和商家并归类。识别官方账单时会自动跳过提现等「不计收支」行与已退款 / 已关闭的交易，一次导入几十笔。<br>`
)
patch(
  'mine-about-sub',
  `<div class="bd"><div class="t">自动记账原理说明</div><div class="s">iOS 为什么读不到短信？我们如何解决</div></div>`,
  `<div class="bd"><div class="t">自动记账原理说明</div><div class="s">读不到短信和微信明细？数据这样进来</div></div>`
)

/* ---------------- 8. 原生外壳：震动反馈（浏览器中自动跳过） ---------------- */
patch(
  'save-haptic',
  `function save(){ try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch(e){} }`,
  `function save(){ try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch(e){} if (window.haptic) window.haptic(); }`
)
patch(
  'native-shell',
  `</script>\n</body>`,
  `/* ---------------------- 17. 原生外壳（IPA 中生效，浏览器打开自动跳过） ---------------------- */
(function nativeShell(){
  try {
    const C = window.Capacitor;
    if (!C || !C.Plugins) return;
    const HB = C.Plugins.Haptics;
    if (HB) window.haptic = function(){ try { HB.impact({ style: 'LIGHT' }); } catch(e){} };
  } catch(e){}
})();
</script>
</body>`
)

/* ---------------- 9. 银行 / 支付短信文本解析模块（iOS 版，整段注入） ---------------- */
const smsPath = path.join(root, 'native', 'www', 'sms-parse.js')
if (!fs.existsSync(smsPath)) throw new Error('缺少 native/www/sms-parse.js')
const smsCode = fs.readFileSync(smsPath, 'utf8')
patch('sms-parse', `</script>\n</body>`, smsCode + `\n</script>\n</body>`)

const out = path.join(root, 'www', 'index.html')
fs.writeFileSync(out, html)

/* ---------------- 自检 ---------------- */
if (/<span class="badge"/.test(html)) throw new Error('自检失败：预览徽标仍存在')
if (/total: 8000/.test(html)) throw new Error('自检失败：演示默认预算仍存在')
if (/bills: seed\(\)/.test(html)) throw new Error('自检失败：演示数据仍为默认注入')
if (!/doLoadDemo/.test(html) || !/nativeShell/.test(html)) throw new Error('自检失败：新函数缺失')
if (!/id="keypad"/.test(html)) throw new Error('自检失败：数字键盘缺失（单项花费输入项）')
if (!/class="ok" onclick="saveBill\(\)"/.test(html)) throw new Error('自检失败：完成按钮缺失')
if (!/function parseBankSms/.test(html)) throw new Error('自检失败：银行短信解析模块未注入')
if (!/function looksLikeSms/.test(html)) throw new Error('自检失败：短信识别门槛缺失')
if (!/parseBankSms\(\{ body: s \}\)/.test(html)) throw new Error('自检失败：导入解析器未接入银行短信')
if (!/iS = col\('当前状态'/.test(html)) throw new Error('自检失败：账单状态列未识别')
if (!/不计收支/.test(html)) throw new Error('自检失败：官方账单「不计收支」过滤缺失')
if (!/短信 \/ 微信 \/ 支付宝账单/.test(html)) throw new Error('自检失败：导入入口副标题未更新')
if (/sms-parse/.test(html)) throw new Error('自检失败：源码注释未清理')

console.log('已生成正式版：%s（%d KB）', out, Math.round(html.length / 1024))
console.log('应用的补丁：')
patches.forEach((p) => console.log('  ✓ ' + p))
