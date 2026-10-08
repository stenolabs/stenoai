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

    /// Nemotron 3 bundles cache under this subdirectory of the cache root
    /// (FluidAudio's `Repo.nemotron3Diarization.folderName`).
    private static let nemotron3CacheFolder = "nemotron-3-diarization"

    /// Placeholder required path for a Nemotron 3 engine without a resolved
    /// preset -- never present on disk, so such a cache is never ready.
    static let unresolvedNemotron3PresetPath = "nemotron-3-diarization/<unresolved preset>"

    /// The one Sortformer config the sidecar runs. Short recordings are padded
    /// to its minimum window (see main.swift), so `.default`'s bundle is never
    /// needed or downloaded.
    public static let sortformerConfig: SortformerConfig = .highContextV2

    /// Sortformer bundles (relative to `sortformer/`) an earlier release
    /// prepared and nothing loads now: `.default`'s v3 bundle, plus both
    /// root-level bundles FluidAudio 0.15 cached before 0.17 moved Sortformer
    /// to a rebuilt `v3/fp16/` set.
    static let retiredSortformerBundles: [String] =
        [SortformerConfig.default].compactMap { ModelNames.Sortformer.bundle(for: $0) }
        + ["Sortformer_v2.1.mlmodelc", "SortformerNvidiaHigh_v2.mlmodelc"]

    public static let requiredModelRelativePaths: [String] =
        requiredModelRelativePaths(engine: .sortformer, nemotron3Config: nil)

    /// Model bundles and assets a given engine needs under the cache root.
    ///
    /// The Nemotron 3 engine needs its preset's CoreML bundle plus the
    /// root-level assets `Nemotron3Models.load` reads (`learnable_sil_emb.bin`,
    /// `pre_encode_proj_t.bin` for split-graph presets); both engines share
    /// the WeSpeaker/pyannote embedding models used for voiceprint centroids.
    public static func requiredModelRelativePaths(
        engine: DiarizationEngine,
        nemotron3Config: Nemotron3Config?
    ) -> [String] {
        let embeddingBundles = DiarizerModels.requiredModelNames
            .sorted()
            .map { "speaker-diarization/\($0)" }
        switch engine {
        case .sortformer:
            let sortformerBundles = [sortformerConfig]
                .compactMap { ModelNames.Sortformer.bundle(for: $0) }
                .map { "sortformer/\($0)" }
            return sortformerBundles + embeddingBundles
        case .nemotron3:
            guard let config = nemotron3Config else {
                // No resolved preset means no knowable bundle. Report a path
                // that can never exist so readiness is false; an empty list
                // would read as "nothing missing" and claim the engine ready.
                return [unresolvedNemotron3PresetPath]
            }
            let bundle = "\(nemotron3CacheFolder)/\(config.hubSubdirectory)/\(config.modelFileName)"
            var assets = ["\(nemotron3CacheFolder)/\(ModelNames.Nemotron3.silenceEmbeddingFile)"]
            if config.splitGraph {
                assets.append("\(nemotron3CacheFolder)/\(ModelNames.Nemotron3.preEncodeProjectionFile)")
            }
            return [bundle] + assets + embeddingBundles
        }
    }

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
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        engine: DiarizationEngine = .sortformer,
        nemotron3Config: Nemotron3Config? = nil
    ) -> URL {
        let preferred = cacheDirectory(environment: environment, homeDirectory: homeDirectory)
        if nonEmpty(environment[modelDirectoryEnvironmentKey]) != nil
            || nonEmpty(environment[userDataEnvironmentKey]) != nil
        {
            return preferred
        }
        if missingModelPaths(
            in: preferred, engine: engine, nemotron3Config: nemotron3Config
        ).isEmpty {
            return preferred
        }
        let legacy = homeDirectory
            .appendingPathComponent("Library/Application Support/FluidAudio/Models", isDirectory: true)
        return missingModelPaths(
            in: legacy, engine: engine, nemotron3Config: nemotron3Config
        ).isEmpty ? legacy : preferred
    }

    public static func status(
        cacheDirectory: URL? = nil,
        engine: DiarizationEngine = .sortformer,
        nemotron3Config: Nemotron3Config? = nil
    ) -> ModelReadinessStatus {
        let resolvedCacheDirectory =
            cacheDirectory ?? runtimeCacheDirectory(engine: engine, nemotron3Config: nemotron3Config)
        let missing = missingModelPaths(
            in: resolvedCacheDirectory, engine: engine, nemotron3Config: nemotron3Config
        )
        return ModelReadinessStatus(
            ready: missing.isEmpty,
            cacheDirectory: resolvedCacheDirectory.path,
            requiredModels: requiredModelRelativePaths(engine: engine, nemotron3Config: nemotron3Config),
            missingModels: missing
        )
    }

    private static func missingModelPaths(
        in cacheDirectory: URL,
        engine: DiarizationEngine,
        nemotron3Config: Nemotron3Config?
    ) -> [String] {
        requiredModelRelativePaths(engine: engine, nemotron3Config: nemotron3Config)
            .filter { relativePath in
                if relativePath.hasSuffix(".mlmodelc") {
                    return !isCompleteModelBundle(
                        cacheDirectory.appendingPathComponent(relativePath, isDirectory: true),
                        relativePath: relativePath
                    )
                }
                return !isCompleteAssetFile(cacheDirectory.appendingPathComponent(relativePath))
            }
    }

    public static func prepare(
        cacheDirectory: URL = cacheDirectory(),
        engine: DiarizationEngine = .sortformer,
        nemotron3Config: Nemotron3Config? = nil,
        computeUnits: MLComputeUnits = .cpuAndNeuralEngine,
        progressHandler: ProgressHandler? = nil
    ) async throws -> ModelReadinessStatus {
        ModelHub.offlineMode = false
        try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)

        // Only the diarizer model's download fills the bar: FluidAudio reports
        // it in bytes, as each load's 0...0.5 (compiling is 0.5...1).
        // Everything after it -- the CoreML compile for this Mac (over a
        // minute on an M3 Max) and the ~13 MB embedding models -- reports as
        // the "compiling" phase, which the UI shows as activity rather than an
        // invented percentage.
        let diarizerProgress = banded(progressHandler, download: 0.0...1.0, compile: 1.0...1.0)
        switch engine {
        case .sortformer:
            _ = try await SortformerModels.loadFromHuggingFace(
                config: sortformerConfig,
                cacheDirectory: cacheDirectory,
                computeUnits: computeUnits,
                progressHandler: diarizerProgress
            )
        case .nemotron3:
            guard let config = nemotron3Config else {
                throw CocoaError(
                    .fileReadCorruptFile,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "Nemotron 3 diarization requires a valid preset "
                            + "(STENOAI_DIARIZE_NEMOTRON_PRESET)"
                    ]
                )
            }
            _ = try await Nemotron3Models.loadFromHuggingFace(
                config: config,
                cacheDirectory: cacheDirectory,
                computeUnits: computeUnits,
                progressHandler: diarizerProgress
            )
        }
        _ = try await DiarizerModels.downloadIfNeeded(
            to: cacheDirectory.appendingPathComponent("speaker-diarization", isDirectory: true),
            configuration: MLModelConfigurationUtils.defaultConfiguration(computeUnits: computeUnits),
            progressHandler: banded(progressHandler, download: 1.0...1.0, compile: 1.0...1.0)
        )
        removeRetiredBundles(in: cacheDirectory)

        let result = status(
            cacheDirectory: cacheDirectory, engine: engine, nemotron3Config: nemotron3Config
        )
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
        _ handler: ProgressHandler?,
        download: ClosedRange<Double>,
        compile: ClosedRange<Double>
    ) -> ProgressHandler? {
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
            handler(DownloadProgress(
                fractionCompleted: overall,
                phase: overall >= preparingFrom
                    ? .compiling(modelName: "")
                    : .downloading(completedFiles: 0, totalFiles: 0)
            ))
        }
    }

    /// Reclaim the Sortformer bundles earlier releases downloaded into Steno's
    /// own model cache (see `retiredSortformerBundles`). Deliberately not the
    /// legacy shared FluidAudio cache, which other apps on the Mac may be
    /// using. Best-effort: a failure leaves disk used, nothing else. Run by
    /// prepare and by each diarization, since a user whose models are already
    /// prepared never re-runs prepare.
    public static func removeRetiredBundles(in root: URL = cacheDirectory()) {
        for bundle in retiredSortformerBundles {
            let url = root
                .appendingPathComponent("sortformer", isDirectory: true)
                .appendingPathComponent(bundle, isDirectory: true)
            try? FileManager.default.removeItem(at: url)
        }
    }

    public static func enableOfflineOnly() {
        ModelHub.offlineMode = true
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

    /// Root-level assets (e.g. `learnable_sil_emb.bin`) are plain files, not
    /// compiled bundles — readiness only needs a non-empty regular file
    /// (symlinks allowed, same as bundle artifacts).
    private static func isCompleteAssetFile(_ url: URL) -> Bool {
        let path = url.resolvingSymlinksInPath().path
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber else {
            return false
        }
        return size.intValue > 0
    }

    static func requiredArtifactRelativePaths(for relativePath: String) -> [String] {
        if relativePath.hasPrefix("sortformer/") {
            // FluidAudio 0.17's v3/fp16 bundles have no metadata.json;
            // older root-level bundles do. Requiring it here leaves a fully
            // downloaded v3 cache permanently marked unready.
            let metadata = relativePath.hasPrefix("sortformer/v3/fp16/")
                ? [] : ["metadata.json"]
            return [
                "coremldata.bin",
            ] + metadata + [
                "model0/model.mil", "model0/weights/0-weight.bin",
                "model1/model.mil", "model1/weights/1-weight.bin",
            ]
        }
        if relativePath.hasPrefix("\(nemotron3CacheFolder)/") {
            // Nemotron 3 bundles ship without metadata.json (verified against the
            // Hugging Face repository layout: coremldata.bin, model.mil, weights/).
            return ["coremldata.bin", "model.mil", "weights/weight.bin"]
        }
        return ["coremldata.bin", "metadata.json", "model.mil", "weights/weight.bin"]
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
