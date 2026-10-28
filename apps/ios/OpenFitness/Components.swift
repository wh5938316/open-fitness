import OpenFitnessKit
import SwiftUI

struct Surface<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    content.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(
      .background, in: .rect(cornerRadius: 24)
    ).overlay(RoundedRectangle(cornerRadius: 24).stroke(.quaternary, lineWidth: 0.5))
  }
}
struct Screen<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) { content }.padding(.horizontal, 20).padding(
        .vertical, 12
      ).padding(.bottom, 20)
    }.background(Color(.systemGroupedBackground))
  }
}
struct SectionTitle: View {
  var title: String
  var detail: String? = nil
  var body: some View {
    HStack {
      Text(title).font(.title3.bold())
      Spacer()
      if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
    }.padding(.top, 6)
  }
}
struct EmptyCard: View {
  var title: String
  var detail: String
  var icon: String
  var body: some View {
    Surface {
      VStack(alignment: .leading, spacing: 12) {
        Image(systemName: icon).font(.system(size: 32, weight: .light)).foregroundStyle(.green)
          .accessibilityHidden(true)
        Text(title).font(.title3.bold())
        Text(detail).font(.subheadline).foregroundStyle(.secondary).fixedSize(
          horizontal: false, vertical: true)
      }.padding(.vertical, 10)
    }
  }
}
struct NutritionGrid: View {
  @Environment(AppModel.self) private var model
  var nutrients: Nutrients
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      ForEach([NutrientKey.proteinG, .carbohydrateG, .fatG], id: \.rawValue) { key in
        VStack(alignment: .leading, spacing: 6) {
          Capsule().fill(color(key)).frame(height: 3)
          Text(model.text(label(key))).font(.caption).foregroundStyle(.secondary)
          HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(model.copy.number(nutrients[key], digits: 1)).font(.title3.weight(.semibold))
              .monospacedDigit()
            Text("g").font(.caption).foregroundStyle(.secondary)
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
  private func color(_ key: NutrientKey) -> Color {
    switch key {
    case .proteinG: .indigo
    case .carbohydrateG: .orange
    default: .teal
    }
  }
  private func label(_ key: NutrientKey) -> CopyKey {
    switch key {
    case .proteinG: .protein
    case .carbohydrateG: .carbs
    default: .fat
    }
  }
}
struct MetricValue: View {
  var title: String
  var value: String
  var unit: String
  var icon: String
  var identifier: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(title, systemImage: icon).font(.caption).foregroundStyle(.secondary)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(value).font(.system(.title, design: .rounded).weight(.semibold)).monospacedDigit()
          .accessibilityIdentifier(identifier ?? "")
        Text(unit).font(.caption).foregroundStyle(.secondary)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
struct PrivateRecipeImage: View {
  @Environment(AppModel.self) private var model
  var assetId: String?
  @State private var image: UIImage?
  var body: some View {
    ZStack {
      LinearGradient(
        colors: [.green.opacity(0.15), .teal.opacity(0.06)], startPoint: .topLeading,
        endPoint: .bottomTrailing)
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: "fork.knife").font(.system(size: 30, weight: .light)).foregroundStyle(
          .green)
      }
    }
    .clipped().task(id: assetId) {
      image = nil
      guard let assetId, let api = try? model.api(),
        let data = try? await api.imageData(assetId: assetId)
      else { return }
      image = UIImage(data: data)
    }
  }
}
struct InlineNumber: View {
  var title: String
  @Binding var value: Double
  var unit: String = ""
  var body: some View {
    HStack {
      Text(title)
      Spacer()
      TextField(title, value: $value, format: .number.precision(.fractionLength(0...2)))
        .keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(
          minWidth: 60, maxWidth: 100)
      Text(unit).foregroundStyle(.secondary)
    }
  }
}
struct PendingBanner: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    if !model.journal.commands.isEmpty {
      Button {
        Task { await model.retryPending() }
      } label: {
        Label(
          "\(model.text(.pendingChanges)) · \(model.journal.commands.count)",
          systemImage: "arrow.triangle.2.circlepath"
        ).font(.footnote.weight(.medium)).frame(maxWidth: .infinity).padding(12)
      }.buttonStyle(.glass).tint(.orange)
    }
  }
}
