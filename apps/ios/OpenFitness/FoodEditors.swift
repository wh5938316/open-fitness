import OpenFitnessKit
import SwiftUI

struct RecipeEditor: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var existing: Record<Recipe>? = nil
  @State private var name = ""
  @State private var restaurant = ""
  @State private var specification = ""
  @State private var notes = ""
  @State private var servings = 1.0
  @State private var cookedWeight = ""
  @State private var ingredients: [Ingredient] = []
  @State private var adding = false
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField(model.text(.recipeName), text: $name)
          TextField(model.text(.restaurant), text: $restaurant)
          TextField(model.text(.standardPortion), text: $specification)
        }
        Section(model.text(.ingredients)) {
          ForEach($ingredients) { $ingredient in
            InlineNumber(
              title: ingredient.food.name, value: $ingredient.quantity, unit: ingredient.unit)
          }.onDelete { ingredients.remove(atOffsets: $0) }
          Button {
            adding = true
          } label: {
            Label(model.text(.addIngredient), systemImage: "plus")
          }
        }
        Section {
          InlineNumber(title: model.text(.yieldServings), value: $servings)
          TextField(model.text(.cookedWeight), text: $cookedWeight).keyboardType(.decimalPad)
        }
        Section(model.text(.notes)) { TextField(model.text(.notes), text: $notes, axis: .vertical) }
      }.navigationTitle(model.text(existing == nil ? .newRecipe : .edit))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button(model.text(.cancel)) { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button(model.text(.save)) {
              model.perform {
                var recipe = Recipe(name: name, ingredients: ingredients, servings: servings)
                recipe.restaurant = restaurant
                recipe.specification = specification
                recipe.notes = notes
                recipe.yield.cookedWeightGrams = Double(cookedWeight)
                recipe.defaultServings = existing?.data.defaultServings ?? 1
                recipe.aliases = existing?.data.aliases
                recipe.coverAssetId = existing?.data.coverAssetId
                recipe.coverThumbnailAssetId = existing?.data.coverThumbnailAssetId
                _ = try await model.saveRecipe(recipe, existing: existing)
                dismiss()
              }
            }.disabled(
              name.trimmingCharacters(in: .whitespaces).isEmpty || ingredients.isEmpty
                || ingredients.contains { $0.quantity <= 0 } || servings <= 0
                || (!cookedWeight.isEmpty && (Double(cookedWeight) ?? -1) <= 0) || model.isBusy)
          }
        }
        .sheet(isPresented: $adding) { IngredientPicker { ingredients.append($0) } }
        .onAppear {
          if let r = existing?.data {
            name = r.name
            restaurant = r.restaurant ?? ""
            specification = r.specification ?? ""
            notes = r.notes ?? ""
            ingredients = r.ingredients.map {
              var i = $0
              i.foodId = nil
              return i
            }
            servings = r.yield.servings
            cookedWeight = r.yield.cookedWeightGrams.map { String($0) } ?? ""
          }
        }
    }
  }
}
struct MealComposer: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var ingredients: [Ingredient] = []
  @State private var notes = ""
  @State private var adding = false
  @State private var occurredAt = Date()
  var body: some View {
    NavigationStack {
      Form {
        Section(model.text(.ingredients)) {
          ForEach($ingredients) { $ingredient in
            InlineNumber(
              title: ingredient.food.name, value: $ingredient.quantity, unit: ingredient.unit)
          }.onDelete { ingredients.remove(atOffsets: $0) }
          Button {
            adding = true
          } label: {
            Label(model.text(.addIngredient), systemImage: "plus")
          }
        }
        Section(model.text(.notes)) { TextField(model.text(.notes), text: $notes, axis: .vertical) }
      }
      .safeAreaInset(edge: .bottom) {
        DatePicker(model.text(.mealTime), selection: $occurredAt).padding().background(.background)
      }
      .navigationTitle(model.text(.logMeal)).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(model.text(.cancel)) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.text(.save)) {
            model.perform {
              try await model.logIngredients(ingredients, notes: notes, occurredAt: occurredAt)
              dismiss()
            }
          }.disabled(
            ingredients.isEmpty || ingredients.contains { $0.quantity <= 0 } || model.isBusy)
        }
      }
      .sheet(isPresented: $adding) { IngredientPicker { ingredients.append($0) } }
    }
  }
}
struct IngredientPicker: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var selected: (Ingredient) -> Void
  @State private var query = ""
  @State private var items: [FoodSearchHit] = []
  @State private var choosing: Food?
  @State private var choosingFoodId: String?
  @State private var showingQuantity = false
  @State private var quantity = 100.0
  @State private var unit = "g"
  @State private var creating = false
  @State private var searching = false
  @State private var loadError: String?
  @State private var catalogDegraded = false
  var body: some View {
    NavigationStack {
      List {
        Button {
          creating = true
        } label: {
          Label(model.text(.newFood), systemImage: "square.and.pencil")
        }
        if catalogDegraded {
          Text(model.text(.catalogDegraded)).font(.footnote).foregroundStyle(.secondary)
        }
        ForEach(items) { hit in
          Button {
            let food = hit.food
            if let savedId = hit.savedId {
              choosing = food
              choosingFoodId = savedId
              quantity = food.basis.quantity
              unit = food.basis.unit
              showingQuantity = true
            } else if let barcode = food.barcode {
              model.perform {
                let saved = try await model.importFood(barcode: barcode)
                choosing = saved.data
                choosingFoodId = saved.id
                quantity = saved.data.basis.quantity
                unit = saved.data.basis.unit
                showingQuantity = true
              }
            }
          } label: {
            VStack(alignment: .leading, spacing: 5) {
              Text(hit.food.name).foregroundStyle(.primary)
              Text(
                "\(model.copy.number(hit.food.nutrients.energyKcal)) \(model.text(.kcal)) / \(model.copy.number(hit.food.basis.quantity)) \(hit.food.basis.unit)"
              ).font(.caption).foregroundStyle(.secondary)
              if hit.food.source.kind == "open_food_facts" {
                Text(model.text(.foodProvider)).font(.caption2).foregroundStyle(.secondary)
              }
            }
          }
        }
        if searching { ProgressView() }
        if let loadError { Text(loadError).font(.footnote).foregroundStyle(.secondary) }
        if !searching && items.isEmpty && query.count >= 2 {
          Text(model.text(.noResults)).foregroundStyle(.secondary)
        }
      }.navigationTitle(model.text(.ingredient)).searchable(
        text: $query, prompt: model.text(.search)
      )
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(model.text(.cancel)) { dismiss() } }
      }
      .task(id: query) {
        guard query.count >= 2 else {
          items = []
          catalogDegraded = false
          return
        }
        do {
          try await Task.sleep(for: .milliseconds(400))
          searching = true
          let result = try await model.searchFoods(query)
          if !Task.isCancelled {
            items = result.hits
            catalogDegraded = result.catalogDegraded
            loadError = nil
            searching = false
          }
        } catch {
          if !Task.isCancelled {
            loadError = model.copy.error(error)
            searching = false
          }
        }
      }
      .sheet(isPresented: $creating) {
        ManualFoodEditor { food, quantity, unit in
          selected(.init(quantity: quantity, unit: unit, food: food))
          dismiss()
        }
      }
      .sheet(isPresented: $showingQuantity) {
        NavigationStack {
          Form {
            Text(choosing?.name ?? "")
            InlineNumber(title: model.text(.quantity), value: $quantity)
            Picker(model.text(.quantity), selection: $unit) {
              Text("g").tag("g")
              Text("ml").tag("ml")
              Text(model.text(.servings)).tag("serving")
            }
          }.navigationTitle(model.text(.quantity)).toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button(model.text(.cancel)) { showingQuantity = false }
            }
            ToolbarItem(placement: .confirmationAction) {
              Button(model.text(.addIngredient)) {
                if let choosing {
                  var ingredient = Ingredient(quantity: quantity, unit: unit, food: choosing)
                  ingredient.foodId = choosingFoodId
                  selected(ingredient)
                  dismiss()
                }
              }.disabled(quantity <= 0)
            }
          }
        }
      }
    }
  }
}
private struct ManualFoodEditor: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var selected: (Food, Double, String) -> Void
  @State private var name = ""
  @State private var energy = ""
  @State private var protein = ""
  @State private var carbs = ""
  @State private var fat = ""
  @State private var fiber = ""
  @State private var amount = 100.0
  @State private var unit = "g"
  @State private var basis = ""
  private var invalid: Bool {
    name.trimmingCharacters(in: .whitespaces).isEmpty || amount <= 0
      || [energy, protein, carbs, fat, fiber].contains { !$0.isEmpty && (Double($0) ?? -1) < 0 }
  }
  var body: some View {
    NavigationStack {
      Form {
        TextField(model.text(.foodName), text: $name)
        Section(model.text(.per100)) {
          Picker(model.text(.quantity), selection: $unit) {
            Text("g").tag("g")
            Text("ml").tag("ml")
          }
          nutritionField(.calories, value: $energy)
          nutritionField(.protein, value: $protein)
          nutritionField(.carbs, value: $carbs)
          nutritionField(.fat, value: $fat)
          nutritionField(.fiber, value: $fiber)
        }
        Section(model.text(.source)) {
          TextField(model.text(.source), text: $basis, axis: .vertical)
        }
        InlineNumber(title: model.text(.quantity), value: $amount, unit: unit)
      }.navigationTitle(model.text(.newFood)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button(model.text(.cancel)) { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button(model.text(.addIngredient)) {
              let food = Food(
                name: name,
                nutrients: .init(
                  energyKcal: Double(energy), proteinG: Double(protein),
                  carbohydrateG: Double(carbs), fatG: Double(fat), fiberG: Double(fiber)),
                basis: .init(quantity: 100, unit: unit),
                source: .init(
                  kind: "user",
                  basis: basis.isEmpty ? "Entered by the owner in OpenFitness iOS." : basis))
              selected(food, amount, unit)
              dismiss()
            }.disabled(invalid)
          }
        }
    }
  }
  private func nutritionField(_ key: CopyKey, value: Binding<String>) -> some View {
    HStack {
      Text(model.text(key))
      Spacer()
      TextField(model.text(.unknown), text: value).keyboardType(.decimalPad).multilineTextAlignment(
        .trailing
      ).frame(width: 100)
    }
  }
}
