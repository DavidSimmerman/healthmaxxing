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
                // Sync first, THEN tell the WebView to reload — reloading before the
                // metrics POST lands would just re-show the stale page (the bug this
                // fixes). reload() keeps the current page, only re-fetching its data.
                Task {
                    await HealthSync.shared.syncNow()
                    NotificationCenter.default.post(name: .healthSyncDidFinish, object: nil)
                }
            }
        }
    }
}
