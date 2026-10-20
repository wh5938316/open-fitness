import Foundation
import HealthKit
import OpenFitnessKit

actor HealthBridge {
  private let store = HKHealthStore()
  private var synchronizing = false
  private var versions: [String: Int] = [:]
  private var journalURL: URL?
  private func type(_ key: NutrientKey) -> HKQuantityType {
    let identifier: HKQuantityTypeIdentifier =
      switch key {
      case .energyKcal: .dietaryEnergyConsumed
      case .proteinG: .dietaryProtein
      case .carbohydrateG: .dietaryCarbohydrates
      case .fatG: .dietaryFatTotal
      case .fiberG: .dietaryFiber
      }
    return HKQuantityType(identifier)
  }
  private func unit(_ key: NutrientKey) -> HKUnit { key == .energyKcal ? .kilocalorie() : .gram() }
  func authorizeNutrition() async throws {
    guard HKHealthStore.isHealthDataAvailable() else { throw APIError("HEALTHKIT_UNAVAILABLE") }
    try await store.requestAuthorization(toShare: Set(NutrientKey.allCases.map(type)), read: [])
    guard
      NutrientKey.allCases.allSatisfy({
        store.authorizationStatus(for: type($0)) == .sharingAuthorized
      })
    else { throw APIError("HEALTHKIT_PERMISSION_REQUIRED") }
  }
  func authorizeSummary() async throws {
    let types: Set<HKObjectType> = [
      HKQuantityType(.stepCount), HKQuantityType(.activeEnergyBurned),
      HKQuantityType(.appleExerciseTime), HKQuantityType(.bodyMass),
      HKQuantityType(.restingHeartRate),
    ]
    try await store.requestAuthorization(toShare: [], read: types)
  }
  func resetJournal(accountKey: String) throws {
    let url = try DiskStore.directory().appendingPathComponent("health-versions-\(accountKey).json")
    if journalURL != url {
      journalURL = url
      versions = DiskStore.read([String: Int].self, at: url) ?? [:]
    }
  }
  func synchronize(client: APIClient, credential: HealthDeviceCredential, accountKey: String)
    async throws
  {
    guard !synchronizing else { return }
    synchronizing = true
    defer { synchronizing = false }
    try resetJournal(accountKey: accountKey)
    let proof: [String: JSONValue] = [
      "deviceId": .string(credential.deviceId), "deviceSecret": .string(credential.deviceSecret),
    ]
    for _ in 0..<10 {
      let lease = try await client.mutation(
        HealthExportLease.self, path: "/api/v1/health/exports/claim", fields: proof)
      if lease.items.isEmpty { return }
      for event in lease.items {
        guard let expiry = Date.parseISO(lease.expiresAt), expiry.timeIntervalSinceNow > 10 else {
          throw APIError("HEALTH_LEASE_EXPIRED", status: 409)
        }
        do {
          try await apply(event)
          struct Receipt: Decodable, Sendable { var status: String }
          var fields = proof
          fields["leaseToken"] = .string(lease.leaseToken)
          fields["status"] = .string("synced")
          _ = try await client.mutation(
            Receipt.self, path: "/api/v1/health/exports/\(event.id.pathSegment)/receipt",
            fields: fields)
        } catch {
          struct Receipt: Decodable, Sendable { var status: String }
          var fields = proof
          fields["leaseToken"] = .string(lease.leaseToken)
          fields["status"] = .string("failed")
          fields["errorCode"] = .string("HEALTHKIT_WRITE_FAILED")
          _ = try? await client.mutation(
            Receipt.self, path: "/api/v1/health/exports/\(event.id.pathSegment)/receipt",
            fields: fields)
          throw error
        }
      }
    }
  }
  private func apply(_ event: HealthExportEvent) async throws {
    let changes = HealthExportPlanner.changes(
      for: event, lastAppliedVersion: versions[event.mealId])
    if changes.isEmpty { return }
    guard let date = Date.parseISO(event.payload.occurredAt) else {
      throw APIError("INVALID_HEALTH_EVENT")
    }
    var samples: [HKQuantitySample] = []
    for change in changes {
      let sampleType = type(change.key)
      if let value = change.value {
        guard store.authorizationStatus(for: sampleType) == .sharingAuthorized else {
          throw APIError("HEALTHKIT_PERMISSION_REQUIRED")
        }
        samples.append(
          HKQuantitySample(
            type: sampleType, quantity: HKQuantity(unit: unit(change.key), doubleValue: value),
            start: date, end: date,
            metadata: [
              HKMetadataKeySyncIdentifier: change.syncIdentifier,
              HKMetadataKeySyncVersion: NSNumber(value: change.version),
            ]))
      } else {
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
          HKQuery.predicateForObjects(from: HKSource.default()),
          HKQuery.predicateForObjects(
            withMetadataKey: HKMetadataKeySyncIdentifier, operatorType: .equalTo,
            value: change.syncIdentifier),
          HKQuery.predicateForObjects(
            withMetadataKey: HKMetadataKeySyncVersion, operatorType: .lessThanOrEqualTo,
            value: change.version),
        ])
        _ = try await store.deleteObjects(of: sampleType, predicate: predicate)
      }
    }
    if !samples.isEmpty { try await store.save(samples) }
    versions[event.mealId] = event.version
    if let journalURL { try DiskStore.write(versions, to: journalURL) }
  }
  func summary(timeZone: String) async throws -> HealthSnapshot {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: timeZone) ?? .current
    let start = calendar.startOfDay(for: Date())
    var result = HealthSnapshot(day: Date().calendarDay(timeZone: timeZone), timeZone: timeZone)
    async let steps = sum(.stepCount, unit: .count(), since: start)
    async let energy = sum(.activeEnergyBurned, unit: .kilocalorie(), since: start)
    async let minutes = sum(.appleExerciseTime, unit: .minute(), since: start)
    async let heart = latest(.restingHeartRate, unit: .count().unitDivided(by: .minute()))
    async let weight = latest(.bodyMass, unit: .gramUnit(with: .kilo))
    result.steps = try await steps
    result.activeEnergyKcal = try await energy
    result.exerciseMinutes = try await minutes
    result.restingHeartRateBpm = try await heart?.0
    let mass = try await weight
    result.bodyMassKg = mass?.0
    result.bodyMassMeasuredAt = mass?.1.iso8601
    return result
  }
  private func sum(_ id: HKQuantityTypeIdentifier, unit: HKUnit, since: Date) async throws
    -> Double?
  {
    try await withCheckedThrowingContinuation { continuation in
      let q = HKStatisticsQuery(
        quantityType: HKQuantityType(id),
        quantitySamplePredicate: HKQuery.predicateForSamples(withStart: since, end: Date()),
        options: .cumulativeSum
      ) { _, result, error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume(returning: result?.sumQuantity()?.doubleValue(for: unit))
        }
      }
      store.execute(q)
    }
  }
  private func latest(_ id: HKQuantityTypeIdentifier, unit: HKUnit) async throws -> (Double, Date)?
  {
    try await withCheckedThrowingContinuation { continuation in
      let q = HKSampleQuery(
        sampleType: HKQuantityType(id), predicate: nil, limit: 1,
        sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]
      ) { _, samples, error in
        if let error {
          continuation.resume(throwing: error)
        } else if let sample = samples?.first as? HKQuantitySample {
          continuation.resume(returning: (sample.quantity.doubleValue(for: unit), sample.endDate))
        } else {
          continuation.resume(returning: nil)
        }
      }
      store.execute(q)
    }
  }
}
