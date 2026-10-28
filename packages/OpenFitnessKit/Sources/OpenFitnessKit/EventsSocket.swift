import Foundation

public struct URLSessionSyncEvents: SyncEventsTransport, Sendable {
  public init() {}
  public func connect(request: URLRequest) async throws -> AsyncStream<SyncEvent> {
    let socket = SocketSession(request: request)
    return AsyncStream { continuation in
      let receive = Task { await socket.receive(continuation) }
      continuation.onTermination = { _ in
        receive.cancel()
        socket.cancel()
      }
    }
  }
}

private final class SocketSession: @unchecked Sendable {
  private let session: URLSession
  private let task: URLSessionWebSocketTask
  private let ping: Task<Void, Never>
  init(request: URLRequest) {
    let session = URLSession(configuration: .ephemeral)
    let task = session.webSocketTask(with: request)
    task.resume()
    self.session = session
    self.task = task
    ping = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(20))
        if Task.isCancelled { break }
        try? await task.send(.string("ping"))
      }
    }
  }
  func receive(_ continuation: AsyncStream<SyncEvent>.Continuation) async {
    defer {
      ping.cancel()
      session.invalidateAndCancel()
      continuation.finish()
    }
    do {
      while !Task.isCancelled {
        let message = try await task.receive()
        if case .string(let text) = message {
          if text.contains("\"ready\"") { continuation.yield(.ready) }
          if text.contains("\"changed\"") { continuation.yield(.changed) }
        }
      }
    } catch {
      let code = task.closeCode.rawValue
      continuation.yield(.closed(code: code == 0 ? 1006 : code))
    }
  }
  func cancel() {
    ping.cancel()
    task.cancel(with: .goingAway, reason: nil)
  }
}
