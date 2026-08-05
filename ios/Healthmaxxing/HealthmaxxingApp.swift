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
                    // NOTHING here may present UI. Requesting HealthKit auth on activation is
                    // what flashed a blank sheet up and down — every foreground at first, then
                    // (once gated to one attempt per process) on every cold launch. Two rounds
                    // of trying to make that request behave failed; it turns out it was never
                    // earning its keep, so it's gone. Auth is requested only from the settings
                    // sheet's "Grant Health access" button now, which is a real tap at a moment
                    // UIKit is definitely ready to present. A fresh install opens that sheet on
                    // its own (showSettings = !isConfigured), and if auth is ever lost later,
                    // syncNow surfaces it in lastSyncDescription instead of silently retrying.
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
