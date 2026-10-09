//
//  LedgerOCRPlugin.swift —— 票据拍照识别（文字识别 / OCR）
//
//  职责只有一个：把一张图片上的文字读出来，交给 JS 层的 native/www/ocr-module.js
//  去解析成「金额 / 日期 / 商户 / 分类」。本插件不做任何业务判断，也不联网。
//
//  为什么用系统自带的 Vision 而不是第三方 SDK：
//    · iOS 13 起系统自带 VNRecognizeTextRequest，中文识别质量足够读发票；
//    · 完全离线，照片不出手机，也不需要任何网络权限；
//    · 不增加任何体积，不引入第三方依赖，不会因为 SDK 过期而失效。
//
//  本文件由 scripts/inject-ios-plugins.js 在 CI 构建时整段注入到
//  ios/App/App/AppDelegate.swift（该文件已在 Xcode target 内，保证被编译），
//  并在 ios/App/App/capacitor.config.json 的 packageClassList 里登记类名，
//  Capacitor 启动时会据此注册插件（见 CapacitorBridge.registerPlugins）。
//
//  JS 侧用法：Capacitor.Plugins.LedgerOCR.recognize({ path })
//             → { text: "识别到的多行文字", lines: 行数 }
//

import UIKit
import Vision

@objc(LedgerOCRPlugin)
public class LedgerOCRPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "LedgerOCRPlugin"
    public let jsName = "LedgerOCR"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: "promise"),
        CAPPluginMethod(name: "recognize", returnType: "promise")
    ]

    /// 识别能力探测（前端据此决定是否显示「拍票入账」）
    @objc func available(_ call: CAPPluginCall) {
        var ok = false
        if #available(iOS 13.0, *) { ok = true }
        call.resolve(["available": ok, "engine": "vision"])
    }

    /// 识别一张本地图片；path 支持 file:// 前缀与 Capacitor 的 _capacitor_file_ 形式
    @objc func recognize(_ call: CAPPluginCall) {
        guard let raw = call.getString("path"), !raw.isEmpty else {
            call.reject("缺少图片路径")
            return
        }

        let path = LedgerOCRPlugin.normalize(raw)
        guard let image = UIImage(contentsOfFile: path) else {
            call.reject("读不到这张图片：\(path)")
            return
        }

        // 手机拍出来动辄 12MP，先缩到长边 2200px：识别更快，精度几乎不变
        let scaled = LedgerOCRPlugin.downscale(image, maxSide: 2200)
        guard let cgImage = scaled.cgImage ?? image.cgImage else {
            call.reject("这张图片的格式不支持识别")
            return
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        if #available(iOS 16.0, *) {
            request.automaticallyDetectsLanguage = false
        }

        let handler = VNImageRequestHandler(
            cgImage: cgImage,
            orientation: LedgerOCRPlugin.orientation(of: image),
            options: [:]
        )

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
                let observations = request.results ?? []
                // Vision 的坐标原点在左下角：midY 越大越靠上，按此把行还原成从上到下
                let lines = observations
                    .sorted { $0.boundingBox.midY > $1.boundingBox.midY }
                    .compactMap { $0.topCandidates(1).first?.string }
                let payload: [String: Any] = [
                    "text": lines.joined(separator: "\n"),
                    "lines": lines.count
                ]
                call.resolve(payload)
            } catch {
                call.reject("识别失败：\(error.localizedDescription)")
            }
        }
    }

    // MARK: - 内部工具

    /// 兼容 file:// 与 Capacitor 的 webPath 写法
    private static func normalize(_ p: String) -> String {
        var s = p
        if let r = s.range(of: "_capacitor_file_") {
            s = String(s[r.upperBound...])
            return s.removingPercentEncoding ?? s
        }
        if s.hasPrefix("file://") {
            return String(s.dropFirst(7))
        }
        return s
    }

    /// 等比缩放到长边不超过 maxSide；本来就够小则原样返回
    private static func downscale(_ image: UIImage, maxSide: CGFloat) -> UIImage {
        let w = image.size.width
        let h = image.size.height
        let longSide = max(w, h)
        if longSide <= maxSide || longSide <= 0 || w <= 0 || h <= 0 {
            return image
        }
        let k = maxSide / longSide
        let target = CGSize(width: floor(w * k), height: floor(h * k))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    /// UIImage 的 EXIF 方向 → Vision 需要的方向枚举（竖拍照片必用，否则识别结果是歪的）
    private static func orientation(of image: UIImage) -> CGImagePropertyOrientation {
        switch image.imageOrientation {
        case .up: return .up
        case .upMirrored: return .upMirrored
        case .down: return .down
        case .downMirrored: return .downMirrored
        case .left: return .left
        case .leftMirrored: return .leftMirrored
        case .right: return .right
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}
