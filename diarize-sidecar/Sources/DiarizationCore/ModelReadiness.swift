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

    public static let requiredModelRelativePaths: [String] = {
        let sortformerBundles = [SortformerConfig.default, .highContextV2]
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

        _ = try await SortformerModels.loadFromHuggingFace(
            config: .default,
            cacheDirectory: cacheDirectory,
            computeUnits: computeUnits,
            progressHandler: progressHandler
        )
        _ = try await SortformerModels.loadFromHuggingFace(
            config: .highContextV2,
            cacheDirectory: cacheDirectory,
            computeUnits: computeUnits,
            progressHandler: progressHandler
        )
        _ = try await DiarizerModels.downloadIfNeeded(
            to: cacheDirectory.appendingPathComponent("speaker-diarization", isDirectory: true),
            configuration: MLModelConfigurationUtils.defaultConfiguration(computeUnits: computeUnits),
            progressHandler: progressHandler
        )

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
