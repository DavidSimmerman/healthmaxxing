import SwiftUI

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
                Task { await HealthSync.shared.syncNow() }
            }
        }
    }
}
