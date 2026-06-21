import Foundation

// Where the dashboard lives and how we authenticate to it. The token is the
// server's API_TOKEN env var, pasted once into the in-app settings sheet.
//
// Stored in a shared App Group container so the widget extension (a separate
// process) reads the same server URL + token the app saves. This file is
// compiled into both the app and the widget target.
enum SyncConfig {
    static let appGroup = "group.tech.simmerman.healthmaxxing"
    static let defaultServer = "https://healthmaxxing.simmerman.tech"

    // Falls back to standard defaults if the group container is unavailable, so
    // the app still works even if the entitlement is misconfigured.
    static var store: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }

    static var serverURL: URL {
        let raw = store.string(forKey: "serverURL") ?? defaultServer
        return URL(string: raw) ?? URL(string: defaultServer)!
    }

    static var apiToken: String? {
        let t = store.string(forKey: "apiToken")
        return (t?.isEmpty ?? true) ? nil : t
    }

    static var isConfigured: Bool { apiToken != nil }

    static func save(serverURL: String, apiToken: String) {
        store.set(serverURL, forKey: "serverURL")
        store.set(apiToken, forKey: "apiToken")
    }

    // ponytail: one-time copy from the pre-App-Group storage so the existing
    // token survives the move and the app doesn't pop the settings sheet again.
    static func migrateIfNeeded() {
        guard store.string(forKey: "apiToken") == nil,
              let token = UserDefaults.standard.string(forKey: "apiToken"), !token.isEmpty
        else { return }
        save(
            serverURL: UserDefaults.standard.string(forKey: "serverURL") ?? defaultServer,
            apiToken: token)
    }
}
