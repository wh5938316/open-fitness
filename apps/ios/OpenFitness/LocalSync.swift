import Foundation
import OpenFitnessKit

extension AppModel {
  func openLocalStore(for context: AgentContext) throws {
    let origin = try ServerConfiguration(serverAddress).origin
    let key = OAuthSecurity.accountKey(origin: origin, ownerId: context.ownerId)
    if localStore != nil, exerciseCacheAccountKey == key { return }
    let folder = try DiskStore.directory()
    let store = try LocalStore(url: folder.appendingPathComponent("store-\(key).sqlite"))
    try LegacyImport.importAccount(store: store, directory: folder, accountKey: key)
    if store.meta("owner_id") == nil { try store.setMeta("owner_id", context.ownerId) }
    if store.meta("time_zone") == nil { try store.setMeta("time_zone", context.timeZone) }
    try registerStore(key: key, origin: origin, ownerId: context.ownerId, directory: folder)
    localStore = store
  }

  func ensureEngine() async {
    guard syncEngine == nil, let localStore, let client, let ownerId = context?.ownerId else {
      if let syncEngine { await syncEngine.start() }
      return
    }
    await client.setUsesLocalOutbox(true)
    let engine = SyncEngine(store: localStore, api: client, ownerId: ownerId)
    syncEngine = engine
    let changes = await engine.changes
    let statuses = await engine.statuses
    Task { @MainActor in
      for await kinds in changes { self.applyRemoteChanges(kinds) }
    }
    Task { @MainActor in
      for await status in statuses {
        self.syncStatus = status
        if case .needsSignIn = status { self.sessionNeedsInteractiveSignIn = true }
      }
    }
    await engine.start()
  }

  func syncNow() async {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("-ui-testing-local-store") { return }
    #endif
    guard isConnected, !isPreview else { return }
    if isRefreshing {
      refreshRequested = true
      return
    }
    isRefreshing = true
    defer {
      isRefreshing = false
      if refreshRequested {
        refreshRequested = false
        Task { await self.syncNow() }
      }
    }
    await ensureEngine()
    if let api = client { try? await api.recoverPendingMutations() }
    await syncEngine?.setForeground(true)
    await syncEngine?.pull()
    await syncEngine?.drainOutbox()
    await drain()
    if let status = await syncEngine?.status {
      syncStatus = status
      if case .needsSignIn = status {
        sessionNeedsInteractiveSignIn = true
        return
      }
    }
    if let value = try? await api().request(AgentContext.self, path: "/api/v1/agent-context") {
      if value.ownerId != context?.ownerId {
        accountNotice = text(.differentAccount)
      } else {
        context = value
        try? localStore?.setMeta("time_zone", value.timeZone)
      }
    }
    if context?.capabilities.healthSyncProtocol != nil {
      healthStatus = try? await api().request(HealthSyncStatus.self, path: "/api/v1/health/status")
    }
    syncLibraries()
    loadFromStore()
    sendCompanion()
    if healthEnabled { await synchronizeHealth() }
  }

  func loadFromStore() {
    guard let localStore else { return }
    foods = overlay(decoded(localStore.documents(kind: "food")), kind: "food")
    plans = overlay(decoded(localStore.documents(kind: "plan")), kind: "plan")
    recipes = overlay(decoded(localStore.documents(kind: "recipe")), kind: "recipe")
    let workoutPage = localStore.workouts(limit: 30, offset: 0).compactMap {
      $0.record(Workout.self)
    }
    workouts = workoutPage
    historyCursor = workoutPage.count == 30 ? "30" : nil
    mergeExercises()
    if journal.commands.contains(where: { $0.kind == .startWorkout }),
      let raw = localStore.meta("pending_local_workout")?.data(using: .utf8),
      let pending = try? JSONDecoder().decode(Record<Workout>.self, from: raw)
    {
      workout = pending
    } else if workouts.first(where: { $0.data.state == "active" }) != nil
      || !journal.commands.contains(where: { $0.kind == .startWorkout })
    {
      workout = workouts.first { $0.data.state == "active" }
    }
    reloadDay()
  }

  func reloadDay() {
    guard let localStore else { return }
    let day = selectedDay.calendarDay(timeZone: timeZone)
    do {
      let bounds = try NutritionMath.dayBounds(day: day, timeZone: timeZone)
      let confirmed = localStore.meals(from: bounds.from, to: bounds.to).compactMap {
        $0.record(Meal.self)
      }
      let pendingDeletes = Set(
        localStore.outbox().filter { $0.name.hasPrefix("delete_") && $0.targetKind == "meal" }
          .compactMap(\.targetId))
      let pending = pendingRecords(Meal.self, kind: "meal").filter {
        $0.deleted != true && $0.data.occurredAt >= bounds.from && $0.data.occurredAt < bounds.to
          && !pendingDeletes.contains($0.id)
      }
      let pendingIds = Set(pending.map(\.id))
      meals =
        confirmed.filter { !pendingIds.contains($0.id) && !pendingDeletes.contains($0.id) }
        + pending
      nutrition = try NutritionMath.summarize(meals: confirmed, day: day, timeZone: timeZone)
      dayUnavailable = false
      downloadingHistory =
        meals.isEmpty && localStore.meta("bootstrap_complete") != "1"
      let known = pending.compactMap(\.data.nutrients.energyKcal)
      if pending.isEmpty {
        pendingKcalText = nil
      } else if known.count == pending.count {
        pendingKcalText = String(format: text(.pendingKcal), Int(known.reduce(0, +).rounded()))
      } else {
        pendingKcalText = text(.unknown)
      }
      conflictIds = Set(
        localStore.outbox().filter { $0.state == "conflict" }.compactMap(\.targetId))
    } catch {
      dayUnavailable = true
      downloadingHistory = false
      meals = []
      nutrition = nil
      pendingKcalText = nil
    }
    reloadToday()
  }

  func shiftDay(_ days: Int) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: timeZone) ?? .current
    selectedDay = calendar.date(byAdding: .day, value: days, to: selectedDay) ?? selectedDay
  }

  func enqueueDocument<Value: Encodable>(
    name: String, method: String, path: String, fields: [String: JSONValue], kind: String,
    record: Record<Value>, baseVersion: Int? = nil, dependsOn: [String] = []
  ) async throws {
    guard let syncEngine else { throw APIError("LOCAL_STORAGE_UNAVAILABLE") }
    let operationId = UUID().uuidString.lowercased()
    var body = fields
    if body["id"] == nil { body["id"] = .string(record.id) }
    let draft = OutboxDraft(
      operationId: operationId, name: name,
      request: OutboxBuilder.request(
        name: name, method: method, path: path, fields: body, operationId: operationId),
      targetKind: kind, targetId: record.id, baseVersion: baseVersion,
      optimistic: try JSONEncoder().encode(record), dependsOn: dependsOn)
    _ = try await syncEngine.enqueue(draft)
    await syncEngine.drainOutbox()
    loadFromStore()
  }

  func applyRemoteChanges(_ kinds: Set<String>) {
    guard localStore != nil else { return }
    if kinds.contains("food") {
      foods = overlay(decoded(localStore!.documents(kind: "food")), kind: "food")
    }
    if kinds.contains("plan") {
      plans = overlay(decoded(localStore!.documents(kind: "plan")), kind: "plan")
    }
    if kinds.contains("recipe") {
      recipes = overlay(decoded(localStore!.documents(kind: "recipe")), kind: "recipe")
    }
    if kinds.contains("exercise") { mergeExercises() }
    if kinds.contains("workout") { loadFromStore() }
    if kinds.contains("meal") || kinds.contains("food") { reloadDay() }
    sendCompanion()
    if kinds.contains("meal"), healthEnabled { Task { await synchronizeHealth() } }
  }

  func foregroundSync() async {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("-ui-testing-local-store") { return }
    #endif
    guard !isPreview else { return }
    await syncEngine?.setForeground(true)
    await syncNow()
  }

  func backgroundSync() async {
    await syncEngine?.setForeground(false)
  }

  func destroyLocalFiles(clientId: String?, origin: String) {
    let folder = try? DiskStore.directory()
    let keys =
      storeIndex(folder).keys.filter { storeIndex(folder)[$0]?.origin == origin }
      + [accountKey]
    for key in Set(keys) where !key.isEmpty {
      localStore?.destroy()
      localStore = nil
      let names = [
        "queue-\(key).json", "cache-\(key).json", "writes-\(key).json", "library-\(key).json",
        "recent-exercises-\(key).json", "health-versions-\(key).json", "store-\(key).sqlite",
      ]
      for name in names {
        if let folder {
          try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
      }
      if let folder {
        let prefix = "exercise-taxonomy-\(key)"
        if let files = try? FileManager.default.contentsOfDirectory(
          at: folder, includingPropertiesForKeys: nil)
        {
          for file in files where file.lastPathComponent.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: file)
          }
        }
      }
      UserDefaults.standard.removeObject(forKey: "nutritionSyncEnabled.\(key)")
      UserDefaults.standard.removeObject(forKey: "sharesHealthSummary.\(key)")
    }
    if let clientId, !origin.isEmpty, let folder {
      let account = "account-\(OAuthSecurity.accountKey(origin: origin, ownerId: clientId)).json"
      try? FileManager.default.removeItem(at: folder.appendingPathComponent(account))
    }
    if let folder {
      var index = storeIndex(folder)
      for key in keys { index.removeValue(forKey: key) }
      writeStoreIndex(index, directory: folder)
    }
    syncEngine = nil
  }

  private func reloadToday() {
    let day = Date().calendarDay(timeZone: timeZone)
    if let summary = try? NutritionMath.summarize(
      meals: mealsFor(day: day), day: day, timeZone: timeZone)
    {
      todayNutrition = summary
    }
    if selectedDay.calendarDay(timeZone: timeZone) == day { nutrition = todayNutrition }
    sendCompanion()
  }

  private func mealsFor(day: String) -> [Record<Meal>] {
    guard let localStore, let bounds = try? NutritionMath.dayBounds(day: day, timeZone: timeZone)
    else { return [] }
    return localStore.meals(from: bounds.from, to: bounds.to).compactMap { $0.record(Meal.self) }
  }

  private func mergeExercises() {
    guard let localStore else { return }
    let owned = localStore.documents(kind: "exercise").compactMap { $0.record(Exercise.self) }
    let catalog = localStore.catalog(locale: language.rawValue).compactMap {
      row -> Record<Exercise>? in
      guard let data = try? JSONDecoder().decode(Exercise.self, from: row.data) else { return nil }
      return Record(id: row.id, kind: "exercise", version: 0, data: data)
    }
    let ownedIds = Set(owned.map(\.id))
    exerciseLibrary = owned + catalog.filter { !ownedIds.contains($0.id) }
    exerciseDetails = Dictionary(exerciseLibrary.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
    exerciseSyncCursor = localStore.meta("catalog_cursor")
    exerciseLibraryComplete = localStore.meta("catalog_complete") == "1"
  }

  private func decoded<Value: Decodable>(_ rows: [StoredDocument]) -> [Record<Value>] {
    rows.compactMap { $0.record(Value.self) }
  }

  private func overlay<Value: Decodable>(_ records: [Record<Value>], kind: String) -> [Record<
    Value
  >] {
    var result = records
    for entry in localStore?.outbox() ?? [] where entry.targetKind == kind {
      if entry.name.hasPrefix("delete_") {
        result.removeAll { $0.id == entry.targetId }
        continue
      }
      guard let data = entry.optimistic,
        let record = try? JSONDecoder().decode(Record<Value>.self, from: data)
      else { continue }
      if let index = result.firstIndex(where: { $0.id == record.id }) {
        result[index] = record
      } else {
        result.insert(record, at: 0)
      }
    }
    return result
  }

  private func pendingRecords<Value: Decodable>(_ type: Value.Type, kind: String) -> [Record<Value>]
  {
    (localStore?.outbox() ?? []).compactMap { entry in
      guard entry.targetKind == kind, entry.state == "pending" || entry.state == "conflict",
        let data = entry.optimistic
      else { return nil }
      return try? JSONDecoder().decode(Record<Value>.self, from: data)
    }
  }

  private func registerStore(key: String, origin: String, ownerId: String, directory: URL) throws {
    var index = storeIndex(directory)
    index[key] = StoreIndexEntry(origin: origin, ownerId: ownerId)
    writeStoreIndex(index, directory: directory)
  }

  private func storeIndex(_ directory: URL?) -> [String: StoreIndexEntry] {
    guard let directory else { return [:] }
    return DiskStore.read(
      [String: StoreIndexEntry].self, at: directory.appendingPathComponent("stores-index.json"))
      ?? [:]
  }

  private func writeStoreIndex(_ index: [String: StoreIndexEntry], directory: URL) {
    try? DiskStore.write(index, to: directory.appendingPathComponent("stores-index.json"))
  }

  #if DEBUG
    func configureLocalStoreFixture() {
      isConnected = true
      isPreview = false
      language = .english
      serverAddress = "http://127.0.0.1:9"
      context = try? JSONDecoder().decode(
        AgentContext.self,
        from: Data(
          #"{"ownerId":"fixture","actorId":"fixture","locale":"en","timeZone":"UTC","capabilities":{"syncFeed":1}}"#
            .utf8))
      syncStatus = .offline(lastSyncedAt: nil)
      let transport = RecordingTransport()
      recordingTransport = transport
      if let server = try? ServerConfiguration(serverAddress) {
        client = APIClient(
          server: server, vault: KeychainVault(service: "org.openfitness.uitest"),
          transport: transport)
      }
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent(
        "openfitness-uitest-\(UUID().uuidString)", isDirectory: true)
      try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      guard let store = try? LocalStore(url: folder.appendingPathComponent("store-fixture.sqlite"))
      else { return }
      localStore = store
      let offsets = [
        (0, "meal-today", 100.0), (-1, "meal-yesterday", 200.0), (-2, "meal-before", 300.0),
      ]
      for (offset, id, kcal) in offsets {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let date = calendar.date(byAdding: .day, value: offset, to: Date()) ?? Date()
        let day = date.calendarDay(timeZone: "UTC")
        let occurred = day + "T12:00:00.000Z"
        let meal = Meal(
          occurredAt: occurred, ingredients: [],
          nutrients: Nutrients(energyKcal: kcal, proteinG: 0, carbohydrateG: 0, fatG: 0, fiberG: 0))
        let data = try? JSONEncoder().encode(meal)
        if let data {
          _ = try? store.importDocument(
            StoredDocument(
              kind: "meal", id: id, version: 1, deleted: false, createdAt: occurred,
              updatedAt: occurred, data: data, occurredAt: occurred, source: "feed", seq: 1),
            source: "feed")
        }
      }
      try? store.setMeta("bootstrap_complete", "1")
      try? store.setMeta("time_zone", "UTC")
      loadFromStore()
      Task { @MainActor in
        while !Task.isCancelled {
          self.debugNetworkCount = transport.requests
          try? await Task.sleep(for: .milliseconds(100))
        }
      }
    }
  #endif
}

struct StoreIndexEntry: Codable, Sendable {
  var origin: String
  var ownerId: String
}

final class RecordingTransport: HTTPTransport, @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var requests: Int { lock.withLock { count } }
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    lock.withLock { count += 1 }
    throw URLError(.notConnectedToInternet)
  }
}
