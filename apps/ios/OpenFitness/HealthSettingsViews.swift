import OpenFitnessKit
import SwiftUI

struct HealthView: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    Screen {
      Image(systemName: "heart.text.clipboard").font(.system(size: 54, weight: .ultraLight))
        .foregroundStyle(.pink).padding(.top, 10).accessibilityHidden(true)
      Text(model.text(.appleHealth)).font(.system(.largeTitle, design: .rounded).bold())
      Text(model.text(.healthHelp)).foregroundStyle(.secondary)
      Surface {
        VStack(alignment: .leading, spacing: 16) {
          Label(
            model.text(model.healthEnabled ? .healthReady : .healthDisabled),
            systemImage: model.healthEnabled ? "checkmark.circle.fill" : "circle"
          ).foregroundStyle(model.healthEnabled ? .green : .secondary).font(.headline)
          if model.context?.capabilities.healthSyncProtocol == nil && !model.isPreview {
            Text(model.text(.updateServer)).font(.subheadline).foregroundStyle(.secondary)
          } else {
            Button {
              model.perform { try await model.enableHealth() }
            } label: {
              Label(model.text(.enableHealth), systemImage: "heart.fill").frame(maxWidth: .infinity)
                .padding(.vertical, 5)
            }.buttonStyle(.glassProminent).disabled(model.isBusy)
            if model.healthEnabled {
              Button(model.text(.syncNow)) { Task { await model.synchronizeHealth() } }.buttonStyle(
                .glass)
              Button(model.text(.disableHealth)) { model.disableHealth() }.font(.footnote)
            }
          }
          if let status = model.healthStatus {
            Divider()
            LabeledContent(model.text(.pending), value: String(status.pendingCount))
            if let date = status.lastDeliveredAt.flatMap(Date.parseISO) {
              LabeledContent(model.text(.lastSync)) {
                Text(date, format: .dateTime.month().day().hour().minute())
              }
            } else {
              Text(model.text(.neverSynced)).font(.caption).foregroundStyle(.secondary)
            }
            if status.writerDeviceId != nil {
              Button(model.text(.useThisPhone)) { model.perform { try await model.selectWriter() } }
                .font(.subheadline)
            }
          }
        }
      }
      Surface {
        VStack(alignment: .leading, spacing: 14) {
          Toggle(
            model.text(.shareHealth),
            isOn: Binding(
              get: { model.sharesHealth },
              set: { enabled in model.perform { try await model.enableSharing(enabled) } }))
          Text(model.text(.shareHealthHelp)).font(.footnote).foregroundStyle(.secondary)
        }
      }
      if let summary = model.healthSummary {
        Surface {
          VStack(spacing: 20) {
            HStack {
              MetricValue(
                title: model.text(.steps), value: model.copy.number(summary.steps), unit: "",
                icon: "figure.walk")
              MetricValue(
                title: model.text(.bodyMass),
                value: model.copy.number(summary.bodyMassKg, digits: 1), unit: model.text(.kg),
                icon: "scalemass")
            }
            HStack {
              MetricValue(
                title: model.text(.activeEnergy),
                value: model.copy.number(summary.activeEnergyKcal), unit: model.text(.kcal),
                icon: "flame")
              MetricValue(
                title: model.text(.restingHeartRate),
                value: model.copy.number(summary.restingHeartRateBpm), unit: model.text(.bpm),
                icon: "heart")
            }
          }
        }
      }
      Text(model.text(.watchHelp)).font(.footnote).foregroundStyle(.secondary)
    }.navigationTitle(model.text(.health)).navigationBarTitleDisplayMode(.inline)
  }
}
struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @State private var confirmsDisconnect = false
  var body: some View {
    Form {
      Section(model.text(.connectedServer)) {
        Text(model.serverAddress).textSelection(.enabled).font(.subheadline)
        LabeledContent(model.text(.timeZone), value: model.timeZone)
      }
      Section(model.text(.language)) {
        Picker(
          model.text(.language),
          selection: Binding(
            get: { model.language }, set: { value in Task { await model.setLanguage(value) } })
        ) {
          Text(model.text(.english)).tag(AppLanguage.english)
          Text(model.text(.simplifiedChinese)).tag(AppLanguage.simplifiedChinese)
        }.pickerStyle(.segmented)
      }
      Section(model.text(.watch)) {
        Text(model.text(.watchHelp)).font(.subheadline).foregroundStyle(.secondary)
        Button(model.text(.requestSync)) { model.sendCompanion() }
      }
      if !model.journal.commands.isEmpty {
        Section(model.text(.pendingChanges)) {
          ForEach(model.journal.commands) { command in
            VStack(alignment: .leading, spacing: 4) {
              Text(
                model.text(
                  command.kind == .startWorkout
                    ? .startWorkout
                    : command.kind == .logSet
                      ? .logSet : command.kind == .finishWorkout ? .finishWorkout : .cancelWorkout)
              ).font(.subheadline)
              if let code = command.failureCode {
                Text(model.copy.error(APIError(code, status: code == "VERSION_CONFLICT" ? 409 : 0)))
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          }
          Button(model.text(.clearError)) { Task { await model.retryPending() } }
        }
      }
      Section(model.text(.about)) {
        LabeledContent("OpenFitness", value: "0.2.0")
        Text(model.text(.privacy)).font(.subheadline).foregroundStyle(.secondary)
        Link("MIT · GitHub", destination: URL(string: "https://github.com/wh5938316/open-fitness")!)
      }
      Section {
        Button(model.text(.disconnect), role: .destructive) { confirmsDisconnect = true }
      } footer: {
        Text(model.text(.disconnectHelp))
      }
    }.navigationTitle(model.text(.settings))
      .confirmationDialog(
        model.text(.disconnect), isPresented: $confirmsDisconnect, titleVisibility: .visible
      ) {
        Button(model.text(.disconnect), role: .destructive) { Task { await model.disconnect() } }
      }
  }
}
