// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "OpenFitnessKit",
  defaultLocalization: "en",
  platforms: [.iOS("26.0"), .watchOS("26.0"), .macOS("15.0")],
  products: [.library(name: "OpenFitnessKit", targets: ["OpenFitnessKit"])],
  targets: [
    .target(name: "OpenFitnessKit", resources: [.process("Resources")]),
    .testTarget(name: "OpenFitnessKitTests", dependencies: ["OpenFitnessKit"]),
  ]
)
