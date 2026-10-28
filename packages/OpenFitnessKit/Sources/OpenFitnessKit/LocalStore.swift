import Foundation
import SQLite3

public final class LocalStore: @unchecked Sendable {
  private let writer: SQLiteConnection
  private let reader: SQLiteConnection
  public let url: URL

  public init(url: URL) throws {
    self.url = url
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let writer = try SQLiteConnection(path: url.path)
    do {
      try LocalStore.migrate(writer)
      reader = try SQLiteConnection(path: url.path)
      self.writer = writer
    } catch {
      writer.close()
      throw error
    }
  }

  public func close() {
    reader.close()
    writer.close()
  }

  public func destroy() {
    let path = url.path
    close()
    let files = [path, path + "-wal", path + "-shm"]
    for file in files { try? FileManager.default.removeItem(atPath: file) }
  }

  public func documents(kind: String, includeDeleted: Bool = false) -> [StoredDocument] {
    let sql =
      "SELECT \(columns) FROM documents WHERE kind=?"
      + (includeDeleted ? "" : " AND deleted=0") + " ORDER BY created_at DESC, id DESC"
    return (try? reader.query(sql, bindings: [.text(kind)]))?.map(Self.document) ?? []
  }

  public func document(kind: String, id: String) -> StoredDocument? {
    (try? reader.query(
      "SELECT \(columns) FROM documents WHERE kind=? AND id=?", bindings: [.text(kind), .text(id)]
    ))?.first.map(Self.document)
  }

  public func meals(from: String, to: String) -> [StoredDocument] {
    (try? reader.query(
      """
      SELECT \(columns) FROM documents
      WHERE kind='meal' AND deleted=0 AND occurred_at>=? AND occurred_at<?
      ORDER BY created_at DESC, id DESC
      """, bindings: [.text(from), .text(to)]))?.map(Self.document) ?? []
  }

  public func workouts(limit: Int, offset: Int) -> [StoredDocument] {
    (try? reader.query(
      """
      SELECT \(columns) FROM documents
      WHERE kind='workout' AND deleted=0
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
      """, bindings: [.int(limit), .int(offset)]))?.map(Self.document) ?? []
  }

  public func meta(_ key: String) -> String? {
    (try? reader.query("SELECT value FROM meta WHERE key=?", bindings: [.text(key)]))?.first?
      .text(0)
  }

  public func setMeta(_ key: String, _ value: String?) throws {
    if let value {
      try writer.run(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        bindings: [.text(key), .text(value)])
    } else {
      try writer.run("DELETE FROM meta WHERE key=?", bindings: [.text(key)])
    }
  }

  public func apply(items: [ChangeItem], cursor: String, account: SyncAccount) throws -> Set<String>
  {
    try writer.transaction {
      var changed = Set<String>()
      for item in items {
        if item.kind.isEmpty || item.id.isEmpty {
          throw SQLiteError(code: SQLITE_CONSTRAINT, message: "invalid document key")
        }
        if try upsert(item, source: "feed", connection: writer) { changed.insert(item.kind) }
      }
      try writer.run(
        "INSERT INTO meta(key,value) VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        bindings: [.text(cursor)])
      try writer.run(
        "INSERT INTO meta(key,value) VALUES('time_zone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        bindings: [.text(account.timeZone)])
      try writer.run(
        "INSERT INTO meta(key,value) VALUES('locale',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        bindings: [.text(account.locale)])
      try writer.run(
        "INSERT INTO meta(key,value) VALUES('owner_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        bindings: [.text(account.ownerId)])
      return changed
    }
  }

  public func importDocument(_ record: StoredDocument, source: String) throws -> Bool {
    let data = try JSONDecoder().decode(JSONValue.self, from: record.data)
    let item = ChangeItem(
      seq: record.seq ?? 0, id: record.id, kind: record.kind, version: max(record.version, 1),
      deleted: record.deleted, createdAt: record.createdAt, updatedAt: record.updatedAt, data: data
    )
    return try writer.transaction { try upsert(item, source: source, connection: writer) }
  }

  public func upsertResponse(_ record: StoredDocument) throws -> Bool {
    let data = try JSONDecoder().decode(JSONValue.self, from: record.data)
    let item = ChangeItem(
      seq: record.seq ?? 0, id: record.id, kind: record.kind, version: record.version,
      deleted: record.deleted, createdAt: record.createdAt, updatedAt: record.updatedAt, data: data
    )
    return try writer.transaction { try upsert(item, source: "response", connection: writer) }
  }

  public func markAllLegacy() throws {
    try writer.run("UPDATE documents SET source='legacy'")
  }

  public func prepareReset() throws {
    try writer.transaction {
      try writer.run("UPDATE documents SET source='legacy'")
      try writer.run("DELETE FROM meta WHERE key IN ('cursor','bootstrap_complete')")
    }
  }

  public func deleteLegacy() throws {
    try writer.run(
      """
      DELETE FROM documents WHERE source='legacy' AND NOT EXISTS (
        SELECT 1 FROM outbox
        WHERE outbox.target_kind=documents.kind AND outbox.target_id=documents.id
      )
      """)
  }

  public func catalog(locale: String) -> [StoredDocument] {
    (try? reader.query(
      "SELECT id, data, locale, fetched_at FROM catalog_exercises WHERE locale=? ORDER BY id",
      bindings: [.text(locale)]))?.map { row in
        StoredDocument(
          kind: "exercise", id: row.text(0), version: 0, deleted: false, createdAt: row.text(2),
          updatedAt: row.text(2), data: row.blob(1), occurredAt: nil, source: "legacy", seq: nil)
      } ?? []
  }

  public func saveCatalog(id: String, data: Data, locale: String, fetchedAt: String) throws {
    try writer.run(
      """
      INSERT INTO catalog_exercises(id,data,locale,fetched_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, locale=excluded.locale, fetched_at=excluded.fetched_at
      """, bindings: [.text(id), .blob(data), .text(locale), .text(fetchedAt)])
  }

  public func clearCatalog() throws {
    try writer.run("DELETE FROM catalog_exercises")
  }

  public func outbox() -> [OutboxEntry] {
    let rows =
      (try? reader.query(
        """
        SELECT local_seq, operation_id, name, request, target_kind, target_id, base_version,
               optimistic, state, attempts, error_code, error_message, created_at
        FROM outbox ORDER BY local_seq
        """)) ?? []
    return rows.map { row in
      let operationId = row.text(1)
      let depends =
        (try? reader.query(
          "SELECT depends_on FROM outbox_dependencies WHERE operation_id=? ORDER BY depends_on",
          bindings: [.text(operationId)]))?.map { $0.text(0) } ?? []
      return Self.entry(row, dependsOn: depends)
    }
  }

  public func pendingCount() -> Int {
    (try? reader.int(
      "SELECT COUNT(*) FROM outbox WHERE state IN ('pending','conflict','failed','unknown')")) ?? 0
  }

  @discardableResult
  public func enqueue(_ draft: OutboxDraft, coalesce: Bool = true) throws -> OutboxEntry {
    try writer.transaction {
      if coalesce, let kind = draft.targetKind, let id = draft.targetId,
        let previous = try pendingSave(kind: kind, id: id, connection: writer),
        previous.attempts == 0, previous.name == draft.name
      {
        let request = try JSONEncoder().encode(draft.request)
        try writer.run(
          """
          UPDATE outbox SET request=?, base_version=?, optimistic=?, error_code=NULL, error_message=NULL
          WHERE operation_id=?
          """,
          bindings: [
            .blob(request), draft.baseVersion.map(SQLiteValue.int) ?? .null,
            draft.optimistic.map(SQLiteValue.blob) ?? .null, .text(previous.operationId),
          ])
        try writer.run(
          "DELETE FROM outbox_dependencies WHERE operation_id=?",
          bindings: [.text(previous.operationId)])
        for dependency in draft.dependsOn {
          try writer.run(
            "INSERT OR IGNORE INTO outbox_dependencies(operation_id,depends_on) VALUES(?,?)",
            bindings: [.text(previous.operationId), .text(dependency)])
        }
        var updated = previous
        updated.request = draft.request
        updated.baseVersion = draft.baseVersion
        updated.optimistic = draft.optimistic
        updated.dependsOn = draft.dependsOn
        return updated
      }
      let created = draft.operationId
      let now = Date().iso8601Milliseconds
      let request = try JSONEncoder().encode(draft.request)
      var depends = draft.dependsOn
      if let kind = draft.targetKind, let id = draft.targetId {
        let previous = try writer.query(
          """
          SELECT operation_id FROM outbox
          WHERE target_kind=? AND target_id=? AND state IN ('pending','conflict','failed','unknown')
          ORDER BY local_seq
          """, bindings: [.text(kind), .text(id)])
        if let last = previous.last?.text(0), !depends.contains(last) { depends.append(last) }
      }
      try writer.run(
        """
        INSERT INTO outbox(
          operation_id, name, request, target_kind, target_id, base_version, optimistic, state, created_at
        ) VALUES(?,?,?,?,?,?,?,'pending',?)
        """,
        bindings: [
          .text(draft.operationId), .text(draft.name), .blob(request),
          draft.targetKind.map(SQLiteValue.text) ?? .null,
          draft.targetId.map(SQLiteValue.text) ?? .null,
          draft.baseVersion.map(SQLiteValue.int) ?? .null,
          draft.optimistic.map(SQLiteValue.blob) ?? .null, .text(now),
        ])
      for dependency in depends {
        try writer.run(
          "INSERT OR IGNORE INTO outbox_dependencies(operation_id,depends_on) VALUES(?,?)",
          bindings: [.text(draft.operationId), .text(dependency)])
      }
      let seq = try writer.int("SELECT last_insert_rowid()")
      return OutboxEntry(
        localSeq: seq, operationId: created, name: draft.name, request: draft.request,
        targetKind: draft.targetKind, targetId: draft.targetId, baseVersion: draft.baseVersion,
        optimistic: draft.optimistic, state: "pending", attempts: 0, errorCode: nil,
        errorMessage: nil, createdAt: now, dependsOn: depends)
    }
  }

  public func updateOutbox(
    operationId: String, state: String? = nil, attempts: Int? = nil, errorCode: String? = nil,
    errorMessage: String? = nil, request: PreparedRequest? = nil, operationId newId: String? = nil,
    clearError: Bool = false
  ) throws {
    var sets: [String] = []
    var bindings: [SQLiteValue] = []
    if let state {
      sets.append("state=?")
      bindings.append(.text(state))
    }
    if let attempts {
      sets.append("attempts=?")
      bindings.append(.int(attempts))
    }
    if let errorCode {
      sets.append("error_code=?")
      bindings.append(.text(errorCode))
    }
    if let errorMessage {
      sets.append("error_message=?")
      bindings.append(.text(errorMessage))
    }
    if let request {
      sets.append("request=?")
      bindings.append(.blob(try JSONEncoder().encode(request)))
    }
    if let newId {
      sets.append("operation_id=?")
      bindings.append(.text(newId))
    }
    if clearError {
      sets.append("error_code=NULL")
      sets.append("error_message=NULL")
    }
    guard !sets.isEmpty else { return }
    bindings.append(.text(operationId))
    try writer.transaction {
      try writer.run(
        "UPDATE outbox SET \(sets.joined(separator: ",")) WHERE operation_id=?", bindings: bindings
      )
      if let newId {
        try writer.run(
          "UPDATE outbox_dependencies SET operation_id=? WHERE operation_id=?",
          bindings: [.text(newId), .text(operationId)])
        try writer.run(
          "UPDATE outbox_dependencies SET depends_on=? WHERE depends_on=?",
          bindings: [.text(newId), .text(operationId)])
      }
    }
  }

  public func deleteOutbox(operationId: String) throws {
    try writer.transaction {
      try writer.run(
        "DELETE FROM outbox_dependencies WHERE operation_id=? OR depends_on=?",
        bindings: [.text(operationId), .text(operationId)])
      try writer.run("DELETE FROM outbox WHERE operation_id=?", bindings: [.text(operationId)])
    }
  }

  public func cascadeFailed(operationId: String, code: String, message: String) throws {
    let dependents =
      (try? writer.query(
        "SELECT operation_id FROM outbox_dependencies WHERE depends_on=?",
        bindings: [.text(operationId)]))?.map { $0.text(0) } ?? []
    for dependent in dependents {
      try updateOutbox(
        operationId: dependent, state: "failed", errorCode: code, errorMessage: message)
      try cascadeFailed(operationId: dependent, code: code, message: message)
    }
  }

  private func pendingSave(kind: String, id: String, connection: SQLiteConnection) throws
    -> OutboxEntry?
  {
    try connection.query(
      """
      SELECT local_seq, operation_id, name, request, target_kind, target_id, base_version,
             optimistic, state, attempts, error_code, error_message, created_at
      FROM outbox WHERE target_kind=? AND target_id=? AND state='pending' AND attempts=0
      ORDER BY local_seq DESC LIMIT 1
      """, bindings: [.text(kind), .text(id)]
    ).first.map { Self.entry($0, dependsOn: []) }
  }

  @discardableResult
  private func upsert(_ item: ChangeItem, source: String, connection: SQLiteConnection) throws
    -> Bool
  {
    let data = try JSONEncoder().encode(item.data)
    let occurred =
      item.kind == "meal" ? item.data.string("occurredAt") : item.data.string("startedAt")
    let current = try connection.query(
      "SELECT version FROM documents WHERE kind=? AND id=?",
      bindings: [.text(item.kind), .text(item.id)]
    ).first?.int(0)
    if let current, item.version < current { return false }
    try connection.run(
      """
      INSERT INTO documents(
        kind, id, version, deleted, created_at, updated_at, data, occurred_at, source, seq
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(kind, id) DO UPDATE SET
        version=excluded.version, deleted=excluded.deleted, created_at=excluded.created_at,
        updated_at=excluded.updated_at, data=excluded.data, occurred_at=excluded.occurred_at,
        source=excluded.source, seq=excluded.seq
      WHERE excluded.version>=documents.version
      """,
      bindings: [
        .text(item.kind), .text(item.id), .int(item.version), .int(item.deleted ? 1 : 0),
        .text(item.createdAt), .text(item.updatedAt), .blob(data),
        occurred.map(SQLiteValue.text) ?? .null, .text(source),
        source == "feed" ? .int(item.seq) : .null,
      ])
    return true
  }

  private static func migrate(_ connection: SQLiteConnection) throws {
    let version = try connection.int("PRAGMA user_version")
    if version > 1 {
      try connection.execute(
        """
        DROP TABLE IF EXISTS documents;
        DROP TABLE IF EXISTS catalog_exercises;
        DELETE FROM meta WHERE key IN ('cursor','bootstrap_complete','catalog_cursor','catalog_complete');
        """)
    }
    if version == 1 { return }
    try connection.execute(schema)
    try connection.execute("PRAGMA user_version=1")
  }

  private static func document(_ row: SQLiteRow) -> StoredDocument {
    StoredDocument(
      kind: row.text(0), id: row.text(1), version: row.int(2), deleted: row.int(3) != 0,
      createdAt: row.text(4), updatedAt: row.text(5), data: row.blob(6),
      occurredAt: row.optionalText(7), source: row.text(8),
      seq: row.values.count > 9 && row.int(9) != 0 ? row.int(9) : nil)
  }

  private static func entry(_ row: SQLiteRow, dependsOn: [String]) -> OutboxEntry {
    let request =
      (try? JSONDecoder().decode(PreparedRequest.self, from: row.blob(3)))
      ?? PreparedRequest(method: "POST", path: "/", body: .object([:]))
    return OutboxEntry(
      localSeq: row.int(0), operationId: row.text(1), name: row.text(2), request: request,
      targetKind: row.optionalText(4), targetId: row.optionalText(5),
      baseVersion: {
        if case .null = row.values[6] { return nil }
        return row.int(6)
      }(),
      optimistic: {
        if case .null = row.values[7] { return nil }
        return row.blob(7)
      }(),
      state: row.text(8), attempts: row.int(9), errorCode: row.optionalText(10),
      errorMessage: row.optionalText(11), createdAt: row.text(12), dependsOn: dependsOn)
  }
}

private let columns =
  "kind, id, version, deleted, created_at, updated_at, data, occurred_at, source, IFNULL(seq,0)"

private let schema = """
  CREATE TABLE IF NOT EXISTS documents(
    kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data BLOB NOT NULL,
    occurred_at TEXT,
    source TEXT NOT NULL CHECK(source IN ('legacy','feed','response')),
    seq INTEGER,
    PRIMARY KEY(kind, id)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS documents_time ON documents(kind, deleted, occurred_at);
  CREATE TABLE IF NOT EXISTS catalog_exercises(
    id TEXT PRIMARY KEY, data BLOB NOT NULL, locale TEXT NOT NULL, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outbox(
    local_seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, request BLOB NOT NULL,
    target_kind TEXT, target_id TEXT, base_version INTEGER,
    optimistic BLOB,
    state TEXT NOT NULL CHECK(state IN ('pending','conflict','failed','unknown')),
    attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outbox_dependencies(
    operation_id TEXT NOT NULL, depends_on TEXT NOT NULL,
    PRIMARY KEY(operation_id, depends_on));
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  """
