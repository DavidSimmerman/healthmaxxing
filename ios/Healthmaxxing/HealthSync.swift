import Foundation
import HealthKit

// HealthKit → dashboard sync.
//
// Four streams:
//  - `days` (→ /api/healthkit): daily activity aggregates (active/basal kcal,
//    steps, exercise minutes) for the trailing window, recomputed each sync.
//    The server upserts by date, so re-pushing today as it grows is the
//    mechanism.
//  - `bodyComp` (→ /api/healthkit): one entry per weigh-in. Anchored query on
//    body mass gives only new samples; body fat % / lean mass written by the
//    scale app at the same moment are correlated by a ±2 min timestamp window.
//  - `workouts` (→ /api/integrations/workouts): anchored query on HKWorkout,
//    with avg/max heart rate pulled from the workout window.
//  - `metrics` (→ /api/integrations/metrics): daily vitals — water, heart
//    rate (resting/min/avg/max), HRV, SpO2, respiratory rate, VO2max, BMI —
//    recomputed per day over the trailing window like `days`.
//
// Background: observer queries + enableBackgroundDelivery wake the app when
// new samples land (Watch sync, Fit Days weigh-in), each triggering a sync.
final class HealthSync {
    static let shared = HealthSync()

    private let store = HKHealthStore()
    private let calendar = Calendar.current

    private let activeEnergy = HKQuantityType(.activeEnergyBurned)
    private let basalEnergy = HKQuantityType(.basalEnergyBurned)
    private let steps = HKQuantityType(.stepCount)
    private let exerciseTime = HKQuantityType(.appleExerciseTime)
    private let bodyMass = HKQuantityType(.bodyMass)
    private let bodyFat = HKQuantityType(.bodyFatPercentage)
    private let leanMass = HKQuantityType(.leanBodyMass)
    private let water = HKQuantityType(.dietaryWater)
    private let heartRate = HKQuantityType(.heartRate)
    private let restingHeartRate = HKQuantityType(.restingHeartRate)
    private let hrv = HKQuantityType(.heartRateVariabilitySDNN)
    private let spo2 = HKQuantityType(.oxygenSaturation)
    private let respiratoryRate = HKQuantityType(.respiratoryRate)
    private let vo2Max = HKQuantityType(.vo2Max)
    private let bmi = HKQuantityType(.bodyMassIndex)

    private let bpm = HKUnit.count().unitDivided(by: .minute())

    private var readTypes: Set<HKObjectType> {
        [
            activeEnergy, basalEnergy, steps, exerciseTime, bodyMass, bodyFat, leanMass,
            water, heartRate, restingHeartRate, hrv, spo2, respiratoryRate, vo2Max, bmi,
            HKObjectType.workoutType(),
        ]
    }

    /// How many trailing days of activity to (re)push each sync. Generous so a
    /// few days of the phone being off never leaves holes.
    private let dayWindow = 14

    private(set) var lastSyncDescription: String? {
        get { UserDefaults.standard.string(forKey: "lastSync") }
        set { UserDefaults.standard.set(newValue, forKey: "lastSync") }
    }

    // MARK: - Authorization & background delivery

    func requestAuthorization() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        try await store.requestAuthorization(toShare: [], read: readTypes)
        startObservers()
    }

    /// Observer queries re-fire whenever HealthKit gets new samples of the
    /// type; background delivery lets that happen while the app is suspended.
    func startObservers() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let observed: [HKSampleType] = [bodyMass, activeEnergy, water, HKObjectType.workoutType()]
        for type in observed {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, _ in
                Task {
                    await self?.syncNow()
                    completion()
                }
            }
            store.execute(query)
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }

    // MARK: - Sync

    func syncNow() async {
        guard SyncConfig.isConfigured, HKHealthStore.isHealthDataAvailable() else { return }
        do {
            let days = try await collectDays()
            let comp = try await collectBodyComp()
            if !days.isEmpty || !comp.isEmpty {
                // First-ever sync can return years of weigh-ins; the server caps a
                // batch at 1000 rows, so chunk. Days ride along with the first chunk.
                let chunks = comp.isEmpty ? [[]] : stride(from: 0, to: comp.count, by: 500).map {
                    Array(comp[$0..<min($0 + 500, comp.count)])
                }
                for (i, chunk) in chunks.enumerated() {
                    try await post(
                        path: "/api/healthkit",
                        body: ["days": i == 0 ? days : [], "bodyComp": chunk])
                }
                commitBodyCompAnchor() // only after a successful POST, so failures retry
            }

            let workouts = try await collectWorkouts()
            if !workouts.isEmpty {
                try await post(path: "/api/integrations/workouts", body: ["workouts": workouts])
                commitWorkoutAnchor()
            }

            let metrics = try await collectMetrics()
            if !metrics.isEmpty {
                try await post(path: "/api/integrations/metrics", body: ["metrics": metrics])
            }

            let f = DateFormatter()
            f.dateStyle = .short
            f.timeStyle = .short
            lastSyncDescription =
                "Last sync \(f.string(from: Date())) — \(days.count) days, \(comp.count) weigh-ins, "
                + "\(workouts.count) workouts, \(metrics.count) metrics"
        } catch {
            lastSyncDescription = "Sync failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Daily aggregates

    private func collectDays() async throws -> [[String: Any]] {
        let end = Date()
        let start = calendar.startOfDay(
            for: calendar.date(byAdding: .day, value: -(dayWindow - 1), to: end)!)

        async let active = sumsByDay(activeEnergy, unit: .kilocalorie(), from: start, to: end)
        async let basal = sumsByDay(basalEnergy, unit: .kilocalorie(), from: start, to: end)
        async let stepCounts = sumsByDay(steps, unit: .count(), from: start, to: end)
        async let exercise = sumsByDay(exerciseTime, unit: .minute(), from: start, to: end)
        let (a, b, s, e) = try await (active, basal, stepCounts, exercise)

        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = calendar

        var days: [[String: Any]] = []
        var cursor = start
        while cursor <= end {
            let key = f.string(from: cursor)
            var day: [String: Any] = ["date": key]
            if let v = a[key] { day["activeKcal"] = v }
            if let v = b[key] { day["basalKcal"] = v }
            if let v = s[key] { day["steps"] = Int(v.rounded()) }
            if let v = e[key] { day["exerciseMin"] = Int(v.rounded()) }
            if day.count > 1 { days.append(day) } // skip days with no data at all
            cursor = calendar.date(byAdding: .day, value: 1, to: cursor)!
        }
        return days
    }

    private func sumsByDay(
        _ type: HKQuantityType, unit: HKUnit, from start: Date, to end: Date
    ) async throws -> [String: Double] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = calendar

        return try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum,
                anchorDate: calendar.startOfDay(for: start),
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { _, collection, error in
                if let error { return cont.resume(throwing: error) }
                var out: [String: Double] = [:]
                collection?.enumerateStatistics(from: start, to: end) { stat, _ in
                    if let sum = stat.sumQuantity() {
                        out[f.string(from: stat.startDate)] = sum.doubleValue(for: unit)
                    }
                }
                cont.resume(returning: out)
            }
            store.execute(query)
        }
    }

    // MARK: - Body composition

    /// Anchor staged here between query and successful POST.
    private var pendingAnchor: HKQueryAnchor?

    private func collectBodyComp() async throws -> [[String: Any]] {
        let anchor: HKQueryAnchor? = UserDefaults.standard.data(forKey: "bodyMassAnchor")
            .flatMap {
                try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0)
            }

        let (samples, newAnchor) = try await anchoredSamples(bodyMass, anchor: anchor)
        pendingAnchor = newAnchor

        var entries: [[String: Any]] = []
        let iso = ISO8601DateFormatter()
        for sample in samples {
            let at = sample.startDate
            var entry: [String: Any] = [
                "hkUuid": sample.uuid.uuidString,
                "measuredAt": iso.string(from: at),
                "weightKg": sample.quantity.doubleValue(for: .gramUnit(with: .kilo)),
                "source": sample.sourceRevision.source.bundleIdentifier,
            ]
            // The scale app writes composition samples at (nearly) the same
            // instant as the weight — pick them up from a ±2 min window.
            if let fat = try await nearestQuantity(bodyFat, around: at) {
                entry["bodyFatPct"] = fat.doubleValue(for: .percent()) * 100
            }
            if let lean = try await nearestQuantity(leanMass, around: at) {
                entry["leanMassKg"] = lean.doubleValue(for: .gramUnit(with: .kilo))
            }
            entries.append(entry)
        }
        return entries
    }

    private func commitBodyCompAnchor() {
        guard let anchor = pendingAnchor,
            let data = try? NSKeyedArchiver.archivedData(
                withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        UserDefaults.standard.set(data, forKey: "bodyMassAnchor")
        pendingAnchor = nil
    }

    private func anchoredSamples(
        _ type: HKQuantityType, anchor: HKQueryAnchor?
    ) async throws -> ([HKQuantitySample], HKQueryAnchor?) {
        try await withCheckedThrowingContinuation { cont in
            let query = HKAnchoredObjectQuery(
                type: type, predicate: nil, anchor: anchor, limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
                if let error { return cont.resume(throwing: error) }
                cont.resume(returning: ((samples as? [HKQuantitySample]) ?? [], newAnchor))
            }
            store.execute(query)
        }
    }

    private func nearestQuantity(
        _ type: HKQuantityType, around date: Date
    ) async throws -> HKQuantity? {
        let predicate = HKQuery.predicateForSamples(
            withStart: date.addingTimeInterval(-120), end: date.addingTimeInterval(120))
        return try await withCheckedThrowingContinuation { cont in
            let query = HKSampleQuery(
                sampleType: type, predicate: predicate, limit: 1,
                sortDescriptors: [
                    NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                ]
            ) { _, samples, error in
                if let error { return cont.resume(throwing: error) }
                cont.resume(returning: (samples?.first as? HKQuantitySample)?.quantity)
            }
            store.execute(query)
        }
    }

    // MARK: - Workouts

    /// Workout anchor staged here between query and successful POST.
    private var pendingWorkoutAnchor: HKQueryAnchor?

    private func collectWorkouts() async throws -> [[String: Any]] {
        let anchor: HKQueryAnchor? = UserDefaults.standard.data(forKey: "workoutAnchor")
            .flatMap {
                try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0)
            }

        let (samples, newAnchor): ([HKSample], HKQueryAnchor?) =
            try await withCheckedThrowingContinuation { cont in
                let query = HKAnchoredObjectQuery(
                    type: HKObjectType.workoutType(), predicate: nil, anchor: anchor,
                    limit: HKObjectQueryNoLimit
                ) { _, samples, _, newAnchor, error in
                    if let error { return cont.resume(throwing: error) }
                    cont.resume(returning: (samples ?? [], newAnchor))
                }
                store.execute(query)
            }
        pendingWorkoutAnchor = newAnchor

        var entries: [[String: Any]] = []
        let iso = ISO8601DateFormatter()
        for case let workout as HKWorkout in samples {
            var entry: [String: Any] = [
                "hkUuid": workout.uuid.uuidString,
                "name": Self.activityName(workout.workoutActivityType),
                "start": iso.string(from: workout.startDate),
                "end": iso.string(from: workout.endDate),
            ]
            if let energy = workout.statistics(for: activeEnergy)?.sumQuantity()
                ?? workout.totalEnergyBurned
            {
                entry["kcal"] = energy.doubleValue(for: .kilocalorie())
            }
            if let stats = try await heartRateStats(from: workout.startDate, to: workout.endDate) {
                if let avg = stats.averageQuantity() {
                    entry["avgHr"] = avg.doubleValue(for: bpm)
                }
                if let max = stats.maximumQuantity() {
                    entry["maxHr"] = max.doubleValue(for: bpm)
                }
            }
            entries.append(entry)
        }
        return entries
    }

    private func commitWorkoutAnchor() {
        guard let anchor = pendingWorkoutAnchor,
            let data = try? NSKeyedArchiver.archivedData(
                withRootObject: anchor, requiringSecureCoding: true)
        else { return }
        UserDefaults.standard.set(data, forKey: "workoutAnchor")
        pendingWorkoutAnchor = nil
    }

    private func heartRateStats(from start: Date, to end: Date) async throws -> HKStatistics? {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        return try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsQuery(
                quantityType: heartRate, quantitySamplePredicate: predicate,
                options: [.discreteAverage, .discreteMax]
            ) { _, stats, error in
                if let error { return cont.resume(throwing: error) }
                cont.resume(returning: stats)
            }
            store.execute(query)
        }
    }

    /// Common activity types, mapped to readable names. Extend as needed.
    private static func activityName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .traditionalStrengthTraining: return "Strength Training"
        case .functionalStrengthTraining: return "Functional Strength"
        case .running: return "Run"
        case .walking: return "Walk"
        case .hiking: return "Hike"
        case .cycling: return "Cycle"
        case .swimming: return "Swim"
        case .rowing: return "Rowing"
        case .elliptical: return "Elliptical"
        case .stairClimbing: return "Stair Climbing"
        case .highIntensityIntervalTraining: return "HIIT"
        case .yoga: return "Yoga"
        case .pilates: return "Pilates"
        case .coreTraining: return "Core Training"
        case .flexibility: return "Stretching"
        case .basketball: return "Basketball"
        case .soccer: return "Soccer"
        case .tennis: return "Tennis"
        case .golf: return "Golf"
        case .mixedCardio: return "Mixed Cardio"
        case .crossTraining: return "Cross Training"
        case .martialArts: return "Martial Arts"
        case .climbing: return "Climbing"
        default: return "Workout"
        }
    }

    // MARK: - Daily vitals

    /// Daily metric definitions: HealthKit type → (metric key, unit, how to
    /// aggregate a day). Adding a row here is all it takes to ship a new
    /// metric — the server table is (date, metric, value).
    private func collectMetrics() async throws -> [[String: Any]] {
        let end = Date()
        let start = calendar.startOfDay(
            for: calendar.date(byAdding: .day, value: -(dayWindow - 1), to: end)!)

        var metrics: [[String: Any]] = []
        func add(_ byDay: [String: Double], as name: String, scale: Double = 1) {
            for (date, value) in byDay {
                metrics.append(["date": date, "metric": name, "value": value * scale])
            }
        }

        async let waterByDay = sumsByDay(water, unit: .liter(), from: start, to: end)
        async let restingByDay = discreteByDay(restingHeartRate, unit: bpm, .discreteAverage, from: start, to: end)
        async let hrAvgByDay = discreteByDay(heartRate, unit: bpm, .discreteAverage, from: start, to: end)
        async let hrMinByDay = discreteByDay(heartRate, unit: bpm, .discreteMin, from: start, to: end)
        async let hrMaxByDay = discreteByDay(heartRate, unit: bpm, .discreteMax, from: start, to: end)
        async let hrvByDay = discreteByDay(hrv, unit: .secondUnit(with: .milli), .discreteAverage, from: start, to: end)
        async let spo2ByDay = discreteByDay(spo2, unit: .percent(), .discreteAverage, from: start, to: end)
        async let respByDay = discreteByDay(respiratoryRate, unit: bpm, .discreteAverage, from: start, to: end)
        async let vo2ByDay = discreteByDay(vo2Max, unit: HKUnit(from: "ml/kg*min"), .discreteAverage, from: start, to: end)
        async let bmiByDay = discreteByDay(bmi, unit: .count(), .discreteAverage, from: start, to: end)

        add(try await waterByDay, as: "water_l")
        add(try await restingByDay, as: "resting_hr")
        add(try await hrAvgByDay, as: "hr_avg")
        add(try await hrMinByDay, as: "hr_min")
        add(try await hrMaxByDay, as: "hr_max")
        add(try await hrvByDay, as: "hrv_ms")
        add(try await spo2ByDay, as: "spo2_pct", scale: 100)
        add(try await respByDay, as: "resp_rate")
        add(try await vo2ByDay, as: "vo2max")
        add(try await bmiByDay, as: "bmi")
        return metrics
    }

    /// Like sumsByDay but for discrete types (heart rate, HRV, SpO2…): one
    /// avg/min/max value per day.
    private func discreteByDay(
        _ type: HKQuantityType, unit: HKUnit, _ option: HKStatisticsOptions,
        from start: Date, to end: Date
    ) async throws -> [String: Double] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = calendar

        return try await withCheckedThrowingContinuation { cont in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: option,
                anchorDate: calendar.startOfDay(for: start),
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { _, collection, error in
                if let error { return cont.resume(throwing: error) }
                var out: [String: Double] = [:]
                collection?.enumerateStatistics(from: start, to: end) { stat, _ in
                    let quantity: HKQuantity? =
                        switch option {
                        case .discreteMin: stat.minimumQuantity()
                        case .discreteMax: stat.maximumQuantity()
                        default: stat.averageQuantity()
                        }
                    if let quantity {
                        out[f.string(from: stat.startDate)] = quantity.doubleValue(for: unit)
                    }
                }
                cont.resume(returning: out)
            }
            store.execute(query)
        }
    }

    // MARK: - Upload

    private func post(path: String, body: [String: Any]) async throws {
        guard let token = SyncConfig.apiToken else { return }
        var request = URLRequest(url: SyncConfig.serverURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else {
            let detail = String(data: data, encoding: .utf8) ?? ""
            throw NSError(
                domain: "HealthSync", code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey: "Server rejected sync: \(detail.prefix(200))"
                ])
        }
    }
}
