#!/usr/bin/env bash
# macOS 本地一键构建签名 IPA（需要 Xcode 15+ 与 Apple 开发者账号材料）
#
# 用法：
#   TEAM_ID=ABC123XYZ PROFILE="随手记账 Adhoc" bash scripts/build-ipa.sh
#
#   TEAM_ID    开发者 Team ID（developer.apple.com → Membership details）
#   PROFILE    已下载的描述文件（Provisioning Profile）名称，需包含本机设备（ad-hoc/开发）
#
# 产物：build/ipa/随手记账.ipa
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM_ID="${TEAM_ID:?请设置 TEAM_ID}"
PROFILE="${PROFILE:?请设置 PROFILE（描述文件名称）}"
BUNDLE_ID="${BUNDLE_ID:-com.suishou.ledger}"
METHOD="${METHOD:-ad-hoc}"   # ad-hoc | development

# 1. 原生工程
if [ ! -d ios ]; then
  echo "==> 生成 iOS 原生工程"
  npx cap add ios
fi
echo "==> 同步 Web 资源"
npx cap sync ios
bash scripts/patch-ios-plist.sh

# 2. 图标（可选）
python3 scripts/make-assets.py || true
npx @capacitor/assets generate --ios || true

# 3. CocoaPods
echo "==> 安装 CocoaPods 依赖"
pod install --project-directory=ios/App

# 4. 导出选项（由模板填充）
mkdir -p build
sed -e "s/__TEAM_ID__/$TEAM_ID/g" \
    -e "s/__BUNDLE_ID__/$BUNDLE_ID/g" \
    -e "s/__PROFILE__/$PROFILE/g" \
    "signing/ExportOptions-$METHOD.plist" > build/ExportOptions.plist

# 5. 归档 + 导出
echo "==> 归档"
xcodebuild archive \
  -workspace ios/App/App.xcworkspace \
  -scheme App -configuration Release \
  -archivePath build/App.xcarchive \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE"

echo "==> 导出 IPA"
xcodebuild -exportArchive \
  -archivePath build/App.xcarchive \
  -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/ipa \
  -allowProvisioningUpdates

echo
echo "完成。IPA 位于 build/ipa/"
ls -lh build/ipa/*.ipa
