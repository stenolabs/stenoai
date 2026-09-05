import Foundation
import Testing
@testable import DiarizationCore

@Suite("Diarization model readiness")
struct ModelReadinessTests {
    private func expectedArtifacts(for relativePath: String) -> [String] {
        if relativePath.hasPrefix("sortformer/") {
            return [
                "coremldata.bin",
                "metadata.json",
                "model0/model.mil",
                "model0/weights/0-weight.bin",
                "model1/model.mil",
                "model1/weights/1-weight.bin",
            ]
        }
        return [
            "coremldata.bin",
            "metadata.json",
            "model.mil",
            "weights/weight.bin",
        ]
    }

    private func createCompleteBundle(at bundle: URL, relativePath: String) throws {
        for artifact in expectedArtifacts(for: relativePath) {
            let file = bundle.appendingPathComponent(artifact, isDirectory: false)
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try Data([0x01]).write(to: file)
        }
    }

    private func createCompleteCache(at root: URL) throws {
        for relativePath in ModelReadiness.requiredModelRelativePaths {
            let bundle = root.appendingPathComponent(relativePath, isDirectory: true)
            try createCompleteBundle(at: bundle, relativePath: relativePath)
        }
    }

    @Test("Readiness paths match FluidAudio's cache folders")
    func cacheFolderContract() {
        let sortformerArtifacts = [
            "coremldata.bin", "metadata.json", "model0/model.mil",
            "model0/weights/0-weight.bin", "model1/model.mil",
            "model1/weights/1-weight.bin",
        ]
        let diarizerArtifacts = [
            "coremldata.bin", "metadata.json", "model.mil", "weights/weight.bin",
        ]
        #expect(ModelReadiness.requiredModelRelativePaths == [
            "sortformer/Sortformer_v2.1.mlmodelc",
            "sortformer/SortformerNvidiaHigh_v2.mlmodelc",
            "speaker-diarization/pyannote_segmentation.mlmodelc",
            "speaker-diarization/wespeaker_v2.mlmodelc",
        ])
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "sortformer/Sortformer_v2.1.mlmodelc"
        ) == sortformerArtifacts)
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "sortformer/SortformerNvidiaHigh_v2.mlmodelc"
        ) == sortformerArtifacts)
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "speaker-diarization/pyannote_segmentation.mlmodelc"
        ) == diarizerArtifacts)
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "speaker-diarization/wespeaker_v2.mlmodelc"
        ) == diarizerArtifacts)
    }

    @Test("A directory in place of a required artifact is not ready")
    func directoryArtifactIsMissing() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-directory-artifact-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try createCompleteCache(at: root)
        let model = root.appendingPathComponent(
            ModelReadiness.requiredModelRelativePaths[0], isDirectory: true
        )
        let artifact = model.appendingPathComponent("metadata.json")
        try FileManager.default.removeItem(at: artifact)
        try FileManager.default.createDirectory(at: artifact, withIntermediateDirectories: true)

        let result = ModelReadiness.status(cacheDirectory: root)

        #expect(result.ready == false)
        #expect(result.missingModels == [ModelReadiness.requiredModelRelativePaths[0]])
    }

    @Test("A required artifact may be a symlink to a regular file")
    func symlinkArtifactIsReady() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-symlink-artifact-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try createCompleteCache(at: root)
        let model = root.appendingPathComponent(
            ModelReadiness.requiredModelRelativePaths[0], isDirectory: true
        )
        let artifact = model.appendingPathComponent("metadata.json")
        let target = root.appendingPathComponent("shared-metadata.json")
        try Data([0x01]).write(to: target)
        try FileManager.default.removeItem(at: artifact)
        try FileManager.default.createSymbolicLink(at: artifact, withDestinationURL: target)

        let result = ModelReadiness.status(cacheDirectory: root)

        #expect(result.ready == true)
        #expect(result.missingModels.isEmpty)
    }

    @Test("A missing cache is reported without creating it")
    func missingCacheIsReadOnly() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-status-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let result = ModelReadiness.status(cacheDirectory: root)

        #expect(result.ready == false)
        #expect(result.missingModels == ModelReadiness.requiredModelRelativePaths)
        #expect(FileManager.default.fileExists(atPath: root.path) == false)
    }

    @Test("All complete model bundles make the cache ready")
    func completeCacheIsReady() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-ready-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        for relativePath in ModelReadiness.requiredModelRelativePaths {
            let bundle = root.appendingPathComponent(relativePath, isDirectory: true)
            try createCompleteBundle(at: bundle, relativePath: relativePath)
        }

        let result = ModelReadiness.status(cacheDirectory: root)

        #expect(result.ready == true)
        #expect(result.missingModels.isEmpty)
    }

    @Test("A partial compiled model is not ready")
    func partialBundleIsMissing() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-partial-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        for relativePath in ModelReadiness.requiredModelRelativePaths {
            let bundle = root.appendingPathComponent(relativePath, isDirectory: true)
            try createCompleteBundle(at: bundle, relativePath: relativePath)
        }
        let partial = root.appendingPathComponent(
            ModelReadiness.requiredModelRelativePaths[0], isDirectory: true
        )
        try FileManager.default.removeItem(at: partial.appendingPathComponent("metadata.json"))

        let result = ModelReadiness.status(cacheDirectory: root)

        #expect(result.ready == false)
        #expect(result.missingModels == [ModelReadiness.requiredModelRelativePaths[0]])
    }

    @Test("The app user-data override owns the speaker model cache")
    func userDataOverrideWins() {
        let resolved = ModelReadiness.cacheDirectory(
            environment: ["STENOAI_USER_DATA_DIR": "/private/tmp/isolated-steno"],
            homeDirectory: URL(fileURLWithPath: "/unused")
        )

        #expect(resolved.path == "/private/tmp/isolated-steno/models/speaker-diarization")
    }

    @Test("A complete legacy FluidAudio cache remains usable after upgrade")
    func completeLegacyCacheIsUsedAtRuntime() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-legacy-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let legacy = home
            .appendingPathComponent("Library/Application Support/FluidAudio/Models")
        try createCompleteCache(at: legacy)

        let resolved = ModelReadiness.runtimeCacheDirectory(
            environment: [:], homeDirectory: home
        )

        #expect(resolved.standardizedFileURL.path == legacy.standardizedFileURL.path)
        #expect(ModelReadiness.status(cacheDirectory: resolved).ready == true)
    }

    @Test("An isolated user-data override never reads the legacy cache")
    func userDataOverrideDoesNotFallBackToLegacyCache() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-isolated-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let legacy = home
            .appendingPathComponent("Library/Application Support/FluidAudio/Models")
        try createCompleteCache(at: legacy)

        let resolved = ModelReadiness.runtimeCacheDirectory(
            environment: ["STENOAI_USER_DATA_DIR": "/private/tmp/isolated-steno"],
            homeDirectory: home
        )

        #expect(resolved.path == "/private/tmp/isolated-steno/models/speaker-diarization")
    }

    @Test("The app-owned cache takes precedence over the legacy cache")
    func appOwnedCacheWins() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-preferred-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let preferred = ModelReadiness.cacheDirectory(environment: [:], homeDirectory: home)
        let legacy = home
            .appendingPathComponent("Library/Application Support/FluidAudio/Models")
        try createCompleteCache(at: preferred)
        try createCompleteCache(at: legacy)

        let resolved = ModelReadiness.runtimeCacheDirectory(
            environment: [:], homeDirectory: home
        )

        #expect(resolved == preferred)
    }
}
