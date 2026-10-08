import FluidAudio
import Foundation
import Testing
@testable import DiarizationCore

@Suite("Diarization model readiness")
struct ModelReadinessTests {
    private func expectedArtifacts(for relativePath: String) -> [String] {
        if relativePath.hasPrefix("sortformer/") {
            let metadata = relativePath.hasPrefix("sortformer/v3/fp16/")
                ? [] : ["metadata.json"]
            return ["coremldata.bin"] + metadata + [
                "model0/model.mil",
                "model0/weights/0-weight.bin",
                "model1/model.mil",
                "model1/weights/1-weight.bin",
            ]
        }
        if relativePath.hasPrefix("nemotron-3-diarization/") && relativePath.hasSuffix(".mlmodelc") {
            return [
                "coremldata.bin",
                "model.mil",
                "weights/weight.bin",
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
        if !relativePath.hasSuffix(".mlmodelc") {
            // Root-level assets (e.g. learnable_sil_emb.bin) are plain files.
            try Data([0x01]).write(to: bundle)
            return
        }
        for artifact in expectedArtifacts(for: relativePath) {
            let file = bundle.appendingPathComponent(artifact, isDirectory: false)
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try Data([0x01]).write(to: file)
        }
    }

    private func createCompleteCache(
        at root: URL,
        engine: DiarizationEngine = .sortformer,
        nemotron3Config: Nemotron3Config? = nil
    ) throws {
        for relativePath in ModelReadiness.requiredModelRelativePaths(
            engine: engine, nemotron3Config: nemotron3Config
        ) {
            let bundle = root.appendingPathComponent(relativePath, isDirectory: true)
            try createCompleteBundle(at: bundle, relativePath: relativePath)
        }
    }

    @Test("Readiness paths match FluidAudio's cache folders")
    func cacheFolderContract() {
        let sortformerArtifacts = [
            "coremldata.bin", "model0/model.mil",
            "model0/weights/0-weight.bin", "model1/model.mil",
            "model1/weights/1-weight.bin",
        ]
        let diarizerArtifacts = [
            "coremldata.bin", "metadata.json", "model.mil", "weights/weight.bin",
        ]
        #expect(ModelReadiness.requiredModelRelativePaths == [
            "sortformer/v3/fp16/SortformerNvidiaHigh_v2.mlmodelc",
            "speaker-diarization/pyannote_segmentation.mlmodelc",
            "speaker-diarization/wespeaker_v2.mlmodelc",
        ])
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "sortformer/v3/fp16/Sortformer_v2.1.mlmodelc"
        ) == sortformerArtifacts)
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "sortformer/v3/fp16/SortformerNvidiaHigh_v2.mlmodelc"
        ) == sortformerArtifacts)
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "sortformer/Sortformer_v2.1.mlmodelc"
        ) == ["coremldata.bin", "metadata.json"] + sortformerArtifacts.dropFirst())
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "speaker-diarization/pyannote_segmentation.mlmodelc"
        ) == diarizerArtifacts)
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "speaker-diarization/wespeaker_v2.mlmodelc"
        ) == diarizerArtifacts)
    }

    @Test("Nemotron 3 readiness paths match the Hugging Face repository layout")
    func nemotron3FolderContract() {
        // Monolithic bundles ship without metadata.json (verified against
        // FluidInference/nemotron-3-diarization-coreml: coremldata.bin,
        // model.mil, weights/weight.bin).
        #expect(ModelReadiness.requiredArtifactRelativePaths(
            for: "nemotron-3-diarization/monolithic/Nemotron3Diarizer_fast32.mlmodelc"
        ) == ["coremldata.bin", "model.mil", "weights/weight.bin"])
        #expect(ModelReadiness.requiredModelRelativePaths(
            engine: .nemotron3, nemotron3Config: .fast32
        ) == [
            "nemotron-3-diarization/monolithic/Nemotron3Diarizer_fast32.mlmodelc",
            "nemotron-3-diarization/learnable_sil_emb.bin",
            "speaker-diarization/pyannote_segmentation.mlmodelc",
            "speaker-diarization/wespeaker_v2.mlmodelc",
        ])
        // Split-graph presets live under split/ and additionally require the
        // host-side pre-encode projection asset.
        let split = Nemotron3Config.preset(named: "c128-split-w8a8")
        #expect(ModelReadiness.requiredModelRelativePaths(
            engine: .nemotron3, nemotron3Config: split
        ) == [
            "nemotron-3-diarization/split/Nemotron3Diarizer_c128_split_w8a8.mlmodelc",
            "nemotron-3-diarization/learnable_sil_emb.bin",
            "nemotron-3-diarization/pre_encode_proj_t.bin",
            "speaker-diarization/pyannote_segmentation.mlmodelc",
            "speaker-diarization/wespeaker_v2.mlmodelc",
        ])
        // An engine without a resolved preset can never be ready: its one
        // required path is a placeholder that never exists on disk.
        #expect(
            ModelReadiness.requiredModelRelativePaths(engine: .nemotron3, nemotron3Config: nil)
                == [ModelReadiness.unresolvedNemotron3PresetPath]
        )
    }

    @Test("A complete Nemotron 3 cache is ready; missing assets are not")
    func nemotron3CacheReadiness() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-nemotron3-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = ModelReadiness.requiredModelRelativePaths(
            engine: .nemotron3, nemotron3Config: .fast32)

        try createCompleteCache(at: root, engine: .nemotron3, nemotron3Config: .fast32)
        var result = ModelReadiness.status(
            cacheDirectory: root, engine: .nemotron3, nemotron3Config: .fast32
        )
        #expect(result.ready == true)
        #expect(result.missingModels.isEmpty)
        #expect(result.requiredModels == paths)

        // A zero-byte silence embedding is not a usable asset.
        let asset = root.appendingPathComponent("nemotron-3-diarization/learnable_sil_emb.bin")
        try Data().write(to: asset)
        result = ModelReadiness.status(
            cacheDirectory: root, engine: .nemotron3, nemotron3Config: .fast32
        )
        #expect(result.ready == false)
        #expect(result.missingModels == ["nemotron-3-diarization/learnable_sil_emb.bin"])

        // A complete sortformer cache alone does not satisfy the nemotron3
        // engine. Drop every Nemotron file first so the assertion cannot pass
        // on the empty silence asset above instead.
        try FileManager.default.removeItem(
            at: root.appendingPathComponent("nemotron-3-diarization", isDirectory: true)
        )
        try createCompleteCache(at: root, engine: .sortformer, nemotron3Config: nil)
        result = ModelReadiness.status(
            cacheDirectory: root, engine: .nemotron3, nemotron3Config: .fast32
        )
        #expect(result.ready == false)
        #expect(result.missingModels == [
            "nemotron-3-diarization/monolithic/Nemotron3Diarizer_fast32.mlmodelc",
            "nemotron-3-diarization/learnable_sil_emb.bin",
        ])
    }

    @Test("A Nemotron 3 engine without a resolved preset is never ready")
    func nemotron3WithoutPresetIsNotReady() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-nemotron3-nopreset-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try createCompleteCache(at: root, engine: .nemotron3, nemotron3Config: .fast32)

        let result = ModelReadiness.status(
            cacheDirectory: root, engine: .nemotron3, nemotron3Config: nil
        )
        #expect(result.ready == false)
        #expect(result.missingModels == [ModelReadiness.unresolvedNemotron3PresetPath])
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
        let artifact = model.appendingPathComponent("model0/model.mil")
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
        let artifact = model.appendingPathComponent("model0/model.mil")
        let target = root.appendingPathComponent("shared-model.mil")
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
        try FileManager.default.removeItem(at: partial.appendingPathComponent("model0/model.mil"))

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

    @Test("A FluidAudio 0.15 Sortformer cache is not ready after the upgrade")
    func preV3SortformerLayoutNeedsRedownload() throws {
        // FluidAudio 0.15 cached Sortformer bundles directly under
        // `sortformer/`; 0.17 reads only the rebuilt `sortformer/v3/fp16/`
        // set (the root-level models hit a CoreML tensor bug). Existing users
        // must re-download, so a complete old-layout cache -- in either the
        // app cache or the legacy FluidAudio location -- must read as missing
        // exactly the two v3 Sortformer bundles, never as ready.
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-model-prev3-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let appCache = ModelReadiness.cacheDirectory(environment: [:], homeDirectory: home)
        let legacy = home
            .appendingPathComponent("Library/Application Support/FluidAudio/Models")
        for root in [appCache, legacy] {
            for bundle in ["Sortformer_v2.1.mlmodelc", "SortformerNvidiaHigh_v2.mlmodelc"] {
                let relativePath = "sortformer/\(bundle)"
                try createCompleteBundle(
                    at: root.appendingPathComponent(relativePath, isDirectory: true),
                    relativePath: relativePath
                )
            }
            for bundle in [
                "speaker-diarization/pyannote_segmentation.mlmodelc",
                "speaker-diarization/wespeaker_v2.mlmodelc",
            ] {
                try createCompleteBundle(
                    at: root.appendingPathComponent(bundle, isDirectory: true),
                    relativePath: bundle
                )
            }
        }

        let resolved = ModelReadiness.runtimeCacheDirectory(
            environment: [:], homeDirectory: home
        )
        let result = ModelReadiness.status(cacheDirectory: resolved)

        #expect(resolved.standardizedFileURL.path == appCache.standardizedFileURL.path)
        #expect(result.ready == false)
        #expect(result.missingModels == [
            "sortformer/v3/fp16/SortformerNvidiaHigh_v2.mlmodelc",
        ])
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
