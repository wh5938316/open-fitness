import OpenFitnessKit
import SwiftUI

private struct PlanDraft: Identifiable {
  var id = UUID()
  var exercise: Record<Exercise>
  var count = 3
  var reps = 8.0
  var weight = 0.0
  var seconds = 60.0
  var meters = 1000.0
  var rest = 90.0
  var group = ""
  func entry() -> PlannedExercise {
    var metrics = SetMetrics()
    switch exercise.data.category ?? "strength" {
    case "duration": metrics.durationSeconds = seconds
    case "distance":
      metrics.distanceMeters = meters
      metrics.durationSeconds = seconds
    default:
      metrics.reps = Int(reps)
      metrics.weightKg = weight
    }
    var value = PlannedExercise(
      exerciseId: exercise.id, exercise: exercise.data,
      sets: Array(repeating: metrics, count: count), restSeconds: rest)
    value.groupId = group.isEmpty ? nil : group
    return value
  }
}
struct PlanEditor: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var notes = ""
  @State private var drafts: [PlanDraft] = []
  @State private var choosing = false
  @State private var detail: Record<Exercise>?
  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField(model.text(.planName), text: $name).accessibilityIdentifier("plan-name")
          TextField(model.text(.notes), text: $notes, axis: .vertical)
        }
        ForEach($drafts) { $draft in
          Section {
            Button {
              detail = model.preferredExercise(draft.exercise)
            } label: {
              HStack {
                Text(draft.exercise.data.localized(model.language).name).foregroundStyle(.primary)
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
              }
            }
            .accessibilityLabel(model.text(.exerciseDetails))
            Stepper("\(model.text(.sets)): \(draft.count)", value: $draft.count, in: 1...30)
            if !["duration", "distance"].contains(draft.exercise.data.category ?? "") {
              InlineNumber(title: model.text(.reps), value: $draft.reps)
              InlineNumber(title: model.text(.load), value: $draft.weight, unit: model.text(.kg))
            }
            if ["duration", "distance"].contains(draft.exercise.data.category ?? "") {
              InlineNumber(
                title: model.text(.duration), value: $draft.seconds, unit: model.text(.sec))
            }
            if draft.exercise.data.category == "distance" {
              InlineNumber(title: model.text(.distance), value: $draft.meters, unit: model.text(.m))
            }
            InlineNumber(title: model.text(.rest), value: $draft.rest, unit: model.text(.sec))
            TextField(model.text(.group), text: $draft.group)
            Button(model.text(.delete), role: .destructive) {
              drafts.removeAll { $0.id == draft.id }
            }
          }
        }
        Button {
          choosing = true
        } label: {
          Label(model.text(.addExercise), systemImage: "plus")
        }.accessibilityIdentifier("plan-add-exercise")
      }.navigationTitle(model.text(.newPlan)).navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button(model.text(.cancel)) { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button(model.text(.save)) {
              model.perform {
                var plan = TrainingPlan(name: name, exercises: drafts.map { $0.entry() })
                plan.notes = notes
                try await model.savePlan(plan)
                dismiss()
              }
            }.disabled(
              name.trimmingCharacters(in: .whitespaces).isEmpty || drafts.isEmpty
                || drafts.contains {
                  $0.reps < 0 || $0.weight < 0 || $0.seconds < 0 || $0.rest < 0 || $0.meters < 0
                } || model.isBusy)
          }
        }
        .sheet(isPresented: $choosing) {
          ExercisePicker(selected: { drafts.append(.init(exercise: $0)) })
        }
        .sheet(item: $detail) { record in
          NavigationStack {
            ExerciseDetailView(record: record)
              .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                  Button(model.text(.done)) { detail = nil }
                }
              }
          }
        }
    }
  }
}
struct NewExerciseEditor: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var selected: (Record<Exercise>) -> Void
  @State private var name = ""
  @State private var category = "strength"
  @State private var instructions = ""
  var body: some View {
    NavigationStack {
      Form {
        TextField(model.text(.exerciseName), text: $name)
        Picker(model.text(.movementType), selection: $category) {
          Text(model.text(.strength)).tag("strength")
          Text(model.text(.timed)).tag("duration")
          Text(model.text(.cardio)).tag("distance")
        }
        Section(model.text(.instructions)) { TextEditor(text: $instructions).frame(minHeight: 140) }
      }
      .navigationTitle(model.text(.addExercise)).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(model.text(.cancel)) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.text(.save)) {
            model.perform {
              let item = try await model.saveExercise(
                .init(name: name, category: category, instructions: instructions))
              selected(item)
              dismiss()
            }
          }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || model.isBusy)
        }
      }
    }
  }
}
