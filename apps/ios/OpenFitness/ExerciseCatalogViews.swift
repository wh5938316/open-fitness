import OpenFitnessKit
import SwiftUI

struct ExercisePicker: View {
  enum Mode { case select, browse }
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var mode: Mode = .select
  var selected: ((Record<Exercise>) -> Void)?
  var selectionTitle: CopyKey = .addToPlan
  @State private var query = ExerciseQuery()
  @State private var items: [Record<Exercise>] = []
  @State private var cursor: String?
  @State private var taxonomy: ExerciseTaxonomy?
  @State private var creating = false
  @State private var searching = false
  @State private var loadError: String?
  @State private var generation = UUID()

  private struct SearchKey: Hashable {
    var query: ExerciseQuery
    var online: Bool
    var account: String
    var language: AppLanguage
    var catalog: Bool
    var revision: Int
    var local: Bool
  }
  private var searchKey: SearchKey {
    .init(
      query: query, online: model.isOnline, account: model.accountKey, language: model.language,
      catalog: model.supportsExerciseCatalog, revision: model.exerciseCatalogRevision,
      local: model.usesLocalExerciseLibrary)
  }

  var body: some View {
    NavigationStack {
      List {
        Button {
          creating = true
        } label: {
          Label(model.text(.addExercise), systemImage: "plus")
        }.disabled(!model.isOnline)
        if !model.isOnline, !model.usesLocalExerciseLibrary {
          Text(model.text(.offlineCatalog)).font(.footnote).foregroundStyle(.secondary)
        }
        if model.supportsExerciseCatalog, let taxonomy {
          ScrollView(.horizontal) {
            HStack {
              filter(.bodyPart, items: taxonomy.bodyParts, selection: $query.bodyPart)
              filter(.equipment, items: taxonomy.equipment, selection: $query.equipment)
              filter(
                .movementCategory, items: taxonomy.movementCategories,
                selection: $query.movementCategory)
              filter(.targetMuscle, items: taxonomy.muscles, selection: $query.target)
            }
          }.scrollIndicators(.hidden).listRowBackground(Color.clear)
        }
        if query.text.isEmpty, !model.recentExerciseHistory.items.isEmpty {
          Section(model.text(.recentExercises)) {
            ForEach(model.recentExerciseHistory.items.prefix(20)) { recent in
              row(recent.record)
            }
          }
        }
        exerciseRows
        if searching { ProgressView().frame(maxWidth: .infinity) }
        if let loadError {
          Text(loadError).foregroundStyle(.secondary)
          Button(model.text(.retry)) {
            Task {
              await loadPage(
                key: searchKey, token: generation, cursor: cursor, replacing: items.isEmpty)
            }
          }
        } else if !searching, items.isEmpty, model.isOnline {
          Text(model.text(.noResults)).foregroundStyle(.secondary)
        }
        if cursor != nil, loadError == nil {
          Button(model.text(.loadMore)) {
            Task { await loadPage(key: searchKey, token: generation, cursor: cursor) }
          }.disabled(searching).task(id: cursor) {
            await loadPage(key: searchKey, token: generation, cursor: cursor)
          }
        }
      }
      .navigationTitle(model.text(.exerciseLibrary))
      .searchable(text: $query.text, prompt: model.text(.exerciseSearchPrompt))
      .modifier(ExerciseSearchScopes(enabled: model.supportsExerciseCatalog, source: $query.source))
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(model.text(.done)) { dismiss() } }
      }
      .task(id: searchKey) {
        let key = searchKey
        let token = UUID()
        generation = token
        loadError = nil
        searching = false
        if model.usesLocalExerciseLibrary {
          var collected: [Record<Exercise>] = []
          var next: String?
          repeat {
            let page = model.localExercisePage(key.query, cursor: next, limit: 200)
            collected += page.items
            next = page.cursor
          } while next != nil
          items = collected
          cursor = nil
          return
        }
        items = model.localExercisePage(key.query, cursor: nil).items
        cursor = nil
        guard model.isOnline else {
          if query.source != "mine" { query.source = "mine" }
          return
        }
        do {
          searching = true
          if !query.text.isEmpty { try await Task.sleep(for: .milliseconds(400)) }
          searching = false
          await loadPage(key: key, token: token, cursor: nil, replacing: true)
        } catch {
          if generation == token { searching = false }
        }
      }
      .task(id: "\(model.accountKey)-\(model.language.rawValue)-\(model.supportsExerciseCatalog)") {
        taxonomy = nil
        taxonomy = try? await model.exerciseTaxonomy()
      }
      .sheet(isPresented: $creating) {
        NewExerciseEditor { record in
          if mode == .select { choose(record) } else { items.insert(record, at: 0) }
        }
      }
    }
  }

  private var exerciseRows: some View {
    ForEach(items) { item in
      row(item)
    }
  }

  private func choose(_ record: Record<Exercise>) {
    model.rememberExercise(record)
    selected?(record)
    dismiss()
  }

  private func row(_ record: Record<Exercise>) -> some View {
    NavigationLink {
      ExerciseDetailView(
        record: model.preferredExercise(record), selectionTitle: selectionTitle,
        selected: mode == .select ? { choose($0) } : nil)
    } label: {
      ExerciseRow(record: record, taxonomy: taxonomy)
    }
    .accessibilityIdentifier("exercise-row-\(record.id)")
  }

  private func filter(
    _ title: CopyKey, items: [ExerciseTaxonomy.Label], selection: Binding<String?>
  ) -> some View {
    Menu {
      Button(model.text(.clearFilter)) { selection.wrappedValue = nil }
      ForEach(items) { item in
        Button(item.label) { selection.wrappedValue = item.id }
      }
    } label: {
      Label(
        items.first { $0.id == selection.wrappedValue }?.label ?? model.text(title),
        systemImage: selection.wrappedValue == nil ? "chevron.down" : "checkmark"
      ).font(.caption).padding(8)
        .background(.green.opacity(selection.wrappedValue == nil ? 0.06 : 0.18), in: .capsule)
    }
  }

  private func loadPage(
    key: SearchKey, token: UUID, cursor requestedCursor: String?, replacing: Bool = false
  ) async {
    guard !searching, key == searchKey, generation == token else { return }
    guard model.isOnline || model.usesLocalExerciseLibrary else { return }
    searching = true
    defer { if generation == token { searching = false } }
    do {
      let page = try await model.searchExercises(key.query, cursor: requestedCursor)
      try Task.checkCancellation()
      guard key == searchKey, generation == token else { return }
      var seen = Set(replacing ? [] : items.map(\.id))
      let newItems = page.items.filter { seen.insert($0.id).inserted }
      items = (replacing ? [] : items) + newItems
      cursor = page.cursor == requestedCursor ? nil : page.cursor
      loadError = nil
    } catch {
      if !Task.isCancelled, key == searchKey, generation == token {
        loadError = model.copy.error(error)
      }
    }
  }
}

private struct ExerciseSearchScopes: ViewModifier {
  @Environment(AppModel.self) private var model
  var enabled: Bool
  @Binding var source: String
  @ViewBuilder func body(content: Content) -> some View {
    if enabled {
      content.searchScopes($source) {
        Text(model.text(.sourceAll)).tag("all")
        Text(model.text(.sourceMine)).tag("mine")
        Text(model.text(.sourceCatalog)).tag("catalog")
      }
    } else {
      content
    }
  }
}

struct ExerciseRow: View {
  @Environment(AppModel.self) private var model
  var record: Record<Exercise>
  var taxonomy: ExerciseTaxonomy?
  private var exercise: Exercise { record.data.localized(model.language) }
  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 5) {
        Text(exercise.name).foregroundStyle(.primary)
        Text(
          ((exercise.primaryMuscles ?? exercise.muscleGroups ?? []).map { value in
            taxonomy?.muscles.first { label in label.id == value }?.label ?? value
          }
            + (exercise.equipment ?? []).map { value in
              taxonomy?.equipment.first { label in label.id == value }?.label ?? value
            }).joined(separator: " · ")
        ).font(.caption).foregroundStyle(.secondary)
      }.frame(maxWidth: .infinity, alignment: .leading)
      if model.supportsExerciseCatalog, record.isCatalogOnly {
        Text(model.text(.catalogBadge)).font(.caption2).padding(.horizontal, 7).padding(
          .vertical, 4
        )
        .background(.green.opacity(0.1), in: .capsule).foregroundStyle(.secondary)
      }
    }.contentShape(.rect)
  }
}

struct ExerciseDetailView: View {
  @Environment(AppModel.self) private var model
  @State var record: Record<Exercise>
  var selectionTitle: CopyKey = .addToPlan
  var selected: ((Record<Exercise>) -> Void)?
  @State private var taxonomy: ExerciseTaxonomy?
  @State private var adopting = false
  @State private var loadingDetail = false
  @AppStorage("muscleMapGender") private var gender = ""
  @State private var loadError: String?
  private var exercise: Exercise { record.data.localized(model.language) }

  private var genderSelection: Binding<String> {
    Binding(
      get: { gender.isEmpty ? (exercise.diagram?.gender ?? "male") : gender },
      set: { gender = $0 })
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if model.supportsExerciseCatalog {
          MuscleMapView(
            diagram: exercise.diagram, genderOverride: gender, accessibilitySummary: muscleSummary
          )
          .padding(12)
          .frame(maxWidth: .infinity)
          .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 16))
        }
        VStack(alignment: .leading, spacing: 4) {
          Text(exercise.name).font(.title.bold())
          if let aliases = exercise.aliases, !aliases.isEmpty {
            Text(aliases.prefix(3).joined(separator: " · "))
              .font(.subheadline).foregroundStyle(.secondary)
          }
        }
        ChipFlowLayout {
          ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
            Text(tag).font(.caption).padding(.horizontal, 8).padding(.vertical, 4)
              .background(.green.opacity(0.1), in: .capsule)
          }
        }
        muscleChips(
          .primaryMuscles, values: exercise.primaryMuscles ?? exercise.muscleGroups ?? [],
          filled: true)
        muscleChips(.secondaryMuscles, values: exercise.secondaryMuscles ?? [], filled: false)
        if let description = exercise.description, !description.isEmpty {
          detail(.exerciseDescription, text: description)
        }
        VStack(alignment: .leading, spacing: 8) {
          Text(model.text(.exerciseSteps)).font(.headline)
          if loadingDetail, instructionLines.isEmpty {
            ProgressView()
          } else if instructionLines.isEmpty {
            Text(model.text(.noInstructions)).foregroundStyle(.secondary)
          } else {
            ForEach(Array(instructionLines.enumerated()), id: \.offset) { index, line in
              HStack(alignment: .top, spacing: 10) {
                Text("\(index + 1)")
                  .font(.caption.bold())
                  .frame(minWidth: 22, minHeight: 22)
                  .background(.green.opacity(0.14), in: .circle)
                Text(line).frame(maxWidth: .infinity, alignment: .leading)
              }
            }
          }
          if exercise.needsRewrite == true || exercise.source?.needsRewrite == true {
            Label(model.text(.needsRewrite), systemImage: "text.badge.clock")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }
        if exercise.source?.kind == "catalog" {
          DisclosureGroup(model.text(.attribution)) {
            VStack(alignment: .leading, spacing: 8) {
              if let text = exercise.source?.attribution { Text(text) }
              if let text = taxonomy?.attribution { Text(text) }
              if let license = exercise.source?.license { Text(license) }
              if let note = taxonomy?.diagramNote { Text(note) }
            }.font(.footnote).foregroundStyle(.secondary)
          }
        }
        if let loadError { Text(loadError).font(.footnote).foregroundStyle(.secondary) }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
    }
    .navigationTitle(model.text(.exerciseDetails)).navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if model.supportsExerciseCatalog,
        exercise.diagram?.highlights?.contains(where: \.matched) == true
      {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Picker(model.text(.muscleMap), selection: genderSelection) {
              Text(model.text(.bodyMale)).tag("male")
              Text(model.text(.bodyFemale)).tag("female")
            }.pickerStyle(.inline)
          } label: {
            Image(systemName: "figure.stand")
          }
          .accessibilityLabel(model.text(.muscleMap))
        }
      }
    }
    .safeAreaInset(edge: .bottom) {
      if let selected {
        Button(model.text(selectionTitle)) { selected(record) }
          .buttonStyle(.glassProminent).padding()
          .accessibilityIdentifier("select-exercise-detail")
      } else if model.supportsExerciseCatalog, exercise.source?.kind == "catalog" {
        Button(model.text(record.isCatalogOnly ? .addToMyExercises : .inMyExercises)) {
          Task {
            adopting = true
            defer { adopting = false }
            do {
              record = try await model.adoptExercise(id: record.id)
              loadError = nil
            } catch { loadError = model.copy.error(error) }
          }
        }.buttonStyle(.glassProminent).padding()
          .disabled(adopting || !record.isCatalogOnly || !model.isOnline)
      }
    }
    .task(id: model.language) {
      record = model.preferredExercise(record)
      let needsFetch = !model.exerciseIsDetailed(record)
      loadingDetail = needsFetch
      if needsFetch, let refreshed = try? await model.exercise(id: record.id), !Task.isCancelled {
        record = refreshed
      }
      if !Task.isCancelled { loadingDetail = false }
      taxonomy = try? await model.exerciseTaxonomy()
    }
  }

  private var muscleSummary: String {
    let primary = (exercise.primaryMuscles ?? exercise.muscleGroups ?? []).map {
      label($0, in: taxonomy?.muscles)
    }.joined(separator: "、")
    let secondary = (exercise.secondaryMuscles ?? []).map { label($0, in: taxonomy?.muscles) }
      .joined(separator: "、")
    return
      "\(model.text(.primaryMuscles)): \(primary); \(model.text(.secondaryMuscles)): \(secondary)"
  }

  private var tags: [String] {
    var result = [String]()
    if let part = exercise.bodyPart { result.append(label(part, in: taxonomy?.bodyParts)) }
    result += (exercise.equipment ?? []).map { label($0, in: taxonomy?.equipment) }
    if let category = exercise.movementCategory {
      result.append(label(category, in: taxonomy?.movementCategories))
    }
    result.append(model.text(exercise.category == "duration" ? .timed : .strength))
    var seen = Set<String>()
    return result.filter { seen.insert($0).inserted }
  }
  private func label(_ value: String, in labels: [ExerciseTaxonomy.Label]?) -> String {
    labels?.first { $0.id == value }?.label ?? value
  }
  private var instructionLines: [String] {
    (exercise.instructions ?? "").split(whereSeparator: \.isNewline).compactMap { line in
      let body = String(line).replacingOccurrences(
        of: #"^\d+[.)、]\s*"#, with: "", options: .regularExpression
      ).trimmingCharacters(in: .whitespaces)
      return body.isEmpty ? nil : body
    }
  }
  private func muscleChips(_ title: CopyKey, values: [String], filled: Bool) -> some View {
    Group {
      if !values.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text(model.text(title)).font(.headline)
          ChipFlowLayout {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
              muscleChip(label(value, in: taxonomy?.muscles), filled: filled)
            }
          }
        }
      }
    }
  }
  private func muscleChip(_ text: String, filled: Bool) -> some View {
    Text(text).font(.caption).padding(.horizontal, 8).padding(.vertical, 4)
      .foregroundStyle(filled ? Color.primary : Color.secondary)
      .background(filled ? Color.green.opacity(0.18) : Color.clear, in: .capsule)
      .overlay {
        if !filled { Capsule().stroke(Color.green.opacity(0.45), lineWidth: 1) }
      }
  }
  private func detail(_ title: CopyKey, text: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(model.text(title)).font(.headline)
      Text(text)
    }
  }
}

private struct ChipFlowLayout: Layout {
  var spacing: CGFloat = 8
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
    let rows = rows(maxWidth: proposal.width ?? .greatestFiniteMagnitude, subviews: subviews)
    let width = proposal.width ?? rows.map(\.width).max() ?? 0
    let gaps = spacing * CGFloat(max(rows.count - 1, 0))
    let height = rows.reduce(CGFloat.zero) { $0 + $1.height } + gaps
    return CGSize(width: width, height: height)
  }
  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void
  ) {
    var y = bounds.minY
    for row in rows(maxWidth: bounds.width, subviews: subviews) {
      var x = bounds.minX
      for index in row.indexes {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(
          at: CGPoint(x: x, y: y), anchor: .topLeading,
          proposal: ProposedViewSize(width: size.width, height: size.height))
        x += size.width + spacing
      }
      y += row.height + spacing
    }
  }
  private struct Row {
    var indexes: [Int]
    var width: CGFloat
    var height: CGFloat
  }
  private func rows(maxWidth: CGFloat, subviews: Subviews) -> [Row] {
    var result: [Row] = []
    var indexes: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      let next = width == 0 ? size.width : width + spacing + size.width
      if width > 0, next > maxWidth {
        result.append(.init(indexes: indexes, width: width, height: height))
        indexes = [index]
        width = size.width
        height = size.height
      } else {
        indexes.append(index)
        width = next
        height = max(height, size.height)
      }
    }
    if !indexes.isEmpty { result.append(.init(indexes: indexes, width: width, height: height)) }
    return result
  }
}
