import OpenFitnessKit
import SwiftUI
import WatchKit

@main
struct OpenFitnessWatchApp: App {
  @State private var model = WatchModel()
  @WKExtensionDelegateAdaptor(WorkoutRecoveryDelegate.self) private var delegate
  var body: some Scene {
    WindowGroup {
      WatchRootView().environment(model).environment(\.locale, model.language.locale).tint(.green)
        .onReceive(NotificationCenter.default.publisher(for: .init("OpenFitnessRecoverWorkout"))) {
          _ in Task { await model.health.recover() }
        }
        .task {
          model.requestSync()
          await model.health.recover()
        }
    }
  }
}
final class WorkoutRecoveryDelegate: NSObject, WKExtensionDelegate {
  func handleActiveWorkoutRecovery() {
    NotificationCenter.default.post(name: .init("OpenFitnessRecoverWorkout"), object: nil)
  }
}
struct WatchRootView: View {
  @Environment(WatchModel.self) private var model
  var body: some View {
    TabView {
      WatchTrainingView()
      WatchMetricsView()
      NavigationStack {
        List {
          Label(
            model.text(model.reachable ? .synced : .watchOffline),
            systemImage: model.reachable ? "iphone" : "iphone.slash")
          Text(model.text(.watchHelp)).font(.footnote).foregroundStyle(.secondary)
          LabeledContent(model.text(.pendingChanges), value: String(model.journal.commands.count))
          Button(model.text(.requestSync)) { model.requestSync() }.buttonStyle(.glass)
        }.navigationTitle(model.text(.settings))
      }
    }.tabViewStyle(.verticalPage)
      .alert(
        model.text(.error),
        isPresented: Binding(
          get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
      ) {
        Button(model.text(.done), role: .cancel) { model.errorMessage = nil }
      } message: {
        Text(model.errorMessage ?? "")
      }
  }
}
struct WatchTrainingView: View {
  @Environment(WatchModel.self) private var model
  @State private var exerciseIndex = 0
  @State private var editing = false
  @State private var ending = false
  @State private var finishing = false
  var body: some View {
    NavigationStack {
      if let workout = model.workout {
        let entries = workout.data.plan?.snapshot.exercises ?? []
        ScrollView {
          VStack(spacing: 12) {
            HStack {
              Label(model.copy.number(model.health.heartRate), systemImage: "heart.fill")
                .foregroundStyle(.pink)
              Spacer()
              if let start = Date.parseISO(workout.data.startedAt) {
                Text(start, style: .timer).monospacedDigit()
              }
            }.font(.caption)
            if !model.reachable {
              Text(model.text(.watchOffline)).font(.caption2).foregroundStyle(.secondary)
            }
            if !entries.isEmpty {
              let entry = entries[min(exerciseIndex, entries.count - 1)]
              Text(entry.exerciseSnapshot.name).font(.title3.bold()).frame(
                maxWidth: .infinity, alignment: .leading
              ).padding(.top, 8)
              HStack {
                Text(
                  "\(workout.data.sets.filter { $0.exerciseId == entry.exerciseId }.count) / \(entry.sets.count)"
                ).font(.system(size: 34, weight: .semibold, design: .rounded)).monospacedDigit()
                Spacer()
                Text(model.text(.sets)).font(.caption).foregroundStyle(.secondary)
              }
              if !entry.sets.isEmpty {
                WatchMetricsLine(
                  metrics: entry.sets[
                    min(
                      workout.data.sets.filter { $0.exerciseId == entry.exerciseId }.count,
                      entry.sets.count - 1)])
              }
              Button {
                editing = true
              } label: {
                Label(model.text(.logSet), systemImage: "plus").frame(maxWidth: .infinity)
              }.buttonStyle(.glassProminent).accessibilityIdentifier("watch-log-set")
              HStack {
                Button {
                  exerciseIndex = max(0, exerciseIndex - 1)
                } label: {
                  Image(systemName: "chevron.left")
                }.disabled(exerciseIndex == 0)
                Spacer()
                Text("\(exerciseIndex + 1) / \(entries.count)").font(.caption2).foregroundStyle(
                  .secondary)
                Spacer()
                Button {
                  exerciseIndex = min(entries.count - 1, exerciseIndex + 1)
                } label: {
                  Image(systemName: "chevron.right")
                }.disabled(exerciseIndex >= entries.count - 1)
              }.buttonStyle(.glass)
              if let rest = model.restUntil, rest > Date() {
                Text(timerInterval: Date()...rest, countsDown: true).font(.title2.monospacedDigit())
                  .foregroundStyle(.green)
                Button(model.text(.skipRest)) { model.restUntil = nil }.font(.caption)
              }
            }
            if model.health.running {
              Button(model.text(model.health.paused ? .continueSession : .pause)) {
                model.health.togglePause()
              }.buttonStyle(.glass)
            } else {
              Button(model.text(.continueSession)) {
                Task {
                  do { try await model.health.start() } catch {
                    model.errorMessage = model.text(.healthDenied)
                  }
                }
              }.font(.caption)
            }
            Button(model.text(.endSession), role: .destructive) { ending = true }.buttonStyle(
              .glass
            ).padding(.top, 8).disabled(finishing)
          }.padding(.horizontal, 4)
        }.navigationTitle(model.text(.train))
          .sheet(isPresented: $editing) {
            if !entries.isEmpty {
              let entry = entries[min(exerciseIndex, entries.count - 1)]
              WatchSetEditor(
                entry: entry,
                target: entry.sets.isEmpty
                  ? .init()
                  : entry.sets[
                    min(
                      workout.data.sets.filter { $0.exerciseId == entry.exerciseId }.count,
                      entry.sets.count - 1)])
            }
          }
          .confirmationDialog(
            model.text(.finishConfirmation), isPresented: $ending, titleVisibility: .visible
          ) {
            Button(model.text(.finishWorkout)) {
              finishing = true
              Task {
                await model.finish()
                finishing = false
              }
            }
            Button(model.text(.cancelWorkout), role: .destructive) {
              finishing = true
              Task {
                await model.finish(cancel: true)
                finishing = false
              }
            }
          }
      } else {
        List {
          if model.snapshot?.connected != true {
            Text(model.text(.pairPhone)).font(.headline)
            Text(model.text(.watchHelp)).font(.footnote).foregroundStyle(.secondary)
          }
          ForEach(model.snapshot?.plans ?? []) { plan in
            Button {
              Task { await model.start(plan) }
            } label: {
              VStack(alignment: .leading, spacing: 5) {
                Text(plan.data.name).font(.headline)
                Text("\(plan.data.exercises.count) \(model.text(.exercises))").font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
          }
          if model.snapshot?.plans.isEmpty ?? true {
            Button(model.text(.requestSync)) { model.requestSync() }
          }
        }.navigationTitle("OpenFitness")
      }
    }
  }
}
private struct WatchMetricsLine: View {
  @Environment(WatchModel.self) private var model
  let metrics: SetMetrics
  var body: some View {
    HStack {
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
    }.font(.caption).foregroundStyle(.secondary)
  }
}
private struct WatchSetEditor: View {
  @Environment(WatchModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var entry: PlannedExercise
  var target: SetMetrics
  @State private var reps = 8
  @State private var weight = 0.0
  @State private var seconds = 60.0
  @State private var meters = 1000.0
  @State private var withEffort = false
  @State private var effort = 8.0
  var body: some View {
    NavigationStack {
      Form {
        if !["duration", "distance"].contains(entry.exerciseSnapshot.category ?? "") {
          Stepper("\(model.text(.reps)) \(reps)", value: $reps, in: 0...200)
          Stepper(
            "\(model.copy.number(weight, digits: 1)) \(model.text(.kg))", value: $weight,
            in: 0...1000, step: 2.5)
        }
        if ["duration", "distance", "mixed"].contains(entry.exerciseSnapshot.category ?? "") {
          Stepper(
            "\(model.copy.number(seconds)) \(model.text(.sec))", value: $seconds, in: 0...14400,
            step: 15)
        }
        if entry.exerciseSnapshot.category == "distance" {
          Stepper(
            "\(model.copy.number(meters)) \(model.text(.m))", value: $meters, in: 0...100000,
            step: 100)
        }
        Toggle("RPE", isOn: $withEffort)
        if withEffort {
          Stepper(
            "RPE \(model.copy.number(effort, digits: 1))", value: $effort, in: 0...10, step: 0.5)
        }
        Button(model.text(.saveSet)) {
          var metrics = target
          let category = entry.exerciseSnapshot.category ?? "strength"
          if !["duration", "distance"].contains(category) {
            metrics.reps = reps
            metrics.weightKg = weight
          }
          if ["duration", "distance", "mixed"].contains(category) {
            metrics.durationSeconds = seconds
          }
          if category == "distance" { metrics.distanceMeters = meters }
          metrics.groupId = entry.groupId ?? metrics.groupId
          metrics.rpe = withEffort ? effort : nil
          model.logSet(exercise: entry, metrics: metrics)
          WKInterfaceDevice.current().play(.success)
          dismiss()
        }.buttonStyle(.glassProminent).accessibilityIdentifier("watch-save-set")
      }.navigationTitle(model.text(.logSet))
        .onAppear {
          reps = target.reps ?? 8
          weight = target.weightKg ?? 0
          seconds = target.durationSeconds ?? 60
          meters = target.distanceMeters ?? 1000
        }
    }
  }
}
private struct WatchMetricsView: View {
  @Environment(WatchModel.self) private var model
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Label(model.text(.heartRate), systemImage: "heart.fill").font(.caption).foregroundStyle(
            .pink)
          Text(model.copy.number(model.health.heartRate)).font(
            .system(size: 46, weight: .medium, design: .rounded)
          ).monospacedDigit()
          Label(model.text(.activeEnergy), systemImage: "flame").font(.caption).foregroundStyle(
            .secondary)
          Text("\(model.copy.number(model.health.activeEnergy)) \(model.text(.kcal))").font(.title3)
          Divider()
          Text(model.text(.nutrition)).font(.headline)
          Text(
            "\(model.copy.number(model.snapshot?.nutrition?.nutrients.energyKcal)) \(model.text(.kcal))"
          ).font(.title2)
          if let updatedAt = model.snapshot?.updatedAt, let date = Date.parseISO(updatedAt) {
            Text(date, style: .relative).font(.caption2).foregroundStyle(.secondary)
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.navigationTitle(model.text(.today))
    }
  }
}
