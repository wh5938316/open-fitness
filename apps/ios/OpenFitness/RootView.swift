import OpenFitnessKit
import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var model
  @State private var tab = 0
  var body: some View {
    @Bindable var model = model
    Group {
      if model.isConnected {
        TabView(selection: $tab) {
          Tab(model.text(.today), systemImage: "circle.grid.2x2", value: 0) {
            NavigationStack { TodayView() }
          }
          Tab(model.text(.train), systemImage: "dumbbell", value: 1) {
            NavigationStack { TrainingView() }
          }
          Tab(model.text(.food), systemImage: "fork.knife", value: 2) {
            NavigationStack { FoodView() }
          }
          Tab(model.text(.health), systemImage: "heart", value: 3) {
            NavigationStack { HealthView() }
          }
          Tab(model.text(.settings), systemImage: "slider.horizontal.3", value: 4) {
            NavigationStack { SettingsView() }
          }
        }.tabBarMinimizeBehavior(.onScrollDown)
          .onChange(of: tab) { _, value in
            if value == 0
              && model.selectedDay.calendarDay(timeZone: model.timeZone)
                != Date().calendarDay(timeZone: model.timeZone)
            {
              model.selectedDay = Date()
              Task { await model.refresh() }
            }
          }
      } else {
        ConnectView()
      }
    }
    .alert(
      model.text(.error),
      isPresented: Binding(
        get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    ) {
      Button(model.text(.done), role: .cancel) { model.errorMessage = nil }
    } message: {
      Text(model.errorMessage ?? "")
    }
    .overlay(alignment: .top) {
      if model.isBusy {
        ProgressView().padding(12).glassEffect().padding(.top, 6).allowsHitTesting(false)
      }
    }
  }
}
struct ConnectView: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    @Bindable var model = model
    NavigationStack {
      Screen {
        VStack(alignment: .leading, spacing: 22) {
          Image(systemName: "figure.strengthtraining.traditional").font(
            .system(size: 72, weight: .ultraLight)
          ).foregroundStyle(.green).padding(.top, 64).accessibilityHidden(true)
          Text("OpenFitness").font(.system(size: 44, weight: .bold, design: .rounded))
          Text(model.text(.connectHelp)).font(.title2).foregroundStyle(.secondary)
          Surface {
            VStack(alignment: .leading, spacing: 18) {
              Text(model.text(.serverAddress)).font(.caption.weight(.medium)).foregroundStyle(
                .secondary)
              TextField("https://", text: $model.serverAddress).textContentType(.URL).keyboardType(
                .URL
              ).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("server-address")
              Divider()
              Text(model.text(.connectionHelp)).font(.subheadline).foregroundStyle(.secondary)
            }
          }
          Button {
            model.perform { try await model.signIn() }
          } label: {
            Label(model.text(.connectWithPasskey), systemImage: "person.badge.key").fontWeight(
              .semibold
            ).frame(maxWidth: .infinity).padding(.vertical, 9)
          }.buttonStyle(.glassProminent).disabled(model.isBusy).accessibilityIdentifier(
            "connect-button")
          Text(model.text(.privacy)).font(.footnote).foregroundStyle(.secondary).frame(
            maxWidth: .infinity)
        }
      }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            Button(model.text(.english)) { Task { await model.setLanguage(.english) } }
            Button(model.text(.simplifiedChinese)) {
              Task { await model.setLanguage(.simplifiedChinese) }
            }
          } label: {
            Image(systemName: "globe")
          }
        }
      }
    }
  }
}
