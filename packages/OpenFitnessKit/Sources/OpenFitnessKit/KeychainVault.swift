import CryptoKit
import Foundation
import Security

public final class KeychainVault: CredentialVault, Sendable {
  private let service: String
  public init(service: String = "org.openfitness.credentials") { self.service = service }
  private func query(_ origin: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: origin,
    ]
  }
  public func read(for origin: String) throws -> OAuthCredentials? {
    var query = query(origin)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &value)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = value as? Data else {
      throw APIError("KEYCHAIN_UNAVAILABLE")
    }
    return try JSONDecoder().decode(OAuthCredentials.self, from: data)
  }
  public func write(_ value: OAuthCredentials?, for origin: String) throws {
    let query = query(origin)
    guard let value else {
      let status = SecItemDelete(query as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw APIError("KEYCHAIN_UNAVAILABLE")
      }
      return
    }
    let data = try JSONEncoder().encode(value)
    let update = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update == errSecItemNotFound {
      var insert = query
      insert[kSecValueData as String] = data
      insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else {
        throw APIError("KEYCHAIN_UNAVAILABLE")
      }
    } else if update != errSecSuccess {
      throw APIError("KEYCHAIN_UNAVAILABLE")
    }
  }
}
public enum OAuthSecurity {
  public static func randomToken() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw APIError("RANDOM_SOURCE_UNAVAILABLE")
    }
    return Data(bytes).base64URL
  }
  public static func challenge(for verifier: String) -> String {
    Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
  }
  public static func accountKey(origin: String, ownerId: String) -> String {
    Data(SHA256.hash(data: Data((origin + ":" + ownerId).utf8))).base64URL
  }
  public static func validateCallback(_ callback: URL, state: String, issuer: String) throws
    -> String
  {
    guard callback.scheme == "org.openfitness.app", callback.path == "/oauth/callback",
      let c = URLComponents(url: callback, resolvingAgainstBaseURL: false),
      c.queryItems?.first(where: { $0.name == "state" })?.value == state,
      c.queryItems?.first(where: { $0.name == "iss" })?.value == issuer,
      let code = c.queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty
    else { throw APIError("INVALID_OAUTH_CALLBACK") }
    return code
  }
}
extension Data {
  fileprivate var base64URL: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
}
