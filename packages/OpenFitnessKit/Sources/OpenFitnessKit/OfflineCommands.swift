import Foundation

public struct PreparedRequest: Codable, Sendable {
  public var method: String
  public var path: String
  public var body: JSONValue
  public init(method: String, path: String, body: JSONValue) {
    self.method = method
    self.path = path
    self.body = body
  }
}
public struct OfflineCommand: Codable, Sendable, Identifiable {
  public enum Kind: String, Codable, Sendable {
    case startWorkout, logSet, finishWorkout, cancelWorkout
  }
  public var id: String
  public var accountKey: String
  public var kind: Kind
  public var workoutReference: String
  public var planId: String?
  public var planVersion: Int?
  public var exerciseId: String?
  public var metrics: SetMetrics?
  public var createdAt: String
  public var source: String
  public var prepared: PreparedRequest?
  public var retry: Int
  public var failureCode: String?
  public init(
    accountKey: String, kind: Kind, workoutReference: String, planId: String? = nil,
    exerciseId: String? = nil, metrics: SetMetrics? = nil, source: String = "ios",
    planVersion: Int? = nil
  ) {
    id = UUID().uuidString
    self.accountKey = accountKey
    self.kind = kind
    self.workoutReference = workoutReference
    self.planId = planId
    self.planVersion = planVersion
    self.exerciseId = exerciseId
    self.metrics = metrics
    self.source = source
    createdAt = Date().iso8601
    retry = 0
  }
  public var operationId: String { id + (retry == 0 ? "" : ".retry\(retry)") }
}
public struct CommandReceipt: Codable, Sendable {
  public var id: String
  public var workoutId: String
  public init(id: String, workoutId: String) {
    self.id = id
    self.workoutId = workoutId
  }
}
public struct CompanionReceipt: Codable, Sendable {
  public var accountKey: String
  public var receipt: CommandReceipt
  public init(accountKey: String, receipt: CommandReceipt) {
    self.accountKey = accountKey
    self.receipt = receipt
  }
}
public struct CompanionSnapshot: Codable, Sendable {
  public var accountKey: String
  public var connected: Bool
  public var language: String
  public var timeZone: String
  public var plans: [Record<TrainingPlan>]
  public var recipes: [Record<Recipe>]
  public var workout: Record<Workout>?
  public var nutrition: DailyNutrition?
  public var receipts: [CommandReceipt]
  public var updatedAt: String
  public init(
    accountKey: String, connected: Bool, language: String = "en",
    timeZone: String = "America/New_York", plans: [Record<TrainingPlan>] = [],
    recipes: [Record<Recipe>] = [], workout: Record<Workout>? = nil,
    nutrition: DailyNutrition? = nil, receipts: [CommandReceipt] = []
  ) {
    self.accountKey = accountKey
    self.connected = connected
    self.language = language
    self.timeZone = timeZone
    self.plans = plans
    self.recipes = recipes
    self.workout = workout
    self.nutrition = nutrition
    self.receipts = receipts
    updatedAt = Date().iso8601
  }
}
public struct CommandJournal: Codable, Sendable {
  public var commands: [OfflineCommand] = []
  public var receipts: [CommandReceipt] = []
  public var workoutIds: [String: String] = [:]
  public init() {}
  public mutating func enqueue(_ command: OfflineCommand, accountKey: String) throws {
    guard command.accountKey == accountKey else { throw APIError("ACCOUNT_MISMATCH") }
    guard !commands.contains(where: { $0.id == command.id }),
      !receipts.contains(where: { $0.id == command.id })
    else { return }
    commands.append(command)
  }
  public mutating func acknowledge(_ command: OfflineCommand, workoutId: String) {
    workoutIds[command.workoutReference] = workoutId
    commands.removeAll { $0.id == command.id }
    receipts.append(.init(id: command.id, workoutId: workoutId))
  }
}
public enum DiskStore {
  public static func directory() throws -> URL {
    let url = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("OpenFitness", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutable = url
    try mutable.setResourceValues(values)
    return url
  }
  public static func read<T: Decodable>(_ type: T.Type, at url: URL) -> T? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }
  public static func write<T: Encodable>(_ value: T, to url: URL) throws {
    #if os(iOS) || os(watchOS)
      try JSONEncoder().encode(value).write(
        to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try JSONEncoder().encode(value).write(to: url, options: .atomic)
    #endif
  }
}
