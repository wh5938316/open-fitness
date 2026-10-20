import Foundation
@preconcurrency import HealthKit
import Observation
import OpenFitnessKit

@MainActor @Observable
final class WatchWorkoutManager: NSObject, HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
  var heartRate: Double?
  var activeEnergy: Double?
  var running = false
  var paused = false
  var startedAt: Date?
  @ObservationIgnored private let store = HKHealthStore()
  @ObservationIgnored private var session: HKWorkoutSession?
  @ObservationIgnored private var builder: HKLiveWorkoutBuilder?
  @ObservationIgnored private var collectionEnded = false
  func start() async throws {
    guard !running else { return }
    guard HKHealthStore.isHealthDataAvailable() else { throw APIError("HEALTHKIT_UNAVAILABLE") }
    try await store.requestAuthorization(
      toShare: [.workoutType()],
      read: [HKQuantityType(.heartRate), HKQuantityType(.activeEnergyBurned)])
    guard store.authorizationStatus(for: .workoutType()) == .sharingAuthorized else {
      throw APIError("HEALTHKIT_PERMISSION_REQUIRED")
    }
    let configuration = HKWorkoutConfiguration()
    configuration.activityType = .traditionalStrengthTraining
    configuration.locationType = .indoor
    let session = try HKWorkoutSession(healthStore: store, configuration: configuration)
    let builder = session.associatedWorkoutBuilder()
    builder.dataSource = HKLiveWorkoutDataSource(
      healthStore: store, workoutConfiguration: configuration)
    session.delegate = self
    builder.delegate = self
    self.session = session
    self.builder = builder
    let date = Date()
    startedAt = date
    heartRate = nil
    activeEnergy = nil
    collectionEnded = false
    session.startActivity(with: date)
    do {
      try await builder.beginCollection(at: date)
      running = true
    } catch {
      session.end()
      builder.discardWorkout()
      self.session = nil
      self.builder = nil
      throw error
    }
  }
  func recover() async {
    do {
      guard let recovered = try await store.recoverActiveWorkoutSession() else { return }
      session = recovered
      builder = recovered.associatedWorkoutBuilder()
      session?.delegate = self
      builder?.delegate = self
      running = recovered.state == .running || recovered.state == .paused
      paused = recovered.state == .paused
      startedAt = recovered.startDate
    } catch { running = false }
  }
  func togglePause() {
    guard let session else { return }
    if paused { session.resume() } else { session.pause() }
  }
  func finish(identifier: String, cancel: Bool = false) async throws {
    guard let session, let builder else { return }
    if !collectionEnded {
      session.end()
      try await builder.endCollection(at: Date())
      collectionEnded = true
    }
    if cancel {
      builder.discardWorkout()
    } else {
      try await builder.addMetadata([
        HKMetadataKeySyncIdentifier: "openfitness.workout." + identifier,
        HKMetadataKeySyncVersion: 1,
      ])
      _ = try await builder.finishWorkout()
    }
    self.session = nil
    self.builder = nil
    running = false
    paused = false
  }
  nonisolated func workoutSession(
    _ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
    from fromState: HKWorkoutSessionState, date: Date
  ) {
    Task { @MainActor in
      paused = toState == .paused
      if toState == .ended { running = false }
    }
  }
  nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error)
  {
    Task { @MainActor in
      running = false
      heartRate = nil
    }
  }
  nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
  nonisolated func workoutBuilder(
    _ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>
  ) {
    let heart = workoutBuilder.statistics(for: HKQuantityType(.heartRate))?.mostRecentQuantity()?
      .doubleValue(for: .count().unitDivided(by: .minute()))
    let energy = workoutBuilder.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?
      .doubleValue(for: .kilocalorie())
    Task { @MainActor in
      heartRate = heart
      activeEnergy = energy
    }
  }
}
