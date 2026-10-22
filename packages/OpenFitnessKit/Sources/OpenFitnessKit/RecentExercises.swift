import Foundation

public struct RecentExercise: Codable, Sendable, Identifiable {
  public var record: Record<Exercise>
  public var usedAt: Date
  public var id: String { record.id }
}

public struct RecentExerciseHistory: Codable, Sendable {
  public private(set) var items: [RecentExercise] = []
  public init() {}
  public mutating func record(_ exercise: Record<Exercise>, at date: Date = Date()) {
    items.removeAll { $0.id == exercise.id }
    items.insert(.init(record: exercise, usedAt: date), at: 0)
    items = Array(items.prefix(20))
  }
}
