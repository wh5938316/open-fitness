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
  }
  private var searchKey: SearchKey {
    .init(
      query: query, online: model.isOnline, account: model.accountKey, language: model.language,
      catalog: model.supportsExerciseCatalog, revision: model.exerciseCatalogRevision)
  }

  var body: some View {
    NavigationStack {
      List {
        Button {
          creating = true
        } label: {
          Label(model.text(.addExercise), systemImage: "plus")
        }.disabled(!model.isOnline)
        if !model.isOnline {
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
        if cursor != nil, !searching, loadError == nil {
          Button(model.text(.loadMore)) {
            Task { await loadPage(key: searchKey, token: generation, cursor: cursor) }
          }.task(id: cursor) {
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
        items = []
        cursor = nil
        loadError = nil
        searching = false
        if !model.isOnline {
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
      HStack {
        if mode == .select {
          Button {
            choose(item)
          } label: {
            ExerciseRow(record: item, taxonomy: taxonomy)
          }.buttonStyle(.plain)
        } else {
          NavigationLink {
            ExerciseDetailView(record: item)
          } label: {
            ExerciseRow(record: item, taxonomy: taxonomy)
          }
        }
        NavigationLink {
          ExerciseDetailView(
            record: item, selectionTitle: selectionTitle,
            selected: mode == .select ? { choose($0) } : nil)
        } label: {
          Image(systemName: "info.circle")
        }.buttonStyle(.borderless)
          .accessibilityLabel(model.text(.exerciseDetails))
          .accessibilityIdentifier("exercise-info-\(item.id)")
      }
    }
  }

  private func choose(_ record: Record<Exercise>) {
    selected?(record)
    dismiss()
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
    guard !searching, key == searchKey, generation == token, model.isOnline else { return }
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
  @State private var loadError: String?
  private var exercise: Exercise { record.data.localized(model.language) }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text(exercise.name).font(.largeTitle.bold())
        if let aliases = exercise.aliases, !aliases.isEmpty {
          Text(aliases.prefix(3).joined(separator: " · ")).foregroundStyle(.secondary)
        }
        Text(tags.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
        muscles(.primaryMuscles, values: exercise.primaryMuscles ?? exercise.muscleGroups ?? [])
        muscles(.secondaryMuscles, values: exercise.secondaryMuscles ?? [])
        if let description = exercise.description, !description.isEmpty {
          detail(.exerciseDescription, text: description)
        }
        VStack(alignment: .leading, spacing: 8) {
          Text(model.text(.exerciseSteps)).font(.headline)
          if let instructions = exercise.instructions, !instructions.isEmpty {
            ForEach(Array(instructions.split(separator: "\n").enumerated()), id: \.offset) {
              _, line in
              Text(String(line))
            }
          } else {
            Text(model.text(.noInstructions)).foregroundStyle(.secondary)
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
            }.font(.footnote).foregroundStyle(.secondary)
          }
        }
        if let loadError { Text(loadError).font(.footnote).foregroundStyle(.secondary) }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
    }
    .navigationTitle(model.text(.exerciseDetails)).navigationBarTitleDisplayMode(.inline)
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
      if let cached = model.exerciseDetails[record.id] { record = cached }
      if let refreshed = try? await model.exercise(id: record.id), !Task.isCancelled {
        record = refreshed
      }
      taxonomy = try? await model.exerciseTaxonomy()
    }
  }

  private var tags: [String] {
    var result = [String]()
    if let part = exercise.bodyPart { result.append(label(part, in: taxonomy?.bodyParts)) }
    result += (exercise.equipment ?? []).map { label($0, in: taxonomy?.equipment) }
    if let category = exercise.movementCategory {
      result.append(label(category, in: taxonomy?.movementCategories))
    }
    result.append(model.text(exercise.category == "duration" ? .timed : .strength))
    return result
  }
  private func label(_ value: String, in labels: [ExerciseTaxonomy.Label]?) -> String {
    labels?.first { $0.id == value }?.label ?? value
  }
  private func muscles(_ title: CopyKey, values: [String]) -> some View {
    Group {
      if !values.isEmpty {
        detail(title, text: values.map { label($0, in: taxonomy?.muscles) }.joined(separator: "、"))
      }
    }
  }
  private func detail(_ title: CopyKey, text: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(model.text(title)).font(.headline)
      Text(text)
    }
  }
}
