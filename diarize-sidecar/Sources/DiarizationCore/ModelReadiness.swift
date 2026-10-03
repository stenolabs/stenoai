import CoreML
import FluidAudio
import Foundation

public struct ModelReadinessStatus: Codable, Equatable, Sendable {
    public let ready: Bool
    public let cacheDirectory: String
    public let requiredModels: [String]
    public let missingModels: [String]

    enum CodingKeys: String, CodingKey {
        case ready
        case cacheDirectory = "cache_directory"
        case requiredModels = "required_models"
        case missingModels = "missing_models"
    }
}

public enum ModelReadiness {
    private static let modelDirectoryEnvironmentKey = "STENOAI_DIARIZE_MODEL_DIR"
    private static let userDataEnvironmentKey = "STENOAI_USER_DATA_DIR"

    /// The one Sortformer config the sidecar runs. Short recordings are padded
    /// to its minimum window (see main.swift), so `.default`'s bundle is never
    /// needed or downloaded.
    public static let sortformerConfig: SortformerConfig = .highContextV2

    /// Sortformer bundles an earlier release prepared and nothing loads now.
    static let retiredSortformerConfigs: [SortformerConfig] = [.default]

    public static let requiredModelRelativePaths: [String] = {
        let sortformerBundles = [sortformerConfig]
            .compactMap { ModelNames.Sortformer.bundle(for: $0) }
            .map { "sortformer/\($0)" }
        let embeddingBundles = DiarizerModels.requiredModelNames
            .sorted()
            .map { "speaker-diarization/\($0)" }
        return sortformerBundles + embeddingBundles
    }()

    public static func cacheDirectory(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        if let override = nonEmpty(environment[modelDirectoryEnvironmentKey]) {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        if let userData = nonEmpty(environment[userDataEnvironmentKey]) {
            return URL(fileURLWithPath: userData, isDirectory: true)
                .appendingPathComponent("models/speaker-diarization", isDirectory: true)
        }
        return homeDirectory
            .appendingPathComponent("Library/Application Support/stenoai", isDirectory: true)
            .appendingPathComponent("models/speaker-diarization", isDirectory: true)
    }

    public static func runtimeCacheDirectory(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        let preferred = cacheDirectory(environment: environment, homeDirectory: homeDirectory)
        if nonEmpty(environment[modelDirectoryEnvironmentKey]) != nil
            || nonEmpty(environment[userDataEnvironmentKey]) != nil
        {
            return preferred
        }
        if missingModelPaths(in: preferred).isEmpty {
            return preferred
        }
        let legacy = homeDirectory
            .appendingPathComponent("Library/Application Support/FluidAudio/Models", isDirectory: true)
        return missingModelPaths(in: legacy).isEmpty ? legacy : preferred
    }

    public static func status(cacheDirectory: URL? = nil) -> ModelReadinessStatus {
        let resolvedCacheDirectory = cacheDirectory ?? runtimeCacheDirectory()
        let missing = missingModelPaths(in: resolvedCacheDirectory)
        return ModelReadinessStatus(
            ready: missing.isEmpty,
            cacheDirectory: resolvedCacheDirectory.path,
            requiredModels: requiredModelRelativePaths,
            missingModels: missing
        )
    }

    private static func missingModelPaths(in cacheDirectory: URL) -> [String] {
        requiredModelRelativePaths.filter { relativePath in
            !isCompleteModelBundle(
                cacheDirectory.appendingPathComponent(relativePath, isDirectory: true),
                relativePath: relativePath
            )
        }
    }

    public static func prepare(
        cacheDirectory: URL = cacheDirectory(),
        computeUnits: MLComputeUnits = .cpuAndNeuralEngine,
        progressHandler: DownloadUtils.ProgressHandler? = nil
    ) async throws -> ModelReadinessStatus {
        DownloadUtils.enforceOffline = false
        try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)

        // Only the Sortformer download is measurable (bytes; see
        // DownloadByteMonitor), so it alone fills the bar. Everything after it
        // -- the CoreML compile for this Mac (over a minute on an M3 Max) and
        // the ~13 MB embedding models -- reports as the "compiling" phase,
        // which the UI shows as activity rather than an invented percentage.
        // FluidAudio reports downloading as each load's 0...0.5 and compiling
        // as 0.5...1.
        _ = try await SortformerModels.loadFromHuggingFace(
            config: sortformerConfig,
            cacheDirectory: cacheDirectory,
            computeUnits: computeUnits,
            progressHandler: banded(progressHandler, download: 0.0...1.0, compile: 1.0...1.0)
        )
        _ = try await DiarizerModels.downloadIfNeeded(
            to: cacheDirectory.appendingPathComponent("speaker-diarization", isDirectory: true),
            configuration: MLModelConfigurationUtils.defaultConfiguration(computeUnits: computeUnits),
            progressHandler: banded(progressHandler, download: 1.0...1.0, compile: 1.0...1.0)
        )
        removeRetiredBundles(in: cacheDirectory)

        let result = status(cacheDirectory: cacheDirectory)
        guard result.ready else {
            throw CocoaError(
                .fileReadCorruptFile,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Speaker diarization model setup completed with missing model bundles: "
                        + result.missingModels.joined(separator: ", ")
                ]
            )
        }
        return result
    }

    /// Overall progress at or past this point is reported as preparing, so
    /// the label only ever moves forward (download, then prepare) even though
    /// the small embedding models still download after Sortformer compiles.
    public static let preparingFrom = 1.0

    /// Size of the Sortformer bundle download, for DownloadByteMonitor's
    /// fraction. Approximate by design: the monitor caps below 100%, and the
    /// band only completes on FluidAudio's own end-of-download event.
    public static let approximateSortformerDownloadBytes: Double = 243_000_000

    /// Where one FluidAudio load's own fraction lands on the overall bar.
    public static func overallFraction(
        _ fraction: Double,
        compiling: Bool,
        download: ClosedRange<Double>,
        compile: ClosedRange<Double>
    ) -> Double {
        let f = min(max(fraction, 0), 1)
        if compiling {
            return compile.lowerBound + (compile.upperBound - compile.lowerBound) * max(0, (f - 0.5) / 0.5)
        }
        return download.lowerBound + (download.upperBound - download.lowerBound) * min(1, f / 0.5)
    }

    static func banded(
        _ handler: DownloadUtils.ProgressHandler?,
        download: ClosedRange<Double>,
        compile: ClosedRange<Double>
    ) -> DownloadUtils.ProgressHandler? {
        guard let handler else { return nil }
        return { progress in
            let compiling: Bool
            switch progress.phase {
            case .compiling: compiling = true
            case .listing, .downloading: compiling = false
            }
            let overall = overallFraction(
                progress.fractionCompleted, compiling: compiling, download: download, compile: compile
            )
            handler(DownloadUtils.DownloadProgress(
                fractionCompleted: overall,
                phase: overall >= preparingFrom
                    ? .compiling(modelName: "")
                    : .downloading(completedFiles: 0, totalFiles: 0)
            ))
        }
    }

    /// Reclaim the ~230 MB `.default` Sortformer bundle an earlier release
    /// downloaded into Steno's own model cache. Deliberately not the legacy
    /// shared FluidAudio cache, which other apps on the Mac may be using.
    /// Best-effort: a failure leaves disk used, nothing else. Run by prepare
    /// and by each diarization, since a user whose models are already
    /// prepared never re-runs prepare.
    public static func removeRetiredBundles(in root: URL = cacheDirectory()) {
        for config in retiredSortformerConfigs {
            guard let bundle = ModelNames.Sortformer.bundle(for: config) else { continue }
            let url = root
                .appendingPathComponent("sortformer", isDirectory: true)
                .appendingPathComponent(bundle, isDirectory: true)
            try? FileManager.default.removeItem(at: url)
        }
    }

    public static func enableOfflineOnly() {
        DownloadUtils.enforceOffline = true
    }

    private static func isCompleteModelBundle(_ url: URL, relativePath: String) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            return false
        }
        return requiredArtifactRelativePaths(for: relativePath).allSatisfy { artifact in
            let path = url
                .appendingPathComponent(artifact, isDirectory: false)
                .resolvingSymlinksInPath()
                .path
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
                  attributes[.type] as? FileAttributeType == .typeRegular,
                  let size = attributes[.size] as? NSNumber else {
                return false
            }
            return size.intValue > 0
        }
    }

    static func requiredArtifactRelativePaths(for relativePath: String) -> [String] {
        let common = ["coremldata.bin", "metadata.json"]
        if relativePath.hasPrefix("sortformer/") {
            return common + [
                "model0/model.mil",
                "model0/weights/0-weight.bin",
                "model1/model.mil",
                "model1/weights/1-weight.bin",
            ]
        }
        return common + ["model.mil", "weights/weight.bin"]
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
