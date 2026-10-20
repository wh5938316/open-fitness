import Foundation
import OpenFitnessKit
@preconcurrency import WatchConnectivity

@MainActor
final class PhoneCompanion: NSObject, WCSessionDelegate {
  private weak var model: AppModel?
  init(model: AppModel) {
    self.model = model
    super.init()
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }
  func send(_ value: CompanionSnapshot) {
    guard WCSession.isSupported(), WCSession.default.activationState == .activated,
      WCSession.default.isPaired, WCSession.default.isWatchAppInstalled
    else { return }
    do {
      var snapshot = value
      snapshot.recipes = []
      snapshot.receipts = Array(snapshot.receipts.suffix(200))
      snapshot.plans = Array(snapshot.plans.prefix(8))
      for i in snapshot.plans.indices {
        for j in snapshot.plans[i].data.exercises.indices {
          snapshot.plans[i].data.exercises[j].exerciseSnapshot.instructions = snapshot.plans[i].data
            .exercises[j].exerciseSnapshot.instructions.map { String($0.prefix(500)) }
        }
      }
      var data = try JSONEncoder().encode(snapshot)
      while data.count > 60000 && !snapshot.plans.isEmpty {
        snapshot.plans.removeLast()
        data = try JSONEncoder().encode(snapshot)
      }
      guard data.count <= 60000 else { return }
      try WCSession.default.updateApplicationContext(["snapshot": data])
      if WCSession.default.isReachable {
        WCSession.default.sendMessageData(data, replyHandler: nil, errorHandler: nil)
      }
    } catch { model?.errorMessage = model?.copy.error(error) }
  }
  func sendReceipt(_ receipt: CommandReceipt, accountKey: String) {
    guard WCSession.isSupported(), WCSession.default.activationState == .activated,
      let data = try? JSONEncoder().encode(
        CompanionReceipt(accountKey: accountKey, receipt: receipt))
    else { return }
    let inFlight = WCSession.default.outstandingUserInfoTransfers.contains {
      $0.userInfo["receiptId"] as? String == receipt.id
    }
    if !inFlight { WCSession.default.transferUserInfo(["receiptId": receipt.id, "receipt": data]) }
    if WCSession.default.isReachable {
      WCSession.default.sendMessage(["receipt": data], replyHandler: nil, errorHandler: nil)
    }
  }
  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) { Task { @MainActor in model?.sendCompanion() } }
  nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
  nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    Task { @MainActor in model?.sendCompanion() }
  }
  nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
    receive(messageData)
  }
  nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
    if let data = userInfo["command"] as? Data { receive(data) }
  }
  private nonisolated func receive(_ data: Data) {
    guard let command = try? JSONDecoder().decode(OfflineCommand.self, from: data) else { return }
    Task { @MainActor in model?.receive(command) }
  }
}
