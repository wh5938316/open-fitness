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

extension AppModel {
  func searchExercises(_ query: ExerciseQuery, cursor: String?, limit: Int = 30) async throws
    -> RecordPage<Exercise>
  {
    guard isOnline else { return .init(items: []) }
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
    let owner = accountKey
    let page = try await api().request(
      RecordPage<Exercise>.self,
      path: query.path(cursor: cursor, limit: limit, supportsCatalog: supportsExerciseCatalog))
    guard owner == accountKey else { throw APIError("ACCOUNT_MISMATCH") }
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

  func cacheExercise(_ value: Record<Exercise>) {
    guard exerciseDetails[value.id].map({ $0.version <= value.version }) ?? true else { return }
    if exerciseDetails[value.id] == nil, exerciseDetails.count >= 200,
      let first = exerciseDetails.keys.sorted().first
    {
      exerciseDetails[first] = nil
    }
    exerciseDetails[value.id] = value
  }

  func exercise(id: String) async throws -> Record<Exercise> {
    #if DEBUG
      if isPreview, let record = PreviewExerciseCatalog.records.first(where: { $0.id == id }) {
        return exerciseDetails[id] ?? record
      }
    #endif
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

  func exerciseSceneChanged(isBackground: Bool) {
    if isBackground {
      exerciseBackgroundedAt = Date()
    } else if let date = exerciseBackgroundedAt {
      if date.timeIntervalSinceNow < -3600 { exerciseDetails = [:] }
      exerciseBackgroundedAt = nil
    }
  }
}
