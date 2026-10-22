import OpenFitnessKit
import SwiftUI

struct MuscleMapView: View {
  @Environment(AppModel.self) private var model
  var diagram: ExerciseDiagram?
  var genderOverride = ""
  var accessibilitySummary: String
  @State private var artwork: [String: MuscleMapArtwork] = [:]
  private var gender: String { genderOverride.isEmpty ? diagram?.gender ?? "male" : genderOverride }
  private var highlights: [DiagramHighlight] { diagram?.highlights?.filter(\.matched) ?? [] }

  var body: some View {
    Group {
      if model.supportsExerciseCatalog, !highlights.isEmpty, !artwork.isEmpty {
        HStack(alignment: .top, spacing: 12) {
          ForEach(diagram?.views ?? [], id: \.self) { view in
            if let map = artwork[view] {
              VStack {
                MuscleMapCanvas(artwork: map, highlights: highlights)
                  .aspectRatio(map.viewBox.width / map.viewBox.height, contentMode: .fit)
                Text(model.text(view == "front" ? .bodyFront : .bodyBack))
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }.accessibilityElement(children: .ignore).accessibilityLabel(accessibilitySummary)
      }
    }
    .task(id: "\(model.accountKey)-\(gender)-\(diagram?.views.joined() ?? "")") {
      artwork = [:]
      guard model.supportsExerciseCatalog, !highlights.isEmpty else { return }
      for view in diagram?.views ?? [] {
        if let value = try? await model.muscleMap(gender: gender, view: view), !Task.isCancelled {
          artwork[view] = value
        }
      }
    }
  }
}

private struct MuscleMapCanvas: View {
  var artwork: MuscleMapArtwork
  var highlights: [DiagramHighlight]
  var body: some View {
    Canvas { context, size in
      let box = artwork.viewBox
      let scaleX = size.width / box.width
      let scaleY = size.height / box.height
      let transform = CGAffineTransform(
        a: scaleX, b: 0, c: 0, d: scaleY, tx: -box.x * scaleX, ty: -box.y * scaleY)
      for commands in artwork.outline {
        context.fill(path(commands).applying(transform), with: .color(Color(.secondarySystemFill)))
      }
      for surface in artwork.surfaces.keys.sorted() {
        let highlight = highlights.filter { $0.surfaces.contains(surface) }.sorted {
          $0.role == "primary" && $1.role != "primary"
        }.first
        for commands in artwork.surfaces[surface] ?? [] {
          let shape = path(commands).applying(transform)
          context.fill(shape, with: .color(Color(.tertiarySystemFill)))
          if let highlight {
            let weight = min(1, max(0, highlight.weight ?? 1))
            let opacity = (highlight.role == "primary" ? 1.0 : 0.5) * (0.35 + 0.65 * weight)
            context.fill(shape, with: .color(.green.opacity(opacity)))
          }
          context.stroke(shape, with: .color(.secondary.opacity(0.25)), lineWidth: 0.4)
        }
      }
    }
  }
  private func path(_ commands: [PathCommand]) -> Path {
    var path = Path()
    for command in commands {
      switch command {
      case .move(let x, let y): path.move(to: CGPoint(x: x, y: y))
      case .line(let x, let y): path.addLine(to: CGPoint(x: x, y: y))
      case .cubic(let x1, let y1, let x2, let y2, let x, let y):
        path.addCurve(
          to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
      case .close: path.closeSubpath()
      }
    }
    return path
  }
}
