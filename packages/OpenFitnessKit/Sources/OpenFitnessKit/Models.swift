import Foundation

public struct Record<Value: Codable & Sendable>: Codable, Sendable, Identifiable {
  public var id: String
  public var kind: String
  public var version: Int
  public var data: Value
  public var createdAt: String
  public var updatedAt: String
  public var deleted: Bool?
  public init(
    id: String, kind: String, version: Int = 1, data: Value, createdAt: String = Date().iso8601,
    updatedAt: String = Date().iso8601
  ) {
    self.id = id
    self.kind = kind
    self.version = version
    self.data = data
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}
public struct RecordPage<Value: Codable & Sendable>: Codable, Sendable {
  public var items: [Record<Value>]
  public var cursor: String?
  public init(items: [Record<Value>], cursor: String? = nil) {
    self.items = items
    self.cursor = cursor
  }
}
public struct Nutrients: Codable, Sendable, Equatable {
  public var energyKcal: Double?
  public var proteinG: Double?
  public var carbohydrateG: Double?
  public var fatG: Double?
  public var fiberG: Double?
  public init(
    energyKcal: Double? = nil, proteinG: Double? = nil, carbohydrateG: Double? = nil,
    fatG: Double? = nil, fiberG: Double? = nil
  ) {
    self.energyKcal = energyKcal
    self.proteinG = proteinG
    self.carbohydrateG = carbohydrateG
    self.fatG = fatG
    self.fiberG = fiberG
  }
  public subscript(_ key: NutrientKey) -> Double? {
    switch key {
    case .energyKcal: energyKcal
    case .proteinG: proteinG
    case .carbohydrateG: carbohydrateG
    case .fatG: fatG
    case .fiberG: fiberG
    }
  }
  public func scaled(by factor: Double) -> Nutrients {
    func scale(_ value: Double?) -> Double? { factor == 0 ? 0 : value.map { $0 * factor } }
    return .init(
      energyKcal: scale(energyKcal), proteinG: scale(proteinG), carbohydrateG: scale(carbohydrateG),
      fatG: scale(fatG), fiberG: scale(fiberG))
  }
}
public enum NutrientKey: String, Codable, Sendable, CaseIterable {
  case energyKcal, proteinG, carbohydrateG, fatG, fiberG
}
public struct FoodBasis: Codable, Sendable {
  public var quantity: Double
  public var unit: String
  public init(quantity: Double = 100, unit: String = "g") {
    self.quantity = quantity
    self.unit = unit
  }
}
public struct FoodSource: Codable, Sendable {
  public var kind: String
  public var reference: String?
  public var basis: String?
  public var retrievedAt: String?
  public var upstreamModifiedAt: String?
  public init(
    kind: String = "user", reference: String? = nil, basis: String? = nil,
    retrievedAt: String? = nil, upstreamModifiedAt: String? = nil
  ) {
    self.kind = kind
    self.reference = reference
    self.basis = basis
    self.retrievedAt = retrievedAt
    self.upstreamModifiedAt = upstreamModifiedAt
  }
}
public struct Food: Codable, Sendable {
  public var name: String
  public var aliases: [String]?
  public var barcode: String?
  public var nutrients: Nutrients
  public var basis: FoodBasis
  public var servingSize: FoodBasis?
  public var densityGPerMl: Double?
  public var preparation: String?
  public var source: FoodSource
  public var notes: String?
  public init(
    name: String, nutrients: Nutrients, basis: FoodBasis = .init(), source: FoodSource = .init(),
    barcode: String? = nil
  ) {
    self.name = name
    self.barcode = barcode
    self.nutrients = nutrients
    self.basis = basis
    self.source = source
  }
}
public struct Ingredient: Codable, Sendable, Identifiable {
  public var id: String
  public var foodId: String?
  public var label: String?
  public var quantity: Double
  public var unit: String
  public var food: Food
  public var nutrients: Nutrients?
  public init(id: String = UUID().uuidString, quantity: Double, unit: String = "g", food: Food) {
    self.id = id
    self.quantity = quantity
    self.unit = unit
    self.food = food
    self.label = food.name
  }
}
public struct RecipeYield: Codable, Sendable {
  public var servings: Double
  public var cookedWeightGrams: Double?
  public init(servings: Double = 1, cookedWeightGrams: Double? = nil) {
    self.servings = servings
    self.cookedWeightGrams = cookedWeightGrams
  }
}
public struct Recipe: Codable, Sendable {
  public var name: String
  public var aliases: [String]?
  public var restaurant: String?
  public var specification: String?
  public var ingredients: [Ingredient]
  public var `yield`: RecipeYield
  public var defaultServings: Double
  public var nutritionVersion: Int?
  public var nutrients: Nutrients?
  public var perServing: Nutrients?
  public var per100g: Nutrients?
  public var coverAssetId: String?
  public var coverThumbnailAssetId: String?
  public var notes: String?
  public init(name: String, ingredients: [Ingredient], servings: Double = 1) {
    self.name = name
    self.ingredients = ingredients
    self.yield = .init(servings: servings)
    self.defaultServings = 1
  }
}
public struct Exercise: Codable, Sendable {
  public var name: String
  public var aliases: [String]?
  public var category: String?
  public var instructions: String?
  public var muscleGroups: [String]?
  public var equipment: [String]?
  public var mediaAssetIds: [String]?
  public var notes: String?
  public var description: String?
  public var bodyPart: String?
  public var primaryMuscles: [String]?
  public var secondaryMuscles: [String]?
  public var movementCategory: String?
  public var muscleMap: MuscleMapRegions?
  public var diagram: ExerciseDiagram?
  public var source: ExerciseSource?
  public var i18n: [String: ExerciseTranslation]?
  public var externalIds: [String: String]?
  public var needsRewrite: Bool?
  public var variantOf: String?
  public init(name: String, category: String = "strength", instructions: String = "") {
    self.name = name
    self.category = category
    self.instructions = instructions
  }
}
public struct ExerciseTranslation: Codable, Sendable {
  public var name: String?
  public var aliases: [String]?
  public var description: String?
  public var instructions: String?
  public var provenance: ExerciseProvenance?
}
public struct ExerciseProvenance: Codable, Sendable {
  public var method: String
  public var reviewed: Bool
  public var tool: String?
}
public struct ExerciseSource: Codable, Sendable {
  public var kind: String
  public var origin: String?
  public var catalogId: String?
  public var catalogVersion: Int?
  public var license: String?
  public var attribution: String?
  public var needsRewrite: Bool?
}
public struct DiagramHighlight: Codable, Sendable, Hashable {
  public var region: String
  public var role: String
  public var weight: Double?
  public var groups: [String]
  public var surfaces: [String]
  public var matched: Bool
}
public struct ExerciseDiagram: Codable, Sendable {
  public struct Href: Codable, Sendable {
    public var gender: String
    public var view: String
    public var href: String
  }
  public var gender: String
  public var views: [String]
  public var regions: [String]?
  public var hrefs: [Href]?
  public var highlights: [DiagramHighlight]?
}
public struct MuscleMapRegions: Codable, Sendable {
  public var primaries: [String]?
  public var secondaries: [String]?
  public var weights: [String: Double]?
  public var bodyPart: String?
}
public struct ExerciseTaxonomy: Codable, Sendable {
  public struct Label: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
  }
  public var bodyParts: [Label]
  public var equipment: [Label]
  public var muscles: [Label]
  public var movementCategories: [Label]
  public var diagrams: Diagrams
  public var attribution: String?
  public var diagramNote: String?
  public struct Diagrams: Codable, Sendable {
    public var artwork: String
    public var viewBox: String
    public var packageVersion: String
    public var license: String
    public var assets: [String: [String: String]]
  }
}
public struct AdoptExerciseResult: Codable, Sendable {
  public var exercise: Record<Exercise>
  public var created: Bool
}
extension Exercise {
  public func localized(_ language: AppLanguage) -> Exercise {
    guard language == .simplifiedChinese, let translation = i18n?["zh-CN"],
      let name = translation.name, !name.isEmpty
    else { return self }
    var copy = self
    var aliases = copy.aliases ?? []
    if copy.name != name { aliases.append(copy.name) }
    aliases += translation.aliases ?? []
    var seen = Set<String>()
    copy.aliases = aliases.filter { $0 != name && seen.insert($0).inserted }
    copy.name = name
    if let description = translation.description, !description.isEmpty {
      copy.description = description
    }
    if let instructions = translation.instructions, !instructions.isEmpty {
      copy.instructions = instructions
    }
    return copy
  }
}
extension Record where Value == Exercise {
  public var isCatalogOnly: Bool { version == 0 && id.hasPrefix("cat-") }
}
public struct SetMetrics: Codable, Sendable {
  public var reps: Int?
  public var weightKg: Double?
  public var durationSeconds: Double?
  public var distanceMeters: Double?
  public var rpe: Double?
  public var rir: Double?
  public var type: String
  public var groupId: String?
  public var notes: String
  public init(
    reps: Int? = nil, weightKg: Double? = nil, durationSeconds: Double? = nil,
    distanceMeters: Double? = nil, rpe: Double? = nil, rir: Double? = nil, type: String = "working",
    notes: String = ""
  ) {
    self.reps = reps
    self.weightKg = weightKg
    self.durationSeconds = durationSeconds
    self.distanceMeters = distanceMeters
    self.rpe = rpe
    self.rir = rir
    self.type = type
    self.notes = notes
  }
}
public struct PlannedExercise: Codable, Sendable, Identifiable {
  public var exerciseId: String
  public var exerciseSnapshot: Exercise
  public var sets: [SetMetrics]
  public var restSeconds: Double
  public var groupId: String?
  public var notes: String?
  public var id: String { exerciseId }
  public init(exerciseId: String, exercise: Exercise, sets: [SetMetrics], restSeconds: Double = 90)
  {
    self.exerciseId = exerciseId
    self.exerciseSnapshot = exercise
    self.sets = sets
    self.restSeconds = restSeconds
  }
}
public struct TrainingPlan: Codable, Sendable {
  public var name: String
  public var notes: String?
  public var exercises: [PlannedExercise]
  public init(name: String, exercises: [PlannedExercise]) {
    self.name = name
    self.exercises = exercises
  }
}
public struct ActualSet: Codable, Sendable, Identifiable {
  public var id: String
  public var exerciseId: String
  public var exerciseSnapshot: Exercise
  public var completedAt: String
  public var reps: Int?
  public var weightKg: Double?
  public var durationSeconds: Double?
  public var distanceMeters: Double?
  public var rpe: Double?
  public var rir: Double?
  public var type: String
  public var groupId: String?
  public var notes: String?
  public var metrics: SetMetrics {
    var value = SetMetrics(
      reps: reps, weightKg: weightKg, durationSeconds: durationSeconds,
      distanceMeters: distanceMeters, rpe: rpe, rir: rir, type: type, notes: notes ?? "")
    value.groupId = groupId
    return value
  }
  public init(
    id: String = UUID().uuidString, exerciseId: String, exercise: Exercise, metrics: SetMetrics,
    completedAt: String = Date().iso8601
  ) {
    self.id = id
    self.exerciseId = exerciseId
    self.exerciseSnapshot = exercise
    self.completedAt = completedAt
    reps = metrics.reps
    weightKg = metrics.weightKg
    durationSeconds = metrics.durationSeconds
    distanceMeters = metrics.distanceMeters
    rpe = metrics.rpe
    rir = metrics.rir
    type = metrics.type
    groupId = metrics.groupId
    notes = metrics.notes
  }
}
public struct PlanSnapshot: Codable, Sendable {
  public var id: String
  public var version: Int
  public var snapshot: TrainingPlan
}
public struct Workout: Codable, Sendable {
  public var name: String
  public var state: String
  public var startedAt: String
  public var finishedAt: String?
  public var notes: String
  public var source: String?
  public var plan: PlanSnapshot?
  public var sets: [ActualSet]
  public init(name: String, plan: Record<TrainingPlan>? = nil, source: String = "ios") {
    self.name = name
    self.state = "active"
    self.startedAt = Date().iso8601
    self.notes = ""
    self.source = source
    self.sets = []
    self.plan = plan.map { .init(id: $0.id, version: $0.version, snapshot: $0.data) }
  }
}
public struct MealRecipe: Codable, Sendable {
  public var id: String
  public var version: Int
  public var servings: Double
  public var snapshot: Recipe
  public init(id: String, version: Int, servings: Double, snapshot: Recipe) {
    self.id = id
    self.version = version
    self.servings = servings
    self.snapshot = snapshot
  }
}
public struct Meal: Codable, Sendable {
  public var occurredAt: String
  public var notes: String
  public var ingredients: [Ingredient]
  public var nutrients: Nutrients
  public var recipe: MealRecipe?
  public var imageAssetId: String?
  public init(
    occurredAt: String, notes: String = "", ingredients: [Ingredient], nutrients: Nutrients,
    recipe: MealRecipe? = nil, imageAssetId: String? = nil
  ) {
    self.occurredAt = occurredAt
    self.notes = notes
    self.ingredients = ingredients
    self.nutrients = nutrients
    self.recipe = recipe
    self.imageAssetId = imageAssetId
  }
}
public struct DailyNutrition: Codable, Sendable {
  public var day: String
  public var timeZone: String
  public var mealCount: Int
  public var nutrients: Nutrients
  public init(day: String, timeZone: String, mealCount: Int = 0, nutrients: Nutrients = .init()) {
    self.day = day
    self.timeZone = timeZone
    self.mealCount = mealCount
    self.nutrients = nutrients
  }
}
public struct AgentContext: Codable, Sendable {
  public var ownerId: String
  public var actorId: String
  public var locale: String
  public var timeZone: String
  public var capabilities: Capabilities
  public struct Capabilities: Codable, Sendable {
    public var healthSyncProtocol: Int?
    public var exerciseCatalog: String?
    public var syncFeed: Int?
  }
}
public struct HealthDeviceCredential: Codable, Sendable {
  public var deviceId: String
  public var deviceSecret: String
}
public struct HealthSyncStatus: Codable, Sendable {
  public var protocolVersion: Int
  public var writerDeviceId: String?
  public var pendingCount: Int
  public var failedCount: Int
  public var lastDeliveredAt: String?
  public var activeLeaseUntil: Double?
}
public struct HealthExportPayload: Codable, Sendable {
  public var syncIdentifier: String
  public var syncVersion: Int
  public var occurredAt: String
  public var nutrients: Nutrients
}
public struct HealthExportEvent: Codable, Sendable, Identifiable {
  public var id: String
  public var mealId: String
  public var version: Int
  public var action: String
  public var payload: HealthExportPayload
  public init(
    id: String, mealId: String, version: Int, action: String, payload: HealthExportPayload
  ) {
    self.id = id
    self.mealId = mealId
    self.version = version
    self.action = action
    self.payload = payload
  }
}
public struct HealthExportLease: Codable, Sendable {
  public var leaseToken: String
  public var expiresAt: String
  public var items: [HealthExportEvent]
}
public struct HealthSnapshot: Codable, Sendable {
  public var measuredAt: String
  public var day: String
  public var timeZone: String
  public var steps: Double?
  public var activeEnergyKcal: Double?
  public var exerciseMinutes: Double?
  public var bodyMassKg: Double?
  public var bodyMassMeasuredAt: String?
  public var restingHeartRateBpm: Double?
  public init(day: String, timeZone: String) {
    measuredAt = Date().iso8601
    self.day = day
    self.timeZone = timeZone
  }
}
extension Date {
  public var iso8601: String { ISO8601DateFormatter().string(from: self) }
  /// UTC timestamp with milliseconds, matching `Date.prototype.toISOString`.
  public var iso8601Milliseconds: String {
    let millis = Int64((timeIntervalSince1970 * 1000).rounded(.toNearestOrAwayFromZero))
    let seconds = millis / 1000
    let fraction = Int(millis % 1000)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    let base = formatter.string(from: Date(timeIntervalSince1970: Double(seconds)))
    guard base.hasSuffix("Z") else { return base }
    return String(base.dropLast()) + String(format: ".%03dZ", fraction)
  }
  public static func parseISO(_ value: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
  public func calendarDay(timeZone: String) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: timeZone)
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: self)
  }
}
