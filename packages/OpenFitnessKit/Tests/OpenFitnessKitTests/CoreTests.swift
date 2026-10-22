import Foundation
import Testing

@testable import OpenFitnessKit

@Test func pkceAndCallbackValidation() throws {
  #expect(
    OAuthSecurity.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
      == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  let callback = URL(
    string:
      "org.openfitness.app:/oauth/callback?state=expected&iss=https%3A%2F%2Ffitness.example&code=code"
  )!
  #expect(
    try OAuthSecurity.validateCallback(
      callback, state: "expected", issuer: "https://fitness.example") == "code")
  #expect(throws: APIError.self) {
    try OAuthSecurity.validateCallback(callback, state: "other", issuer: "https://fitness.example")
  }
  #expect(throws: APIError.self) {
    try OAuthSecurity.validateCallback(
      callback, state: "expected", issuer: "https://attacker.example")
  }
}
@Test func serverOriginAndEndpointBoundaries() throws {
  let server = try ServerConfiguration("https://fitness.example/admin")
  #expect(server.origin == "https://fitness.example")
  #expect(throws: APIError.self) { try ServerConfiguration("http://fitness.example") }
  #expect(throws: APIError.self) { try ServerConfiguration("https://user:secret@fitness.example") }
  #expect(throws: APIError.self) { try server.endpoint("//attacker.example") }
  #expect(try ServerConfiguration("http://localhost:8787").origin == "http://localhost:8787")
}
@Test func healthCorrectionsPreserveUnknownValuesAndVersions() throws {
  let payload = HealthExportPayload(
    syncIdentifier: "openfitness.meal.meal", syncVersion: 3, occurredAt: "2026-10-20T12:00:00Z",
    nutrients: .init(energyKcal: 0, proteinG: 12))
  var event = HealthExportEvent(
    id: "event", mealId: "meal", version: 3, action: "upsert", payload: payload)
  let changes = HealthExportPlanner.changes(for: event)
  #expect(changes.first { $0.key == .energyKcal }?.value == 0)
  #expect(changes.first { $0.key == .fiberG }?.value == nil)
  #expect(Set(changes.map(\.syncIdentifier)).count == 5)
  #expect(HealthExportPlanner.changes(for: event, lastAppliedVersion: 3).isEmpty)
  event.action = "delete"
  #expect(HealthExportPlanner.changes(for: event).allSatisfy { $0.value == nil })
}
@Test func offlineJournalRetainsPreparedWritesAndRejectsCrossAccountCommands() throws {
  var grouped = SetMetrics(reps: 5, weightKg: 60)
  grouped.groupId = "superset-A"
  let set = ActualSet(exerciseId: "squat", exercise: .init(name: "Squat"), metrics: grouped)
  let decoded = try JSONDecoder().decode(ActualSet.self, from: JSONEncoder().encode(set))
  #expect(decoded.metrics.groupId == "superset-A")
  var journal = CommandJournal()
  var command = OfflineCommand(
    accountKey: "account", kind: .logSet, workoutReference: "local-session", exerciseId: "squat",
    metrics: .init(reps: 5, weightKg: 60))
  command.prepared = .init(
    method: "POST", path: "/api/v1/workouts/server-session/sets",
    body: .object(["operationId": .string(command.operationId), "expectedVersion": .number(4)]))
  try journal.enqueue(command, accountKey: "account")
  try journal.enqueue(command, accountKey: "account")
  #expect(journal.commands.count == 1)
  let restored = try JSONDecoder().decode(CommandJournal.self, from: JSONEncoder().encode(journal))
  #expect(restored.commands.first?.prepared?.body == command.prepared?.body)
  #expect(throws: APIError.self) { try journal.enqueue(command, accountKey: "different") }
  journal.acknowledge(command, workoutId: "server-session")
  try journal.enqueue(command, accountKey: "account")
  #expect(journal.commands.isEmpty)
  #expect(journal.workoutIds["local-session"] == "server-session")
  for _ in 0..<1001 {
    let delayed = OfflineCommand(
      accountKey: "account", kind: .logSet, workoutReference: "server-session")
    journal.acknowledge(delayed, workoutId: "server-session")
  }
  try journal.enqueue(command, accountKey: "account")
  #expect(journal.commands.isEmpty)
}
@Test func localizationIsCompleteAndDoesNotChangeUserTextOrMath() throws {
  for key in CopyKey.allCases {
    #expect(Localizer(.english).hasTranslation(key))
    #expect(Localizer(.simplifiedChinese).hasTranslation(key))
  }
  #expect(Localizer(.english).text(.connect) != Localizer(.simplifiedChinese).text(.connect))
  let original = Food(name: "沙县鸡腿饭", nutrients: .init(energyKcal: 540, fiberG: nil))
  let decoded = try JSONDecoder().decode(Food.self, from: JSONEncoder().encode(original))
  #expect(decoded.name == "沙县鸡腿饭")
  #expect(decoded.nutrients.scaled(by: 0.5).energyKcal == 270)
  #expect(decoded.nutrients.scaled(by: 0.5).fiberG == nil)
}
private final class TestVault: CredentialVault, @unchecked Sendable {
  private let lock = NSLock()
  private var value: OAuthCredentials?
  init(_ value: OAuthCredentials?) { self.value = value }
  func read(for origin: String) -> OAuthCredentials? { lock.withLock { value } }
  func write(_ value: OAuthCredentials?, for origin: String) {
    lock.withLock { self.value = value }
  }
}
private actor TestTransport: HTTPTransport {
  var refreshes = 0
  var writes: [URLRequest] = []
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let path = request.url!.path
    let result: Data
    if path == "/.well-known/oauth-authorization-server" {
      result = Data(
        #"{"issuer":"https://fitness.example","authorization_endpoint":"https://fitness.example/authorize","token_endpoint":"https://fitness.example/oauth/token","registration_endpoint":"https://fitness.example/oauth/register","code_challenge_methods_supported":["S256"]}"#
          .utf8)
    } else if path == "/oauth/token" {
      refreshes += 1
      try await Task.sleep(for: .milliseconds(20))
      result = Data(
        #"{"access_token":"renewed-test-token","refresh_token":"rotated-test-refresh","expires_in":3600}"#
          .utf8)
    } else {
      writes.append(request)
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer renewed-test-token")
      result = Data(#"{"data":{"ok":true}}"#.utf8)
    }
    return (
      result,
      HTTPURLResponse(
        url: request.url!, statusCode: 200, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
    )
  }
}
@Test func concurrentRequestsShareOneTokenRefresh() async throws {
  let transport = TestTransport()
  let vault = TestVault(
    .init(
      clientId: "test-client", accessToken: "expired", refreshToken: "test-refresh",
      expiresAt: .distantPast))
  let api = APIClient(
    server: try .init("https://fitness.example"), vault: vault, transport: transport)
  struct Result: Decodable, Sendable { var ok: Bool }
  try await withThrowingTaskGroup(of: Bool.self) { group in
    for _ in 0..<5 { group.addTask { try await api.request(Result.self, path: "/api/v1/test").ok } }
    for try await ok in group { #expect(ok) }
  }
  #expect(await transport.refreshes == 1)
  #expect(vault.read(for: "https://fitness.example")?.refreshToken == "rotated-test-refresh")
}

private actor LostResponseTransport: HTTPTransport {
  var bodies: [Data] = []
  var loseNextResponse = true
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    bodies.append(request.httpBody ?? Data())
    if loseNextResponse {
      loseNextResponse = false
      throw URLError(.networkConnectionLost)
    }
    return (
      Data(#"{"data":{"saved":true}}"#.utf8),
      HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    )
  }
}
@Test func uncertainMealWriteSurvivesRestartWithTheSameOperation() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let vault = TestVault(.init(clientId: "native", accessToken: "test-access"))
  let transport = LostResponseTransport()
  let server = try ServerConfiguration("https://fitness.example")
  let first = APIClient(server: server, vault: vault, transport: transport)
  try await first.enableMutationRecovery(accountKey: "owner", directory: directory)
  do {
    _ = try await first.mutation(
      JSONValue.self, path: "/api/v1/meals", fields: ["occurredAt": .string("2026-10-20T12:00:00Z")]
    )
    Issue.record("A lost response must remain recoverable.")
  } catch is URLError {}
  let restarted = APIClient(server: server, vault: vault, transport: transport)
  try await restarted.enableMutationRecovery(accountKey: "owner", directory: directory)
  try await restarted.recoverPendingMutations()
  let bodies = await transport.bodies
  #expect(bodies.count == 2)
  #expect(
    try JSONDecoder().decode(JSONValue.self, from: bodies[0])
      == JSONDecoder().decode(JSONValue.self, from: bodies[1]))
  try await restarted.recoverPendingMutations()
  #expect(await transport.bodies.count == 2)
  let otherAccount = APIClient(server: server, vault: vault, transport: transport)
  try await otherAccount.enableMutationRecovery(accountKey: "different-owner", directory: directory)
  try await otherAccount.recoverPendingMutations()
  #expect(await transport.bodies.count == 2)
}

@Test func searchQueryValuesUseOnlyRFC3986UnreservedCharacters() throws {
  let values = [
    ("卧推", "%E5%8D%A7%E6%8E%A8"),
    ("哑铃 卧推", "%E5%93%91%E9%93%83%20%E5%8D%A7%E6%8E%A8"),
    ("3/4 sit-up", "3%2F4%20sit-up"),
    ("a&b=c", "a%26b%3Dc"), ("+", "%2B"), ("-._~", "-._~"),
  ]
  let server = try ServerConfiguration("https://fitness.example")
  for (raw, encoded) in values {
    #expect(raw.queryValue == encoded)
    let url = try server.endpoint("/api/v1/exercises?query=\(raw.queryValue)")
    #expect(
      URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value == raw)
  }
}

private func catalogueFixtures() throws -> [Record<Exercise>] {
  let url = try #require(Bundle.module.url(forResource: "catalog-exercises", withExtension: "json"))
  return try JSONDecoder().decode([Record<Exercise>].self, from: Data(contentsOf: url))
}
@Test func catalogueFieldsRoundTripAndOlderExercisesStillDecode() throws {
  let records = try catalogueFixtures()
  #expect(records.count == 3)
  #expect(records[0].isCatalogOnly)
  #expect(records[0].data.description == nil)
  #expect(records[0].data.diagram?.highlights?.first?.matched == true)
  #expect(records[0].data.i18n?["zh-CN"]?.provenance?.tool == "fixture")
  #expect(records[2].data.variantOf == "cat-5266")
  let roundTrip = try JSONDecoder().decode(
    [Record<Exercise>].self, from: JSONEncoder().encode(records))
  #expect(try JSONValue.from(records) == JSONValue.from(roundTrip))
  let old = try JSONDecoder().decode(Exercise.self, from: Data(#"{"name":"Squat"}"#.utf8))
  #expect(old.name == "Squat")
  #expect(old.diagram == nil)
  #expect(old.localized(.simplifiedChinese).name == "Squat")
}
@Test func catalogueLocalizationIsIdempotent() throws {
  let original = try catalogueFixtures()[0].data
  #expect(try JSONValue.from(original.localized(.english)) == JSONValue.from(original))
  let translated = original.localized(.simplifiedChinese)
  #expect(translated.name == "四分之三仰卧起坐")
  #expect(translated.description == "练习腹肌。")
  #expect(translated.aliases?.contains(original.name) == true)
  #expect(translated.aliases?.contains(translated.name) == false)
  #expect(
    try JSONValue.from(translated.localized(.simplifiedChinese)) == JSONValue.from(translated))
  var presented = translated
  presented.aliases = [original.name, "卷腹"]
  #expect(try JSONValue.from(presented.localized(.simplifiedChinese)) == JSONValue.from(presented))
}
@Test func catalogueCapabilityIsOptional() throws {
  for capabilities in [#"{}"#, #"{"exerciseCatalog":"shared_catalog","healthSyncProtocol":1}"#] {
    let json = """
      {"ownerId":"owner","actorId":"actor","locale":"en","timeZone":"Asia/Shanghai",
       "capabilities":\(capabilities)}
      """
    let context = try JSONDecoder().decode(AgentContext.self, from: Data(json.utf8))
    #expect(context.capabilities.exerciseCatalog == (capabilities == "{}" ? nil : "shared_catalog"))
  }
}

@Test func muscleMapPreservesRepeatedSurfacesAndUnmappedRegions() throws {
  let url = try #require(Bundle.module.url(forResource: "male-front", withExtension: "svg"))
  let artwork = try MuscleMap.parse(svg: Data(contentsOf: url))
  #expect(artwork.viewBox.width == 1024)
  #expect(artwork.viewBox.height == 1536)
  #expect(artwork.surfaces.count == 30)
  #expect(artwork.surfaces["QUADRICEPS_LEFT"]?.count == 2)
  #expect(artwork.surfaces["SERRATUS_LEFT"]?.count == 4)
  #expect(artwork.surfaces["ABDUCTOR_LEFT"] != nil)
  #expect(artwork.regions["ABDUCTOR_LEFT"] == nil)
  #expect(!artwork.outline.isEmpty)
  let roundTrip = try JSONDecoder().decode(
    MuscleMapArtwork.self, from: JSONEncoder().encode(artwork))
  #expect(roundTrip.surfaces == artwork.surfaces)
}
private func svgWithPath(_ path: String) -> Data {
  Data(
    """
    <svg viewBox="0 0 10 20"><path data-outline="BODY" d="M0 0L10 20Z"/>
    <path data-surface="TEST" d="\(path)"/></svg>
    """.utf8)
}
@Test func muscleMapSupportsRelativeRepeatedAndHorizontalVerticalCommands() throws {
  let artwork = try MuscleMap.parse(
    svg: svgWithPath("m1 2 3 4h2v-1c1 0 2 0 3 0 1 0 2 0 3 0z M1e1 .5L-1-2Z"))
  #expect(
    artwork.surfaces["TEST"]?.first == [
      .move(1, 2), .line(4, 6), .line(6, 6), .line(6, 5),
      .cubic(7, 5, 8, 5, 9, 5), .cubic(10, 5, 11, 5, 12, 5), .close,
      .move(10, 0.5), .line(-1, -2), .close,
    ])
}
@Test func muscleMapRejectsUnsupportedAndMalformedPaths() {
  for path in ["M0 0Q1 2 3 4", "M0 0A1 2 3 4 5 6 7", "M0 0L1", "M0 0@L1 2", "", "Z"] {
    #expect(throws: APIError.self) { try MuscleMap.parse(svg: svgWithPath(path)) }
  }
}
private actor PublicArtworkTransport: HTTPTransport {
  var requests: [URLRequest] = []
  let status: Int
  let responseURL: URL?
  init(status: Int = 200, responseURL: URL? = nil) {
    self.status = status
    self.responseURL = responseURL
  }
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    requests.append(request)
    return (
      Data("svg".utf8),
      HTTPURLResponse(
        url: responseURL ?? request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["Location": "https://attacker.example/art.svg"])!
    )
  }
}
@Test func publicArtworkNeverSendsCredentialsAndRejectsOtherEndpoints() async throws {
  let transport = PublicArtworkTransport()
  let api = APIClient(
    server: try .init("https://fitness.example"),
    vault: TestVault(.init(clientId: "native", accessToken: "private-token")), transport: transport)
  #expect(try await api.publicData(path: "/musclemap/male-front.svg") == Data("svg".utf8))
  let requests = await transport.requests
  #expect(requests.first?.httpMethod == "GET")
  #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
  for path in [
    "/api/v1/exercises", "https://attacker.example/musclemap/male-front.svg",
    "//attacker.example/musclemap/male-front.svg", "/musclemap/../api/v1/agent-context",
    "/musclemap/%2e%2e/secret.svg", "/musclemap/male-front.svg?token=secret",
  ] {
    await #expect(throws: APIError.self) { try await api.publicData(path: path) }
  }
  #expect(await transport.requests.count == 1)
  for transport in [
    PublicArtworkTransport(status: 302),
    PublicArtworkTransport(
      responseURL: URL(string: "https://attacker.example/musclemap/male-front.svg")),
  ] {
    let api = APIClient(
      server: try .init("https://fitness.example"), vault: TestVault(nil), transport: transport)
    await #expect(throws: APIError.self) {
      try await api.publicData(path: "/musclemap/male-front.svg")
    }
  }
}

@Test func unplannedWorkoutSetsPersistTheirSnapshotAndLegacyCommandsStillDecode() throws {
  let planned = Exercise(name: "Original plan squat")
  let plan = Record(
    id: "plan", kind: "plan",
    data: TrainingPlan(
      name: "Training", exercises: [.init(exerciseId: "squat", exercise: planned, sets: [])]))
  let workout = Record(id: "session", kind: "workout", data: Workout(name: "Training", plan: plan))
  let catalog = try catalogueFixtures()[0]
  let command = try OfflineCommand.workoutSet(
    accountKey: "owner", workout: workout, exerciseId: catalog.id,
    metrics: .init(reps: 8), exercise: catalog.data)
  #expect(command.exerciseSnapshot?.name == catalog.data.name)
  var journal = CommandJournal()
  try journal.enqueue(command, accountKey: "owner")
  let restored = try JSONDecoder().decode(CommandJournal.self, from: JSONEncoder().encode(journal))
  #expect(restored.commands[0].exerciseSnapshot?.name == catalog.data.name)
  #expect(restored.commands[0].id == command.id)
  #expect(throws: APIError.self) {
    try OfflineCommand.workoutSet(
      accountKey: "owner", workout: workout, exerciseId: "unknown", metrics: .init())
  }
  let plannedCommand = try OfflineCommand.workoutSet(
    accountKey: "owner", workout: workout, exerciseId: "squat", metrics: .init(),
    exercise: Exercise(name: "Updated template"))
  #expect(plannedCommand.exerciseSnapshot?.name == "Original plan squat")
  var old = try #require(
    JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
  old.removeValue(forKey: "exerciseSnapshot")
  let legacy = try JSONDecoder().decode(
    OfflineCommand.self, from: JSONSerialization.data(withJSONObject: old))
  #expect(legacy.exerciseSnapshot == nil)
  #expect(legacy.exerciseId == command.exerciseId)
}
@Test func recentExercisesAreBoundedDeduplicatedAndPersistedInUseOrder() throws {
  var history = RecentExerciseHistory()
  for index in 0..<25 {
    history.record(
      .init(id: "exercise-\(index)", kind: "exercise", data: .init(name: "Exercise \(index)")))
  }
  #expect(history.items.count == 20)
  #expect(history.items.first?.id == "exercise-24")
  let date = Date(timeIntervalSince1970: 1234)
  history.record(
    .init(id: "exercise-10", kind: "exercise", data: .init(name: "Selected again")), at: date)
  #expect(history.items.first?.id == "exercise-10")
  #expect(history.items.first?.usedAt == date)
  #expect(Set(history.items.map(\.id)).count == 20)
  let decoded = try JSONDecoder().decode(
    RecentExerciseHistory.self, from: JSONEncoder().encode(history))
  #expect(decoded.items.map(\.id) == history.items.map(\.id))
  #expect(decoded.items.first?.record.data.name == "Selected again")
}
