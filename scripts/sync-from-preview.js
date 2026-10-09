/**
 * 从 H5 预览页同步生成正式版 www/index.html（开发用）。
 *
 * 预览页（随手记账-iPhone预览.html）与 iOS 客户端共用同一套交互与逻辑，
 * 本脚本负责把「预览版」差异替换为「正式版」差异，每一项替换都做断言，
 * 预览页结构变化导致任何一项匹配失败时立即报错退出，不会悄悄产出错误结果。
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
patch('version', `<span class="val">v1.1.0 预览版</span>`, `<span class="val">v1.1.0</span>`)
patch(
  'footer',
  `本页为小程序交互预览，数据仅存于本机浏览器`,
  `所有数据仅保存在本机，不会上传任何服务器`
)

/* ---------------- 7. 原理说明：贴合独立 App 场景 ---------------- */
patch(
  'about-copy',
  `苹果的沙箱机制不允许小程序 / 网页读取系统短信、通话记录和其他 App 的通知。这不只是微信小程序做不到，任何第三方 App 都做不到。`,
  `苹果的沙箱机制不允许任何第三方 App 读取系统短信、通话记录和其他 App 的通知——这不是本应用没做，而是所有 App 都做不到。`
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

const out = path.join(root, 'www', 'index.html')
fs.writeFileSync(out, html)

/* ---------------- 自检 ---------------- */
if (/<span class="badge"/.test(html)) throw new Error('自检失败：预览徽标仍存在')
if (/total: 8000/.test(html)) throw new Error('自检失败：演示默认预算仍存在')
if (/bills: seed\(\)/.test(html)) throw new Error('自检失败：演示数据仍为默认注入')
if (!/doLoadDemo/.test(html) || !/nativeShell/.test(html)) throw new Error('自检失败：新函数缺失')
if (!/id="keypad"/.test(html)) throw new Error('自检失败：数字键盘缺失（单项花费输入项）')
if (!/class="ok" onclick="saveBill\(\)"/.test(html)) throw new Error('自检失败：完成按钮缺失')

console.log('已生成正式版：%s（%d KB）', out, Math.round(html.length / 1024))
console.log('应用的补丁：')
patches.forEach((p) => console.log('  ✓ ' + p))
