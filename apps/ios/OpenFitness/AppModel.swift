import Foundation
import Network
import Observation
import OpenFitnessKit
import UIKit

private struct CachedAccount: Codable {
  var context: AgentContext
  var origin: String
  var clientId: String
  var savedAt: Date
}

struct FoodSearchHit: Identifiable, Sendable {
  var id: String
  var food: Food
  var savedId: String?
}
struct FoodSearchResults: Sendable {
  var hits: [FoodSearchHit]
  var catalogDegraded: Bool
}

@MainActor @Observable
final class AppModel {
  var serverAddress: String
  var language: AppLanguage
  var context: AgentContext?
  var plans: [Record<TrainingPlan>] = []
  var recipes: [Record<Recipe>] = []
  var meals: [Record<Meal>] = []
  var workouts: [Record<Workout>] = []
  var workout: Record<Workout>?
  var nutrition: DailyNutrition?
  var journal = CommandJournal()
  var errorMessage: String?
  var isBusy = false
  var isRefreshing = false
  var isDraining = false
  var isConnected = false
  var isOnline = true
  var healthStatus: HealthSyncStatus?
  var healthSummary: HealthSnapshot?
  var healthEnabled = false
  var sharesHealth = false
  var selectedDay = Date()
  var restUntil: Date?
  var isPreview = false
  @ObservationIgnored private var client: APIClient?
  @ObservationIgnored private let vault = KeychainVault()
  @ObservationIgnored private let authentication = NativeAuthentication()
  @ObservationIgnored private let health = HealthBridge()
  @ObservationIgnored private var queueURL: URL?
  @ObservationIgnored private var cacheURL: URL?
  @ObservationIgnored private let monitor = NWPathMonitor()
  @ObservationIgnored private var companion: PhoneCompanion?
  @ObservationIgnored private var historyCursor: String?
  @ObservationIgnored private var refreshRequested = false
  @ObservationIgnored var exerciseDetails: [String: Record<Exercise>] = [:]
  @ObservationIgnored var muscleMapCache: [String: MuscleMapArtwork] = [:]
  @ObservationIgnored var taxonomyCache: [String: CachedExerciseTaxonomy] = [:]
  @ObservationIgnored var exerciseBackgroundedAt: Date?
  var exerciseCatalogRevision = 0
  var supportsExerciseCatalog: Bool { context?.capabilities.exerciseCatalog == "shared_catalog" }
  var copy: Localizer { .init(language) }
  func text(_ key: CopyKey) -> String { copy.text(key) }
  var timeZone: String { context?.timeZone ?? "America/New_York" }
  var accountKey: String {
    context.map {
      OAuthSecurity.accountKey(
        origin: (try? ServerConfiguration(serverAddress).origin) ?? "", ownerId: $0.ownerId)
    } ?? ""
  }
  var activeWorkout: Record<Workout>? {
    guard var value = workout else { return nil }
    for command in journal.commands
    where command.workoutReference == value.id
      || journal.workoutIds[command.workoutReference] == value.id
    {
      switch command.kind {
      case .logSet:
        if let id = command.exerciseId, let metrics = command.metrics,
          let exercise = value.data.plan?.snapshot.exercises.first(where: { $0.exerciseId == id })?
            .exerciseSnapshot
        {
          value.data.sets.append(
            .init(
              id: command.id, exerciseId: id, exercise: exercise, metrics: metrics,
              completedAt: command.createdAt))
        }
      case .finishWorkout: value.data.state = "completed"
      case .cancelWorkout: value.data.state = "cancelled"
      case .startWorkout: break
      }
    }
    return value.data.state == "active" ? value : nil
  }
  init() {
    serverAddress =
      UserDefaults.standard.string(forKey: "serverAddress")
      ?? "https://open-fitness.hotee.workers.dev"
    language =
      AppLanguage(rawValue: UserDefaults.standard.string(forKey: "appLanguage") ?? "en") ?? .english
    monitor.pathUpdateHandler = { [weak self] path in
      let online = path.status == .satisfied
      Task { @MainActor in
        self?.isOnline = online
        if online { await self?.drain() }
      }
    }
    monitor.start(queue: DispatchQueue(label: "org.openfitness.network"))
  }
  func boot() async {
    companion = PhoneCompanion(model: self)
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("-ui-testing") {
        loadPreview()
        return
      }
    #endif
    do {
      let configuration = try ServerConfiguration(serverAddress)
      client = APIClient(server: configuration, vault: vault)
      if let credentials = try vault.read(for: configuration.origin) {
        do { try await loadAccount() } catch {
          guard error is URLError || ((error as? APIError)?.status ?? 0) >= 500,
            let cached = DiskStore.read(
              CachedAccount.self,
              at: try accountCacheURL(configuration, clientId: credentials.clientId)),
            cached.origin == configuration.origin, cached.clientId == credentials.clientId,
            cached.savedAt.timeIntervalSinceNow > -86400
          else { throw error }
          try await activateAccount(cached.context)
        }
        await refresh()
      }
    } catch { if (error as? APIError)?.status != 401 { errorMessage = copy.error(error) } }
  }
  func signIn() async throws {
    let configuration = try ServerConfiguration(serverAddress)
    let api = APIClient(server: configuration, vault: vault)
    client = api
    await api.setLanguage(language.rawValue)
    try await authentication.signIn(client: api)
    UserDefaults.standard.set(configuration.origin, forKey: "serverAddress")
    serverAddress = configuration.origin
    try await loadAccount()
    await refresh()
  }
  private func loadAccount() async throws {
    let api = try api()
    await api.setLanguage(language.rawValue)
    let value = try await api.request(AgentContext.self, path: "/api/v1/agent-context")
    try await activateAccount(value)
    if let credentials = try await api.credentials() {
      let server = try ServerConfiguration(serverAddress)
      try DiskStore.write(
        CachedAccount(
          context: value, origin: server.origin, clientId: credentials.clientId, savedAt: Date()),
        to: accountCacheURL(server, clientId: credentials.clientId))
    }
  }
  private func accountCacheURL(_ server: ServerConfiguration, clientId: String) throws -> URL {
    try DiskStore.directory().appendingPathComponent(
      "account-\(OAuthSecurity.accountKey(origin: server.origin, ownerId: clientId)).json")
  }
  private func activateAccount(_ value: AgentContext) async throws {
    let api = try api()
    if context?.ownerId != value.ownerId {
      exerciseDetails = [:]
      taxonomyCache = [:]
    }
    context = value
    isConnected = true
    try await api.enableMutationRecovery(accountKey: accountKey)
    healthEnabled = UserDefaults.standard.bool(forKey: "nutritionSyncEnabled.\(accountKey)")
    sharesHealth = UserDefaults.standard.bool(forKey: "sharesHealthSummary.\(accountKey)")
    let folder = try DiskStore.directory()
    queueURL = folder.appendingPathComponent("queue-\(accountKey).json")
    cacheURL = folder.appendingPathComponent("cache-\(accountKey).json")
    journal = queueURL.flatMap { DiskStore.read(CommandJournal.self, at: $0) } ?? .init()
    if let cache = cacheURL.flatMap({ DiskStore.read(CompanionSnapshot.self, at: $0) }),
      Date.parseISO(cache.updatedAt)?.timeIntervalSinceNow ?? -.infinity > -86400
    {
      plans = cache.plans
      recipes = cache.recipes
      workout = cache.workout
      nutrition = cache.nutrition
    }
  }
  func api() throws -> APIClient {
    guard let client else { throw APIError("AUTHENTICATION_REQUIRED", status: 401) }
    return client
  }
  func perform(_ action: @escaping @MainActor () async throws -> Void) {
    Task {
      isBusy = true
      defer { isBusy = false }
      do { try await action() } catch { errorMessage = copy.error(error) }
    }
  }
  func refresh() async {
    guard isConnected, !isPreview else { return }
    if isRefreshing {
      refreshRequested = true
      return
    }
    isRefreshing = true
    defer {
      isRefreshing = false
      if refreshRequested {
        refreshRequested = false
        Task { await refresh() }
      }
    }
    do {
      let api = try api()
      try await api.recoverPendingMutations()
      async let p = allRecords(TrainingPlan.self, path: "/api/v1/training-plans", api: api)
      async let r = allRecords(Recipe.self, path: "/api/v1/recipes", api: api)
      async let w = api.request(RecordPage<Workout>.self, path: "/api/v1/workouts?limit=30")
      async let m = mealsForSelectedDay(api)
      async let n = api.request(
        DailyNutrition.self,
        path: "/api/v1/nutrition/daily/\(selectedDay.calendarDay(timeZone: timeZone))")
      plans = try await p
      recipes = try await r
      let history = try await w
      workouts = history.items
      historyCursor = history.cursor
      let remoteActive = workouts.first { $0.data.state == "active" }
      if remoteActive != nil || !journal.commands.contains(where: { $0.kind == .startWorkout }) {
        workout = remoteActive
      }
      meals = try await m
      nutrition = try await n
      if context?.capabilities.healthSyncProtocol != nil {
        healthStatus = try? await api.request(HealthSyncStatus.self, path: "/api/v1/health/status")
      }
      try persistCache()
      sendCompanion()
      await drain()
      if healthEnabled { await synchronizeHealth() }
    } catch {
      if let e = error as? APIError, e.status == 401 {
        errorMessage = copy.text(.authRequired)
      } else if let e = error as? APIError, e.status == 409 {
        errorMessage = copy.text(.recordChanged)
      }
    }
  }
  private func mealsForSelectedDay(_ api: APIClient) async throws -> [Record<Meal>] {
    var items: [Record<Meal>] = []
    var cursor: String?
    let day = selectedDay.calendarDay(timeZone: timeZone)
    repeat {
      let page = try await api.request(
        RecordPage<Meal>.self,
        path: "/api/v1/meals?limit=100" + (cursor.map { "&cursor=\($0.pathSegment)" } ?? ""))
      items += page.items.filter {
        Date.parseISO($0.data.occurredAt)?.calendarDay(timeZone: timeZone) == day
      }
      cursor = page.cursor
    } while cursor != nil
    return items.sorted { $0.data.occurredAt > $1.data.occurredAt }
  }
  private func allRecords<T: Codable & Sendable>(_ type: T.Type, path: String, api: APIClient)
    async throws -> [Record<T>]
  {
    var items: [Record<T>] = []
    var cursor: String?
    repeat {
      let page = try await api.request(
        RecordPage<T>.self,
        path: path + "?limit=100" + (cursor.map { "&cursor=\($0.pathSegment)" } ?? ""))
      items += page.items
      cursor = page.cursor
    } while cursor != nil
    return items
  }
  func loadMoreHistory() async throws {
    guard let cursor = historyCursor else { return }
    let encoded = cursor.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    let page = try await api().request(
      RecordPage<Workout>.self, path: "/api/v1/workouts?limit=30&cursor=\(encoded)")
    workouts += page.items
    historyCursor = page.cursor
  }
  var canLoadMoreHistory: Bool { historyCursor != nil }
  func setLanguage(_ value: AppLanguage) async {
    language = value
    UserDefaults.standard.set(value.rawValue, forKey: "appLanguage")
    await client?.setLanguage(value.rawValue)
    sendCompanion()
  }
  func start(_ plan: Record<TrainingPlan>, source: String = "ios") throws {
    guard activeWorkout == nil else { return }
    let reference = "local-" + UUID().uuidString
    workout = .init(
      id: reference, kind: "workout", version: 0,
      data: .init(name: plan.data.name, plan: plan, source: source))
    do {
      try enqueue(
        .init(
          accountKey: accountKey, kind: .startWorkout, workoutReference: reference, planId: plan.id,
          source: source, planVersion: plan.version))
    } catch {
      workout = nil
      throw error
    }
  }
  func logSet(exerciseId: String, metrics: SetMetrics, restSeconds: Double) throws {
    guard let workout = activeWorkout else { return }
    if isPreview {
      let exercise = workout.data.plan!.snapshot.exercises.first { $0.exerciseId == exerciseId }!
        .exerciseSnapshot
      self.workout?.data.sets.append(
        .init(exerciseId: exerciseId, exercise: exercise, metrics: metrics))
    } else {
      try enqueue(
        .init(
          accountKey: accountKey, kind: .logSet, workoutReference: workout.id,
          exerciseId: exerciseId, metrics: metrics))
    }
    restUntil = Date().addingTimeInterval(restSeconds)
  }
  func finish(cancel: Bool = false) throws {
    guard let workout = activeWorkout else { return }
    if isPreview {
      self.workout = nil
      return
    }
    try enqueue(
      .init(
        accountKey: accountKey, kind: cancel ? .cancelWorkout : .finishWorkout,
        workoutReference: workout.id))
    restUntil = nil
  }
  func receive(_ command: OfflineCommand) {
    do {
      guard command.accountKey == accountKey else { throw APIError("ACCOUNT_MISMATCH") }
      if let receipt = journal.receipts.first(where: { $0.id == command.id }) {
        companion?.sendReceipt(receipt, accountKey: accountKey)
        return
      }
      if journal.commands.contains(where: { $0.id == command.id }) {
        sendCompanion()
        return
      }
      let previousWorkout = workout
      if command.kind == .startWorkout, workout == nil,
        let plan = plans.first(where: { $0.id == command.planId })
      {
        workout = .init(
          id: command.workoutReference, kind: "workout", version: 0,
          data: .init(name: plan.data.name, plan: plan, source: "watch"))
      }
      do { try enqueue(command) } catch {
        workout = previousWorkout
        throw error
      }
    } catch { errorMessage = copy.error(error) }
  }
  private func enqueue(_ command: OfflineCommand) throws {
    guard isConnected else { throw APIError("AUTHENTICATION_REQUIRED", status: 401) }
    let previous = journal
    do {
      try journal.enqueue(command, accountKey: accountKey)
      try persistJournal()
    } catch {
      journal = previous
      throw error
    }
    try persistCache()
    sendCompanion()
    Task { await drain() }
  }
  func retryPending() async {
    for index in journal.commands.indices {
      if journal.commands[index].failureCode == "VERSION_CONFLICT" {
        journal.commands[index].prepared = nil
        journal.commands[index].retry += 1
      }
      journal.commands[index].failureCode = nil
    }
    try? persistJournal()
    await drain()
  }
  private func acknowledge(_ command: OfflineCommand, workoutId: String) throws {
    let previous = journal
    journal.acknowledge(command, workoutId: workoutId)
    do { try persistJournal() } catch {
      journal = previous
      throw error
    }
    if command.source == "watch" {
      companion?.sendReceipt(.init(id: command.id, workoutId: workoutId), accountKey: accountKey)
    }
  }
  func drain() async {
    guard isConnected, !isDraining, isOnline, !isPreview, let client else { return }
    isDraining = true
    defer { isDraining = false }
    while let first = journal.commands.first {
      guard first.accountKey == accountKey,
        first.failureCode == nil || first.failureCode == "NETWORK_UNAVAILABLE"
      else { return }
      do {
        var command = first
        if command.prepared == nil {
          var fields: [String: JSONValue] = ["operationId": .string(command.operationId)]
          let path: String
          if command.kind == .startWorkout {
            path = "/api/v1/workouts"
            fields["planId"] = command.planId.map(JSONValue.string)
            fields["planVersion"] = command.planVersion.map { .number(Double($0)) }
            fields["startedAt"] = .string(command.createdAt)
            fields["source"] = .string(command.source)
          } else {
            let remoteId = journal.workoutIds[command.workoutReference] ?? command.workoutReference
            let current = try await client.request(
              Record<Workout>.self, path: "/api/v1/workouts/\(remoteId.pathSegment)")
            if (command.kind == .finishWorkout && current.data.state == "completed")
              || (command.kind == .cancelWorkout && current.data.state == "cancelled")
            {
              try acknowledge(command, workoutId: current.id)
              continue
            }
            fields["expectedVersion"] = .number(Double(current.version))
            switch command.kind {
            case .logSet:
              path = "/api/v1/workouts/\(remoteId.pathSegment)/sets"
              fields["exerciseId"] = command.exerciseId.map(JSONValue.string)
              fields["set"] = try JSONValue.from(command.metrics!)
              fields["completedAt"] = .string(command.createdAt)
            case .finishWorkout, .cancelWorkout:
              path =
                "/api/v1/workouts/\(remoteId.pathSegment)/\(command.kind == .finishWorkout ? "finish" : "cancel")"
              fields["finishedAt"] = .string(command.createdAt)
            case .startWorkout: throw APIError("INVALID_COMMAND")
            }
          }
          command.prepared = .init(method: "POST", path: path, body: .object(fields))
          journal.commands[0] = command
          try persistJournal()
        }
        let request = command.prepared!
        let result = try await client.request(
          Record<Workout>.self, method: request.method, path: request.path, body: request.body)
        try acknowledge(command, workoutId: result.id)
        workout = result.data.state == "active" ? result : nil
        if let index = workouts.firstIndex(where: { $0.id == result.id }) {
          workouts[index] = result
        } else {
          workouts.insert(result, at: 0)
        }
        try persistCache()
        sendCompanion()
      } catch {
        guard journal.commands.first?.id == first.id else {
          errorMessage = copy.error(error)
          return
        }
        if let e = error as? APIError, e.code == "VERSION_CONFLICT", first.retry < 3 {
          journal.commands[0].prepared = nil
          journal.commands[0].retry += 1
          try? persistJournal()
          continue
        }
        journal.commands[0].failureCode = (error as? APIError)?.code ?? "NETWORK_UNAVAILABLE"
        try? persistJournal()
        sendCompanion()
        return
      }
    }
  }
  func reviseSet(workout: Record<Workout>, set: ActualSet, metrics: SetMetrics) async throws {
    _ = try await api().mutation(
      Record<Workout>.self, method: "PUT",
      path: "/api/v1/workouts/\(workout.id.pathSegment)/sets/\(set.id.pathSegment)",
      fields: ["expectedVersion": .number(Double(workout.version)), "set": try .from(metrics)])
    await refresh()
  }
  func saveExercise(_ value: Exercise) async throws -> Record<Exercise> {
    let result = try await api().mutation(
      Record<Exercise>.self, path: "/api/v1/exercises", fields: ["data": try .from(value)])
    cacheExercise(result)
    exerciseCatalogRevision += 1
    return result
  }
  func savePlan(_ value: TrainingPlan) async throws {
    if isPreview {
      plans.append(.init(id: UUID().uuidString, kind: "plan", data: value))
      return
    }
    _ = try await api().mutation(
      Record<TrainingPlan>.self, path: "/api/v1/training-plans", fields: ["data": try .from(value)])
    for entry in value.exercises where exerciseDetails[entry.exerciseId]?.isCatalogOnly == true {
      exerciseDetails[entry.exerciseId] = nil
    }
    exerciseCatalogRevision += 1
    await refresh()
  }
  func saveRecipe(_ value: Recipe, existing: Record<Recipe>? = nil) async throws -> Record<Recipe> {
    var fields: [String: JSONValue] = ["data": try .from(value)]
    if let existing {
      fields["id"] = .string(existing.id)
      fields["expectedVersion"] = .number(Double(existing.version))
    }
    let result = try await api().mutation(
      Record<Recipe>.self, path: "/api/v1/recipes", fields: fields)
    await refresh()
    return result
  }
  func logRecipe(
    _ value: Record<Recipe>, servings: Double, overrides: [String: Double] = [:],
    additions: [Ingredient] = [], notes: String = "", occurredAt: Date
  ) async throws {
    if isPreview { return }
    let changes = overrides.sorted { $0.key < $1.key }.map {
      JSONValue.object(["ingredientId": .string($0.key), "quantity": .number($0.value)])
    }
    _ = try await api().mutation(
      Record<Meal>.self, path: "/api/v1/meals/from-recipe",
      fields: [
        "recipeId": .string(value.id), "recipeVersion": .number(Double(value.version)),
        "servings": .number(servings), "overrides": .array(changes),
        "additions": try .from(additions), "occurredAt": .string(occurredAt.iso8601),
        "notes": .string(notes),
      ])
    await refresh()
  }
  func logIngredients(_ value: [Ingredient], notes: String, occurredAt: Date) async throws {
    _ = try await api().mutation(
      Record<Meal>.self, path: "/api/v1/meals",
      fields: [
        "ingredients": try .from(value), "occurredAt": .string(occurredAt.iso8601),
        "notes": .string(notes),
      ])
    await refresh()
  }
  func reviseMeal(
    _ value: Record<Meal>, quantities: [String: Double], notes: String, occurredAt: Date
  ) async throws {
    let changes = quantities.sorted { $0.key < $1.key }.map {
      JSONValue.object(["ingredientId": .string($0.key), "quantity": .number($0.value)])
    }
    _ = try await api().mutation(
      Record<Meal>.self, method: "PUT", path: "/api/v1/meals/\(value.id.pathSegment)",
      fields: [
        "expectedVersion": .number(Double(value.version)), "overrides": .array(changes),
        "notes": .string(notes), "occurredAt": .string(occurredAt.iso8601),
      ])
    await refresh()
  }
  func deleteMeal(_ value: Record<Meal>) async throws {
    _ = try await api().mutation(
      Record<Meal>.self, method: "DELETE", path: "/api/v1/meals/\(value.id.pathSegment)",
      fields: ["expectedVersion": .number(Double(value.version))])
    await refresh()
  }
  func searchFoods(_ query: String) async throws -> FoodSearchResults {
    let digits = query.filter(\.isNumber)
    if digits.count == query.count, [8, 12, 13, 14].contains(digits.count) {
      struct Lookup: Decodable, Sendable {
        var food: Food?
        var localFood: Record<Food>?
        var stale: Bool?
      }
      let lookup = try await api().request(
        Lookup.self, path: "/api/v1/food-catalog/\(digits.pathSegment)")
      if let saved = lookup.localFood {
        return .init(
          hits: [.init(id: saved.id, food: saved.data, savedId: saved.id)], catalogDegraded: false)
      }
      if let food = lookup.food {
        return .init(
          hits: [.init(id: food.barcode ?? digits, food: food, savedId: nil)],
          catalogDegraded: lookup.stale == true)
      }
      return .init(hits: [], catalogDegraded: lookup.stale == true)
    }
    struct Page: Decodable, Sendable {
      struct Catalog: Decodable, Sendable {
        var items: [Food]
        var catalogStatus: String?
      }
      var items: [Record<Food>]
      var catalog: Catalog?
    }
    let encoded = query.queryValue
    let page = try await api().request(
      Page.self, path: "/api/v1/foods?query=\(encoded)&includeCatalog=true&limit=30")
    var hits = page.items.map { FoodSearchHit(id: $0.id, food: $0.data, savedId: $0.id) }
    for food in page.catalog?.items ?? [] {
      hits.append(
        .init(id: "catalog-" + (food.barcode ?? food.name), food: food, savedId: nil))
    }
    return .init(hits: hits, catalogDegraded: page.catalog?.catalogStatus == "degraded")
  }
  func importFood(barcode: String) async throws -> Record<Food> {
    struct Imported: Decodable, Sendable {
      var food: Record<Food>
      var created: Bool
    }
    return try await api().mutation(
      Imported.self, path: "/api/v1/foods/import", fields: ["barcode": .string(barcode)]
    ).food
  }
  func uploadCover(_ data: Data, recipe: Record<Recipe>) async throws {
    struct Ticket: Decodable, Sendable {
      struct Asset: Decodable, Sendable { var id: String }
      var asset: Asset
      var uploadUrl: URL
    }
    let api = try api()
    let ticket = try await api.mutation(
      Ticket.self, path: "/api/v1/media/uploads",
      fields: [
        "contentType": .string("image/jpeg"), "processing": .string("Prepared in OpenFitness iOS"),
      ])
    try await api.upload(data, to: ticket.uploadUrl, contentType: "image/jpeg")
    _ = try await api.mutation(
      Record<Recipe>.self, method: "PUT", path: "/api/v1/recipes/\(recipe.id.pathSegment)/cover",
      fields: [
        "assetId": .string(ticket.asset.id), "expectedVersion": .number(Double(recipe.version)),
      ])
    await refresh()
  }
  func enableHealth() async throws {
    guard context?.capabilities.healthSyncProtocol != nil else {
      throw APIError("SERVER_UPDATE_REQUIRED", message: text(.updateServer))
    }
    try await health.authorizeNutrition()
    let api = try api()
    var credential = try await api.credentials()
    if credential?.scope.split(separator: " ").contains("health:sync") != true {
      try await authentication.signIn(client: api)
      try await loadAccount()
      credential = try await api.credentials()
    }
    if credential?.device == nil {
      let device = try await api.mutation(
        HealthDeviceCredential.self, path: "/api/v1/health/devices",
        fields: ["name": .string(UIDevice.current.name)])
      try await api.saveDevice(device)
      credential = try await api.credentials()
    }
    healthEnabled = true
    UserDefaults.standard.set(true, forKey: "nutritionSyncEnabled.\(accountKey)")
    await synchronizeHealth()
  }
  func disableHealth() {
    healthEnabled = false
    UserDefaults.standard.set(false, forKey: "nutritionSyncEnabled.\(accountKey)")
  }
  func selectWriter() async throws {
    guard let device = try await api().credentials()?.device else { return }
    _ = try await api().mutation(
      JSONValue.self, method: "PUT", path: "/api/v1/health/writer",
      fields: ["deviceId": .string(device.deviceId), "deviceSecret": .string(device.deviceSecret)])
    await synchronizeHealth()
  }
  func synchronizeHealth() async {
    guard healthEnabled, !isPreview, let api = client,
      let device = try? await api.credentials()?.device
    else { return }
    do {
      try await health.synchronize(client: api, credential: device, accountKey: accountKey)
      if sharesHealth { try await shareHealthSummary() }
      healthStatus = try await api.request(HealthSyncStatus.self, path: "/api/v1/health/status")
    } catch {
      if let e = error as? APIError, e.code == "HEALTH_WRITER_CONFLICT" {
        healthStatus = try? await api.request(HealthSyncStatus.self, path: "/api/v1/health/status")
      } else {
        errorMessage = error is APIError ? copy.error(error) : text(.healthDenied)
      }
    }
  }
  func enableSharing(_ enabled: Bool) async throws {
    if enabled {
      try await health.authorizeSummary()
      try await shareHealthSummary()
    }
    sharesHealth = enabled
    UserDefaults.standard.set(enabled, forKey: "sharesHealthSummary.\(accountKey)")
  }
  private func shareHealthSummary() async throws {
    guard let device = try await api().credentials()?.device else {
      throw APIError("HEALTH_DEVICE_REQUIRED", message: text(.enableHealth))
    }
    let summary = try await health.summary(timeZone: timeZone)
    _ = try await api().mutation(
      JSONValue.self, method: "PUT", path: "/api/v1/health/snapshot",
      fields: [
        "deviceId": .string(device.deviceId), "deviceSecret": .string(device.deviceSecret),
        "snapshot": try .from(summary),
      ])
    healthSummary = summary
  }
  func disconnect() async {
    await client?.disconnect()
    client = nil
    healthEnabled = false
    sharesHealth = false
    healthStatus = nil
    healthSummary = nil
    journal = .init()
    isConnected = false
    exerciseDetails = [:]
    taxonomyCache = [:]
    context = nil
    plans = []
    recipes = []
    meals = []
    workouts = []
    workout = nil
    nutrition = nil
    companion?.send(.init(accountKey: "", connected: false, language: language.rawValue))
  }
  private func persistJournal() throws {
    guard let queueURL else { throw APIError("LOCAL_STORAGE_UNAVAILABLE") }
    try DiskStore.write(journal, to: queueURL)
  }
  private func persistCache() throws {
    if let cacheURL { try DiskStore.write(snapshot(), to: cacheURL) }
  }
  private func snapshot() -> CompanionSnapshot {
    .init(
      accountKey: accountKey, connected: isConnected, language: language.rawValue,
      timeZone: timeZone, plans: plans, recipes: recipes, workout: workout, nutrition: nutrition,
      receipts: journal.receipts)
  }
  func sendCompanion() { companion?.send(snapshot()) }
  #if DEBUG
    private func loadPreview() {
      isPreview = true
      isConnected = true
      language =
        ProcessInfo.processInfo.arguments.contains("-ui-testing-zh")
        ? .simplifiedChinese : .english
      context = try? JSONDecoder().decode(
        AgentContext.self,
        from: Data(
          #"{"ownerId":"preview","actorId":"preview","locale":"en","timeZone":"Asia/Shanghai","capabilities":{"exerciseCatalog":"shared_catalog"}}"#
            .utf8))
      let exercise = Exercise(
        name: "Back squat",
        instructions:
          "Brace your trunk and keep the whole foot planted. Move through a comfortable range, then stand tall."
      )
      let plan = Record(
        id: "preview-plan", kind: "plan",
        data: TrainingPlan(
          name: "Lower body · A",
          exercises: [
            .init(
              exerciseId: "preview-squat", exercise: exercise,
              sets: Array(repeating: .init(reps: 8, weightKg: 60), count: 3)),
            .init(
              exerciseId: "preview-hinge", exercise: .init(name: "Romanian deadlift"),
              sets: Array(repeating: .init(reps: 10, weightKg: 40), count: 3)),
          ]))
      plans = [plan]
      workout = .init(
        id: "preview-workout", kind: "workout", data: .init(name: plan.data.name, plan: plan))
      var recipe = Recipe(
        name: "Chicken & rice",
        ingredients: [
          .init(quantity: 200, food: .init(name: "Cooked rice", nutrients: .init(energyKcal: 130)))
        ])
      recipe.perServing = .init(energyKcal: 540, proteinG: 40, carbohydrateG: 56, fatG: 15)
      recipes = [.init(id: "preview-recipe", kind: "recipe", data: recipe)]
      nutrition = .init(
        day: Date().calendarDay(timeZone: timeZone), timeZone: timeZone, mealCount: 2,
        nutrients: .init(energyKcal: 1240, proteinG: 82, carbohydrateG: 135, fatG: 42, fiberG: 16))
    }
  #endif
}
