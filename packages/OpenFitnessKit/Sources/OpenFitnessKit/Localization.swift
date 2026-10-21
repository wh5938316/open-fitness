import Foundation

public enum CopyKey: String, CaseIterable, Sendable {
  case connect
  case connectHelp
  case serverAddress
  case connectWithPasskey
  case connectionHelp
  case today
  case train
  case food
  case health
  case settings
  case trainingPlans
  case workoutHistory
  case recipes
  case meals
  case search
  case loading
  case retry
  case done
  case cancel
  case save
  case delete
  case edit
  case refresh
  case error
  case networkError
  case authRequired
  case recordChanged
  case noPlans
  case noPlansHelp
  case noMeals
  case noMealsHelp
  case noRecipes
  case noRecipesHelp
  case noHistory
  case startWorkout
  case resumeWorkout
  case finishWorkout
  case cancelWorkout
  case logSet
  case sets
  case reps
  case load
  case duration
  case distance
  case rest
  case restTimer
  case skipRest
  case effort
  case rpe
  case rir
  case notes
  case instructions
  case planned
  case performed
  case warmup
  case working
  case drop
  case restPause = "rest_pause"
  case failure
  case group
  case active
  case completed
  case cancelled
  case calories
  case protein
  case carbs
  case fat
  case fiber
  case nutrition
  case unknown
  case servings
  case grams
  case quantity
  case ingredients
  case ingredient
  case addIngredient
  case logMeal
  case logFromRecipe
  case mealSaved
  case newRecipe
  case recipeName
  case restaurant
  case yieldServings
  case cookedWeight
  case standardPortion
  case oneMealOnly
  case source
  case estimate
  case newFood
  case foodName
  case per100
  case barcode
  case lookup
  case noResults
  case cover
  case choosePhoto
  case history
  case quickMeal
  case dailyOverview
  case nextSession
  case pending
  case pendingChanges
  case synced
  case syncing
  case syncNow
  case appleHealth
  case healthHelp
  case enableHealth
  case healthPermission
  case healthDisabled
  case healthReady
  case updateServer
  case useThisPhone
  case otherWriter
  case shareHealth
  case shareHealthHelp
  case healthMetrics
  case steps
  case bodyMass
  case activeEnergy
  case exerciseMinutes
  case restingHeartRate
  case heartRate
  case lastSync
  case neverSynced
  case language
  case english
  case simplifiedChinese
  case timeZone
  case disconnect
  case disconnectHelp
  case connectedServer
  case watch
  case watchHelp
  case watchOffline
  case waitingPhone
  case pairPhone
  case requestSync
  case watchWorkout
  case endSession
  case pause
  case continueSession
  case healthDenied
  case newPlan
  case planName
  case exercises
  case addExercise
  case exerciseName
  case strength
  case timed
  case cardio
  case movementType
  case deleteConfirmation
  case finishConfirmation
  case queuedNotice
  case workoutSummary
  case elapsed
  case min
  case sec
  case kg
  case m
  case kcal
  case bpm
  case about
  case privacy
  case preview
  case foodProvider
  case catalogDegraded
  case noActiveWorkout
  case nutritionVersion
  case additions
  case mealNotes
  case serverUnavailable
  case permissionNeeded
  case pendingReview
  case saveSet
  case clearError
  case mealTime
  case calculationUnavailable
  case disableHealth
}
public enum AppLanguage: String, Codable, CaseIterable, Sendable {
  case english = "en"
  case simplifiedChinese = "zh-CN"
  public var locale: Locale { Locale(identifier: rawValue) }
}
public struct Localizer: Sendable {
  public var language: AppLanguage
  public init(_ language: AppLanguage = .english) { self.language = language }
  private var bundle: Bundle {
    let code = language == .simplifiedChinese ? "zh-hans" : "en"
    let actual = Bundle.module.localizations.first { $0.lowercased() == code } ?? code
    return Bundle(url: Bundle.module.bundleURL.appendingPathComponent(actual + ".lproj"))
      ?? Bundle.module
  }
  public func hasTranslation(_ key: CopyKey) -> Bool {
    bundle.localizedString(forKey: key.rawValue, value: "__missing__", table: nil) != "__missing__"
  }
  public func text(_ key: CopyKey) -> String {
    let translated = bundle.localizedString(forKey: key.rawValue, value: "__missing__", table: nil)
    if translated != "__missing__" { return translated }
    let english =
      Bundle(url: Bundle.module.bundleURL.appendingPathComponent("en.lproj")) ?? Bundle.module
    return english.localizedString(forKey: key.rawValue, value: key.rawValue, table: nil)
  }
  public func number(_ value: Double?, digits: Int = 0) -> String {
    guard let value else { return "—" }
    return value.formatted(.number.locale(language.locale).precision(.fractionLength(0...digits)))
  }
  public func error(_ error: Error) -> String {
    guard let e = error as? APIError else { return text(.networkError) }
    if e.code.hasPrefix("HEALTH_WRITER_") { return text(.otherWriter) }
    if e.code.hasPrefix("HEALTHKIT_") { return text(.healthDenied) }
    if e.code == "SERVER_UPDATE_REQUIRED" { return text(.updateServer) }
    if e.code == "ACCOUNT_MISMATCH" { return text(.authRequired) }
    if e.status == 401 { return text(.authRequired) }
    if e.status == 409 { return text(.recordChanged) }
    return e.message == "The request could not be completed." ? text(.networkError) : e.message
  }
}
