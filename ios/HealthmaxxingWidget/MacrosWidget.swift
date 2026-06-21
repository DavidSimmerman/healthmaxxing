import SwiftUI
import WidgetKit

// Home-screen widget: calories + protein left today. Tapping opens the app (via
// the healthmaxxing:// scheme) to the macro tracker. Reads the same server URL +
// API token the app saved, through the shared App Group (see SyncConfig).

// MARK: - API

private struct TodayResponse: Decodable {
    struct Entry: Decodable {
        let calories: Double
        let proteinG: Double
    }
    struct Targets: Decodable {
        let calorieTarget: Double
        let proteinTargetG: Double
    }
    let entries: [Entry]
    let targets: Targets?
}

// Mirrors the app's fallback when no targets row is set.
private let defaultCalorieTarget = 2100.0
private let defaultProteinTarget = 180.0

private func fetchEntry() async -> MacrosEntry {
    guard let token = SyncConfig.apiToken else {
        return MacrosEntry(date: Date(), calLeft: 0, proLeft: 0, state: .needsSetup)
    }
    var req = URLRequest(url: SyncConfig.serverURL.appending(path: "/api/today"))
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.cachePolicy = .reloadIgnoringLocalCacheData
    req.timeoutInterval = 15
    do {
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            return MacrosEntry(date: Date(), calLeft: 0, proLeft: 0, state: .failed)
        }
        let today = try JSONDecoder().decode(TodayResponse.self, from: data)
        let calTarget = today.targets?.calorieTarget ?? defaultCalorieTarget
        let proTarget = today.targets?.proteinTargetG ?? defaultProteinTarget
        let calSum = today.entries.reduce(0) { $0 + $1.calories }
        let proSum = today.entries.reduce(0) { $0 + $1.proteinG }
        return MacrosEntry(
            date: Date(),
            calLeft: Int((calTarget - calSum).rounded()),
            proLeft: Int((proTarget - proSum).rounded()),
            state: .ok)
    } catch {
        return MacrosEntry(date: Date(), calLeft: 0, proLeft: 0, state: .failed)
    }
}

// MARK: - Timeline

struct MacrosEntry: TimelineEntry {
    enum State { case ok, failed, needsSetup }
    let date: Date
    let calLeft: Int
    let proLeft: Int
    let state: State
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> MacrosEntry {
        MacrosEntry(date: Date(), calLeft: 1450, proLeft: 92, state: .ok)
    }

    func getSnapshot(in context: Context, completion: @escaping (MacrosEntry) -> Void) {
        Task { completion(await fetchEntry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MacrosEntry>) -> Void) {
        Task {
            let entry = await fetchEntry()
            // Re-fetch ~every 30 min; WidgetKit budgets refreshes anyway.
            let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())!
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// MARK: - View

struct MacrosWidgetEntryView: View {
    var entry: MacrosEntry

    // App palette (src/routes/layout.css).
    private let bg = Color(hex: 0x0D0D10)
    private let subtle = Color(hex: 0x71717A)
    private let calorie = Color(hex: 0xFB923C)
    private let protein = Color(hex: 0xFDA4AF)
    private let over = Color(hex: 0xFB7185)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LEFT TODAY")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(subtle)

            switch entry.state {
            case .needsSetup:
                Text("Open app to add your API token")
                    .font(.system(size: 13))
                    .foregroundStyle(subtle)
            case .failed:
                Text("Couldn’t load — tap to open")
                    .font(.system(size: 13))
                    .foregroundStyle(over)
            case .ok:
                metric(value: entry.calLeft, unit: "kcal", color: calorie, size: 30)
                metric(value: entry.proLeft, unit: "protein", color: protein, size: 22)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(bg, for: .widget)
        .widgetURL(URL(string: "healthmaxxing://open"))
    }

    @ViewBuilder
    private func metric(value: Int, unit: String, color: Color, size: CGFloat) -> some View {
        let isOver = value < 0
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(isOver ? "+\(-value)" : "\(value)")
                .font(.system(size: size, weight: .bold))
                .foregroundStyle(isOver ? over : color)
            Text(isOver ? "\(unit) over" : "\(unit) left")
                .font(.system(size: 11))
                .foregroundStyle(subtle)
        }
    }
}

// MARK: - Widget

@main
struct MacrosWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MacrosWidget", provider: Provider()) { entry in
            MacrosWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Macros Left")
        .description("Calories and protein remaining today.")
        .supportedFamilies([.systemSmall])
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255)
    }
}
