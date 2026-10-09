//
//  LedgerVaultPlugin.swift —— 钥匙串（Keychain）保险柜
//
//  为什么需要它：iPhone 上应用沙盒里的任何存储（UserDefaults、WebView 的
//  localStorage、Documents 目录）都会随 App 一起被删除；用免费 Apple ID 侧载
//  签名时，重签安装也可能让 iOS 换掉整个数据容器。**钥匙串是 iOS 上唯一在
//  「卸载 App / 重新签名安装」之后仍然保留的本地存储**，所以账本必须往这里
//  再存一份，才能在覆盖安装、重装、重签之后自动长回来。
//
//  本文件由 scripts/inject-ios-vault.js 在 CI 构建时整段注入到
//  ios/App/App/AppDelegate.swift（该文件已在 Xcode target 内，保证被编译），
//  并在 ios/App/App/capacitor.config.json 的 packageClassList 里登记类名，
//  Capacitor 启动时会据此注册插件（见 CapacitorBridge.registerPlugins）。
//
//  JS 侧用法：Capacitor.Plugins.LedgerVault.readVault() / writeVault({value}) / clearVault()
//  只做三件事：读、写、清空，不发送任何数据，不联网。
//

import Security

@objc(LedgerVaultPlugin)
public class LedgerVaultPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "LedgerVaultPlugin"
    public let jsName = "LedgerVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "readVault", returnType: "promise"),
        CAPPluginMethod(name: "writeVault", returnType: "promise"),
        CAPPluginMethod(name: "clearVault", returnType: "promise")
    ]

    private let vaultService = "com.suishou.ledger.vault"
    private let vaultAccount = "ledger-backup"

    private var baseQuery: [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: vaultService,
            kSecAttrAccount as String: vaultAccount
        ]
    }

    /// 写入保险柜（内容整体覆盖，先更新、不存在再新增）
    @objc func writeVault(_ call: CAPPluginCall) {
        guard let value = call.getString("value"),
              let data = value.data(using: .utf8) else {
            call.reject("value required")
            return
        }

        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]

        // 先试更新（避免出现短暂的数据空窗）
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attrs as CFDictionary)
        if updateStatus == errSecSuccess {
            call.resolve(["ok": true, "bytes": data.count])
            return
        }

        var addQuery = baseQuery
        addQuery.merge(attrs) { _, new in new }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess {
            call.resolve(["ok": true, "bytes": data.count])
        } else {
            call.reject("keychain write failed: \(addStatus)")
        }
    }

    /// 读取保险柜；不存在时回空串（JS 侧按「无副本」处理）
    @objc func readVault(_ call: CAPPluginCall) {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        if status == errSecItemNotFound {
            call.resolve(["value": ""])
            return
        }
        guard status == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8) else {
            call.reject("keychain read failed: \(status)")
            return
        }
        call.resolve(["value": text])
    }

    /// 清空保险柜（仅在用户主动清空账本时调用）
    @objc func clearVault(_ call: CAPPluginCall) {
        let status = SecItemDelete(baseQuery as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve(["ok": true])
        } else {
            call.reject("keychain clear failed: \(status)")
        }
    }
}
