import Foundation

/// Sortformer's `.highContextV2` emits nothing until it has a full ~30.4 s
/// window, so a shorter recording is padded with trailing silence before
/// diarization and the resulting segments are clipped back to the real
/// length. Pure arithmetic, kept here so it is unit-testable without models.
public enum ShortRecording {
    /// `samples` extended with zeros to at least `minDuration` seconds.
    public static func padded(_ samples: [Float], minDuration: Double, sampleRate: Double) -> [Float] {
        let minSamples = Int((minDuration * sampleRate).rounded(.up))
        guard samples.count < minSamples else { return samples }
        return samples + [Float](repeating: 0, count: minSamples - samples.count)
    }

    /// A segment clipped to the real recording, or nil if what remains is
    /// shorter than `minSegment` (including segments wholly in the padding).
    public static func clipped(
        start: Double, end: Double, recordingDuration: Double, minSegment: Double
    ) -> (start: Double, end: Double)? {
        let clippedEnd = min(end, recordingDuration)
        guard clippedEnd - start >= minSegment else { return nil }
        return (start, clippedEnd)
    }
}
