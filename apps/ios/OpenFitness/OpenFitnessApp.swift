import BackgroundTasks
import OpenFitnessKit
import SwiftUI

@main
struct OpenFitnessApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase
  var body: some Scene {
    WindowGroup {
      RootView().environment(model)
        .environment(\.locale, model.language.locale)
        .environment(\.timeZone, TimeZone(identifier: model.timeZone) ?? .current)
        .tint(.green)
        .task { await model.boot() }
        .onChange(of: scenePhase) { _, phase in
          if phase == .active { Task { await model.refresh() } }
          if phase == .background {
            let request = BGAppRefreshTaskRequest(identifier: "org.openfitness.refresh")
            request.earliestBeginDate = Date().addingTimeInterval(900)
            try? BGTaskScheduler.shared.submit(request)
          }
        }
    }
    .backgroundTask(.appRefresh("org.openfitness.refresh")) { await model.refresh() }
  }
}
