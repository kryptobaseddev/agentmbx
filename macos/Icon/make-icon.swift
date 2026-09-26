// Draws the AgentMBX app icon (rounded-square gradient with an envelope and an "MBX" wordmark) into an
// .iconset folder at every size iconutil expects. No image assets: everything is drawn with AppKit.
//   swiftc make-icon.swift -o make-icon && ./make-icon <out.iconset>
import AppKit

func draw(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                             bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px) / 1024  // design on a 1024 grid; Apple's icon body is 824 wide, inset 100
  let body = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)

  // soft drop shadow + squircle-ish rounded square with an indigo→teal gradient
  let shape = NSBezierPath(roundedRect: body, xRadius: 185 * s, yRadius: 185 * s)
  NSGraphicsContext.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
  shadow.shadowOffset = NSSize(width: 0, height: -12 * s)
  shadow.shadowBlurRadius = 24 * s
  shadow.set()
  NSColor(calibratedRed: 0.20, green: 0.22, blue: 0.55, alpha: 1).setFill()
  shape.fill()
  NSGraphicsContext.restoreGraphicsState()
  NSGradient(colors: [NSColor(calibratedRed: 0.31, green: 0.27, blue: 0.90, alpha: 1),
                      NSColor(calibratedRed: 0.05, green: 0.66, blue: 0.72, alpha: 1)])!
    .draw(in: shape, angle: -60)

  // envelope
  let env = NSRect(x: 250 * s, y: 390 * s, width: 524 * s, height: 360 * s)
  let envPath = NSBezierPath(roundedRect: env, xRadius: 44 * s, yRadius: 44 * s)
  NSColor.white.setFill()
  envPath.fill()
  let flap = NSBezierPath()
  flap.move(to: NSPoint(x: env.minX + 30 * s, y: env.maxY - 34 * s))
  flap.line(to: NSPoint(x: env.midX, y: env.minY + 150 * s))
  flap.line(to: NSPoint(x: env.maxX - 30 * s, y: env.maxY - 34 * s))
  flap.lineWidth = max(1, 34 * s)
  flap.lineCapStyle = .round
  flap.lineJoinStyle = .round
  NSColor(calibratedRed: 0.27, green: 0.35, blue: 0.85, alpha: 1).setStroke()
  flap.stroke()

  // signature seal: a small teal dot with a check, hinting "signed"
  let seal = NSRect(x: env.maxX - 120 * s, y: env.minY - 60 * s, width: 170 * s, height: 170 * s)
  NSColor(calibratedRed: 0.05, green: 0.75, blue: 0.62, alpha: 1).setFill()
  NSBezierPath(ovalIn: seal).fill()
  NSColor.white.setStroke()
  let tick = NSBezierPath()
  tick.move(to: NSPoint(x: seal.minX + 45 * s, y: seal.midY))
  tick.line(to: NSPoint(x: seal.minX + 75 * s, y: seal.midY - 30 * s))
  tick.line(to: NSPoint(x: seal.maxX - 40 * s, y: seal.midY + 35 * s))
  tick.lineWidth = max(1, 20 * s)
  tick.lineCapStyle = .round
  tick.lineJoinStyle = .round
  tick.stroke()

  // wordmark (skipped at tiny sizes where it would only be noise)
  if px >= 64 {
    let font = NSFont.systemFont(ofSize: 150 * s, weight: .heavy)
    let para = NSMutableParagraphStyle(); para.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white,
                                                .kern: 12 * s, .paragraphStyle: para]
    NSAttributedString(string: "MBX", attributes: attrs)
      .draw(in: NSRect(x: body.minX, y: 150 * s, width: body.width, height: 190 * s))
  }
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  try draw(base).write(to: URL(fileURLWithPath: "\(out)/icon_\(base)x\(base).png"))
  try draw(base * 2).write(to: URL(fileURLWithPath: "\(out)/icon_\(base)x\(base)@2x.png"))
}
print("wrote \(out)")
