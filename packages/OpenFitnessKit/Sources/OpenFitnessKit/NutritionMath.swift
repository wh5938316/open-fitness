import Foundation

public enum NutritionMath {
  public static func round8(_ value: Double) -> Double {
    (value * 1e8).rounded(.toNearestOrAwayFromZero) / 1e8
  }

  public static func scaleNutrients(_ nutrients: Nutrients, factor: Double) -> Nutrients {
    func scale(_ value: Double?) -> Double? {
      if factor == 0 { return 0 }
      guard let value else { return nil }
      return round8(value * factor)
    }
    return Nutrients(
      energyKcal: scale(nutrients.energyKcal), proteinG: scale(nutrients.proteinG),
      carbohydrateG: scale(nutrients.carbohydrateG), fatG: scale(nutrients.fatG),
      fiberG: scale(nutrients.fiberG))
  }

  public static func sumNutrients(_ items: [Nutrients]) -> Nutrients {
    func sum(_ values: [Double?]) -> Double? {
      if items.isEmpty { return 0 }
      if values.contains(where: { $0 == nil }) { return nil }
      return round8(values.reduce(0) { $0 + ($1 ?? 0) })
    }
    return Nutrients(
      energyKcal: sum(items.map(\.energyKcal)), proteinG: sum(items.map(\.proteinG)),
      carbohydrateG: sum(items.map(\.carbohydrateG)), fatG: sum(items.map(\.fatG)),
      fiberG: sum(items.map(\.fiberG)))
  }

  public static func foodNutrition(food: Food, amount: Double, unit: String) throws -> Nutrients {
    if amount == 0 { return scaleNutrients(food.nutrients, factor: 0) }
    var resolvedUnit = unit
    var resolvedAmount = amount
    var basisUnit = food.basis.unit
    var basisAmount = food.basis.quantity
    if resolvedUnit != basisUnit && (resolvedUnit == "serving" || basisUnit == "serving") {
      guard let serving = food.servingSize else {
        throw APIError("MISSING_CONVERSION", status: 422, message: food.name)
      }
      if resolvedUnit == "serving" {
        resolvedAmount *= serving.quantity
        resolvedUnit = serving.unit
      }
      if basisUnit == "serving" {
        basisAmount *= serving.quantity
        basisUnit = serving.unit
      }
    }
    if resolvedUnit != basisUnit {
      guard let density = food.densityGPerMl else {
        throw APIError("MISSING_CONVERSION", status: 422, message: food.name)
      }
      resolvedAmount =
        resolvedUnit == "g" ? resolvedAmount / density : resolvedAmount * density
    }
    let result = scaleNutrients(food.nutrients, factor: resolvedAmount / basisAmount)
    for key in NutrientKey.allCases {
      if let value = result[key], !value.isFinite {
        throw APIError("INVALID_NUTRITION", status: 422)
      }
    }
    return result
  }

  public static func optionalFoodNutrition(food: Food, amount: Double, unit: String) -> Nutrients?
  {
    do { return try foodNutrition(food: food, amount: amount, unit: unit) } catch let error
      as APIError where error.code == "MISSING_CONVERSION"
    {
      return nil
    } catch {
      return nil
    }
  }

  /// Fixed-point local midnight, matching the server's `dayBounds` loop.
  public static func dayBounds(day: String, timeZone: String) throws -> (from: String, to: String)
  {
    guard day.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
      throw APIError("INVALID_DATE", status: 422)
    }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime]
    parser.timeZone = TimeZone(secondsFromGMT: 0)
    guard let nominal = parser.date(from: day + "T00:00:00Z") else {
      throw APIError("INVALID_DATE", status: 422)
    }
    let nominalText = nominal.iso8601Milliseconds
    guard nominalText.hasPrefix(day) else { throw APIError("INVALID_DATE", status: 422) }
    guard let zone = TimeZone(identifier: timeZone) else {
      throw APIError("INVALID_TIME_ZONE", status: 422)
    }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    func midnight(_ target: Double) throws -> String {
      var guess = target
      for _ in 0..<5 {
        let date = Date(timeIntervalSince1970: guess / 1000)
        let parts = calendar.dateComponents(
          [.year, .month, .day, .hour, .minute, .second], from: date)
        var utc = DateComponents()
        utc.calendar = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)
        utc.year = parts.year
        utc.month = parts.month
        utc.day = parts.day
        utc.hour = parts.hour
        utc.minute = parts.minute
        utc.second = parts.second
        guard let represented = utc.date else {
          throw APIError("UNRESOLVABLE_LOCAL_DATE", status: 422)
        }
        let representedMs = represented.timeIntervalSince1970 * 1000
        let next = guess + target - representedMs
        if next == guess { return Date(timeIntervalSince1970: guess / 1000).iso8601Milliseconds }
        guess = next
      }
      throw APIError("UNRESOLVABLE_LOCAL_DATE", status: 422)
    }
    let start = nominal.timeIntervalSince1970 * 1000
    return (from: try midnight(start), to: try midnight(start + 86_400_000))
  }

  public static func summarize(
    meals: [Record<Meal>], day: String, timeZone: String
  ) throws -> DailyNutrition {
    let bounds = try dayBounds(day: day, timeZone: timeZone)
    let included = meals.filter { meal in
      meal.deleted != true && meal.data.occurredAt >= bounds.from && meal.data.occurredAt < bounds.to
    }.sorted { left, right in
      if left.createdAt != right.createdAt { return left.createdAt > right.createdAt }
      return left.id > right.id
    }
    return DailyNutrition(
      day: day, timeZone: timeZone, mealCount: included.count,
      nutrients: sumNutrients(included.map(\.data.nutrients)))
  }
}
