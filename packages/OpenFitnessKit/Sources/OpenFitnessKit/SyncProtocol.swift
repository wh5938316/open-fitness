import Foundation

public struct SyncAccount: Codable, Sendable, Equatable {
  public var ownerId: String
  public var timeZone: String
  public var locale: String
  public init(ownerId: String, timeZone: String, locale: String) {
    self.ownerId = ownerId
    self.timeZone = timeZone
    self.locale = locale
  }
}

public struct ChangeItem: Codable, Sendable, Equatable {
  public var seq: Int
  public var id: String
  public var kind: String
  public var version: Int
  public var deleted: Bool
  public var createdAt: String
  public var updatedAt: String
  public var data: JSONValue
  public init(
    seq: Int, id: String, kind: String, version: Int, deleted: Bool = false,
    createdAt: String, updatedAt: String, data: JSONValue
  ) {
    self.seq = seq
    self.id = id
    self.kind = kind
    self.version = version
    self.deleted = deleted
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.data = data
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    seq = try container.decode(Int.self, forKey: .seq)
    id = try container.decode(String.self, forKey: .id)
    kind = try container.decode(String.self, forKey: .kind)
    version = try container.decode(Int.self, forKey: .version)
    deleted = try container.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    createdAt = try container.decode(String.self, forKey: .createdAt)
    updatedAt = try container.decode(String.self, forKey: .updatedAt)
    data = try container.decode(JSONValue.self, forKey: .data)
  }
}

public struct ChangePage: Codable, Sendable, Equatable {
  public var items: [ChangeItem]
  public var cursor: String?
  public var hasMore: Bool
  public var reset: Bool
  public var account: SyncAccount
  public init(
    items: [ChangeItem], cursor: String?, hasMore: Bool, reset: Bool, account: SyncAccount
  ) {
    self.items = items
    self.cursor = cursor
    self.hasMore = hasMore
    self.reset = reset
    self.account = account
  }
}

public enum SyncEvent: Sendable, Equatable {
  case ready
  case changed
  case closed(code: Int)
}

public protocol SyncEventsTransport: Sendable {
  func connect(request: URLRequest) async throws -> AsyncStream<SyncEvent>
}

public enum SyncStatus: Sendable, Equatable {
  case idle(lastSyncedAt: String?)
  case syncing
  case offline(lastSyncedAt: String?)
  case needsSignIn
  case failed(code: String, message: String, lastSyncedAt: String?)

  public var lastSyncedAt: String? {
    switch self {
    case .idle(let value), .offline(let value), .failed(_, _, let value): value
    case .syncing, .needsSignIn: nil
    }
  }
}

public struct StoredDocument: Sendable, Equatable {
  public var kind: String
  public var id: String
  public var version: Int
  public var deleted: Bool
  public var createdAt: String
  public var updatedAt: String
  public var data: Data
  public var occurredAt: String?
  public var source: String
  public var seq: Int?

  public func record<Value: Decodable>(_ type: Value.Type = Value.self) -> Record<Value>? {
    guard let value = try? JSONDecoder().decode(Value.self, from: data) else { return nil }
    var record = Record(
      id: id, kind: kind, version: version, data: value, createdAt: createdAt, updatedAt: updatedAt
    )
    if deleted { record.deleted = true }
    return record
  }
}

extension JSONValue {
  public var objectValue: [String: JSONValue]? {
    if case .object(let value) = self { return value }
    return nil
  }
  public func setting(_ key: String, to value: JSONValue) -> JSONValue {
    var object = objectValue ?? [:]
    object[key] = value
    return .object(object)
  }
  public func string(_ key: String) -> String? {
    guard case .string(let value) = objectValue?[key] else { return nil }
    return value
  }
  public var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }
  public var numberValue: Double? {
    if case .number(let value) = self { return value }
    return nil
  }
  public var boolValue: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }
  public var arrayValue: [JSONValue]? {
    if case .array(let value) = self { return value }
    return nil
  }
}
