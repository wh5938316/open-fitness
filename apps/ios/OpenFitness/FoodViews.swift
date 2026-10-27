import ImageIO
import OpenFitnessKit
import PhotosUI
import SwiftUI

struct RecipeRow: View {
  @Environment(AppModel.self) private var model
  var recipe: Record<Recipe>
  var body: some View {
    HStack(spacing: 14) {
      PrivateRecipeImage(assetId: recipe.data.coverThumbnailAssetId ?? recipe.data.coverAssetId)
        .frame(width: 78, height: 78).clipShape(.rect(cornerRadius: 18))
      VStack(alignment: .leading, spacing: 6) {
        Text(recipe.data.name).font(.headline).foregroundStyle(.primary)
        if let restaurant = recipe.data.restaurant, !restaurant.isEmpty {
          Text(restaurant).font(.caption).foregroundStyle(.secondary)
        }
        Text("\(model.copy.number(recipe.data.perServing?.energyKcal)) \(model.text(.kcal))").font(
          .subheadline
        ).foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
    }.padding(12).background(.background, in: .rect(cornerRadius: 22))
  }
}
struct FoodView: View {
  @Environment(AppModel.self) private var model
  @State private var query = ""
  @State private var showRecipe = false
  @State private var showMeal = false
  var body: some View {
    @Bindable var model = model
    Screen {
      HStack {
        Button { model.shiftDay(-1) } label: { Image(systemName: "chevron.left") }
          .accessibilityIdentifier("previous-day")
        DatePicker(model.text(.today), selection: $model.selectedDay, displayedComponents: .date)
          .datePickerStyle(.compact)
        Button { model.shiftDay(1) } label: { Image(systemName: "chevron.right") }
          .accessibilityIdentifier("next-day")
      }
      if model.dayUnavailable {
        EmptyCard(title: model.text(.dayUnavailable), detail: "", icon: "calendar.badge.exclamationmark")
      } else if model.downloadingHistory && model.meals.isEmpty {
        EmptyCard(title: model.text(.downloadingHistory), detail: "", icon: "arrow.down.circle")
      } else if let nutrition = model.nutrition {
        Surface {
          VStack(alignment: .leading, spacing: 18) {
            MetricValue(
              title: model.text(.calories),
              value: model.copy.number(nutrition.nutrients.energyKcal), unit: model.text(.kcal),
              icon: "flame", identifier: "day-total-kcal")
            NutritionGrid(nutrients: nutrition.nutrients)
            if let pending = model.pendingKcalText {
              Text(pending).font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
      SectionTitle(title: model.text(.meals))
      ForEach(model.meals) { meal in
        NavigationLink {
          MealEditor(meal: meal)
        } label: {
          Surface {
            if model.conflictIds.contains(meal.id) {
              Text(model.text(.conflictTitle)).font(.caption).foregroundStyle(.orange)
            }
            HStack {
              VStack(alignment: .leading, spacing: 5) {
                Text(
                  meal.data.recipe?.snapshot.name
                    ?? meal.data.ingredients.map { $0.food.name }.joined(separator: ", ")
                ).font(.headline).foregroundStyle(.primary)
                if let date = Date.parseISO(meal.data.occurredAt) {
                  Text(date, format: .dateTime.hour().minute()).font(.caption).foregroundStyle(
                    .secondary)
                }
              }
              Spacer()
              Text("\(model.copy.number(meal.data.nutrients.energyKcal)) \(model.text(.kcal))")
                .font(.subheadline).foregroundStyle(.secondary)
            }
          }
        }.buttonStyle(.plain).accessibilityIdentifier("meal-row-\(meal.id)")
      }
      if model.meals.isEmpty && !model.downloadingHistory && !model.dayUnavailable {
        EmptyCard(title: model.text(.noMeals), detail: model.text(.noMealsHelp), icon: "sun.max")
      }
      Button {
        showMeal = true
      } label: {
        Label(model.text(.logMeal), systemImage: "plus").frame(maxWidth: .infinity).padding(
          .vertical, 5)
      }.buttonStyle(.glass)
      SectionTitle(title: model.text(.recipes))
      ForEach(
        model.recipes.filter {
          query.isEmpty || $0.data.name.localizedCaseInsensitiveContains(query)
            || ($0.data.aliases ?? []).contains(where: {
              $0.localizedCaseInsensitiveContains(query)
            }) || ($0.data.restaurant ?? "").localizedCaseInsensitiveContains(query)
        }
      ) { recipe in
        NavigationLink {
          RecipeDetail(recipe: recipe)
        } label: {
          RecipeRow(recipe: recipe)
        }.buttonStyle(.plain)
      }
      if model.recipes.isEmpty {
        EmptyCard(
          title: model.text(.noRecipes), detail: model.text(.noRecipesHelp), icon: "book.closed")
      }
    }.navigationTitle(model.text(.food)).searchable(text: $query, prompt: model.text(.search))
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            showRecipe = true
          } label: {
            Image(systemName: "plus")
          }.accessibilityLabel(model.text(.newRecipe))
        }
      }
      .sheet(isPresented: $showRecipe) { RecipeEditor() }.sheet(isPresented: $showMeal) {
        MealComposer()
      }
      .refreshable { await model.refresh() }
  }
}
struct RecipeDetail: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let recipe: Record<Recipe>
  @State private var servings = 1.0
  @State private var overrides: [String: Double] = [:]
  @State private var additions: [Ingredient] = []
  @State private var notes = ""
  @State private var photo: PhotosPickerItem?
  @State private var editing = false
  @State private var adding = false
  @State private var preview: Nutrients?
  @State private var calculating = false
  @State private var occurredAt = Date()
  @State private var calculationFailed = false
  private var current: Record<Recipe> { model.recipes.first { $0.id == recipe.id } ?? recipe }
  private var portion: [Ingredient] {
    (current.data.ingredients.map { item in
      var value = item
      value.foodId = nil
      value.quantity = overrides[item.id] ?? item.quantity * servings / current.data.yield.servings
      return value
    } + additions).filter { $0.quantity > 0 }
  }
  private var portionKey: Data? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return try? encoder.encode(portion)
  }
  private var displayedNutrition: Nutrients {
    preview
      ?? (overrides.isEmpty && additions.isEmpty
        ? current.data.perServing?.scaled(by: servings) : nil) ?? .init()
  }
  var body: some View {
    let photoLabel = model.text(.choosePhoto)
    Screen {
      PrivateRecipeImage(assetId: current.data.coverAssetId).frame(height: 236).clipShape(
        .rect(cornerRadius: 30))
      if let restaurant = current.data.restaurant, !restaurant.isEmpty {
        Label(restaurant, systemImage: "mappin.and.ellipse").font(.subheadline).foregroundStyle(
          .secondary)
      }
      Surface {
        VStack(alignment: .leading, spacing: 18) {
          HStack {
            MetricValue(
              title: model.text(.calories), value: model.copy.number(displayedNutrition.energyKcal),
              unit: model.text(.kcal), icon: "flame")
            if calculating { ProgressView() }
          }
          NutritionGrid(nutrients: displayedNutrition)
          Stepper(
            "\(model.text(.servings)): \(model.copy.number(servings, digits: 2))", value: $servings,
            in: 0.25...100, step: 0.25)
          if calculationFailed {
            Text(model.text(.calculationUnavailable)).font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      Text(model.text(.oneMealOnly)).font(.footnote).foregroundStyle(.secondary)
      SectionTitle(title: model.text(.ingredients))
      Surface {
        VStack(spacing: 16) {
          ForEach(current.data.ingredients) { ingredient in
            InlineNumber(
              title: ingredient.label ?? ingredient.food.name,
              value: Binding(
                get: {
                  overrides[ingredient.id] ?? ingredient.quantity * servings
                    / current.data.yield.servings
                }, set: { overrides[ingredient.id] = $0 }), unit: ingredient.unit)
          }
          ForEach(additions) { ingredient in
            HStack {
              Text(ingredient.food.name)
              Spacer()
              Text("+\(model.copy.number(ingredient.quantity, digits: 1)) \(ingredient.unit)")
                .foregroundStyle(.secondary)
            }
          }
          Button {
            adding = true
          } label: {
            Label(model.text(.additions), systemImage: "plus")
          }
        }
      }
      TextField(model.text(.mealNotes), text: $notes, axis: .vertical).padding(16).background(
        .background, in: .rect(cornerRadius: 18))
      DatePicker(model.text(.mealTime), selection: $occurredAt)
      Button {
        model.perform {
          try await model.logRecipe(
            current, servings: servings, overrides: overrides, additions: additions, notes: notes,
            occurredAt: occurredAt)
          dismiss()
        }
      } label: {
        Label(model.text(.logFromRecipe), systemImage: "checkmark").fontWeight(.semibold).frame(
          maxWidth: .infinity
        ).padding(.vertical, 8)
      }.buttonStyle(.glassProminent).disabled(model.isBusy || overrides.values.contains { $0 < 0 })
        .accessibilityIdentifier("log-recipe")
      Text("\(model.text(.nutritionVersion)) · \(current.data.nutritionVersion ?? 1)").font(
        .caption
      ).foregroundStyle(.secondary)
    }.navigationTitle(current.data.name).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Button(model.text(.edit)) { editing = true }
            PhotosPicker(selection: $photo, matching: .images) {
              Label(photoLabel, systemImage: "photo")
            }
          } label: {
            Image(systemName: "ellipsis")
          }
        }
      }
      .sheet(isPresented: $editing) { RecipeEditor(existing: current) }.sheet(isPresented: $adding)
    { IngredientPicker { additions.append($0) } }
      .onAppear { servings = current.data.defaultServings }
      .task(id: portionKey) {
        guard !model.isPreview else { return }
        if overrides.isEmpty, additions.isEmpty {
          preview = nil
          calculating = false
          calculationFailed = false
          return
        }
        calculating = true
        preview = nil
        calculationFailed = false
        do {
          try await Task.sleep(for: .milliseconds(250))
          struct Calculation: Decodable, Sendable { var nutrients: Nutrients }
          let result = try await model.api().request(
            Calculation.self, method: "POST", path: "/api/v1/nutrition/calculate",
            body: .object(["ingredients": try .from(portion)]))
          if !Task.isCancelled {
            preview = result.nutrients
            calculating = false
          }
        } catch {
          if !Task.isCancelled {
            preview = nil
            calculationFailed = true
            calculating = false
          }
        }
      }
      .task(id: photo) {
        guard let photo else { return }
        do {
          guard let data = try await photo.loadTransferable(type: Data.self),
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let cgImage = CGImageSourceCreateThumbnailAtIndex(
              source, 0,
              [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048,
                kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary),
            let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.85)
          else { throw APIError("INVALID_IMAGE") }
          try await model.uploadCover(jpeg, recipe: current)
        } catch { model.errorMessage = model.copy.error(error) }
      }
  }
}
struct MealEditor: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let meal: Record<Meal>
  @State private var quantities: [String: Double] = [:]
  @State private var notes = ""
  @State private var deleting = false
  @State private var occurredAt = Date()
  var body: some View {
    Form {
      if let image = meal.data.imageAssetId {
        PrivateRecipeImage(assetId: image).frame(height: 180)
      }
      Section(model.text(.nutrition)) {
        NutritionGrid(nutrients: meal.data.nutrients)
        LabeledContent(
          model.text(.calories),
          value: "\(model.copy.number(meal.data.nutrients.energyKcal)) \(model.text(.kcal))")
      }
      Section {
        ForEach(meal.data.ingredients) { ingredient in
          InlineNumber(
            title: ingredient.label ?? ingredient.food.name,
            value: Binding(
              get: { quantities[ingredient.id] ?? ingredient.quantity },
              set: { quantities[ingredient.id] = $0 }), unit: ingredient.unit)
        }
      } header: {
        Text(model.text(.ingredients))
      } footer: {
        Text(model.text(.oneMealOnly))
      }
      Section(model.text(.notes)) { TextField(model.text(.notes), text: $notes, axis: .vertical) }
      Section { DatePicker(model.text(.mealTime), selection: $occurredAt) }
      Section(model.text(.source)) {
        ForEach(meal.data.ingredients) { ingredient in
          VStack(alignment: .leading, spacing: 4) {
            Text(ingredient.food.name)
            Text(
              ingredient.food.source.kind == "bot_estimate"
                ? model.text(.estimate)
                : ingredient.food.source.kind == "open_food_facts"
                  ? model.text(.foodProvider) : model.text(.source)
            ).font(.caption).foregroundStyle(.secondary)
            if let basis = ingredient.food.source.basis {
              Text(basis).font(.caption).foregroundStyle(.secondary)
            }
            if let link = ingredient.food.source.reference.flatMap(URL.init(string:)),
              link.scheme == "https"
            {
              Link(link.host ?? model.text(.source), destination: link).font(.caption)
            }
          }
        }
      }
      Button(model.text(.delete), role: .destructive) { deleting = true }
    }.navigationTitle(meal.data.recipe?.snapshot.name ?? model.text(.meals))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(model.text(.save)) {
            model.perform {
              try await model.reviseMeal(
                meal, quantities: quantities, notes: notes, occurredAt: occurredAt)
              dismiss()
            }
          }.disabled(model.isBusy || quantities.values.contains { $0 < 0 })
        }
      }
      .onAppear {
        notes = meal.data.notes
        occurredAt = Date.parseISO(meal.data.occurredAt) ?? Date()
      }
      .confirmationDialog(
        model.text(.deleteConfirmation), isPresented: $deleting, titleVisibility: .visible
      ) {
        Button(model.text(.delete), role: .destructive) {
          model.perform {
            try await model.deleteMeal(meal)
            dismiss()
          }
        }
      }
  }
}
