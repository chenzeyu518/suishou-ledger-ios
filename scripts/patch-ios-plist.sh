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
set_key CFBundleShortVersionString string "1.0.0"
set_key CFBundleVersion string "1"
set_key UIUserInterfaceStyle string "Light"
set_key UIStatusBarStyle string "UIStatusBarStyleDarkContent"
set_key UIViewControllerBasedStatusBarAppearance bool false
set_key ITSAppUsesNonExemptEncryption bool false

# 仅竖屏
"$PB" -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
"$PB" -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"

echo "✓ Info.plist 已配置（显示名 / 浅色界面 / 深色状态栏文字 / 竖屏）"
