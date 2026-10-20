import Foundation
import Observation
import OpenFitnessKit
@preconcurrency import WatchConnectivity

private struct WatchState: Codable {
  var snapshot: CompanionSnapshot?
  var journal: CommandJournal
  var workout: Record<Workout>?
  var activeAccount: String
  var pendingFinish: OfflineCommand?
}
@MainActor @Observable
final class WatchModel: NSObject, WCSessionDelegate {
  var snapshot: CompanionSnapshot?
  var journal = CommandJournal()
  var workout: Record<Workout>?
  var activeAccount = ""
  var errorMessage: String?
  var restUntil: Date?
  var reachable = false
  var pendingFinish: OfflineCommand?
  let health = WatchWorkoutManager()
  @ObservationIgnored private var storage: URL?
  var language: AppLanguage { .init(rawValue: snapshot?.language ?? "en") ?? .english }
  var copy: Localizer { .init(language) }
  func text(_ key: CopyKey) -> String { copy.text(key) }
  override init() {
    super.init()
    storage = try? DiskStore.directory().appendingPathComponent("watch-state.json")
    if let storage, let state = DiskStore.read(WatchState.self, at: storage) {
      snapshot = state.snapshot
      journal = state.journal
      workout = state.workout
      activeAccount = state.activeAccount
      pendingFinish = state.pendingFinish
    }
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("-ui-testing") {
        let exercise = Exercise(name: "Back squat")
        let plan = Record(
          id: "preview-plan", kind: "plan",
          data: TrainingPlan(
            name: "Lower body · A",
            exercises: [
              .init(
                exerciseId: "preview-squat", exercise: exercise,
                sets: Array(repeating: .init(reps: 8, weightKg: 60), count: 3))
            ]))
        snapshot = .init(accountKey: "preview", connected: true, plans: [plan])
        workout = .init(
          id: "preview-workout", kind: "workout",
          data: .init(name: plan.data.name, plan: plan, source: "watch"))
        activeAccount = "preview"
      }
    #endif
  }
  func requestSync() {
    guard WCSession.default.activationState == .activated else { return }
    if WCSession.default.isReachable {
      WCSession.default.sendMessage(["request": "snapshot"], replyHandler: nil, errorHandler: nil)
    }
    sendPending()
  }
  func start(_ plan: Record<TrainingPlan>) async {
    guard workout == nil, let snapshot, snapshot.connected else { return }
    let reference = "local-" + UUID().uuidString
    activeAccount = snapshot.accountKey
    workout = .init(
      id: reference, kind: "workout", version: 0,
      data: .init(name: plan.data.name, plan: plan, source: "watch"))
    do {
      try enqueue(
        .init(
          accountKey: activeAccount, kind: .startWorkout, workoutReference: reference,
          planId: plan.id, source: "watch", planVersion: plan.version))
    } catch {
      workout = nil
      errorMessage = copy.error(error)
      return
    }
    do { try await health.start() } catch { errorMessage = text(.healthDenied) }
  }
  func logSet(exercise: PlannedExercise, metrics: SetMetrics) {
    guard let workout else { return }
    do {
      let command = OfflineCommand(
        accountKey: activeAccount, kind: .logSet, workoutReference: workout.id,
        exerciseId: exercise.exerciseId, metrics: metrics, source: "watch")
      try enqueue(command)
      self.workout?.data.sets.append(
        .init(
          id: command.id, exerciseId: exercise.exerciseId, exercise: exercise.exerciseSnapshot,
          metrics: metrics))
      restUntil = Date().addingTimeInterval(exercise.restSeconds)
      try persist()
    } catch { errorMessage = copy.error(error) }
  }
  func finish(cancel: Bool = false) async {
    guard let workout else { return }
    do {
      let command =
        pendingFinish
        ?? OfflineCommand(
          accountKey: activeAccount, kind: cancel ? .cancelWorkout : .finishWorkout,
          workoutReference: workout.id, source: "watch")
      pendingFinish = command
      try enqueue(command)
      try await health.finish(
        identifier: command.workoutReference, cancel: command.kind == .cancelWorkout)
      self.workout = nil
      pendingFinish = nil
      restUntil = nil
      try persist()
    } catch { errorMessage = copy.error(error) }
  }
  private func enqueue(_ command: OfflineCommand) throws {
    let previous = journal
    do {
      try journal.enqueue(command, accountKey: activeAccount)
      try persist()
    } catch {
      journal = previous
      throw error
    }
    sendPending()
  }
  private func persist() throws {
    guard let storage else { throw APIError("LOCAL_STORAGE_UNAVAILABLE") }
    try DiskStore.write(
      WatchState(
        snapshot: snapshot, journal: journal, workout: workout, activeAccount: activeAccount,
        pendingFinish: pendingFinish), to: storage)
  }
  private func sendPending() {
    guard WCSession.default.activationState == .activated else { return }
    let inFlight = Set(
      WCSession.default.outstandingUserInfoTransfers.compactMap { $0.userInfo["id"] as? String })
    for command in journal.commands where command.accountKey == snapshot?.accountKey {
      guard let data = try? JSONEncoder().encode(command) else { continue }
      if !inFlight.contains(command.id) {
        WCSession.default.transferUserInfo(["id": command.id, "command": data])
      }
      if WCSession.default.isReachable {
        WCSession.default.sendMessageData(data, replyHandler: nil, errorHandler: nil)
      }
    }
  }
  private func receive(_ data: Data) {
    guard let value = try? JSONDecoder().decode(CompanionSnapshot.self, from: data) else { return }
    snapshot = value
    if value.connected {
      for receipt in value.receipts {
        if let command = journal.commands.first(where: {
          $0.id == receipt.id && $0.accountKey == value.accountKey
        }) {
          journal.acknowledge(command, workoutId: receipt.workoutId)
        }
      }
      if let remote = value.workout, pendingFinish == nil,
        workout == nil || (journal.commands.isEmpty && activeAccount == value.accountKey)
      {
        workout = remote
        activeAccount = value.accountKey
      }
      if value.workout == nil && journal.commands.isEmpty && !health.running && pendingFinish == nil
        && activeAccount == value.accountKey
      {
        workout = nil
      }
    }
    try? persist()
    sendPending()
  }
  private func receiveReceipt(_ data: Data) {
    guard let message = try? JSONDecoder().decode(CompanionReceipt.self, from: data),
      let command = journal.commands.first(where: {
        $0.id == message.receipt.id && $0.accountKey == message.accountKey
      })
    else { return }
    let previous = journal
    journal.acknowledge(command, workoutId: message.receipt.workoutId)
    do { try persist() } catch {
      journal = previous
      errorMessage = copy.error(error)
    }
  }
  nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
    if let data = userInfo["receipt"] as? Data { Task { @MainActor in receiveReceipt(data) } }
  }
  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    if let data = message["receipt"] as? Data { Task { @MainActor in receiveReceipt(data) } }
  }
  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    let data = session.receivedApplicationContext["snapshot"] as? Data
    Task { @MainActor in
      if let data { receive(data) }
      requestSync()
      reachable = session.isReachable
    }
  }
  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    let isReachable = session.isReachable
    Task { @MainActor in
      reachable = isReachable
      if isReachable { requestSync() }
    }
  }
  nonisolated func session(
    _ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]
  ) {
    guard let data = applicationContext["snapshot"] as? Data else { return }
    Task { @MainActor in receive(data) }
  }
  nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
    Task { @MainActor in receive(messageData) }
  }
}
