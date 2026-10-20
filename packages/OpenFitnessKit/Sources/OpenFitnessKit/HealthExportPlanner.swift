import Foundation

public struct HealthSampleChange: Sendable, Equatable {
  public var key: NutrientKey
  public var syncIdentifier: String
  public var version: Int
  public var value: Double?
}
public enum HealthExportPlanner {
  public static func changes(for event: HealthExportEvent, lastAppliedVersion: Int? = nil)
    -> [HealthSampleChange]
  {
    guard event.version > (lastAppliedVersion ?? 0) else { return [] }
    return NutrientKey.allCases.map { key in
      .init(
        key: key, syncIdentifier: event.payload.syncIdentifier + "." + key.rawValue,
        version: event.version, value: event.action == "delete" ? nil : event.payload.nutrients[key]
      )
    }
  }
}
