import SwiftUI

struct ContentView: View {
    @State private var showSettings = !SyncConfig.isConfigured
    @State private var serverURL = SyncConfig.serverURL.absoluteString
    @State private var apiToken = SyncConfig.apiToken ?? ""
    // Asked fresh each time the sheet opens, not cached: a flag saved once in the past said
    // "granted ✓" forever, even after the app started reading types nobody had approved.
    @State private var needsHealthAccess = false
    @State private var syncing = false

    var body: some View {
        WebView(url: SyncConfig.serverURL)
            .ignoresSafeArea()
            // Hidden settings entry. simultaneousGesture so the WKWebView's own
            // long-press (text selection) doesn't swallow it. ponytail: fires even on
            // a text hold — harmless, it just opens the debug sheet; switch to a shake
            // gesture if the false-trigger ever annoys.
            .simultaneousGesture(
                LongPressGesture(minimumDuration: 1.5).onEnded { _ in showSettings = true }
            )
            .sheet(isPresented: $showSettings) { settingsSheet }
    }

    private var settingsSheet: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Server URL", text: $serverURL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()
                    SecureField("API token", text: $apiToken)
                }
                Section {
                    Button(needsHealthAccess ? "Grant Health access" : "Health access granted ✓") {
                        Task {
                            try? await HealthSync.shared.requestAuthorization()
                            needsHealthAccess = await HealthSync.shared.needsAuthorization()
                            HealthSync.shared.resendWorkouts()
                            runSync()
                        }
                    }
                    .tint(needsHealthAccess ? .orange : nil)
                    .bold(needsHealthAccess)
                    Button(syncing ? "Syncing…" : "Sync now") { runSync() }
                        .disabled(syncing)
                    // Read straight from the store so a background / scene-activation
                    // sync is reflected too; `syncing` toggling forces the re-read.
                    if let last = HealthSync.shared.lastSyncDescription {
                        Text(last).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Sync Settings")
            .task { needsHealthAccess = await HealthSync.shared.needsAuthorization() }
            .toolbar {
                Button("Done") {
                    SyncConfig.save(serverURL: serverURL, apiToken: apiToken)
                    showSettings = false
                    runSync()
                }
            }
        }
    }

    // Runs a sync and surfaces the result. Button actions run on the main actor,
    // so these @State writes re-render the sheet — without this the status text
    // never updated and the button looked dead even when sync succeeded.
    private func runSync() {
        Task {
            syncing = true
            await HealthSync.shared.syncNow()
            syncing = false // re-render picks up the new lastSyncDescription
        }
    }
}
