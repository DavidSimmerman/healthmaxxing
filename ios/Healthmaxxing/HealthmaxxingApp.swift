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
                    // A reinstall/rebuild resets HealthKit auth to "not determined", which
                    // makes every query (and thus the whole sync) throw. …IfNeeded self-heals
                    // that, but AT MOST ONCE per process — asking on every activation is what
                    // flashed a blank permission sheet up and down each time you switched
                    // back into the app. See requestAuthorizationIfNeeded for why the status
                    // check alone couldn't stop it.
                    try? await HealthSync.shared.requestAuthorizationIfNeeded()
                    // Sync, THEN refresh the page — refreshing before the metrics POST lands
                    // would just re-show pre-sync numbers. The refresh is a soft one (see
                    // WebView.observeSyncReload): it re-runs the page's data loads in place
                    // rather than tearing down whatever you had open.
                    await HealthSync.shared.syncNow()
                    NotificationCenter.default.post(name: .healthSyncDidFinish, object: nil)
                }
            }
        }
    }
}
