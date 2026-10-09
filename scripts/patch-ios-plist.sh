#!/usr/bin/env bash
# 调整 Capacitor 生成的 iOS 工程 Info.plist（在 macOS 上运行，CI 与本地通用）：
#   1. 显示名改为「随手记账」
#   2. 强制浅色界面 + 深色状态栏文字（应用为浅色主题，默认模板的状态栏文字是白色，会看不清）
#   3. 锁定竖屏
#   4. 声明不使用非豁免加密，避免 TestFlight 出口合规问答
set -euo pipefail
cd "$(dirname "$0")/.."

PLIST="ios/App/App/Info.plist"
PB="/usr/libexec/PlistBuddy"
if [ ! -f "$PLIST" ]; then
  echo "未找到 $PLIST，请先执行: npx cap add ios" >&2
  exit 1
fi

set_key() { # set_key <键名> <类型> <值>
  "$PB" -c "Set :$1 $3" "$PLIST" 2>/dev/null || "$PB" -c "Add :$1 $2 $3" "$PLIST"
}

set_key CFBundleDisplayName string "随手记账"
# 版本号与 package.json 保持一致；构建号优先取 CI 运行号（每次构建递增），本地回退为 1
APP_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "1.1.0")"
BUILD_NUMBER="${GITHUB_RUN_NUMBER:-1}"
set_key CFBundleShortVersionString string "$APP_VERSION"
set_key CFBundleVersion string "$BUILD_NUMBER"
set_key UIUserInterfaceStyle string "Light"
set_key UIStatusBarStyle string "UIStatusBarStyleDarkContent"
set_key UIViewControllerBasedStatusBarAppearance bool false
set_key ITSAppUsesNonExemptEncryption bool false

# 让「文件」App 能看到 App 的 Documents 目录（备份文件放这里，用户可自行拷出/存 iCloud）
set_key UIFileSharingEnabled bool true
set_key LSSupportsOpeningDocumentsInPlace bool true

# 拍照识别票据（发票 / 小票）需要的用途说明
# iOS 上只要用到相机或相册就必须声明，否则一调用就被系统直接杀掉进程
set_key NSCameraUsageDescription string "用于拍摄发票、小票，在手机上识别成账目，照片不会上传。"
set_key NSPhotoLibraryUsageDescription string "用于从相册选择发票或小票图片，识别成账目。"
set_key NSPhotoLibraryAddUsageDescription string "用于把票据照片保存到相册。"

# 仅竖屏
"$PB" -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
"$PB" -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"

echo "✓ Info.plist 已配置（显示名 / 浅色界面 / 深色状态栏文字 / 竖屏 / 文件共享 / 相机与相册用途）"
