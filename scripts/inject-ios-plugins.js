#!/usr/bin/env node
/**
 * 把 native/ios/*.swift 里的自建 Capacitor 插件注入到 iOS 工程（CI 构建时执行）。
 *
 * 为什么不把 .swift 直接放进仓库的 ios/ 目录：ios/ 是 `npx cap add ios` 每次
 * 重新生成的，不入库（见 .gitignore）。所以插件源码放在 native/ios/ 下，构建时
 * 由本脚本注入——注入目标是 Xcode target 里**已经存在**的 Swift 文件，这样不必
 * 改动 project.pbxproj，避免工程文件被写坏。
 *
 * 本脚本是**通用注入器**：扫描 native/ios/ 下的每个 .swift，各自作为一个带标记的
 * 注入块追加进宿主文件，并把它 @objc 声明的类名登记到
 * ios/App/App/capacitor.config.json 的 packageClassList（Capacitor 启动时按此列表
 * 用 NSClassFromString 注册插件）。新增插件只需往 native/ios/ 里丢一个 .swift，
 * 不需要改本脚本，也不需要改工程文件。
 *
 * 全程带断言，任一失败即中止构建，不会产出「看起来成功但功能缺失」的包：
 *   1. 每个插件的注入块恰好一份、类声明恰好一次
 *   2. 每个插件的 jsName 出现在宿主文件里
 *   3. packageClassList 里登记了全部插件类，且原有插件没被挤掉
 *
 * 用法：node scripts/inject-ios-plugins.js
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const iosApp = path.join(root, 'ios', 'App', 'App')
const swiftDir = path.join(root, 'native', 'ios')

function fail(msg) {
  console.error('✗ 注入失败：' + msg)
  process.exit(1)
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* ---------------- 0. 前置检查 ---------------- */
if (!fs.existsSync(iosApp)) {
  fail('未找到 iOS 原生工程目录：' + iosApp + '（请先执行 npx cap add ios / cap sync ios）')
}
if (!fs.existsSync(swiftDir)) fail('缺少 native/ios 目录')

const sources = fs
  .readdirSync(swiftDir)
  .filter((f) => f.endsWith('.swift'))
  .sort()
if (!sources.length) fail('native/ios 下没有任何 .swift 插件源码')

const hosts = ['AppDelegate.swift', 'ViewController.swift'].map((f) => path.join(iosApp, f))
const host = hosts.find((f) => fs.existsSync(f))
if (!host) fail('AppDelegate.swift / ViewController.swift 都不存在，无法注入')

/* ---------------- 1. 逐个注入（幂等：同名块先替换再追加） ---------------- */
let hostCode = fs.readFileSync(host, 'utf8')
const plugins = []

for (const file of sources) {
  const code = fs.readFileSync(path.join(swiftDir, file), 'utf8')
  if (/<\/script/i.test(code)) fail(file + ' 内容异常，中止')

  const classMatch = code.match(/@objc\(([A-Za-z0-9_]+)\)/)
  if (!classMatch) fail(file + ' 里找不到 @objc(ClassName) 类声明')
  const className = classMatch[1]

  const jsMatch = code.match(/jsName\s*=\s*"([^"]+)"/)
  if (!jsMatch) fail(file + ' 里找不到 jsName')
  const jsName = jsMatch[1]

  const BEGIN = '/* ===== [auto-injected] ' + className + ' BEGIN ===== */'
  const END = '/* ===== [auto-injected] ' + className + ' END ===== */'
  const block = BEGIN + '\n' + code.trim() + '\n' + END + '\n'

  if (hostCode.includes(BEGIN)) {
    hostCode = hostCode.replace(new RegExp(escapeRe(BEGIN) + '[\\s\\S]*?' + escapeRe(END)), block.trim())
  } else {
    hostCode = hostCode.replace(/\s*$/, '') + '\n\n' + block
  }

  plugins.push({ file: file, className: className, jsName: jsName })
}

fs.writeFileSync(host, hostCode)
console.log('✓ 已注入 ' + plugins.length + ' 个插件源码：' + path.relative(root, host))
plugins.forEach((p) => console.log('    · ' + p.file + ' → ' + p.className + ' (jsName: ' + p.jsName + ')'))

/* ---------------- 2. 登记插件类名 ---------------- */
const cfgPath = path.join(iosApp, 'capacitor.config.json')
if (!fs.existsSync(cfgPath)) fail('未找到 ios/App/App/capacitor.config.json（cap sync 未完成？）')

let cfg
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
} catch (e) {
  fail('capacitor.config.json 不是合法 JSON：' + e.message)
}
cfg.packageClassList = Array.isArray(cfg.packageClassList) ? cfg.packageClassList : []
plugins.forEach((p) => {
  if (!cfg.packageClassList.includes(p.className)) cfg.packageClassList.push(p.className)
})
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, '\t') + '\n')
console.log('✓ 已登记插件类：packageClassList = ' + JSON.stringify(cfg.packageClassList))

/* ---------------- 3. 结果自检 ---------------- */
const finalHost = fs.readFileSync(host, 'utf8')
const finalCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))

plugins.forEach((p) => {
  if (!new RegExp('@objc\\(' + p.className + '\\)').test(finalHost)) {
    fail('宿主文件中缺少 @objc(' + p.className + ') 类声明')
  }
  if (!new RegExp('jsName\\s*=\\s*"' + p.jsName + '"').test(finalHost)) {
    fail('宿主文件中 ' + p.className + ' 的 jsName 不是 ' + p.jsName)
  }
  if (!finalCfg.packageClassList.includes(p.className)) {
    fail('packageClassList 未登记 ' + p.className)
  }
  const begins = (finalHost.match(new RegExp('\\[auto-injected\\] ' + p.className + ' BEGIN', 'g')) || []).length
  const decls = (finalHost.match(new RegExp('\\bclass ' + p.className + '\\b', 'g')) || []).length
  if (begins !== 1) fail(p.className + ' 注入块数量异常：' + begins + '（应为 1）')
  if (decls !== 1) fail(p.className + ' 类声明数量异常：' + decls + '（应为 1）')
})

/* 关键实现细节一旦被误删，构建必须失败而不是静默产出残缺包 */
if (!/import Security/.test(finalHost)) fail('缺少 import Security（钥匙串 API）')
if (!/SecItemAdd/.test(finalHost) || !/SecItemCopyMatching/.test(finalHost)) fail('钥匙串读写实现缺失')
if (!/import Vision/.test(finalHost) || !/VNRecognizeTextRequest/.test(finalHost)) fail('拍照识别（Vision）实现缺失')
if (!finalCfg.packageClassList.some((x) => String(x).indexOf('Preferences') > -1)) {
  fail('原有插件注册被破坏（Preferences 插件丢失）')
}

console.log('✓ 自检通过：')
plugins.forEach((p) => console.log('    Capacitor.Plugins.' + p.jsName + ' 可用'))
