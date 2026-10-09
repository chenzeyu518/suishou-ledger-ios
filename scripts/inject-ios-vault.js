#!/usr/bin/env node
/**
 * 把「钥匙串保险柜」原生插件注入到 Capacitor 生成的 iOS 工程里（CI 构建时执行）。
 *
 * 为什么不把 .swift 直接放进仓库的 ios/ 目录：ios/ 是 `npx cap add ios` 每次
 * 重新生成的，不入库（见 .gitignore）。所以插件源码放在 native/ios/ 下，构建时
 * 由本脚本注入——注入目标是 Xcode target 里**已经存在**的 Swift 文件，这样不必
 * 改动 project.pbxproj，避免工程文件被写坏。
 *
 * 做三件事（全部带断言，任一失败即中止构建，不会产出「看起来成功但功能缺失」的包）：
 *   1. 把 native/ios/LedgerVaultPlugin.swift 追加进 AppDelegate.swift（幂等，带标记）
 *   2. 在 ios/App/App/capacitor.config.json 的 packageClassList 登记 LedgerVaultPlugin
 *      （Capacitor 启动时按此列表注册插件）
 *   3. 校验注入结果：类名、jsName、packageClassList、宿主文件均正确
 *
 * 用法：node scripts/inject-ios-vault.js
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const iosApp = path.join(root, 'ios', 'App', 'App')

function fail(msg) {
  console.error('✗ 注入失败：' + msg)
  process.exit(1)
}

/* ---------------- 0. 前置检查 ---------------- */
if (!fs.existsSync(iosApp)) fail('未找到 iOS 原生工程目录：' + iosApp + '（请先执行 npx cap add ios / cap sync ios）')

const swiftSrc = path.join(root, 'native', 'ios', 'LedgerVaultPlugin.swift')
if (!fs.existsSync(swiftSrc)) fail('缺少 native/ios/LedgerVaultPlugin.swift')
const pluginCode = fs.readFileSync(swiftSrc, 'utf8')

/* ---------------- 1. 注入到已存在的 Swift 宿主文件 ---------------- */
const BEGIN = '/* ===== [auto-injected] LedgerVaultPlugin BEGIN ===== */'
const END = '/* ===== [auto-injected] LedgerVaultPlugin END ===== */'
const block = `${BEGIN}\n${pluginCode.trim()}\n${END}\n`

const hosts = ['AppDelegate.swift', 'ViewController.swift'].map((f) => path.join(iosApp, f))
const host = hosts.find((f) => fs.existsSync(f))
if (!host) fail('AppDelegate.swift / ViewController.swift 都不存在，无法注入')

let hostCode = fs.readFileSync(host, 'utf8')
if (hostCode.includes(BEGIN)) {
  /* 幂等：替换旧的注入块，便于本脚本反复执行 */
  const re = new RegExp(
    BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )
  hostCode = hostCode.replace(re, block.trim())
} else {
  hostCode = hostCode.replace(/\s*$/, '') + '\n\n' + block
}
fs.writeFileSync(host, hostCode)
console.log('✓ 已注入插件源码：' + path.relative(root, host))

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
if (!cfg.packageClassList.includes('LedgerVaultPlugin')) cfg.packageClassList.push('LedgerVaultPlugin')
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, '\t') + '\n')
console.log('✓ 已登记插件类：packageClassList = ' + JSON.stringify(cfg.packageClassList))

/* ---------------- 3. 结果自检 ---------------- */
const finalHost = fs.readFileSync(host, 'utf8')
const finalCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))

if (!/@objc\(LedgerVaultPlugin\)/.test(finalHost)) fail('宿主文件中缺少 @objc(LedgerVaultPlugin) 类声明')
if (!/public let jsName = "LedgerVault"/.test(finalHost)) fail('插件 jsName 不是 LedgerVault')
if (!/import Security/.test(finalHost)) fail('缺少 import Security（钥匙串 API）')
if (!/SecItemAdd/.test(finalHost) || !/SecItemCopyMatching/.test(finalHost)) fail('钥匙串读写实现缺失')
if (!finalCfg.packageClassList.includes('LedgerVaultPlugin')) fail('packageClassList 未登记 LedgerVaultPlugin')
if (!finalCfg.packageClassList.includes('PreferencesPlugin')) fail('原有插件注册被破坏（PreferencesPlugin 丢失）')

/* 注入块必须恰好一份、类声明恰好一次（防止重复注入导致「重复定义」编译失败） */
const begins = (finalHost.match(/\[auto-injected\] LedgerVaultPlugin BEGIN/g) || []).length
const classes = (finalHost.match(/class LedgerVaultPlugin/g) || []).length
if (begins !== 1) fail(`注入块数量异常：${begins}（应为 1）`)
if (classes !== 1) fail(`LedgerVaultPlugin 类声明数量异常：${classes}（应为 1）`)

console.log('✓ 自检通过：插件已就位，JS 侧可用 Capacitor.Plugins.LedgerVault')
