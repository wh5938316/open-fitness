import Foundation
import Testing

@testable import OpenFitnessKit

@Suite(.serialized) struct LocalStoreTests {
  @Test func versionGuardTombstoneAndCursorRollback() throws {
    let store = try TestDirectory().store()
    let account = SyncAccount(ownerId: "owner", timeZone: "UTC", locale: "en")
    let first = change(seq: 1, id: "a", version: 1)
    _ = try store.apply(items: [first], cursor: "c1", account: account)
    let older = change(seq: 2, id: "a", version: 1, name: "stale")
    _ = try store.apply(items: [older], cursor: "c2", account: account)
    #expect(store.document(kind: "food", id: "a")?.version == 1)
    let tombstone = change(seq: 3, id: "a", version: 2, deleted: true)
    _ = try store.apply(items: [tombstone], cursor: "c3", account: account)
    #expect(store.documents(kind: "food").isEmpty)
    #expect(store.document(kind: "food", id: "a")?.deleted == true)
    let before = store.meta("cursor")
    let bad = ChangeItem(
      seq: 4, id: "", kind: "", version: 1, createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", data: .object([:]))
    #expect(throws: SQLiteError.self) {
      try store.apply(
        items: [change(seq: 4, id: "b", version: 1), bad], cursor: "c4", account: account)
    }
    #expect(store.meta("cursor") == before)
    #expect(store.document(kind: "food", id: "b") == nil)
  }

  @Test func deleteLegacyKeepsResponseAndOutboxRows() throws {
    let store = try TestDirectory().store()
    let account = SyncAccount(ownerId: "owner", timeZone: "UTC", locale: "en")
    _ = try store.apply(
      items: [change(seq: 1, id: "feed", version: 1)], cursor: "c", account: account)
    _ = try store.importDocument(stored("legacy"), source: "legacy")
    _ = try store.importDocument(stored("kept", id: "kept"), source: "legacy")
    _ = try store.upsertResponse(stored("response", id: "response"))
    _ = try store.enqueue(
      OutboxDraft(
        operationId: "op-kept", name: "save_food",
        request: PreparedRequest(method: "POST", path: "/api/v1/foods", body: .object([:])),
        targetKind: "food", targetId: "kept"))
    try store.deleteLegacy()
    #expect(store.document(kind: "food", id: "legacy") == nil)
    #expect(store.document(kind: "food", id: "kept") != nil)
    #expect(store.document(kind: "food", id: "response")?.source == "response")
    #expect(store.document(kind: "food", id: "feed")?.source == "feed")
  }

  @Test func accountsAreIsolatedAndDestroyRemovesSidecars() throws {
    let directory = TestDirectory()
    let left = try directory.store("a")
    let right = try directory.store("b")
    _ = try left.importDocument(stored("only-a"), source: "legacy")
    #expect(right.document(kind: "food", id: "only-a") == nil)
    let path = left.url.path
    left.destroy()
    #expect(!FileManager.default.fileExists(atPath: path))
    #expect(!FileManager.default.fileExists(atPath: path + "-wal"))
    #expect(!FileManager.default.fileExists(atPath: path + "-shm"))
    _ = right
  }
}

@Suite(.serialized) struct SyncEngineTests {
  @Test func bootstrapPagesResetAndOwnerMismatch() async throws {
    let directory = TestDirectory()
    let store = try directory.store()
    _ = try store.importDocument(stored("old"), source: "legacy")
    let transport = FeedTransport()
    await transport.setPages([
      page(reset: true),
      page(items: [change(seq: 1, id: "one", version: 1)], cursor: "p1", hasMore: true),
      page(items: [change(seq: 2, id: "two", version: 1)], cursor: "p2", hasMore: false),
    ])
    let engine = try await makeEngine(store: store, transport: transport)
    await engine.pull()
    #expect(store.document(kind: "food", id: "old") == nil)
    #expect(store.document(kind: "food", id: "one") != nil)
    #expect(store.document(kind: "food", id: "two") != nil)
    #expect(store.meta("bootstrap_complete") == "1")
    #expect(await engine.status == .idle(lastSyncedAt: store.meta("last_synced_at")))

    await transport.setPages([
      page(items: [change(seq: 3, id: "foreign", version: 1)], accountOwner: "other")
    ])
    await engine.pull()
    #expect(store.document(kind: "food", id: "foreign") == nil)
    #expect(await engine.status == .needsSignIn)
  }

  @Test func authAndServerFailuresKeepLocalRows() async throws {
    let store = try TestDirectory().store()
    _ = try store.importDocument(stored("kept", id: "kept"), source: "response")
    let denied = FeedTransport()
    await denied.setStatus(401)
    let deniedEngine = try await makeEngine(store: store, transport: denied)
    await deniedEngine.pull()
    #expect(await deniedEngine.status == .needsSignIn)
    #expect(store.document(kind: "food", id: "kept") != nil)

    let broken = FeedTransport()
    await broken.setStatus(503)
    let brokenEngine = try await makeEngine(store: store, transport: broken, owner: "owner-503")
    await brokenEngine.pull()
    if case .failed = await brokenEngine.status {
    } else {
      Issue.record("A server error should surface without clearing data")
    }
    #expect(store.document(kind: "food", id: "kept") != nil)
  }

  @Test func outboxOrdersCoalescesReplaysAndConflicts() async throws {
    let store = try TestDirectory().store()
    let transport = FeedTransport()
    let engine = try await makeEngine(store: store, transport: transport, retryNanoseconds: 1_000)
    let first = draft("a", id: "food-1", name: "save_food")
    _ = try await engine.enqueue(first)
    _ = try await engine.enqueue(draft("b", id: "food-1", name: "save_food"))
    #expect(store.outbox().count == 1)
    #expect(store.outbox().first?.operationId == "a")
    try store.updateOutbox(operationId: "a", attempts: 1)
    _ = try await engine.enqueue(draft("c", id: "food-1", name: "save_food"))
    #expect(store.outbox().count == 2)
    await transport.failNext(1)
    await transport.setSuccessBody(recordJSON(id: "food-1"))
    await engine.drainOutbox()
    let bodies = await transport.bodies()
    #expect(bodies.count >= 2)
    #expect(bodies[0] == bodies[1])

    let conflictStore = try TestDirectory().store("conflict")
    let conflictTransport = FeedTransport()
    await conflictTransport.setStatus(409, code: "VERSION_CONFLICT")
    let conflictEngine = try await makeEngine(
      store: conflictStore, transport: conflictTransport, owner: "owner-conflict")
    _ = try await conflictEngine.enqueue(draft("edit", id: "food-9", name: "save_food"))
    _ = try conflictStore.importDocument(stored("server", id: "food-9", version: 4), source: "feed")
    await conflictEngine.drainOutbox()
    #expect(conflictStore.outbox().first?.state == "conflict")
    try await conflictEngine.retryConflict(operationId: "edit")
    #expect(conflictStore.outbox().contains { $0.operationId == "edit.rebase1" })

    let missingStore = try TestDirectory().store("missing")
    let missingTransport = FeedTransport()
    await missingTransport.setStatus(404, code: "NOT_FOUND")
    let missingEngine = try await makeEngine(
      store: missingStore, transport: missingTransport, owner: "owner-missing")
    _ = try missingStore.enqueue(draft("parent", id: "food-x", name: "save_food"))
    try missingStore.updateOutbox(operationId: "parent", attempts: 1)
    _ = try missingStore.enqueue(draft("child", id: "food-x", name: "save_food"))
    await missingEngine.drainOutbox()
    let states = missingStore.outbox().map(\.state)
    #expect(states.allSatisfy { $0 == "failed" })

    let unknownStore = try TestDirectory().store("unknown")
    let unknownTransport = FeedTransport()
    await unknownTransport.setAccountOwner("owner-unknown")
    await unknownTransport.setWriteStatus(409, code: "IDEMPOTENCY_CONFLICT")
    let unknownEngine = try await makeEngine(
      store: unknownStore, transport: unknownTransport, owner: "owner-unknown")
    _ = try unknownStore.enqueue(
      draft("create", id: "food-z", name: "save_food", baseVersion: nil))
    await unknownEngine.drainOutbox()
    #expect(unknownStore.outbox().first?.state == "unknown")
    _ = try unknownStore.importDocument(stored("landed", id: "food-z"), source: "feed")
    try unknownStore.updateOutbox(
      operationId: "create", state: "pending", attempts: 0, clearError: true)
    await unknownEngine.pull()
    await unknownEngine.drainOutbox()
    #expect(unknownStore.outbox().isEmpty)
  }

  @Test func pokePullsAndReconnects() async throws {
    let store = try TestDirectory().store()
    let transport = FeedTransport()
    await transport.setPages([
      page(items: [change(seq: 1, id: "poked", version: 1)], hasMore: false)
    ])
    let events = ScriptedEvents(events: [.ready, .changed])
    let engine = try await makeEngine(store: store, transport: transport, events: events)
    await engine.start()
    try await Task.sleep(for: .milliseconds(250))
    #expect(store.document(kind: "food", id: "poked") != nil)
    await engine.stop()
    let connects = await events.connects
    #expect(connects >= 1)
  }
}

@Suite struct NutritionParityTests {
  @Test func sharedFixtureMatchesTheServer() throws {
    let url = Bundle.module.url(forResource: "daily-nutrition-parity", withExtension: "json")
    let data = try Data(contentsOf: try #require(url))
    let fixture = try JSONDecoder().decode(ParityFixture.self, from: data)
    for item in fixture.cases {
      let meals = item.meals.map { meal in
        Record(
          id: meal.id, kind: "meal",
          data: Meal(
            occurredAt: meal.occurredAt, ingredients: [], nutrients: meal.nutrients),
          createdAt: meal.createdAt, updatedAt: meal.createdAt)
      }
      var decoded = meals
      for index in decoded.indices where item.meals[index].deleted == true {
        decoded[index].deleted = true
      }
      if let code = item.expect.error {
        #expect(throws: APIError.self) {
          try NutritionMath.summarize(meals: decoded, day: item.day, timeZone: item.timeZone)
        }
        do {
          _ = try NutritionMath.summarize(meals: decoded, day: item.day, timeZone: item.timeZone)
        } catch let error as APIError {
          #expect(error.code == code)
        }
        continue
      }
      let summary = try NutritionMath.summarize(
        meals: decoded, day: item.day, timeZone: item.timeZone)
      let bounds = try NutritionMath.dayBounds(day: item.day, timeZone: item.timeZone)
      #expect(bounds.from == item.expect.from)
      #expect(bounds.to == item.expect.to)
      #expect(summary.mealCount == item.expect.mealCount)
      #expect(summary.nutrients == item.expect.nutrients)
    }
  }

  @Test func conversionAndMissingDensity() throws {
    var food = Food(
      name: "Milk", nutrients: Nutrients(energyKcal: 200),
      basis: FoodBasis(quantity: 100, unit: "g"))
    #expect(try NutritionMath.foodNutrition(food: food, amount: 50, unit: "g").energyKcal == 100)
    #expect(NutritionMath.optionalFoodNutrition(food: food, amount: 10, unit: "ml") == nil)
    food.densityGPerMl = 1
    #expect(try NutritionMath.foodNutrition(food: food, amount: 50, unit: "ml").energyKcal == 100)
    #expect(NutritionMath.scaleNutrients(food.nutrients, factor: 0).energyKcal == 0)
    let unknown = Nutrients(energyKcal: 1, proteinG: nil)
    #expect(NutritionMath.sumNutrients([unknown]).proteinG == nil)
    #expect(NutritionMath.sumNutrients([]).energyKcal == 0)
  }
}

@Suite struct LegacyImportTests {
  @Test func importsLibraryCacheAndWrites() throws {
    let directory = TestDirectory()
    try FileManager.default.createDirectory(at: directory.url, withIntermediateDirectories: true)
    let folder = directory.url
    let key = "account"
    let meal = Record(
      id: "meal-1", kind: "meal",
      data: Meal(
        occurredAt: "2026-01-01T12:00:00.000Z", ingredients: [],
        nutrients: Nutrients(energyKcal: 10)),
      createdAt: "2026-01-01T12:00:00.000Z", updatedAt: "2026-01-01T12:00:00.000Z")
    let catalog = Record(
      id: "cat-0001", kind: "exercise", version: 0, data: Exercise(name: "Catalog curl"))
    let owned = Record(id: "ex-1", kind: "exercise", version: 2, data: Exercise(name: "Own curl"))
    var library = LegacyDeviceLibrary()
    library.meals = [meal]
    library.exercises = [catalog, owned]
    library.exercisesCursor = "cursor"
    library.exercisesComplete = true
    try DiskStore.write(library, to: folder.appendingPathComponent("library-\(key).json"))
    let pending = Record(
      id: "local-workout", kind: "workout", version: 0, data: Workout(name: "Offline"))
    let snapshot = CompanionSnapshot(
      accountKey: key, connected: true,
      plans: [
        Record(id: "plan-1", kind: "plan", data: TrainingPlan(name: "Day A", exercises: []))
      ], workout: pending)
    try DiskStore.write(snapshot, to: folder.appendingPathComponent("cache-\(key).json"))
    let request = PreparedRequest(
      method: "POST", path: "/api/v1/foods",
      body: .object(["operationId": .string("op-legacy"), "id": .string("food-legacy")]))
    try DiskStore.write(["fp": request], to: folder.appendingPathComponent("writes-\(key).json"))
    let store = try directory.store(key)
    try LegacyImport.importAccount(store: store, directory: folder, accountKey: key)
    #expect(store.document(kind: "meal", id: "meal-1")?.source == "legacy")
    #expect(store.document(kind: "exercise", id: "ex-1") != nil)
    #expect(store.document(kind: "exercise", id: "cat-0001") == nil)
    #expect(store.catalog(locale: "en").contains { $0.id == "cat-0001" })
    #expect(store.document(kind: "plan", id: "plan-1") != nil)
    #expect(store.meta("pending_local_workout")?.contains("local-workout") == true)
    #expect(store.outbox().contains { $0.operationId == "op-legacy" })
    #expect(
      !FileManager.default.fileExists(
        atPath: folder.appendingPathComponent("writes-\(key).json").path))
    try LegacyImport.importAccount(store: store, directory: folder, accountKey: key)
    #expect(store.outbox().filter { $0.operationId == "op-legacy" }.count == 1)
  }
}

private struct ParityFixture: Decodable {
  struct Meal: Decodable {
    var id: String
    var createdAt: String
    var deleted: Bool?
    var occurredAt: String
    var nutrients: Nutrients
  }
  struct Expectation: Decodable {
    var error: String?
    var from: String?
    var to: String?
    var mealCount: Int?
    var nutrients: Nutrients?
  }
  struct Case: Decodable {
    var name: String
    var day: String
    var timeZone: String
    var meals: [Meal]
    var expect: Expectation
  }
  var cases: [Case]
}

private struct TestDirectory {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  func store(_ name: String = "store") throws -> LocalStore {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return try LocalStore(url: url.appendingPathComponent("\(name).sqlite"))
  }
}

private func change(
  seq: Int, id: String, version: Int, deleted: Bool = false, name: String = "Oats"
) -> ChangeItem {
  ChangeItem(
    seq: seq, id: id, kind: "food", version: version, deleted: deleted,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    data: .object(["name": .string(name)]))
}

private func stored(_ name: String, id: String = "legacy", version: Int = 1) -> StoredDocument {
  StoredDocument(
    kind: "food", id: id, version: version, deleted: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    data: Data(#"{"name":"\#(name)"}"#.utf8), occurredAt: nil, source: "legacy", seq: nil)
}

private func page(
  items: [ChangeItem] = [], cursor: String? = "cursor", hasMore: Bool = false, reset: Bool = false,
  accountOwner: String = "owner"
) -> Data {
  let page = ChangePage(
    items: items, cursor: cursor, hasMore: hasMore, reset: reset,
    account: SyncAccount(ownerId: accountOwner, timeZone: "UTC", locale: "en"))
  return try! JSONEncoder().encode(APIBox(data: page))
}

private struct APIBox<T: Encodable>: Encodable { var data: T }

private func draft(_ operationId: String, id: String, name: String, baseVersion: Int? = 1)
  -> OutboxDraft
{
  OutboxDraft(
    operationId: operationId, name: name,
    request: PreparedRequest(
      method: "POST", path: "/api/v1/foods",
      body: .object(["operationId": .string(operationId), "id": .string(id)])),
    targetKind: "food", targetId: id, baseVersion: baseVersion)
}

private func recordJSON(id: String) -> Data {
  Data(
    """
    {"data":{"id":"\(id)","kind":"food","version":1,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","data":{"name":"Saved"}}}
    """.utf8)
}

private func makeEngine(
  store: LocalStore, transport: FeedTransport, events: any SyncEventsTransport = SilentEvents(),
  owner: String = "owner", retryNanoseconds: UInt64 = 1_000_000_000
) async throws -> SyncEngine {
  let vault = MemoryVault(
    .init(clientId: "native", accessToken: "token", expiresAt: .distantFuture))
  let api = APIClient(
    server: try ServerConfiguration("https://fitness.example"), vault: vault, transport: transport)
  return SyncEngine(
    store: store, api: api, ownerId: owner, events: events, retryNanoseconds: retryNanoseconds)
}

private final class MemoryVault: CredentialVault, @unchecked Sendable {
  private let lock = NSLock()
  private var value: OAuthCredentials?
  init(_ value: OAuthCredentials?) { self.value = value }
  func read(for origin: String) -> OAuthCredentials? { lock.withLock { value } }
  func write(_ value: OAuthCredentials?, for origin: String) {
    lock.withLock { self.value = value }
  }
}

private actor FeedTransport: HTTPTransport {
  var pages: [Data] = []
  var status = 200
  var code = "ERROR"
  /// Mutation status. Pulls keep using `status` so a 409 write does not blank the change feed.
  var writeStatus: Int?
  var writeCode: String?
  var accountOwner = "owner"
  var requests: [URLRequest] = []
  var failures = 0
  var successBody: Data?
  func setPages(_ pages: [Data]) { self.pages = pages }
  func setStatus(_ status: Int, code: String = "ERROR") {
    self.status = status
    self.code = code
  }
  func setWriteStatus(_ status: Int, code: String = "ERROR") {
    writeStatus = status
    writeCode = code
  }
  func setAccountOwner(_ owner: String) { accountOwner = owner }
  func setSuccessBody(_ data: Data) { successBody = data }
  func failNext(_ count: Int) { failures = count }
  func bodies() -> [Data] { requests.compactMap(\.httpBody) }
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    requests.append(request)
    let url = request.url!
    let isChangeFeed = url.path == "/api/v1/sync/changes"
    let responseStatus = isChangeFeed ? status : (writeStatus ?? status)
    let responseCode = isChangeFeed ? code : (writeCode ?? code)
    let payload: Data
    if url.path == "/.well-known/oauth-authorization-server" {
      payload = Data(
        #"{"issuer":"https://fitness.example","authorization_endpoint":"https://fitness.example/authorize","token_endpoint":"https://fitness.example/oauth/token","code_challenge_methods_supported":["S256"]}"#
          .utf8)
    } else if failures > 0 {
      failures -= 1
      throw URLError(.timedOut)
    } else if responseStatus >= 400 {
      payload = Data(#"{"error":{"code":"\#(responseCode)","message":"failed"}}"#.utf8)
    } else if isChangeFeed {
      payload = pages.isEmpty ? page(accountOwner: accountOwner) : pages.removeFirst()
    } else {
      payload = successBody ?? recordJSON(id: "saved")
    }
    return (
      payload,
      HTTPURLResponse(
        url: url, statusCode: responseStatus == 0 ? 200 : responseStatus, httpVersion: nil,
        headerFields: nil)!
    )
  }
}

private struct SilentEvents: SyncEventsTransport {
  func connect(request: URLRequest) async throws -> AsyncStream<SyncEvent> {
    AsyncStream { $0.finish() }
  }
}

private actor ScriptedEvents: SyncEventsTransport {
  var events: [SyncEvent]
  var connects = 0
  init(events: [SyncEvent]) { self.events = events }
  func connect(request: URLRequest) async throws -> AsyncStream<SyncEvent> {
    connects += 1
    let events = self.events
    return AsyncStream { continuation in
      for event in events { continuation.yield(event) }
      continuation.finish()
    }
  }
}
