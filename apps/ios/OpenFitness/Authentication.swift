import AuthenticationServices
import OpenFitnessKit
import UIKit

@MainActor
final class NativeAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var session: ASWebAuthenticationSession?
  func signIn(client: APIClient) async throws {
    let discovery = try await client.discovery()
    guard let registrationURL = discovery.registrationEndpoint.flatMap(URL.init(string:)) else {
      throw APIError("CLIENT_REGISTRATION_UNAVAILABLE")
    }
    struct Registration: Decodable, Sendable {
      var clientId: String
      enum CodingKeys: String, CodingKey { case clientId = "client_id" }
    }
    let redirect = "org.openfitness.app:/oauth/callback"
    let registration = try await client.publicRequest(
      Registration.self, url: registrationURL,
      json: .object([
        "client_name": .string("OpenFitness iOS"), "redirect_uris": .array([.string(redirect)]),
        "grant_types": .array([.string("authorization_code"), .string("refresh_token")]),
        "response_types": .array([.string("code")]), "token_endpoint_auth_method": .string("none"),
      ]))
    let verifier = try OAuthSecurity.randomToken()
    let state = try OAuthSecurity.randomToken()
    let supportsHealth = discovery.scopesSupported?.contains("health:sync") == true
    let scope = "fitness:full offline_access" + (supportsHealth ? " health:sync" : "")
    var components = URLComponents(string: discovery.authorizationEndpoint)!
    components.queryItems = [
      "response_type": "code", "client_id": registration.clientId, "redirect_uri": redirect,
      "scope": scope, "resource": discovery.issuer, "state": state,
      "code_challenge": OAuthSecurity.challenge(for: verifier), "code_challenge_method": "S256",
    ].map { .init(name: $0.key, value: $0.value) }
    let callback: URL = try await withCheckedThrowingContinuation { continuation in
      let web = ASWebAuthenticationSession(
        url: components.url!, callbackURLScheme: "org.openfitness.app"
      ) { url, error in
        if let url {
          continuation.resume(returning: url)
        } else {
          continuation.resume(throwing: error ?? APIError("AUTHORIZATION_CANCELLED"))
        }
      }
      web.presentationContextProvider = self
      web.prefersEphemeralWebBrowserSession = false
      session = web
      if !web.start() { continuation.resume(throwing: APIError("AUTHORIZATION_UNAVAILABLE")) }
    }
    defer { session = nil }
    let code = try OAuthSecurity.validateCallback(callback, state: state, issuer: discovery.issuer)
    let token = try await client.publicRequest(
      OAuthTokenResponse.self, url: URL(string: discovery.tokenEndpoint)!,
      form: [
        "grant_type": "authorization_code", "client_id": registration.clientId, "code": code,
        "code_verifier": verifier, "redirect_uri": redirect, "resource": discovery.issuer,
      ])
    try await client.saveCredentials(
      .init(
        clientId: registration.clientId, accessToken: token.accessToken,
        refreshToken: token.refreshToken, expiresAt: Date().addingTimeInterval(token.expiresIn),
        scope: token.scope ?? scope))
  }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    guard
      let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(
        where: { $0.activationState == .foregroundActive })
    else { preconditionFailure("Authentication requires a foreground window scene.") }
    return scene.windows.first(where: \.isKeyWindow) ?? ASPresentationAnchor(windowScene: scene)
  }
}
