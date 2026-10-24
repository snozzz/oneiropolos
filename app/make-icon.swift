import AppKit

// 把生成的图标原图（带透明圆角底板）放进 macOS 图标网格：1024 画布、824 底板、四周留阴影空间。
// 用法：make-icon <原图.png> <输出 1024 图标.png> [<输出无边距小图标.png> <边长>]
// 第二个输出给界面里用（侧栏 logo、网页图标），只裁掉透明边，不加阴影。

func loadRep(_ path: String) -> NSBitmapImageRep {
    guard let data = FileManager.default.contents(atPath: path), let rep = NSBitmapImageRep(data: data) else {
        FileHandle.standardError.write("无法读取 \(path)\n".data(using: .utf8)!)
        exit(1)
    }
    return rep
}

/// 底板的实际范围（alpha > 0.5 的外接矩形），坐标原点在左上角
func opaqueBounds(_ rep: NSBitmapImageRep) -> NSRect {
    let w = rep.pixelsWide, h = rep.pixelsHigh
    var minX = w, minY = h, maxX = 0, maxY = 0
    for y in stride(from: 0, to: h, by: 2) {
        for x in stride(from: 0, to: w, by: 2) where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 {
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        }
    }
    return NSRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

func render(size: Int, _ draw: (NSRect) -> Void) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    ctx.imageInterpolation = .high
    NSGraphicsContext.current = ctx
    draw(NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("用法：make-icon <原图.png> <输出1024.png> [<输出小图.png> <边长>]")
    exit(2)
}
let src = loadRep(args[1])
let image = NSImage(size: NSSize(width: src.pixelsWide, height: src.pixelsHigh))
image.addRepresentation(src)
let b = opaqueBounds(src)
// NSImage 的坐标原点在左下角
let crop = NSRect(x: b.minX, y: CGFloat(src.pixelsHigh) - b.maxY, width: b.width, height: b.height)

let icon = render(size: 1024) { _ in
    let body = NSRect(x: 100, y: 112, width: 824, height: 824)
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.32)
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.shadowBlurRadius = 22
    shadow.set()
    image.draw(in: body, from: crop, operation: .sourceOver, fraction: 1)
}
FileManager.default.createFile(atPath: args[2], contents: icon)

if args.count >= 5, let side = Int(args[4]) {
    let small = render(size: side) { rect in
        image.draw(in: rect, from: crop, operation: .sourceOver, fraction: 1)
    }
    FileManager.default.createFile(atPath: args[3], contents: small)
}
