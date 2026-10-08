import FluidAudio
import Foundation
import Testing
@testable import DiarizationCore

@Suite("Engine selection")
struct EngineSelectionTests {
    @Test("An unset or empty engine resolves to the Sortformer default")
    func defaultEngine() {
        #expect(EngineSelection.engine(environment: [:]) == .sortformer)
        #expect(EngineSelection.engine(environment: ["STENOAI_DIARIZE_ENGINE": ""]) == .sortformer)
        #expect(EngineSelection.engine(environment: ["STENOAI_DIARIZE_ENGINE": "  "]) == .sortformer)
    }

    @Test("The nemotron3 engine is recognized, case-insensitively")
    func nemotron3Engine() {
        #expect(EngineSelection.engine(environment: ["STENOAI_DIARIZE_ENGINE": "nemotron3"]) == .nemotron3)
        #expect(EngineSelection.engine(environment: ["STENOAI_DIARIZE_ENGINE": "Nemotron3"]) == .nemotron3)
        #expect(EngineSelection.engine(environment: ["STENOAI_DIARIZE_ENGINE": "sortformer"]) == .sortformer)
    }

    @Test("An unrecognized engine value fails loudly instead of resolving")
    func unknownEngineFails() {
        #expect(EngineSelection.engine(environment: ["STENOAI_DIARIZE_ENGINE": "bogus"]) == nil)
    }

    @Test("An unset preset resolves to the default split-graph ANE build")
    func defaultPreset() {
        let config = EngineSelection.nemotron3Config(environment: [:])
        #expect(config?.modelFileName == "Nemotron3Diarizer_c128_split_w8a8.mlmodelc")
        #expect(config?.splitGraph == true)
        #expect(config?.numSpeakers == 8)
        #expect(config?.outputFrameSeconds == 0.01)
        #expect(EngineSelection.defaultNemotron3PresetName == "c128-split-w8a8")
    }

    @Test("Known presets resolve to their model files")
    func knownPresets() {
        #expect(
            EngineSelection.nemotron3Config(
                environment: ["STENOAI_DIARIZE_NEMOTRON_PRESET": "fast128"]
            )?.modelFileName == "Nemotron3Diarizer_fast128.mlmodelc")
        let split = EngineSelection.nemotron3Config(
            environment: ["STENOAI_DIARIZE_NEMOTRON_PRESET": "c128-split-w8a8"]
        )
        #expect(split?.splitGraph == true)
        #expect(split?.modelFileName == "Nemotron3Diarizer_c128_split_w8a8.mlmodelc")
    }

    @Test("An unrecognized preset value fails loudly instead of resolving")
    func unknownPresetFails() {
        #expect(
            EngineSelection.nemotron3Config(
                environment: ["STENOAI_DIARIZE_NEMOTRON_PRESET": "not-a-preset"]
            ) == nil
        )
    }
}
