import Charts
import OpenFitnessKit
import SwiftUI

struct TodayView: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    Screen {
      Text(Date(), format: .dateTime.weekday(.wide).month(.wide).day()).font(.subheadline)
        .foregroundStyle(.secondary)
      Text(model.text(.dailyOverview)).font(.system(.largeTitle, design: .rounded).bold())
      Surface {
        VStack(alignment: .leading, spacing: 24) {
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 5) {
              Label(model.text(.calories), systemImage: "flame").font(.subheadline).foregroundStyle(
                .secondary)
              HStack(alignment: .firstTextBaseline) {
                Text(
                  model.copy.number((model.todayNutrition ?? model.nutrition)?.nutrients.energyKcal)
                ).font(
                  .system(size: 54, weight: .semibold, design: .rounded)
                ).monospacedDigit()
                Text(model.text(.kcal)).foregroundStyle(.secondary)
              }
            }
            Spacer()
            Image(systemName: "leaf.circle").font(.system(size: 68, weight: .ultraLight))
              .foregroundStyle(.green).accessibilityHidden(true)
          }
          NutritionGrid(nutrients: (model.todayNutrition ?? model.nutrition)?.nutrients ?? .init())
        }
      }
      PendingBanner()
      SectionTitle(title: model.text(.nextSession))
      if let workout = model.activeWorkout {
        NavigationLink {
          WorkoutRunner()
        } label: {
          ActiveWorkoutCard(workout: workout)
        }.buttonStyle(.plain)
      } else if let plan = model.plans.first {
        PlanCard(plan: plan)
      } else {
        EmptyCard(title: model.text(.noPlans), detail: model.text(.noPlansHelp), icon: "dumbbell")
      }
      SectionTitle(title: model.text(.recipes), detail: model.text(.quickMeal))
      ForEach(model.recipes.prefix(3)) { recipe in
        NavigationLink {
          RecipeDetail(recipe: recipe)
        } label: {
          RecipeRow(recipe: recipe)
        }.buttonStyle(.plain)
      }
      if model.recipes.isEmpty {
        EmptyCard(
          title: model.text(.noRecipes), detail: model.text(.noRecipesHelp), icon: "fork.knife")
      }
      if model.isPreview { Text(model.text(.preview)).font(.caption).foregroundStyle(.secondary) }
    }.navigationTitle("OpenFitness").navigationBarTitleDisplayMode(.inline).refreshable {
      await model.refresh()
    }
  }
}
struct ActiveWorkoutCard: View {
  @Environment(AppModel.self) private var model
  var workout: Record<Workout>
  var body: some View {
    Surface {
      VStack(alignment: .leading, spacing: 14) {
        Label(model.text(.active), systemImage: "waveform.path.ecg").font(.caption.bold())
          .foregroundStyle(.green)
        Text(workout.data.name).font(.title2.bold())
        HStack {
          Text("\(workout.data.sets.count) \(model.text(.sets))").foregroundStyle(.secondary)
          Spacer()
          Label(model.text(.resumeWorkout), systemImage: "arrow.up.right").font(.subheadline.bold())
            .foregroundStyle(.green)
        }
      }
    }
  }
}
struct PlanCard: View {
  @Environment(AppModel.self) private var model
  var plan: Record<TrainingPlan>
  var body: some View {
    NavigationLink {
      PlanDetail(plan: plan)
    } label: {
      Surface {
        HStack(alignment: .top, spacing: 16) {
          Image(systemName: "figure.strengthtraining.traditional").font(.title).foregroundStyle(
            .green
          ).frame(width: 44, height: 52).background(
            .green.opacity(0.08), in: .rect(cornerRadius: 14))
          VStack(alignment: .leading, spacing: 6) {
            Text(plan.data.name).font(.headline).foregroundStyle(.primary)
            Text(plan.data.exercises.map { $0.exerciseSnapshot.name }.joined(separator: " · "))
              .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            Text("\(plan.data.exercises.reduce(0) { $0 + $1.sets.count }) \(model.text(.sets))")
              .font(.caption).foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
      }
    }.buttonStyle(.plain)
  }
}
struct TrainingView: View {
  @Environment(AppModel.self) private var model
  @State private var showEditor = false
  @State private var showLibrary = false
  var body: some View {
    Screen {
      PendingBanner()
      if let workout = model.activeWorkout {
        NavigationLink {
          WorkoutRunner()
        } label: {
          ActiveWorkoutCard(workout: workout)
        }.buttonStyle(.plain)
      }
      SectionTitle(title: model.text(.trainingPlans))
      ForEach(model.plans) { PlanCard(plan: $0) }
      if model.plans.isEmpty {
        EmptyCard(title: model.text(.noPlans), detail: model.text(.noPlansHelp), icon: "dumbbell")
      }
      SectionTitle(title: model.text(.workoutHistory))
      ForEach(model.workouts.filter { $0.data.state != "active" }) { workout in
        NavigationLink {
          WorkoutRunner(historical: workout)
        } label: {
          Surface {
            HStack {
              VStack(alignment: .leading, spacing: 5) {
                Text(workout.data.name).font(.headline)
                if let date = Date.parseISO(workout.data.startedAt) {
                  Text(date, format: .dateTime.month().day().hour().minute()).font(.caption)
                    .foregroundStyle(.secondary)
                }
              }
              Spacer()
              Text("\(workout.data.sets.count)").font(.title2.weight(.medium)).monospacedDigit()
              Text(model.text(.sets)).font(.caption).foregroundStyle(.secondary)
            }
          }
        }.buttonStyle(.plain)
      }
      if model.workouts.isEmpty {
        Text(model.text(.noHistory)).font(.subheadline).foregroundStyle(.secondary)
      }
      if model.canLoadMoreHistory {
        Button(model.text(.history)) { model.perform { try await model.loadMoreHistory() } }
          .buttonStyle(.glass)
      }
    }.navigationTitle(model.text(.train)).toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          showLibrary = true
        } label: {
          Image(systemName: "books.vertical")
        }
        .accessibilityLabel(model.text(.exerciseLibrary))
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          showEditor = true
        } label: {
          Image(systemName: "plus")
        }.accessibilityLabel(model.text(.newPlan)).accessibilityIdentifier("new-plan")
      }
    }.sheet(isPresented: $showEditor) { PlanEditor() }
      .sheet(isPresented: $showLibrary) { ExercisePicker(mode: .browse) }
      .refreshable { await model.refresh() }
  }
}
struct PlanDetail: View {
  @Environment(AppModel.self) private var model
  var plan: Record<TrainingPlan>
  @State private var showWorkout = false
  var body: some View {
    Screen {
      if let notes = plan.data.notes, !notes.isEmpty { Text(notes).foregroundStyle(.secondary) }
      ForEach(Array(plan.data.exercises.enumerated()), id: \.offset) { index, entry in
        Surface {
          VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
              Text(String(format: "%02d", index + 1)).font(.caption.monospaced()).foregroundStyle(
                .secondary)
              VStack(alignment: .leading, spacing: 5) {
                NavigationLink {
                  ExerciseDetailView(
                    record: model.preferredExercise(
                      .init(id: entry.exerciseId, kind: "exercise", data: entry.exerciseSnapshot))
                  )
                } label: {
                  Text(entry.exerciseSnapshot.localized(model.language).name).font(.title3.bold())
                }.buttonStyle(.plain)
                Text(
                  "\(entry.sets.count) \(model.text(.sets)) · \(Int(entry.restSeconds)) \(model.text(.sec)) \(model.text(.rest))"
                ).font(.subheadline).foregroundStyle(.secondary)
              }
            }
            if let group = entry.groupId {
              Label(group, systemImage: "link").font(.caption).foregroundStyle(.green)
            }
            ForEach(Array(entry.sets.enumerated()), id: \.offset) { _, target in
              MetricsLine(metrics: target)
            }
            if let guidance = entry.exerciseSnapshot.instructions, !guidance.isEmpty {
              Text(guidance).font(.subheadline).foregroundStyle(.secondary)
            }
            if model.supportsExerciseCatalog,
              entry.exerciseSnapshot.diagram?.highlights?.contains(where: \.matched) == true
            {
              DisclosureGroup(model.text(.muscleMap)) {
                MuscleMapView(
                  diagram: entry.exerciseSnapshot.diagram,
                  accessibilitySummary: entry.exerciseSnapshot.localized(model.language).name
                )
                .frame(maxHeight: 220)
              }
            }
            ForEach(entry.exerciseSnapshot.mediaAssetIds ?? [], id: \.self) {
              PrivateRecipeImage(assetId: $0).frame(height: 180).clipShape(.rect(cornerRadius: 16))
            }
          }
        }
      }
    }.navigationTitle(plan.data.name)
      .safeAreaInset(edge: .bottom) {
        Button {
          model.perform {
            try model.start(plan)
            showWorkout = true
          }
        } label: {
          Label(
            model.text(model.activeWorkout == nil ? .startWorkout : .resumeWorkout),
            systemImage: "play.fill"
          ).font(.headline).frame(maxWidth: .infinity).padding(.vertical, 10)
        }.buttonStyle(.glassProminent).padding(20)
      }
      .navigationDestination(isPresented: $showWorkout) { WorkoutRunner() }
  }
}
struct MetricsLine: View {
  @Environment(AppModel.self) private var model
  var metrics: SetMetrics
  var body: some View {
    HStack(spacing: 10) {
      if let reps = metrics.reps { Text("\(reps) \(model.text(.reps))") }
      if let weight = metrics.weightKg {
        Text("\(model.copy.number(weight, digits: 1)) \(model.text(.kg))")
      }
      if let seconds = metrics.durationSeconds {
        Text("\(model.copy.number(seconds)) \(model.text(.sec))")
      }
      if let meters = metrics.distanceMeters {
        Text("\(model.copy.number(meters)) \(model.text(.m))")
      }
      Spacer()
      Text(model.text(CopyKey(rawValue: metrics.type) ?? .working)).font(.caption).foregroundStyle(
        .secondary)
    }.font(.subheadline).monospacedDigit()
  }
}
private struct SetEditorSelection: Identifiable {
  var id = UUID()
  var exerciseId: String
  var exercise: Exercise
  var metrics: SetMetrics
  var rest: Double
  var existing: ActualSet?
}
struct WorkoutRunner: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var historical: Record<Workout>? = nil
  @State private var editor: SetEditorSelection?
  @State private var confirmsFinish = false
  @State private var choosingExercise = false
  @State private var extraExercises: [Record<Exercise>] = []
  private var record: Record<Workout>? {
    if let historical { return model.workouts.first { $0.id == historical.id } ?? historical }
    return model.activeWorkout
  }
  var body: some View {
    Group {
      if let record {
        Screen {
          HStack {
            MetricValue(
              title: model.text(.sets), value: "\(record.data.sets.count)", unit: "",
              icon: "checkmark.circle")
            if let start = Date.parseISO(record.data.startedAt) {
              VStack(alignment: .leading, spacing: 8) {
                Label(model.text(.elapsed), systemImage: "clock").font(.caption).foregroundStyle(
                  .secondary)
                if record.data.state == "active" {
                  Text(start, style: .timer).font(
                    .system(.title, design: .rounded).weight(.semibold)
                  ).monospacedDigit()
                } else {
                  Text(
                    "\(model.copy.number((Date.parseISO(record.data.finishedAt ?? "") ?? start).timeIntervalSince(start) / 60)) \(model.text(.min))"
                  ).font(.title)
                }
              }.frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          PendingBanner()
          ForEach(Array(exercises(in: record).enumerated()), id: \.element.exerciseId) {
            index, exercise in
            Surface {
              VStack(alignment: .leading, spacing: 16) {
                HStack {
                  Text(String(format: "%02d", index + 1)).font(.caption.monospaced())
                    .foregroundStyle(.green)
                  Text(exercise.exerciseSnapshot.localized(model.language).name).font(
                    .title3.bold())
                  Spacer()
                }
                if let text = exercise.exerciseSnapshot.instructions, !text.isEmpty {
                  DisclosureGroup(model.text(.instructions)) {
                    Text(text).font(.subheadline).foregroundStyle(.secondary).padding(.vertical, 6)
                  }
                }
                ForEach(record.data.sets.filter { $0.exerciseId == exercise.exerciseId }) { set in
                  Button {
                    editor = .init(
                      exerciseId: exercise.exerciseId, exercise: exercise.exerciseSnapshot,
                      metrics: set.metrics, rest: exercise.restSeconds, existing: set)
                  } label: {
                    HStack {
                      Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                      MetricsLine(metrics: set.metrics).foregroundStyle(.primary)
                      Image(systemName: "pencil").font(.caption).foregroundStyle(.tertiary)
                    }
                  }.buttonStyle(.plain).accessibilityIdentifier(
                    "recorded-set-\(set.exerciseId)-\(set.id)"
                  )
                  .disabled(model.journal.commands.contains { $0.id == set.id })
                }
                if record.data.state == "active" {
                  Button {
                    let index = min(
                      record.data.sets.filter { $0.exerciseId == exercise.exerciseId }.count,
                      max(exercise.sets.count - 1, 0))
                    var metrics = exercise.sets.isEmpty ? SetMetrics() : exercise.sets[index]
                    metrics.groupId = exercise.groupId ?? metrics.groupId
                    editor = .init(
                      exerciseId: exercise.exerciseId, exercise: exercise.exerciseSnapshot,
                      metrics: metrics, rest: exercise.restSeconds)
                  } label: {
                    Label(model.text(.logSet), systemImage: "plus").frame(maxWidth: .infinity)
                      .padding(.vertical, 4)
                  }.buttonStyle(.glass).accessibilityIdentifier("log-set-\(index)")
                }
              }
            }
          }
          if record.data.state == "active" {
            Button {
              choosingExercise = true
            } label: {
              Label(model.text(.addExerciseToWorkout), systemImage: "plus")
                .frame(maxWidth: .infinity)
            }.buttonStyle(.glass).accessibilityIdentifier("workout-add-exercise")
            Button(model.text(.finishWorkout)) { confirmsFinish = true }.buttonStyle(
              .glassProminent
            ).frame(maxWidth: .infinity).accessibilityIdentifier("finish-workout")
            Button(model.text(.cancelWorkout), role: .destructive) {
              model.perform {
                try model.finish(cancel: true)
                dismiss()
              }
            }.font(.footnote).frame(maxWidth: .infinity).padding(.top, 8)
          }
        }.navigationTitle(record.data.name).navigationBarTitleDisplayMode(.inline)
          .sheet(isPresented: $choosingExercise) {
            ExercisePicker(
              selected: { exercise in
                if !exercises(in: record).contains(where: { $0.exerciseId == exercise.id }) {
                  extraExercises.append(exercise)
                }
              }, selectionTitle: .addExerciseToWorkout)
          }
          .sheet(item: $editor) { selection in
            SetEditor(selection: selection) { metrics in
              if let existing = selection.existing {
                try await model.reviseSet(workout: record, set: existing, metrics: metrics)
              } else {
                try model.logSet(
                  exerciseId: selection.exerciseId, metrics: metrics, restSeconds: selection.rest,
                  exercise: selection.exercise)
              }
            }
          }
      } else {
        ContentUnavailableView(model.text(.noActiveWorkout), systemImage: "dumbbell")
      }
    }
    .safeAreaInset(edge: .bottom) {
      if let deadline = model.restUntil, deadline > Date() { RestTimerBar(deadline: deadline) }
    }
    .confirmationDialog(
      model.text(.finishConfirmation), isPresented: $confirmsFinish, titleVisibility: .visible
    ) {
      Button(model.text(.finishWorkout)) {
        model.perform {
          try model.finish()
          dismiss()
        }
      }
    }
  }
  private func exercises(in record: Record<Workout>) -> [PlannedExercise] {
    var entries = record.data.plan?.snapshot.exercises ?? []
    var seen = Set(entries.map(\.exerciseId))
    for set in record.data.sets where seen.insert(set.exerciseId).inserted {
      entries.append(
        .init(
          exerciseId: set.exerciseId, exercise: set.exerciseSnapshot, sets: [set.metrics]))
    }
    for extra in extraExercises where seen.insert(extra.id).inserted {
      let metrics =
        extra.data.category == "duration"
        ? SetMetrics(durationSeconds: 60) : SetMetrics(reps: 8, weightKg: 0)
      entries.append(.init(exerciseId: extra.id, exercise: extra.data, sets: [metrics]))
    }
    return entries
  }

}
private struct SetEditor: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var selection: SetEditorSelection
  var save: @MainActor (SetMetrics) async throws -> Void
  @State private var reps: Double = 8
  @State private var weight: Double = 0
  @State private var seconds: Double = 60
  @State private var meters: Double = 1000
  @State private var type = "working"
  @State private var effort = 8.0
  @State private var effortType = 0
  @State private var notes = ""
  var body: some View {
    NavigationStack {
      Form {
        Section(selection.exercise.name) {
          if !["duration", "distance"].contains(selection.exercise.category ?? "") {
            InlineNumber(title: model.text(.reps), value: $reps)
            InlineNumber(title: model.text(.load), value: $weight, unit: model.text(.kg))
          }
          if ["duration", "distance", "mixed"].contains(selection.exercise.category ?? "") {
            InlineNumber(title: model.text(.duration), value: $seconds, unit: model.text(.sec))
          }
          if ["distance", "mixed"].contains(selection.exercise.category ?? "") {
            InlineNumber(title: model.text(.distance), value: $meters, unit: model.text(.m))
          }
          Picker(model.text(.sets), selection: $type) {
            ForEach(["working", "warmup", "drop", "rest_pause", "failure"], id: \.self) {
              Text(model.text(CopyKey(rawValue: $0)!)).tag($0)
            }
          }
        }
        Section(model.text(.effort)) {
          Picker(model.text(.effort), selection: $effortType) {
            Text("—").tag(0)
            Text("RPE").tag(1)
            Text("RIR").tag(2)
          }.pickerStyle(.segmented)
          if effortType != 0 {
            HStack {
              Slider(value: $effort, in: 0...10, step: 0.5)
              Text(model.copy.number(effort, digits: 1)).monospacedDigit().frame(width: 40)
            }
          }
        }
        Section(model.text(.notes)) {
          TextField(model.text(.notes), text: $notes, axis: .vertical).lineLimit(3...6)
        }
      }
      .navigationTitle(model.text(selection.existing == nil ? .logSet : .edit))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(model.text(.cancel)) { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.text(.saveSet)) {
            model.perform {
              var metrics = SetMetrics(type: type, notes: notes)
              metrics.groupId = selection.metrics.groupId
              let category = selection.exercise.category ?? "strength"
              if !["duration", "distance"].contains(category) {
                metrics.reps = Int(reps)
                metrics.weightKg = weight
              }
              if ["duration", "distance", "mixed"].contains(category) {
                metrics.durationSeconds = seconds
              }
              if ["distance", "mixed"].contains(category) { metrics.distanceMeters = meters }
              if effortType == 1 { metrics.rpe = effort }
              if effortType == 2 { metrics.rir = effort }
              try await save(metrics)
              dismiss()
            }
          }.disabled(model.isBusy || reps < 0 || weight < 0 || seconds < 0 || meters < 0)
            .accessibilityIdentifier("save-set")
        }
      }
      .onAppear {
        let m = selection.metrics
        reps = Double(m.reps ?? 8)
        weight = m.weightKg ?? 0
        seconds = m.durationSeconds ?? 60
        meters = m.distanceMeters ?? 1000
        type = m.type
        notes = m.notes
        effort = m.rpe ?? m.rir ?? 8
        effortType = m.rpe != nil ? 1 : m.rir != nil ? 2 : 0
      }
    }.presentationDetents([.large])
  }
}
struct RestTimerBar: View {
  @Environment(AppModel.self) private var model
  let deadline: Date
  var body: some View {
    GlassEffectContainer {
      HStack {
        Image(systemName: "timer").foregroundStyle(.green)
        Text(model.text(.restTimer)).font(.subheadline.weight(.medium))
        Spacer()
        Text(timerInterval: Date()...deadline, countsDown: true).font(.title3.monospacedDigit())
          .frame(width: 74)
        Button {
          model.restUntil = nil
        } label: {
          Image(systemName: "forward.end.fill")
        }.buttonStyle(.glass).accessibilityLabel(model.text(.skipRest))
      }.padding(16).glassEffect(in: .rect(cornerRadius: 26))
    }.padding(.horizontal, 20).padding(.bottom, 8).task(id: deadline) {
      try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
      if !Task.isCancelled {
        model.restUntil = nil
        UINotificationFeedbackGenerator().notificationOccurred(.success)
      }
    }
  }
}
