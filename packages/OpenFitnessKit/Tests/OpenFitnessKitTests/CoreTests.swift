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
