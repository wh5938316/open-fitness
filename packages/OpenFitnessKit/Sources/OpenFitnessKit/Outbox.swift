import Foundation

public struct OutboxEntry: Sendable, Equatable, Identifiable {
  public var localSeq: Int
  public var operationId: String
  public var name: String
  public var request: PreparedRequest
  public var targetKind: String?
  public var targetId: String?
  public var baseVersion: Int?
  public var optimistic: Data?
  public var state: String
  public var attempts: Int
  public var errorCode: String?
  public var errorMessage: String?
  public var createdAt: String
  public var dependsOn: [String]
  public var id: String { operationId }
}

public struct OutboxDraft: Sendable {
  public var operationId: String
  public var name: String
  public var request: PreparedRequest
  public var targetKind: String?
  public var targetId: String?
  public var baseVersion: Int?
  public var optimistic: Data?
  public var dependsOn: [String]
  public init(
    operationId: String, name: String, request: PreparedRequest, targetKind: String? = nil,
    targetId: String? = nil, baseVersion: Int? = nil, optimistic: Data? = nil,
    dependsOn: [String] = []
  ) {
    self.operationId = operationId
    self.name = name
    self.request = request
    self.targetKind = targetKind
    self.targetId = targetId
    self.baseVersion = baseVersion
    self.optimistic = optimistic
    self.dependsOn = dependsOn
  }
}

public enum OutboxBuilder {
  public static func request(
    name: String, method: String, path: String, fields: [String: JSONValue], operationId: String
  ) -> PreparedRequest {
    var body = fields
    body["operationId"] = .string(operationId)
    return PreparedRequest(method: method, path: path, body: .object(body))
  }

  public static func encode<T: Encodable>(_ value: T) throws -> Data {
    try JSONEncoder().encode(value)
  }

  public static func meal(
    id: String, occurredAt: String, ingredients: [Ingredient], notes: String, nutrients: Nutrients?,
    operationId: String = UUID().uuidString.lowercased(), dependsOn: [String] = []
  ) throws -> OutboxDraft {
    let fields: [String: JSONValue] = [
      "id": .string(id),
      "occurredAt": .string(occurredAt),
      "ingredients": try .from(ingredients),
      "notes": .string(notes),
    ]
    let meal = Meal(
      occurredAt: occurredAt, notes: notes, ingredients: ingredients,
      nutrients: nutrients ?? Nutrients(
        energyKcal: nil, proteinG: nil, carbohydrateG: nil, fatG: nil, fiberG: nil))
    let record = Record(id: id, kind: "meal", version: 1, data: meal, createdAt: occurredAt, updatedAt: occurredAt)
    return OutboxDraft(
      operationId: operationId, name: "log_meal",
      request: request(name: "log_meal", method: "POST", path: "/api/v1/meals", fields: fields, operationId: operationId),
      targetKind: "meal", targetId: id, baseVersion: nil, optimistic: try encode(record),
      dependsOn: dependsOn)
  }
}
