import Foundation

public struct LegacyDeviceLibrary: Codable, Sendable {
  public var foods: [Record<Food>] = []
  public var exercises: [Record<Exercise>] = []
  public var exercisesCursor: String?
  public var exercisesComplete = false
  public var exercisesIncludeCatalog = false
  public var meals: [Record<Meal>] = []
  public var mealsDay: String?
  public var workouts: [Record<Workout>] = []
  public init() {}
}

public enum LegacyImport {
  public static func importAccount(store: LocalStore, directory: URL, accountKey: String) throws {
    if store.meta("legacy_imported") != nil {
      removeImportedFiles(directory: directory, accountKey: accountKey)
      return
    }
    let libraryURL = directory.appendingPathComponent("library-\(accountKey).json")
    let cacheURL = directory.appendingPathComponent("cache-\(accountKey).json")
    let writesURL = directory.appendingPathComponent("writes-\(accountKey).json")
    let library = DiskStore.read(LegacyDeviceLibrary.self, at: libraryURL)
    let cache = DiskStore.read(CompanionSnapshot.self, at: cacheURL)
    let writes = DiskStore.read([String: PreparedRequest].self, at: writesURL) ?? [:]
    if let library {
      for food in library.foods { try insert(store, food, kind: "food") }
      for meal in library.meals { try insert(store, meal, kind: "meal") }
      for workout in library.workouts { try insert(store, workout, kind: "workout") }
      for exercise in library.exercises {
        if exercise.isCatalogOnly {
          try store.saveCatalog(
            id: exercise.id, data: try JSONEncoder().encode(exercise.data), locale: "en",
            fetchedAt: exercise.updatedAt)
        } else {
          try insert(store, exercise, kind: "exercise")
        }
      }
      if let cursor = library.exercisesCursor { try store.setMeta("catalog_cursor", cursor) }
      try store.setMeta("catalog_complete", library.exercisesComplete ? "1" : "0")
    }
    if let cache {
      for plan in cache.plans { try insert(store, plan, kind: "plan") }
      for recipe in cache.recipes { try insert(store, recipe, kind: "recipe") }
      if let workout = cache.workout, workout.id.hasPrefix("local-") || workout.version == 0 {
        try store.setMeta(
          "pending_local_workout", String(data: try JSONEncoder().encode(workout), encoding: .utf8))
      } else if let workout = cache.workout {
        try insert(store, workout, kind: "workout")
      }
    }
    for (_, request) in writes {
      let operationId = request.body.string("operationId") ?? UUID().uuidString.lowercased()
      let draft = OutboxDraft(
        operationId: operationId, name: request.path, request: request,
        targetKind: nil, targetId: nil)
      _ = try store.enqueue(draft, coalesce: false)
    }
    try store.setMeta("legacy_imported", Date().iso8601Milliseconds)
    removeImportedFiles(directory: directory, accountKey: accountKey)
  }

  public static func removeImportedFiles(directory: URL, accountKey: String) {
    let names = [
      "library-\(accountKey).json", "cache-\(accountKey).json", "writes-\(accountKey).json",
    ]
    for name in names {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
  }

  private static func insert<T: Encodable>(_ store: LocalStore, _ record: Record<T>, kind: String)
    throws
  {
    let data = try JSONEncoder().encode(record.data)
    let stored = StoredDocument(
      kind: kind, id: record.id, version: max(record.version, 1), deleted: record.deleted == true,
      createdAt: record.createdAt, updatedAt: record.updatedAt, data: data, occurredAt: nil,
      source: "legacy", seq: nil)
    _ = try store.importDocument(stored, source: "legacy")
  }
}
