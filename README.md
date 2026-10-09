# 随手记账 · iOS 客户端（IPA 打包工程）

把「随手记账」打包成**独立 iPhone App（.ipa）**的完整工程：Capacitor 原生壳 +
网页版应用 + 应用图标 / 启动图 + 云端构建流水线。

> **为什么需要这个工程？** 微信小程序运行在微信里，不是独立 App，无法生成 IPA。
> IPA 是苹果原生应用的安装包，必须有一个真正的 iOS 工程（Xcode）编译签名产出。
> 本工程已把这件事全部做好，你只需要走完下面任意一条路线。

应用本体在 `www/index.html`，与小程序版共用同一套交互与逻辑（智能归类、周期自动
记账、批量导入、预算、Canvas 图表），数据只存在手机本地，**无任何网络请求**。

## 当前交付状态：IPA 已构建完成

| 项目 | 值 |
|---|---|
| IPA 文件 | `C:\Users\Administrator\Desktop\SuishouLedger.ipa` |
| 大小 | 942,307 字节（解包后 2.5 MB，25 个文件） |
| App 名称 / 包名 | 随手记账 / `com.suishou.ledger` |
| 版本 / 最低系统 | 1.0.0 (1) / iOS 13.0 |
| 架构 | arm64（Mach-O 64 位，魔数 `0xFEEDFACF`） |
| 构建方式 | GitHub Actions `macos-14`，Run `37902630088`，**1 分 11 秒** |
| 仓库 | <https://github.com/chenzeyu518/suishou-ledger-ios>（public） |
| 签名状态 | **未签名**，需用免费 Apple ID 通过 Sideloadly 重签安装（见路线 A 第 3 步） |

包已实测校验：`Payload/App.app` 位于压缩包根（符合 IPA 规范），Capacitor /
CapacitorHaptics / Cordova 框架与图标、启动图齐全，包内 `public/index.html`
与本地 `www/index.html` **md5 完全一致**。

## 目录结构

```
ledger-ios/
├── www/index.html              # 应用本体（正式版：无演示数据、无预览徽标、原生外壳适配）
├── assets/                     # 应用图标 + 启动图（scripts/make-assets.py 生成）
├── capacitor.config.json       # App ID: com.suishou.ledger
├── package.json                # Capacitor 6 依赖
├── scripts/
│   ├── build-ipa.sh            # Mac 本地一键构建签名 IPA
│   ├── patch-ios-plist.sh      # 配置 Info.plist（显示名/浅色界面/竖屏/状态栏）
│   ├── make-assets.py          # 重新生成图标与启动图（纯标准库，可自定义配色）
│   ├── sync-from-preview.js    # 从 H5 预览页同步生成正式版 www/index.html
│   └── test-www.js             # 冒烟测试（18 项断言 + 重启持久化检查）
├── signing/                    # 签名导出配置模板（ad-hoc / development / app-store）
└── .github/workflows/ios-ipa.yml   # GitHub Actions 云端构建 → 产出 .ipa
```

## 三条路线怎么选

| 路线 | 你需要 | 费用 | 装上后有效期 |
|---|---|---|---|
| **A. 云端构建 + 免费签名**（推荐） | GitHub 账号 + 这台 Windows 电脑 + 数据线 + 免费 Apple ID | 0 元 | 7 天，到期重签即可 |
| B. 云端构建 + 付费签名 | 上面的 + Apple Developer（99 美元/年） | 99 美元/年 | 1 年，可上 TestFlight |
| C. 本地 Mac 构建 | 一台 Mac + Xcode 15+ | 视账号 | 同上 |

---

## 路线 A：云端构建，免费装到 iPhone（无需 Mac）

> **当前状态：这一步已经完成过了。**
> 仓库地址 <https://github.com/chenzeyu518/suishou-ledger-ios>（public），
> 首次构建 Run `37902630088` 用时 **1 分 11 秒**，产出的
> `SuishouLedger.ipa`（942,307 字节）已放在桌面。直接从「第 3 步」开始即可。
> 下面第 1、2 步保留，供以后改动代码后重新构建时参考。

### 第 1 步：把工程推到 GitHub

仓库已建好并已绑定远程，日常更新只需：

```bash
cd "C:/Users/Administrator/WorkBuddy/2026-10-09-14-43-39/ledger-ios"
git add . && git commit -m "更新说明"
git push
```

从零开始的完整命令（换新仓库时用）：

```bash
cd ledger-ios
git init && git add . && git commit -m "随手记账 iOS 打包工程"
git remote add origin https://github.com/<你的用户名>/suishou-ledger-ios.git
git push -u origin main
```

> 注意：推送 `.github/workflows/` 下的流水线文件要求令牌具备 **`workflow`** 作用域。
> gh CLI 默认令牌只有 `repo, read:org, gist`，需先执行
> `gh auth refresh -h github.com -s workflow` 补充授权，否则 GitHub 会拒绝推送。

### 第 2 步：云端自动构建

推送后 GitHub Actions 会自动开始构建（或到 **Actions → Build iOS IPA → Run
workflow** 手动触发）。实测约 **1~2 分钟**出包（首次含 pod install 会更久些）。

用 gh CLI 一条命令取回产物：

```bash
GH="C:/Users/Administrator/.workbuddy/tools/gh/bin/gh.exe"
"$GH" run list --repo chenzeyu518/suishou-ledger-ios --limit 1
"$GH" run download <RunID> --repo chenzeyu518/suishou-ledger-ios \
      -n SuishouLedger-unsigned-ipa -D ./ipa-out
```

或在该次运行页面底部 **Artifacts** 下载 `SuishouLedger-unsigned-ipa`，
解压得到 `SuishouLedger-unsigned.ipa`。

> 这是**未签名** IPA——苹果规定安装包必须签名，下一步用你自己的 Apple ID 签。

### 第 3 步：在 Windows 上签名并安装

1. 下载安装 [Sideloadly](https://sideloadly.io)（还需装
   [iTunes](https://www.apple.com/itunes/) 与 iCloud 的官网版以提供手机驱动）
2. 数据线连接 iPhone，首次连接请在手机上点「信任」
3. 打开 Sideloadly：拖入 `.ipa` → 输入你的 Apple ID → 点 **Start**
4. 完成后，手机上 **设置 → 通用 → VPN 与设备管理 → 信任** 你的 Apple ID 证书
5. 桌面出现「随手记账」，可以用了

**须知（苹果免费账号的限制，与本项目无关）：**
- 签名 **7 天有效**，过期后 App 打不开；重做第 3 步即可，**数据不会丢**
- 一个免费 Apple ID 同时最多签 3 个自装 App
- 想一劳永逸 → 路线 B

### 第 4 步（可选）：升级为付费账号的签名 IPA

付费开发者账号（99 美元/年）可在仓库 **Settings → Secrets and variables →
Actions** 配置以下 secrets，流水线会自动切换为签名导出（可装 1 年、可分发、可上
TestFlight）：

| Secret | 内容 |
|---|---|
| `BUILD_CERTIFICATE_BASE64` | p12 证书的 base64（`certutil -encode xxx.p12 xxx.txt` 取正文） |
| `P12_PASSWORD` | p12 导出密码 |
| `BUILD_PROVISION_PROFILE_BASE64` | 描述文件 `.mobileprovision` 的 base64 |
| `PROFILE_NAME` | 描述文件「名称」（Apple Developer 网站上显示的名字） |
| `TEAM_ID` | 开发者 Team ID |
| `KEYCHAIN_PASSWORD` | 任意字符串（CI 临时钥匙串密码） |

手动触发时选择 mode = `unsigned` 可随时强制走未签名路线。

---

## 路线 C：Mac 本地构建（有 Mac 时最快）

```bash
cd ledger-ios
npm install
TEAM_ID=你的TeamID PROFILE="描述文件名称" bash scripts/build-ipa.sh
# 产物：build/ipa/*.ipa
```

或者：`npm run open` 打开 Xcode → 选好 Team → **Product → Archive → Distribute App**。

## 常见问题

- **图标/配色想换？** `python3 scripts/make-assets.py --top "#16B364" --bottom "#0B7A4B"`，重新构建即可
- **改了网页版功能？** 改 `www/index.html`（或改预览页后 `node scripts/sync-from-preview.js`），推送自动重新构建
- **数据安全吗？** 应用无任何网络请求，账单只存在手机本地；「我的 → 导出备份（JSON）」可随时备份
- **能上 App Store 吗？** 技术上可以（Capacitor 壳 + 无敏感权限，走标准审核），需补充隐私政策与账号资料；上架前建议删除「从剪贴板恢复」相关能力以简化隐私声明

## 本地验证

```bash
npm test        # 18 项断言：启动/记账/归类/持久化/周期引擎/导入，0 运行期错误
```
