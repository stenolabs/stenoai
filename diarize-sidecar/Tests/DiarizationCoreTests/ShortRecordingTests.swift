import FluidAudio
import Foundation
import Testing
@testable import DiarizationCore

@Suite("Short recordings and prepare progress")
struct ShortRecordingTests {
    @Test("Short audio is padded with trailing silence; long audio is untouched")
    func padding() {
        let short: [Float] = [0.5, -0.5, 0.25]
        let padded = ShortRecording.padded(short, minDuration: 1.0, sampleRate: 10)
        #expect(padded.count == 10)
        #expect(Array(padded.prefix(3)) == short)
        #expect(padded.dropFirst(3).allSatisfy { $0 == 0 })

        let long = [Float](repeating: 0.1, count: 20)
        #expect(ShortRecording.padded(long, minDuration: 1.0, sampleRate: 10) == long)
    }

    @Test("Segments are clipped to the recording and padding-only ones dropped")
    func clipping() {
        let inside = ShortRecording.clipped(start: 1, end: 3, recordingDuration: 10, minSegment: 0.25)
        #expect(inside?.start == 1 && inside?.end == 3)

        let straddling = ShortRecording.clipped(start: 9, end: 40, recordingDuration: 10, minSegment: 0.25)
        #expect(straddling?.start == 9 && straddling?.end == 10)

        #expect(ShortRecording.clipped(start: 12, end: 20, recordingDuration: 10, minSegment: 0.25) == nil)
        #expect(ShortRecording.clipped(start: 9.9, end: 30, recordingDuration: 10, minSegment: 0.25) == nil)
    }

    @Test("Each FluidAudio load maps onto its own band and the bar only moves forward")
    func progressBands() {
        let sortformer = (download: 0.0...0.85, compile: 0.85...0.95)
        let embeddings = (download: 0.95...0.975, compile: 0.975...1.0)
        // FluidAudio: downloading fills 0...0.5 of a load, compiling 0.5...1.
        let sequence: [(Double, Bool, (download: ClosedRange<Double>, compile: ClosedRange<Double>))] = [
            (0.0, false, sortformer), (0.25, false, sortformer), (0.5, false, sortformer),
            (0.75, true, sortformer), (1.0, true, sortformer),
            (0.0, false, embeddings), (0.5, false, embeddings), (1.0, true, embeddings),
        ]
        let overall = sequence.map {
            ModelReadiness.overallFraction($0.0, compiling: $0.1, download: $0.2.download, compile: $0.2.compile)
        }
        #expect(overall == overall.sorted())
        #expect(abs(overall[1] - 0.425) < 1e-9)
        #expect(abs(overall[2] - 0.85) < 1e-9)
        #expect(abs(overall.last! - 1.0) < 1e-9)
        #expect(ModelReadiness.overallFraction(2, compiling: false, download: 0...0.85, compile: 0.85...0.95) == 0.85)
    }

    @Test("Prepare cleanup removes only the retired Sortformer bundle")
    func retiredBundleCleanup() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("steno-retired-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let sortformer = root.appendingPathComponent("sortformer", isDirectory: true)
        let retired = try #require(ModelNames.Sortformer.bundle(for: .default))
        let kept = try #require(ModelNames.Sortformer.bundle(for: ModelReadiness.sortformerConfig))
        for name in [retired, kept] {
            try FileManager.default.createDirectory(
                at: sortformer.appendingPathComponent(name), withIntermediateDirectories: true
            )
        }
        ModelReadiness.removeRetiredBundles(in: root)
        #expect(!FileManager.default.fileExists(atPath: sortformer.appendingPathComponent(retired).path))
        #expect(FileManager.default.fileExists(atPath: sortformer.appendingPathComponent(kept).path))
    }
}
