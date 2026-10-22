import CryptoKit
import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public enum JSONValue: Codable, Sendable, Equatable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let value = try? c.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? c.decode(Double.self) {
      self = .number(value)
    } else if let value = try? c.decode(String.self) {
      self = .string(value)
    } else if let value = try? c.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
  public static func from<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
  }
}
public struct APIError: Error, Sendable, LocalizedError {
  public var code: String
  public var status: Int
  public var message: String
  public var errorDescription: String? { message }
  public init(
    _ code: String, status: Int = 0, message: String = "The request could not be completed."
  ) {
    self.code = code
    self.status = status
    self.message = message
  }
}
public struct OAuthCredentials: Codable, Sendable {
  public var clientId: String
  public var accessToken: String
  public var refreshToken: String?
  public var expiresAt: Date
  public var scope: String
  public var device: HealthDeviceCredential?
  public init(
    clientId: String, accessToken: String, refreshToken: String? = nil,
    expiresAt: Date = .distantFuture, scope: String = "fitness:full"
  ) {
    self.clientId = clientId
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.expiresAt = expiresAt
    self.scope = scope
  }
}
public protocol CredentialVault: Sendable {
  func read(for origin: String) throws -> OAuthCredentials?
  func write(_ value: OAuthCredentials?, for origin: String) throws
}
public protocol HTTPTransport: Sendable {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}
private final class RejectRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
public struct URLSessionTransport: HTTPTransport, Sendable {
  private let session: URLSession
  public init() {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 25
    c.httpCookieStorage = nil
    c.urlCache = nil
    self.session = URLSession(configuration: c, delegate: RejectRedirects(), delegateQueue: nil)
  }
  public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw APIError("INVALID_RESPONSE") }
    return (data, response)
  }
}
public struct ServerConfiguration: Sendable, Equatable {
  public let url: URL
  public var origin: String {
    url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  }
  public init(_ value: String) throws {
    guard let c = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      let host = c.host, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
      c.scheme == "https" || (c.scheme == "http" && ["localhost", "127.0.0.1"].contains(host)),
      let url = URL(string: "\(c.scheme!)://\(host)\(c.port.map { ":\($0)" } ?? "")")
    else { throw APIError("INVALID_SERVER_URL") }
    self.url = url
  }
  public func endpoint(_ path: String) throws -> URL {
    guard path.hasPrefix("/"), !path.hasPrefix("//"), let result = URL(string: origin + path),
      result.host == url.host, result.port == url.port, result.scheme == url.scheme
    else { throw APIError("INVALID_ENDPOINT") }
    return result
  }
}
public struct OAuthDiscovery: Decodable, Sendable {
  public var issuer: String
  public var authorizationEndpoint: String
  public var tokenEndpoint: String
  public var registrationEndpoint: String?
  public var revocationEndpoint: String?
  public var scopesSupported: [String]?
  public var codeChallengeMethodsSupported: [String]?
  enum CodingKeys: String, CodingKey {
    case issuer
    case authorizationEndpoint = "authorization_endpoint"
    case tokenEndpoint = "token_endpoint"
    case registrationEndpoint = "registration_endpoint"
    case revocationEndpoint = "revocation_endpoint"
    case scopesSupported = "scopes_supported"
    case codeChallengeMethodsSupported = "code_challenge_methods_supported"
  }
}
public struct OAuthTokenResponse: Decodable, Sendable {
  public var accessToken: String
  public var refreshToken: String?
  public var expiresIn: Double
  public var scope: String?
  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case refreshToken = "refresh_token"
    case expiresIn = "expires_in"
    case scope
  }
}
private struct APIEnvelope<T: Decodable>: Decodable { var data: T }
private struct ErrorEnvelope: Decodable {
  struct Failure: Decodable {
    var code: String
    var message: String
  }
  var error: Failure
}

public actor APIClient {
  public let server: ServerConfiguration
  private let transport: any HTTPTransport
  private let vault: any CredentialVault
  private var refreshTask: Task<OAuthCredentials, Error>?
  private var language = "en"
  private var pendingWrites: [String: PreparedRequest] = [:]
  private var pendingWritesURL: URL?
  private var inFlightWrites = Set<String>()
  public init(
    server: ServerConfiguration, vault: any CredentialVault,
    transport: any HTTPTransport = URLSessionTransport()
  ) {
    self.server = server
    self.vault = vault
    self.transport = transport
  }
  public func setLanguage(_ value: String) { language = value }
  public func credentials() throws -> OAuthCredentials? { try vault.read(for: server.origin) }
  public func saveCredentials(_ value: OAuthCredentials?) throws {
    try vault.write(value, for: server.origin)
  }
  public func saveDevice(_ device: HealthDeviceCredential) throws {
    guard var c = try credentials() else { throw APIError("AUTHENTICATION_REQUIRED", status: 401) }
    c.device = device
    try saveCredentials(c)
  }
  public func enableMutationRecovery(accountKey: String, directory: URL? = nil) throws {
    let folder = try directory ?? DiskStore.directory()
    let url = folder.appendingPathComponent("writes-\(accountKey).json")
    pendingWritesURL = url
    pendingWrites = DiskStore.read([String: PreparedRequest].self, at: url) ?? [:]
  }
  private func persistWrites() throws {
    if let pendingWritesURL { try DiskStore.write(pendingWrites, to: pendingWritesURL) }
  }
  private func clearWrite(_ key: String) throws {
    let previous = pendingWrites.removeValue(forKey: key)
    do { try persistWrites() } catch {
      pendingWrites[key] = previous
      throw error
    }
  }
  public func recoverPendingMutations() async throws {
    for (key, request) in pendingWrites where !inFlightWrites.contains(key) {
      inFlightWrites.insert(key)
      defer { inFlightWrites.remove(key) }
      do {
        _ = try await self.request(
          JSONValue.self, method: request.method, path: request.path, body: request.body)
        try clearWrite(key)
      } catch {
        if let error = error as? APIError, (400..<500).contains(error.status), error.status != 401,
          error.status != 403
        {
          try clearWrite(key)
        }
        throw error
      }
    }
  }
  public func disconnect() async {
    refreshTask?.cancel()
    refreshTask = nil
    if let current = try? credentials(), let metadata = try? await discovery(),
      let endpoint = metadata.revocationEndpoint.flatMap(URL.init(string:)),
      endpoint.host == server.url.host, endpoint.scheme == server.url.scheme,
      endpoint.port == server.url.port
    {
      var request = URLRequest(url: endpoint)
      request.httpMethod = "POST"
      var form = URLComponents()
      form.queryItems = [
        URLQueryItem(name: "token", value: current.refreshToken ?? current.accessToken),
        URLQueryItem(name: "client_id", value: current.clientId),
      ]
      request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(
        using: .utf8)
      request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
      _ = try? await transport.data(for: request)
    }
    try? saveCredentials(nil)
  }
  public func discovery() async throws -> OAuthDiscovery {
    let (data, response) = try await transport.data(
      for: URLRequest(url: server.endpoint("/.well-known/oauth-authorization-server")))
    try Self.check(data, response)
    let value = try JSONDecoder().decode(OAuthDiscovery.self, from: data)
    guard value.issuer == server.origin,
      value.codeChallengeMethodsSupported?.contains("S256") == true
    else { throw APIError("INVALID_AUTHORIZATION_SERVER") }
    for endpoint in [
      value.authorizationEndpoint, value.tokenEndpoint, value.registrationEndpoint,
    ].compactMap({ $0 }) {
      guard let url = URL(string: endpoint), url.scheme == server.url.scheme,
        url.host == server.url.host, url.port == server.url.port
      else { throw APIError("INVALID_AUTHORIZATION_SERVER") }
    }
    return value
  }
  public func publicRequest<T: Decodable & Sendable>(
    _ type: T.Type, url: URL, json: JSONValue? = nil, form: [String: String]? = nil
  ) async throws -> T {
    guard url.host == server.url.host, url.scheme == server.url.scheme, url.port == server.url.port
    else { throw APIError("INVALID_ENDPOINT") }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    if let json {
      request.httpBody = try JSONEncoder().encode(json)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let form {
      var c = URLComponents()
      c.queryItems = form.map { URLQueryItem(name: $0.key, value: $0.value) }
      request.httpBody = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(
        using: .utf8)
      request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await transport.data(for: request)
    try Self.check(data, response)
    return try JSONDecoder().decode(type, from: data)
  }
  private func accessToken(forceRefresh: Bool = false) async throws -> String {
    guard let current = try credentials() else {
      throw APIError("AUTHENTICATION_REQUIRED", status: 401)
    }
    if !forceRefresh && current.expiresAt.timeIntervalSinceNow > 30 { return current.accessToken }
    if let refreshTask { return try await refreshTask.value.accessToken }
    guard let refresh = current.refreshToken else {
      throw APIError("AUTHENTICATION_REQUIRED", status: 401)
    }
    let task = Task<OAuthCredentials, Error> {
      let discovery = try await self.discovery()
      let value = try await self.publicRequest(
        OAuthTokenResponse.self, url: URL(string: discovery.tokenEndpoint)!,
        form: [
          "grant_type": "refresh_token", "client_id": current.clientId, "refresh_token": refresh,
          "resource": self.server.origin,
        ])
      var next = current
      next.accessToken = value.accessToken
      next.refreshToken = value.refreshToken ?? refresh
      next.expiresAt = Date().addingTimeInterval(value.expiresIn)
      next.scope = value.scope ?? current.scope
      try Task.checkCancellation()
      try self.saveCredentials(next)
      return next
    }
    refreshTask = task
    defer { refreshTask = nil }
    return try await task.value.accessToken
  }
  public func request<T: Decodable & Sendable>(
    _ type: T.Type, method: String = "GET", path: String, body: JSONValue? = nil
  ) async throws -> T {
    let bytes = try await authorizedData(method: method, path: path, body: body)
    return try JSONDecoder().decode(APIEnvelope<T>.self, from: bytes).data
  }
  public func mutation<T: Decodable & Sendable>(
    _ type: T.Type, method: String = "POST", path: String, fields: [String: JSONValue],
    operationId: String? = nil
  ) async throws -> T {
    let recoverable =
      operationId == nil
      && [
        "/api/v1/meals", "/api/v1/recipes", "/api/v1/foods", "/api/v1/exercises",
        "/api/v1/training-plans", "/api/v1/workouts", "/api/v1/preferences",
      ].contains { path == $0 || path.hasPrefix($0 + "/") }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let fingerprint = SHA256.hash(
      data: try encoder.encode(
        JSONValue.object([
          "method": .string(method), "path": .string(path), "fields": .object(fields),
        ]))
    ).map { String(format: "%02x", $0) }.joined()
    var body = fields
    body["operationId"] = .string(operationId ?? UUID().uuidString)
    var prepared = PreparedRequest(method: method, path: path, body: .object(body))
    if recoverable {
      guard !inFlightWrites.contains(fingerprint) else { throw APIError("REQUEST_IN_PROGRESS") }
      if let existing = pendingWrites[fingerprint] {
        prepared = existing
      } else {
        pendingWrites[fingerprint] = prepared
        do { try persistWrites() } catch {
          pendingWrites[fingerprint] = nil
          throw error
        }
      }
      inFlightWrites.insert(fingerprint)
    }
    defer { inFlightWrites.remove(fingerprint) }
    do {
      let result = try await request(
        type, method: prepared.method, path: prepared.path, body: prepared.body)
      if recoverable { try clearWrite(fingerprint) }
      return result
    } catch {
      if recoverable, let error = error as? APIError, (400..<500).contains(error.status),
        error.status != 401, error.status != 403
      {
        try clearWrite(fingerprint)
      }
      throw error
    }
  }
  public func imageData(assetId: String) async throws -> Data {
    try await authorizedData(path: "/api/v1/media/\(assetId.pathSegment)/content")
  }
  public func publicData(path: String) async throws -> Data {
    guard
      [
        "/musclemap/male-front.svg", "/musclemap/male-back.svg",
        "/musclemap/female-front.svg", "/musclemap/female-back.svg",
      ].contains(path)
    else { throw APIError("INVALID_ENDPOINT") }
    let url = try server.endpoint(path)
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    let (data, response) = try await transport.data(for: request)
    guard response.url == url else { throw APIError("INVALID_ENDPOINT") }
    try Self.check(data, response)
    return data
  }
  public func upload(_ bytes: Data, to url: URL, contentType: String) async throws {
    guard url.host == server.url.host, url.port == server.url.port, url.scheme == server.url.scheme
    else { throw APIError("INVALID_UPLOAD_URL") }
    var r = URLRequest(url: url)
    r.httpMethod = "PUT"
    r.httpBody = bytes
    r.setValue(contentType, forHTTPHeaderField: "Content-Type")
    let (data, response) = try await transport.data(for: r)
    try Self.check(data, response)
  }
  private func authorizedData(method: String = "GET", path: String, body: JSONValue? = nil)
    async throws -> Data
  {
    let initialToken = try await accessToken()
    for attempt in 0..<2 {
      var request = URLRequest(url: try server.endpoint(path))
      request.httpMethod = method
      request.setValue(
        "Bearer \(attempt == 0 ? initialToken : try await accessToken(forceRefresh: true))",
        forHTTPHeaderField: "Authorization")
      request.setValue(language, forHTTPHeaderField: "Accept-Language")
      if let body {
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      let (data, response) = try await transport.data(for: request)
      if response.statusCode == 401 && attempt == 0 { continue }
      try Self.check(data, response)
      return data
    }
    throw APIError("AUTHENTICATION_REQUIRED", status: 401)
  }
  private static func check(_ data: Data, _ response: HTTPURLResponse) throws {
    guard (200..<300).contains(response.statusCode) else {
      if let e = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) {
        throw APIError(e.error.code, status: response.statusCode, message: e.error.message)
      }
      throw APIError("HTTP_\(response.statusCode)", status: response.statusCode)
    }
  }
}
extension String {
  public var queryValue: String {
    addingPercentEncoding(
      withAllowedCharacters: CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? ""
  }
  public var pathSegment: String {
    addingPercentEncoding(
      withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? ""
  }
}
