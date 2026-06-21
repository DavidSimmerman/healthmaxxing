import Foundation

// Where the dashboard lives and how we authenticate to it. The token is the
// server's API_TOKEN env var, pasted once into the in-app settings sheet.
enum SyncConfig {
    static let defaultServer = "https://healthmaxxing.simmerman.tech"

    static var serverURL: URL {
        let raw = UserDefaults.standard.string(forKey: "serverURL") ?? defaultServer
        return URL(string: raw) ?? URL(string: defaultServer)!
    }

    static var apiToken: String? {
        let t = UserDefaults.standard.string(forKey: "apiToken")
        return (t?.isEmpty ?? true) ? nil : t
    }

    static var isConfigured: Bool { apiToken != nil }
}
