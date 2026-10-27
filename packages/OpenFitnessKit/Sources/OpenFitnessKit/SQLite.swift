import Foundation
import SQLite3
import Synchronization

public struct SQLiteError: Error, Sendable, Equatable {
  public var code: Int32
  public var message: String
  public init(code: Int32, message: String) {
    self.code = code
    self.message = message
  }
}

/// One SQLite connection. Callers serialize access with the connection lock;
/// the pointer never leaves this type.
final class SQLiteConnection: @unchecked Sendable {
  private let mutex = Mutex<OpaquePointer?>(nil)
  let path: String

  init(path: String) throws {
    self.path = path
    var handle: OpaquePointer?
    var flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
    #if os(iOS) || os(watchOS) || os(macOS)
      flags |= SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION
    #endif
    let status = sqlite3_open_v2(path, &handle, flags, nil)
    guard status == SQLITE_OK, let handle else {
      let message = handle.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "unable to open"
      if let handle { sqlite3_close(handle) }
      throw SQLiteError(code: status, message: message)
    }
    mutex.withLock { $0 = handle }
    try execute("PRAGMA journal_mode=WAL")
    try execute("PRAGMA synchronous=NORMAL")
    try execute("PRAGMA foreign_keys=ON")
    try execute("PRAGMA busy_timeout=5000")
  }

  func close() {
    mutex.withLock { handle in
      if let handle { sqlite3_close_v2(handle) }
      handle = nil
    }
  }

  func execute(_ sql: String) throws {
    try withHandle { db in
      var error: UnsafeMutablePointer<CChar>?
      let status = sqlite3_exec(db, sql, nil, nil, &error)
      if status != SQLITE_OK {
        let message = error.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(db))
        sqlite3_free(error)
        throw SQLiteError(code: status, message: message)
      }
    }
  }

  func transaction<T>(_ body: () throws -> T) throws -> T {
    try execute("BEGIN IMMEDIATE")
    do {
      let value = try body()
      try execute("COMMIT")
      return value
    } catch {
      try? execute("ROLLBACK")
      throw error
    }
  }

  func query(_ sql: String, bindings: [SQLiteValue] = []) throws -> [SQLiteRow] {
    try withHandle { db in
      let statement = try prepare(db, sql)
      defer { sqlite3_finalize(statement) }
      try bind(statement, bindings)
      var rows: [SQLiteRow] = []
      while true {
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { break }
        if status != SQLITE_ROW {
          throw SQLiteError(code: status, message: String(cString: sqlite3_errmsg(db)))
        }
        rows.append(SQLiteRow(statement: statement))
      }
      return rows
    }
  }

  func run(_ sql: String, bindings: [SQLiteValue] = []) throws {
    try withHandle { db in
      let statement = try prepare(db, sql)
      defer { sqlite3_finalize(statement) }
      try bind(statement, bindings)
      let status = sqlite3_step(statement)
      guard status == SQLITE_DONE || status == SQLITE_ROW else {
        throw SQLiteError(code: status, message: String(cString: sqlite3_errmsg(db)))
      }
    }
  }

  func int(_ sql: String, bindings: [SQLiteValue] = []) throws -> Int {
    let rows = try query(sql, bindings: bindings)
    return rows.first?.int(0) ?? 0
  }

  private func withHandle<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
    try mutex.withLock { handle in
      guard let handle else { throw SQLiteError(code: SQLITE_MISUSE, message: "connection closed") }
      return try body(handle)
    }
  }

  private func prepare(_ db: OpaquePointer, _ sql: String) throws -> OpaquePointer {
    var statement: OpaquePointer?
    let status = sqlite3_prepare_v2(db, sql, -1, &statement, nil)
    guard status == SQLITE_OK, let statement else {
      throw SQLiteError(code: status, message: String(cString: sqlite3_errmsg(db)))
    }
    return statement
  }

  private func bind(_ statement: OpaquePointer, _ values: [SQLiteValue]) throws {
    for (offset, value) in values.enumerated() {
      let index = Int32(offset + 1)
      let status: Int32
      switch value {
      case .null:
        status = sqlite3_bind_null(statement, index)
      case .int(let number):
        status = sqlite3_bind_int64(statement, index, sqlite3_int64(number))
      case .double(let number):
        status = sqlite3_bind_double(statement, index, number)
      case .text(let text):
        status = text.withCString { pointer in
          sqlite3_bind_text(statement, index, pointer, -1, transientDestructor)
        }
      case .blob(let data):
        status = data.withUnsafeBytes { buffer in
          sqlite3_bind_blob(
            statement, index, buffer.baseAddress, Int32(data.count), transientDestructor)
        }
      }
      if status != SQLITE_OK {
        throw SQLiteError(code: status, message: "bind failed")
      }
    }
  }
}

private let transientDestructor = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum SQLiteValue: Sendable {
  case null
  case int(Int)
  case double(Double)
  case text(String)
  case blob(Data)
}

struct SQLiteRow: Sendable {
  var values: [SQLiteValue]
  var names: [String]

  init(statement: OpaquePointer) {
    let count = sqlite3_column_count(statement)
    var values: [SQLiteValue] = []
    var names: [String] = []
    for index in 0..<count {
      names.append(String(cString: sqlite3_column_name(statement, index)))
      switch sqlite3_column_type(statement, index) {
      case SQLITE_NULL:
        values.append(.null)
      case SQLITE_INTEGER:
        values.append(.int(Int(sqlite3_column_int64(statement, index))))
      case SQLITE_FLOAT:
        values.append(.double(sqlite3_column_double(statement, index)))
      case SQLITE_BLOB:
        let count = Int(sqlite3_column_bytes(statement, index))
        if let pointer = sqlite3_column_blob(statement, index), count > 0 {
          values.append(.blob(Data(bytes: pointer, count: count)))
        } else {
          values.append(.blob(Data()))
        }
      default:
        if let pointer = sqlite3_column_text(statement, index) {
          values.append(.text(String(cString: pointer)))
        } else {
          values.append(.text(""))
        }
      }
    }
    self.values = values
    self.names = names
  }

  func int(_ index: Int) -> Int {
    guard values.indices.contains(index) else { return 0 }
    switch values[index] {
    case .int(let value): return value
    case .double(let value): return Int(value)
    case .text(let value): return Int(value) ?? 0
    default: return 0
    }
  }

  func text(_ index: Int) -> String {
    guard values.indices.contains(index) else { return "" }
    switch values[index] {
    case .text(let value): return value
    case .int(let value): return String(value)
    case .null: return ""
    case .blob(let data): return String(data: data, encoding: .utf8) ?? ""
    case .double(let value): return String(value)
    }
  }

  func blob(_ index: Int) -> Data {
    guard values.indices.contains(index) else { return Data() }
    if case .blob(let data) = values[index] { return data }
    if case .text(let text) = values[index] { return Data(text.utf8) }
    return Data()
  }

  func optionalText(_ index: Int) -> String? {
    guard values.indices.contains(index) else { return nil }
    if case .null = values[index] { return nil }
    let text = text(index)
    return text.isEmpty ? nil : text
  }
}
