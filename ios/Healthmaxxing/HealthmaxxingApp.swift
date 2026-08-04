import SwiftUI

extension Notification.Name {
    // Posted after a foreground sync finishes so the WebView reloads and shows
    // freshly-pushed metrics (e.g. today's water) instead of pre-sync data.
    static let healthSyncDidFinish = Notification.Name("healthSyncDidFinish")
}

@main
struct HealthmaxxingApp: App {
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Move any pre-App-Group token into the shared container so the widget
        // can read it (no-op after the first run).
        SyncConfig.migrateIfNeeded()
        // Re-arm observers on every launch — including launches initiated by
        // HealthKit background delivery, where no UI ever appears.
        HealthSync.shared.startObservers()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    // Re-request first: a reinstall/rebuild resets HealthKit auth to
                    // "not determined", which makes every query (and thus the whole
                    // sync) throw, so checking each foreground self-heals that case.
                    // …IfNeeded, though: requestAuthorization is NOT a silent no-op when
                    // everything's already granted — it still flashes the permission
                    // sheet up and back down. That was the blank drawer on every launch.
                    try? await HealthSync.shared.requestAuthorizationIfNeeded()
                    // Sync, THEN reload the WebView — reloading before the metrics POST
                    // lands would just re-show the stale page. reload() keeps the
                    // current page, only re-fetching its data.
                    await HealthSync.shared.syncNow()
                    NotificationCenter.default.post(name: .healthSyncDidFinish, object: nil)
                }
            }
        }
    }
}
