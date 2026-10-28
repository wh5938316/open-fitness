import Foundation

public actor SyncEngine {
  public let changes: AsyncStream<Set<String>>
  public let statuses: AsyncStream<SyncStatus>
  private let changeContinuation: AsyncStream<Set<String>>.Continuation
  private let statusContinuation: AsyncStream<SyncStatus>.Continuation
  private let store: LocalStore
  private let api: APIClient
  private let ownerId: String
  private let events: any SyncEventsTransport
  private let retryNanoseconds: UInt64
  private var stopped = false
  private var pulling = false
  private var pullAgain = false
  private var draining = false
  private var drainAgain = false
  private var eventsTask: Task<Void, Never>?
  private var foreground = true
  public private(set) var status: SyncStatus

  public init(
    store: LocalStore, api: APIClient, ownerId: String,
    events: any SyncEventsTransport = URLSessionSyncEvents(),
    retryNanoseconds: UInt64 = 1_000_000_000,
    initialStatus: SyncStatus = .idle(lastSyncedAt: nil)
  ) {
    self.store = store
    self.api = api
    self.ownerId = ownerId
    self.events = events
    self.retryNanoseconds = retryNanoseconds
    self.status = initialStatus
    var changeContinuation: AsyncStream<Set<String>>.Continuation!
    var statusContinuation: AsyncStream<SyncStatus>.Continuation!
    changes = AsyncStream { changeContinuation = $0 }
    statuses = AsyncStream { statusContinuation = $0 }
    self.changeContinuation = changeContinuation
    self.statusContinuation = statusContinuation
  }

  public func start() {
    stopped = false
    Task { await pull() }
    Task { await drainOutbox() }
    startEvents()
  }

  public func stop() {
    stopped = true
    eventsTask?.cancel()
    eventsTask = nil
  }

  public func setForeground(_ value: Bool) {
    foreground = value
    if value {
      stopped = false
      startEvents()
      Task { await pull() }
      Task { await drainOutbox() }
    } else {
      eventsTask?.cancel()
      eventsTask = nil
    }
  }

  public func pull() async {
    if stopped { return }
    if pulling {
      pullAgain = true
      return
    }
    pulling = true
    defer {
      pulling = false
      if pullAgain && !stopped {
        pullAgain = false
        Task { await self.pull() }
      }
    }
    setStatus(.syncing)
    var cursor = store.meta("cursor")
    var resets = 0
    do {
      while !stopped {
        var path = "/api/v1/sync/changes?limit=500"
        if let cursor, !cursor.isEmpty { path += "&after=\(cursor.queryValue)" }
        let page = try await api.request(ChangePage.self, path: path)
        if page.account.ownerId != ownerId {
          halt(.needsSignIn)
          return
        }
        if page.reset {
          resets += 1
          if resets > 2 { throw APIError("SYNC_RESET", status: 409) }
          try store.prepareReset()
          changeContinuation.yield([
            "meal", "food", "recipe", "plan", "exercise", "workout", "asset",
          ])
          cursor = nil
          continue
        }
        let changed = try store.apply(
          items: page.items, cursor: page.cursor ?? cursor ?? "", account: page.account)
        if !changed.isEmpty { changeContinuation.yield(changed) }
        cursor = page.cursor
        if !page.hasMore {
          try store.setMeta("bootstrap_complete", "1")
          try store.deleteLegacy()
          let stamp = Date().iso8601Milliseconds
          try store.setMeta("last_synced_at", stamp)
          setStatus(.idle(lastSyncedAt: stamp))
          return
        }
      }
    } catch {
      handle(error)
    }
  }

  public func enqueue(_ draft: OutboxDraft) throws -> OutboxEntry {
    try store.enqueue(draft)
  }

  public func drainOutbox() async {
    if stopped || draining {
      drainAgain = true
      return
    }
    draining = true
    defer {
      draining = false
      if drainAgain && !stopped {
        drainAgain = false
        Task { await self.drainOutbox() }
      }
    }
    var delay = retryNanoseconds
    while !stopped {
      let entries = store.outbox().filter { $0.state == "pending" }.sorted {
        $0.localSeq < $1.localSeq
      }
      guard let entry = entries.first(where: { canSend($0, all: store.outbox()) }) else { return }
      do {
        let payload = try await api.request(
          JSONValue.self, method: entry.request.method, path: entry.request.path,
          body: entry.request.body)
        try absorb(payload)
        try store.deleteOutbox(operationId: entry.operationId)
        await pull()
        delay = retryNanoseconds
      } catch let error as APIError where error.status == 401 {
        halt(.needsSignIn)
        return
      } catch let error as APIError where error.status == 403 {
        setStatus(
          .failed(
            code: error.code, message: error.message, lastSyncedAt: store.meta("last_synced_at")))
        return
      } catch let error as APIError where error.status == 409 && error.code == "VERSION_CONFLICT" {
        try? store.updateOutbox(
          operationId: entry.operationId, state: "conflict", errorCode: error.code,
          errorMessage: error.message)
        await pull()
        return
      } catch let error as APIError
        where error.status == 409 && error.code == "IDEMPOTENCY_CONFLICT"
      {
        try? store.updateOutbox(
          operationId: entry.operationId, state: "unknown", errorCode: error.code,
          errorMessage: error.message)
        await pull()
        resolveUnknown(entry)
        return
      } catch let error as APIError where error.status == 404 {
        try? store.updateOutbox(
          operationId: entry.operationId, state: "failed", errorCode: "deletedElsewhere",
          errorMessage: error.message)
        try? store.cascadeFailed(
          operationId: entry.operationId, code: "deletedElsewhere", message: error.message)
        return
      } catch let error as APIError where error.status == 422 {
        try? store.updateOutbox(
          operationId: entry.operationId, state: "failed", errorCode: error.code,
          errorMessage: error.message)
        return
      } catch let error as APIError where error.status == 429 || error.status >= 500 {
        try? store.updateOutbox(
          operationId: entry.operationId, attempts: entry.attempts + 1, errorCode: error.code,
          errorMessage: error.message)
        setStatus(
          .failed(
            code: error.code, message: error.message, lastSyncedAt: store.meta("last_synced_at")))
        return
      } catch {
        try? store.updateOutbox(
          operationId: entry.operationId, attempts: entry.attempts + 1, errorCode: "NETWORK",
          errorMessage: error.localizedDescription)
        setStatus(.offline(lastSyncedAt: store.meta("last_synced_at")))
        try? await Task.sleep(nanoseconds: delay)
        delay = min(delay * 2, 300_000_000_000)
        if delay > retryNanoseconds * 2 { return }
      }
    }
  }

  public func retryConflict(operationId: String) throws {
    guard let entry = store.outbox().first(where: { $0.operationId == operationId }) else { return }
    let version =
      entry.targetKind.flatMap { kind in
        entry.targetId.flatMap { store.document(kind: kind, id: $0)?.version }
      } ?? 1
    var request = entry.request
    request.body = request.body.setting("expectedVersion", to: .number(Double(version)))
    let next = rebaseId(entry.operationId)
    try store.updateOutbox(
      operationId: entry.operationId, state: "pending", attempts: 0, request: request,
      operationId: next, clearError: true)
  }

  public func discard(operationId: String) throws {
    try store.deleteOutbox(operationId: operationId)
  }

  private func resolveUnknown(_ entry: OutboxEntry) {
    guard entry.baseVersion == nil, let kind = entry.targetKind, let id = entry.targetId else {
      return
    }
    if store.document(kind: kind, id: id) != nil {
      try? store.deleteOutbox(operationId: entry.operationId)
    }
  }

  private func canSend(_ entry: OutboxEntry, all: [OutboxEntry]) -> Bool {
    for dependency in entry.dependsOn {
      guard let other = all.first(where: { $0.operationId == dependency }) else { continue }
      if ["conflict", "failed", "unknown", "pending"].contains(other.state) { return false }
    }
    return true
  }

  private func absorb(_ value: JSONValue) throws {
    guard let object = value.objectValue else { return }
    try upsertObject(object)
    for key in ["adoptedFoods", "adoptedExercises"] {
      for item in object[key]?.arrayValue ?? [] {
        if let child = item.objectValue { try upsertObject(child) }
      }
    }
  }

  private func upsertObject(_ object: [String: JSONValue]) throws {
    guard let id = object["id"]?.stringValue, let kind = object["kind"]?.stringValue,
      let data = object["data"], let createdAt = object["createdAt"]?.stringValue,
      let updatedAt = object["updatedAt"]?.stringValue
    else { return }
    let version = Int(object["version"]?.numberValue ?? 1)
    let deleted = object["deleted"]?.boolValue ?? false
    let bytes = try JSONEncoder().encode(data)
    _ = try store.upsertResponse(
      StoredDocument(
        kind: kind, id: id, version: version, deleted: deleted, createdAt: createdAt,
        updatedAt: updatedAt, data: bytes, occurredAt: nil, source: "response", seq: nil))
    changeContinuation.yield([kind])
  }

  private func rebaseId(_ operationId: String) -> String {
    let base = operationId.components(separatedBy: ".rebase").first ?? operationId
    let existing = store.outbox().compactMap { entry -> Int? in
      guard entry.operationId.hasPrefix(base + ".rebase") else { return nil }
      return Int(entry.operationId.dropFirst(base.count + ".rebase".count))
    }
    return base + ".rebase\((existing.max() ?? 0) + 1)"
  }

  private func startEvents() {
    eventsTask?.cancel()
    eventsTask = Task { await self.runEvents() }
  }

  private func runEvents() async {
    var delay = retryNanoseconds
    while !stopped && foreground {
      do {
        let request = try await api.webSocketRequest(path: "/api/v1/sync/events")
        let stream = try await events.connect(request: request)
        delay = retryNanoseconds
        for await event in stream {
          if stopped || !foreground { return }
          switch event {
          case .ready: break
          case .changed: await pull()
          case .closed(let code):
            if code == 4001 {
              _ = try? await api.webSocketRequest(path: "/api/v1/sync/events")
            }
          }
        }
      } catch let error as APIError where error.status == 401 {
        halt(.needsSignIn)
        return
      } catch {
        if status.lastSyncedAt != nil || store.meta("bootstrap_complete") == "1" {
          setStatus(.offline(lastSyncedAt: store.meta("last_synced_at")))
        }
      }
      if stopped || !foreground { return }
      try? await Task.sleep(nanoseconds: delay)
      delay = min(delay * 2, 60_000_000_000)
    }
  }

  private func handle(_ error: Error) {
    if let error = error as? APIError, error.status == 401 || error.code == "SYNC_OWNER_MISMATCH" {
      halt(.needsSignIn)
      return
    }
    if let error = error as? APIError, error.status == 429 || error.status >= 500 {
      setStatus(
        .failed(
          code: error.code, message: error.message, lastSyncedAt: store.meta("last_synced_at")))
      return
    }
    if error is URLError {
      setStatus(.offline(lastSyncedAt: store.meta("last_synced_at")))
      return
    }
    if let error = error as? APIError {
      setStatus(
        .failed(
          code: error.code, message: error.message, lastSyncedAt: store.meta("last_synced_at")))
      return
    }
    setStatus(.offline(lastSyncedAt: store.meta("last_synced_at")))
  }

  private func halt(_ status: SyncStatus) {
    stopped = true
    eventsTask?.cancel()
    setStatus(status)
  }

  private func setStatus(_ status: SyncStatus) {
    self.status = status
    statusContinuation.yield(status)
  }
}
