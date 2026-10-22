import OpenFitnessKit
import SwiftUI

struct MuscleMapView: View {
  @Environment(AppModel.self) private var model
  var diagram: ExerciseDiagram?
  var genderOverride = ""
  var accessibilitySummary: String
  @State private var phase: Phase = .idle
  @State private var attempt = 0
  @State private var loadGeneration = 0
  private var gender: String { genderOverride.isEmpty ? diagram?.gender ?? "male" : genderOverride }
  private var highlights: [DiagramHighlight] { diagram?.highlights?.filter(\.matched) ?? [] }
  private var diagramViews: [String] { diagram?.views ?? [] }
  private var mapAspect: CGFloat {
    let count = CGFloat(max(diagramViews.count, 1))
    let gaps = CGFloat(max(diagramViews.count - 1, 0)) * 12
    return (1024 * count + gaps) / 1536
  }

  private enum Phase {
    case idle
    case loading
    case loaded(String, [String: MuscleMapArtwork])
    case failed(String)
    case noDiagram
  }
  private struct ArtworkKey: Hashable {
    var account: String
    var supported: Bool
    var gender: String
    var views: [String]
    var highlights: [DiagramHighlight]
    var attempt: Int
  }

  var body: some View {
    Group {
      switch displayed {
      case .idle, .loading: loadingPlaceholder
      case .loaded(let loadedGender, let artwork): loadedMap(artwork, gender: loadedGender)
      case .failed(let message): failure(message)
      case .noDiagram: emptyState
      }
    }
    .frame(maxWidth: .infinity)
    .task(
      id: ArtworkKey(
        account: model.accountKey, supported: model.supportsExerciseCatalog, gender: gender,
        views: diagramViews, highlights: highlights, attempt: attempt)
    ) {
      await load()
    }
  }

  private var displayed: Phase {
    switch phase {
    case .loaded(let loadedGender, _) where loadedGender != gender: return .loading
    case .idle where !model.supportsExerciseCatalog: return .failed(model.text(.updateServer))
    case .idle where highlights.isEmpty: return .noDiagram
    case .idle: return .loading
    default: return phase
    }
  }

  private func load() async {
    loadGeneration += 1
    let generation = loadGeneration
    guard model.supportsExerciseCatalog else {
      phase = .failed(model.text(.updateServer))
      return
    }
    guard !highlights.isEmpty, !diagramViews.isEmpty else {
      phase = .noDiagram
      return
    }
    phase = .loading
    let requestedGender = gender
    do {
      var artwork: [String: MuscleMapArtwork] = [:]
      for view in diagramViews {
        artwork[view] = try await model.muscleMap(gender: requestedGender, view: view)
        try Task.checkCancellation()
      }
      guard generation == loadGeneration else { return }
      phase = .loaded(requestedGender, artwork)
    } catch is CancellationError {
      return
    } catch {
      guard generation == loadGeneration, !Task.isCancelled else { return }
      phase = .failed(model.copy.error(error))
    }
  }

  private var loadingPlaceholder: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 28, style: .continuous)
        .fill(Color(.quaternarySystemFill))
        .aspectRatio(mapAspect, contentMode: .fit)
        .frame(maxHeight: 300)
        .redacted(reason: .placeholder)
      ProgressView()
    }
    .frame(maxWidth: .infinity, maxHeight: 300)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(model.text(.muscleMapLoading))
  }

  private func loadedMap(_ artwork: [String: MuscleMapArtwork], gender loadedGender: String)
    -> some View
  {
    VStack(spacing: 8) {
      HStack(alignment: .top, spacing: 12) {
        ForEach(diagramViews, id: \.self) { view in
          if let map = artwork[view] {
            VStack(spacing: 4) {
              MuscleMapCanvas(artwork: map, highlights: highlights)
                .aspectRatio(map.viewBox.width / map.viewBox.height, contentMode: .fit)
                .frame(maxHeight: 300)
              Text(model.text(view == "front" ? .bodyFront : .bodyBack))
                .font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(accessibilitySummary)
      .accessibilityIdentifier("muscle-map-\(loadedGender)")
      HStack(spacing: 16) {
        legendSwatch(.green, .primaryShort)
        legendSwatch(.green.opacity(0.5), .secondaryShort)
      }
      .font(.caption2).foregroundStyle(.secondary)
    }
  }

  private func legendSwatch(_ color: Color, _ title: CopyKey) -> some View {
    HStack(spacing: 4) {
      RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 12, height: 12)
      Text(model.text(title))
    }
  }

  private func failure(_ message: String) -> some View {
    ContentUnavailableView {
      Label(model.text(.muscleMapFailed), systemImage: "figure.stand")
    } description: {
      Text(message)
    } actions: {
      Button(model.text(.retry)) {
        phase = .loading
        attempt += 1
      }
    }
    .accessibilityIdentifier("muscle-map-error")
  }

  private var emptyState: some View {
    VStack(spacing: 6) {
      Image(systemName: "figure.stand").font(.title2).foregroundStyle(.secondary)
      Text(model.text(.muscleMapUnavailable)).font(.subheadline)
      Text(accessibilitySummary).font(.caption).foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, minHeight: 120)
    .padding(.vertical, 8)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("muscle-map-empty")
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
        context.fill(path(commands).applying(transform), with: .color(Color(.systemGray5)))
      }
      for surface in artwork.surfaces.keys.sorted() {
        let highlight = highlights.filter { $0.surfaces.contains(surface) }.sorted {
          $0.role == "primary" && $1.role != "primary"
        }.first
        for commands in artwork.surfaces[surface] ?? [] {
          let shape = path(commands).applying(transform)
          context.fill(shape, with: .color(Color(.systemGray4)))
          if let highlight {
            let weight = min(1, max(0, highlight.weight ?? 1))
            let opacity = (highlight.role == "primary" ? 1.0 : 0.5) * (0.35 + 0.65 * weight)
            context.fill(shape, with: .color(.green.opacity(opacity)))
          }
          context.stroke(shape, with: .color(Color(.systemGray3)), lineWidth: 0.6)
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
