import AppKit
import Foundation

let root = URL(
  fileURLWithPath: CommandLine.arguments.dropFirst().first
    ?? FileManager.default.currentDirectoryPath)
let size = NSSize(width: 1024, height: 1024)
let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 3,
  hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let frame = NSRect(origin: .zero, size: size)
NSGradient(colors: [
  NSColor(srgbRed: 0.04, green: 0.18, blue: 0.15, alpha: 1),
  NSColor(srgbRed: 0.08, green: 0.55, blue: 0.35, alpha: 1),
])!.draw(in: frame, angle: 55)
NSColor.white.withAlphaComponent(0.14).setStroke()
let ring = NSBezierPath(ovalIn: frame.insetBy(dx: 116, dy: 116))
ring.lineWidth = 22
ring.stroke()
NSColor.white.setFill()
for block in [
  NSRect(x: 300, y: 470, width: 424, height: 84),
  NSRect(x: 326, y: 320, width: 90, height: 384),
  NSRect(x: 608, y: 320, width: 90, height: 384),
  NSRect(x: 244, y: 392, width: 64, height: 240),
  NSRect(x: 716, y: 392, width: 64, height: 240),
] {
  NSBezierPath(roundedRect: block, xRadius: 22, yRadius: 22).fill()
}
NSGraphicsContext.restoreGraphicsState()
let data = bitmap.representation(using: .png, properties: [:])!
for name in ["OpenFitness", "OpenFitnessWatch"] {
  let catalog = root.appendingPathComponent("apps/ios/\(name)/Assets.xcassets")
  let icon = catalog.appendingPathComponent("AppIcon.appiconset")
  try FileManager.default.createDirectory(at: icon, withIntermediateDirectories: true)
  try data.write(to: icon.appendingPathComponent("AppIcon.png"))
}
print("Generated native application icons.")
