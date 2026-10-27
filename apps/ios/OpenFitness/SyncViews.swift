import OpenFitnessKit
import SwiftUI

struct SyncStatusBanner: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch model.syncStatus {
      case .offline:
        Text(model.text(.syncOffline))
      case .needsSignIn:
        Text(model.text(.signInAgain))
        Button(model.text(.signInAgain)) { model.perform { try await model.signIn() } }
      case .failed(_, let message, _):
        Text(model.text(.syncFailed))
        Text(message).font(.caption)
      case .syncing:
        Text(model.text(.syncing))
      case .idle(let synced):
        if model.pendingSyncCount > 0 {
          Text(String(format: model.text(.syncPendingCount), model.pendingSyncCount))
        } else if let synced {
          Text(String(format: model.text(.lastSynced), synced))
        }
      }
      if let notice = model.accountNotice { Text(notice) }
      if !model.conflictIds.isEmpty {
        NavigationLink(model.text(.conflictTitle)) { ConflictReviewView() }
      }
    }
    .font(.footnote)
    .foregroundStyle(.secondary)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct ConflictReviewView: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    let entries = model.localStore?.outbox().filter { $0.state == "conflict" || $0.state == "failed" || $0.state == "unknown" } ?? []
    List(entries) { entry in
      VStack(alignment: .leading, spacing: 8) {
        Text(entry.name).font(.headline)
        Text(entry.state == "unknown" ? model.text(.outcomeUnknown) : entry.errorMessage ?? model.text(.conflictTitle))
          .font(.subheadline).foregroundStyle(.secondary)
        HStack {
          Button(model.text(.conflictRetryOnLatest)) {
            Task {
              try? await model.syncEngine?.retryConflict(operationId: entry.operationId)
              await model.syncEngine?.drainOutbox()
              model.loadFromStore()
            }
          }
          Button(model.text(.conflictDiscard), role: .destructive) {
            Task {
              try? await model.syncEngine?.discard(operationId: entry.operationId)
              model.loadFromStore()
            }
          }
        }
      }
    }.navigationTitle(model.text(.conflictTitle))
  }
}
