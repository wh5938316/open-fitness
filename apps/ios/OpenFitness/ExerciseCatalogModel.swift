import Foundation
import OpenFitnessKit

struct ExerciseQuery: Hashable {
  var text = ""
  var source = "all"
  var bodyPart: String?
  var equipment: String?
  var movementCategory: String?
  var target: String?

  func path(cursor: String?, limit: Int, supportsCatalog: Bool) -> String {
    var fields = [("limit", String(min(100, max(1, limit)))), ("query", text)]
    if let cursor { fields.append(("cursor", cursor)) }
    if supportsCatalog {
      fields += [
        ("source", source), ("bodyPart", bodyPart ?? ""), ("equipment", equipment ?? ""),
        ("movementCategory", movementCategory ?? ""), ("target", target ?? ""),
      ]
    }
    return "/api/v1/exercises?"
      + fields.filter { !$0.1.isEmpty }.map { "\($0.0)=\($0.1.queryValue)" }.joined(separator: "&")
  }
}

struct CachedExerciseTaxonomy: Codable {
  var value: ExerciseTaxonomy
  var savedAt: Date
}

struct DeviceLibrary: Codable {
  var foods: [Record<Food>] = []
  var exercises: [Record<Exercise>] = []
  var exercisesCursor: String?
  var exercisesComplete = false
  var exercisesIncludeCatalog = false
  var meals: [Record<Meal>] = []
  var mealsDay: String?
  var workouts: [Record<Workout>] = []
}

extension AppModel {
  var usesLocalExerciseLibrary: Bool {
    if isPreview { return false }
    return exerciseLibraryComplete || (!isOnline && !exerciseLibrary.isEmpty)
  }

  func deviceLibraryURL() throws -> URL {
    guard !accountKey.isEmpty else { throw APIError("AUTHENTICATION_REQUIRED", status: 401) }
    return try DiskStore.directory().appendingPathComponent("library-\(accountKey).json")
  }

  func loadDeviceLibrary() {
    guard let url = try? deviceLibraryURL(),
      let library = DiskStore.read(DeviceLibrary.self, at: url)
    else { return }
    foods = library.foods
    exerciseLibrary = library.exercises
    exerciseDetails = Dictionary(
      library.exercises.map { ($0.id, $0) }, uniquingKeysWith: { first, second in
        first.version >= second.version ? first : second
      })
    exerciseSyncCursor = library.exercisesCursor
    exerciseLibraryComplete = library.exercisesComplete
    exerciseLibraryIncludesCatalog = library.exercisesIncludeCatalog
    if library.mealsDay == selectedDay.calendarDay(timeZone: timeZone) { meals = library.meals }
    if !library.workouts.isEmpty { workouts = library.workouts }
  }

  func persistDeviceLibrary() {
    guard let url = try? deviceLibraryURL() else { return }
    try? DiskStore.write(
      DeviceLibrary(
        foods: foods, exercises: exerciseLibrary, exercisesCursor: exerciseSyncCursor,
        exercisesComplete: exerciseLibraryComplete,
        exercisesIncludeCatalog: exerciseLibraryIncludesCatalog, meals: meals,
        mealsDay: selectedDay.calendarDay(timeZone: timeZone), workouts: workouts), to: url)
  }

  func matchingFoods(_ query: String) -> [FoodSearchHit] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return foods.compactMap { record in
      guard foodMatches(record.data, trimmed) else { return nil }
      return FoodSearchHit(id: record.id, food: record.data, savedId: record.id)
    }
  }

  func rememberFood(_ record: Record<Food>) {
    if let index = foods.firstIndex(where: { $0.id == record.id }) {
      guard foods[index].version < record.version else { return }
      foods[index] = record
    } else {
      foods.append(record)
    }
    persistDeviceLibrary()
  }

  func rememberFoods(_ hits: [FoodSearchHit]) {
    var changed = false
    for hit in hits {
      guard let savedId = hit.savedId else { continue }
      let record = Record(id: savedId, kind: "food", data: hit.food)
      if let index = foods.firstIndex(where: { $0.id == savedId }) {
        guard foods[index].version < record.version else { continue }
        foods[index] = record
      } else {
        foods.append(record)
      }
      changed = true
    }
    if changed { persistDeviceLibrary() }
  }

  func syncLibraries() {
    if supportsExerciseCatalog, exerciseLibraryComplete, !exerciseLibraryIncludesCatalog {
      exerciseLibraryComplete = false
      exerciseSyncCursor = nil
    }
    guard isOnline, isConnected, !isPreview else { return }
    if exerciseLibraryComplete {
      Task { await refreshOwnedExercises() }
    } else {
      Task { await syncExerciseLibrary() }
    }
  }

  func exerciseIsDetailed(_ record: Record<Exercise>) -> Bool {
    let data = record.data
    func filled(_ value: String?) -> Bool {
      value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
    if filled(data.instructions) || filled(data.description)
      || data.diagram?.highlights?.isEmpty == false
    {
      return true
    }
    if let translated = data.i18n?["zh-CN"],
      filled(translated.instructions) || filled(translated.description)
    {
      return true
    }
    return data.source != nil && data.instructions != nil
  }

  func preferredExercise(_ record: Record<Exercise>) -> Record<Exercise> {
    guard let cached = exerciseDetails[record.id] else { return record }
    if exerciseIsDetailed(cached) == exerciseIsDetailed(record) {
      return cached.version >= record.version ? cached : record
    }
    return exerciseIsDetailed(cached) ? cached : record
  }

  func localExercisePage(_ query: ExerciseQuery, cursor: String?, limit: Int = 30)
    -> RecordPage<Exercise>
  {
    let filtered = exerciseLibrary.filter { exerciseMatches($0, query) }
    let start = max(cursor.flatMap(Int.init) ?? 0, 0)
    guard start <= filtered.count else { return .init(items: []) }
    let end = min(start + limit, filtered.count)
    return .init(
      items: Array(filtered[start..<end]), cursor: end < filtered.count ? String(end) : nil)
  }

  func searchExercises(_ query: ExerciseQuery, cursor: String?, limit: Int = 30) async throws
    -> RecordPage<Exercise>
  {
    #if DEBUG
      if isPreview {
        let items = PreviewExerciseCatalog.records.map { exerciseDetails[$0.id] ?? $0 }.filter {
          (query.source != "mine" || !$0.isCatalogOnly)
            && (query.source != "catalog" || $0.isCatalogOnly)
            && (query.text.isEmpty
              || ($0.data.name + " " + $0.data.localized(.simplifiedChinese).name)
                .localizedCaseInsensitiveContains(query.text))
            && (query.bodyPart == nil || $0.data.bodyPart == query.bodyPart)
            && (query.equipment == nil || $0.data.equipment?.contains(query.equipment!) == true)
            && (query.movementCategory == nil || $0.data.movementCategory == query.movementCategory)
            && (query.target == nil || $0.data.primaryMuscles?.contains(query.target!) == true)
        }
        let start = cursor.flatMap(Int.init) ?? 0
        let end = min(start + limit, items.count)
        guard start <= end else { throw APIError("INVALID_CURSOR") }
        return .init(
          items: Array(items[start..<end]), cursor: end < items.count ? String(end) : nil)
      }
    #endif
    if usesLocalExerciseLibrary || !isOnline {
      return localExercisePage(query, cursor: cursor, limit: limit)
    }
    let owner = accountKey
    let page = try await api().request(
      RecordPage<Exercise>.self,
      path: query.path(cursor: cursor, limit: limit, supportsCatalog: supportsExerciseCatalog))
    guard owner == accountKey else { throw APIError("ACCOUNT_MISMATCH") }
    for item in page.items { cacheExercise(item, persist: false) }
    persistDeviceLibrary()
    return page
  }

  func recentExercisesURL() throws -> URL {
    guard !accountKey.isEmpty else { throw APIError("AUTHENTICATION_REQUIRED", status: 401) }
    return try DiskStore.directory().appendingPathComponent("recent-exercises-\(accountKey).json")
  }

  func rememberExercise(_ record: Record<Exercise>) {
    var history = recentExerciseHistory
    history.record(record)
    do {
      if !isPreview { try DiskStore.write(history, to: recentExercisesURL()) }
      recentExerciseHistory = history
    } catch { errorMessage = copy.error(error) }
  }

  @discardableResult
  func cacheExercise(_ value: Record<Exercise>, persist: Bool = true) -> Bool {
    if let existing = exerciseDetails[value.id] {
      if existing.version > value.version { return false }
      if existing.version == value.version, existing.updatedAt == value.updatedAt { return false }
    }
    exerciseDetails[value.id] = value
    if let index = exerciseLibrary.firstIndex(where: { $0.id == value.id }) {
      exerciseLibrary[index] = value
    } else {
      exerciseLibrary.append(value)
    }
    if persist, !isPreview { persistDeviceLibrary() }
    return true
  }

  func exercise(id: String) async throws -> Record<Exercise> {
    #if DEBUG
      if isPreview, let record = PreviewExerciseCatalog.records.first(where: { $0.id == id }) {
        return exerciseDetails[id] ?? record
      }
    #endif
    if let cached = exerciseDetails[id], exerciseIsDetailed(cached) { return cached }
    if !isOnline {
      guard let cached = exerciseDetails[id] else { throw APIError("NETWORK_UNAVAILABLE") }
      return cached
    }
    let owner = accountKey
    let result = try await api().request(
      Record<Exercise>.self, path: "/api/v1/exercises/\(id.pathSegment)")
    guard owner == accountKey else { throw APIError("ACCOUNT_MISMATCH") }
    cacheExercise(result)
    return exerciseDetails[id] ?? result
  }

  func adoptExercise(id: String) async throws -> Record<Exercise> {
    #if DEBUG
      if isPreview {
        var result = try await exercise(id: id)
        result.version = 1
        cacheExercise(result)
        exerciseCatalogRevision += 1
        return result
      }
    #endif
    let owner = accountKey
    let result = try await api().mutation(
      AdoptExerciseResult.self, path: "/api/v1/exercises/\(id.pathSegment)/adopt", fields: [:])
    guard owner == accountKey else { throw APIError("ACCOUNT_MISMATCH") }
    cacheExercise(result.exercise)
    exerciseCatalogRevision += 1
    return result.exercise
  }

  func exerciseTaxonomy() async throws -> ExerciseTaxonomy {
    guard supportsExerciseCatalog else { throw APIError("SERVER_UPDATE_REQUIRED") }
    #if DEBUG
      if isPreview { return PreviewExerciseCatalog.taxonomy }
    #endif
    let owner = accountKey
    let key = "\(owner)-\(language.rawValue)"
    let url = try DiskStore.directory().appendingPathComponent("exercise-taxonomy-\(key).json")
    let cached = taxonomyCache[key] ?? DiskStore.read(CachedExerciseTaxonomy.self, at: url)
    if let cached, !isOnline || cached.savedAt.timeIntervalSinceNow > -7 * 86400 {
      taxonomyCache[key] = cached
      return cached.value
    }
    guard isOnline else { throw APIError("NETWORK_UNAVAILABLE") }
    do {
      let api = try api()
      await api.setLanguage(language.rawValue)
      let value = try await api.request(ExerciseTaxonomy.self, path: "/api/v1/exercise-taxonomy")
      try Task.checkCancellation()
      guard owner == accountKey else { throw APIError("ACCOUNT_MISMATCH") }
      let entry = CachedExerciseTaxonomy(value: value, savedAt: Date())
      taxonomyCache[key] = entry
      try? DiskStore.write(entry, to: url)
      return value
    } catch {
      guard owner == accountKey else { throw APIError("ACCOUNT_MISMATCH") }
      if let cached { return cached.value }
      throw error
    }
  }

  func muscleMap(gender: String, view: String) async throws -> MuscleMapArtwork {
    guard ["male", "female"].contains(gender), ["front", "back"].contains(view) else {
      throw APIError("INVALID_ENDPOINT")
    }
    let taxonomy = try await exerciseTaxonomy()
    let server = try ServerConfiguration(serverAddress)
    let origin = OAuthSecurity.accountKey(origin: server.origin, ownerId: "musclemap")
    let key = "\(origin)-\(taxonomy.diagrams.packageVersion.queryValue)-\(gender)-\(view)"
    if let cached = muscleMapCache[key] { return cached }
    let url = try DiskStore.directory().appendingPathComponent("musclemap-\(key).json")
    if let cached = DiskStore.read(MuscleMapArtwork.self, at: url) {
      muscleMapCache[key] = cached
      return cached
    }
    guard isOnline, let path = taxonomy.diagrams.assets[gender]?[view] else {
      throw APIError("ARTWORK_UNAVAILABLE")
    }
    let data = try await api().publicData(path: path)
    let parsed = try await Task.detached(priority: .utility) { try MuscleMap.parse(svg: data) }
      .value
    try Task.checkCancellation()
    muscleMapCache[key] = parsed
    try? DiskStore.write(parsed, to: url)
    return parsed
  }

  private func foodMatches(_ food: Food, _ query: String) -> Bool {
    if query.isEmpty { return true }
    if food.name.localizedCaseInsensitiveContains(query) { return true }
    if food.barcode?.localizedCaseInsensitiveContains(query) == true { return true }
    return food.aliases?.contains { $0.localizedCaseInsensitiveContains(query) } == true
  }

  private func exerciseMatches(_ record: Record<Exercise>, _ query: ExerciseQuery) -> Bool {
    if query.source == "mine", record.isCatalogOnly { return false }
    if query.source == "catalog", !record.isCatalogOnly { return false }
    if let body = query.bodyPart, record.data.bodyPart != body { return false }
    if let equipment = query.equipment, record.data.equipment?.contains(equipment) != true {
      return false
    }
    if let category = query.movementCategory, record.data.movementCategory != category {
      return false
    }
    if let target = query.target, record.data.primaryMuscles?.contains(target) != true {
      return false
    }
    let text = query.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return true }
    let translated = record.data.i18n?["zh-CN"]
    let fields = [
      record.data.name, record.data.description ?? "", record.data.instructions ?? "",
      translated?.name ?? "", translated?.description ?? "", translated?.instructions ?? "",
      (record.data.aliases ?? []).joined(separator: " "),
      (translated?.aliases ?? []).joined(separator: " "),
    ]
    return fields.joined(separator: "\n").localizedCaseInsensitiveContains(text)
  }

  private func syncExerciseLibrary() async {
    guard !exerciseSyncing, !exerciseLibraryComplete, isOnline, isConnected, !isPreview else {
      return
    }
    exerciseSyncing = true
    defer { exerciseSyncing = false }
    var cursor = exerciseSyncCursor
    var restarted = false
    var pagesSinceSave = 0
    let owner = accountKey
    let query = ExerciseQuery()
    while !Task.isCancelled {
      do {
        let page = try await api().request(
          RecordPage<Exercise>.self,
          path: query.path(cursor: cursor, limit: 100, supportsCatalog: supportsExerciseCatalog))
        guard owner == accountKey else { return }
        for item in page.items { cacheExercise(item, persist: false) }
        cursor = page.cursor
        exerciseSyncCursor = cursor
        pagesSinceSave += 1
        if cursor == nil {
          exerciseLibraryComplete = true
          exerciseLibraryIncludesCatalog = supportsExerciseCatalog
          exerciseSyncCursor = nil
        }
        if exerciseLibraryComplete || pagesSinceSave.isMultiple(of: 10) {
          persistDeviceLibrary()
          pagesSinceSave = 0
        }
        if exerciseLibraryComplete {
          exerciseCatalogRevision += 1
          return
        }
      } catch {
        guard owner == accountKey else { return }
        if !restarted, (error as? APIError)?.code == "INVALID_CURSOR" {
          restarted = true
          cursor = nil
          exerciseSyncCursor = nil
          exerciseLibrary = []
          exerciseDetails = [:]
          continue
        }
        return
      }
    }
  }

  private func refreshOwnedExercises() async {
    guard !exerciseSyncing, exerciseLibraryComplete, isOnline, isConnected, !isPreview else {
      return
    }
    exerciseSyncing = true
    defer { exerciseSyncing = false }
    var cursor: String?
    var changed = false
    let owner = accountKey
    let query = ExerciseQuery(source: "mine")
    do {
      repeat {
        let page = try await api().request(
          RecordPage<Exercise>.self,
          path: query.path(cursor: cursor, limit: 100, supportsCatalog: supportsExerciseCatalog))
        guard owner == accountKey else { return }
        for item in page.items where cacheExercise(item, persist: false) { changed = true }
        cursor = page.cursor
      } while cursor != nil
      if changed {
        persistDeviceLibrary()
        exerciseCatalogRevision += 1
      }
    } catch {}
  }
}
