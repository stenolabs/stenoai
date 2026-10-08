import FluidAudio
import Foundation

/// Which diarization backend `steno-diarize` runs. Sortformer (4-slot) remains
/// the default; Nemotron 3 (8-speaker streaming Sortformer, 100M params) is an
/// opt-in engine selected with STENOAI_DIARIZE_ENGINE=nemotron3.
public enum DiarizationEngine: String, Sendable, Equatable {
    case sortformer
    case nemotron3
}

/// Environment-driven engine and preset selection, shared by the CLI entry
/// point and ModelReadiness so `model-status`, `prepare-models`, and `diarize`
/// all agree on which model bundles are required.
public enum EngineSelection {
    public static let engineEnvironmentKey = "STENOAI_DIARIZE_ENGINE"
    public static let nemotron3PresetEnvironmentKey = "STENOAI_DIARIZE_NEMOTRON_PRESET"
    /// Default preset: the split-graph W8A8 build the model card calls "the
    /// batch/iOS pick". This app only diarizes finished recordings, so the
    /// 10.56 s input-buffer latency is irrelevant; what matters is that the
    /// pure-transformer graph is 100% ANE-resident (verified to compile for
    /// the ANE even on the M3-generation chip, where the monolithic graphs
    /// fail ANECCompile), halves the download (95 vs 190 MB), and posts the
    /// best speaker-counting accuracy of the lineup (SCA 100 vs 93.8 for
    /// fp16 fast32) at a small DER cost (9.63 vs 9.53).
    public static let defaultNemotron3PresetName = "c128-split-w8a8"

    /// Resolve the engine. Unset or empty -> the Sortformer default. An
    /// unrecognized non-empty value returns nil so callers can fail loudly
    /// instead of silently diarizing with the wrong backend.
    public static func engine(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> DiarizationEngine? {
        guard let raw = nonEmpty(environment[engineEnvironmentKey]) else {
            return .sortformer
        }
        return DiarizationEngine(rawValue: raw.lowercased())
    }

    /// Resolve the Nemotron 3 streaming preset. Unset or empty -> the default
    /// split-graph build; an unrecognized value returns nil so callers can
    /// fail loudly.
    public static func nemotron3Config(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Nemotron3Config? {
        let name = nonEmpty(environment[nemotron3PresetEnvironmentKey]) ?? defaultNemotron3PresetName
        return Nemotron3Config.preset(named: name.lowercased())
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
