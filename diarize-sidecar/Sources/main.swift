// diarize-sidecar — offline speaker diarization + voiceprint embeddings via
// FluidAudio's Sortformer + WeSpeaker.
//
// Usage:
//   steno-diarize diarize <audio-file>
//   steno-diarize model-status
//   steno-diarize prepare-models
//
// `steno-diarize <audio-file>` remains accepted for compatibility.
//
// Sortformer has a fixed 4-speaker-slot architecture (SortformerConfig.numSpeakers
// is hardcoded to 4) — there is no speaker-count hint to pass, unlike the
// previous OfflineDiarizerManager-based version of this tool.
//
// Output (stdout): one JSON line on success
//   {"segments":[{"speakerId":"SPEAKER_0","start":0.0,"end":3.2}, ...],
//    "speakers":{"SPEAKER_0":[0.1,0.2,...(256 floats)], ...}}
//
// Exit 0 on success, 1 on failure (error written to stderr).
// stdout is unbuffered so the parent receives the line immediately.
//
// Audio loading avoids all CoreAudio file APIs (which fail with error
// 1954115647 when spawned from a PyInstaller bundle) by delegating to
// ffmpeg, which uses its own decoders entirely outside CoreAudio. This is
// also why we call SortformerDiarizer.processComplete(_:sourceSampleRate:)
// with raw samples rather than the processComplete(audioFileURL:) overload —
// that overload internally uses AudioConverter.resampleAudioFile, which
// calls AVAudioFile(forReading:) and would reintroduce the same crash.
//
// Voiceprint embeddings: extracted via FluidAudio's own bundled WeSpeaker
// model (DiarizerModels/EmbeddingExtractor — the same one the older,
// pyannote-segmentation-based DiarizerManager pipeline uses), NOT a
// separate ONNX model. This mirrors the proven approach in
// github.com/pasrom/meeting-transcriber (verified via GitHub's raw content
// API directly, not a fetched summary): overlap-excluded per-speaker
// activity masks from Sortformer's own frame-level predictions (so
// crosstalk never contaminates an embedding), chunked into 10s windows to
// match WeSpeaker's fixed input shape, embeddings averaged (L2-normalized
// mean) across all chunks into one centroid per speaker. A single-clip,
// no-overlap-exclusion embedding (an earlier, simpler attempt) proved too
// easily confused between genuinely different speakers in real testing.

import CoreML
import DiarizationCore
import Foundation
import FluidAudio

setbuf(stdout, nil)

// Segments shorter than this are spurious artifacts (an ~80ms noise-blip
// pattern observed empirically against real meeting audio), dropped before
// emitting rather than surfaced as a phantom speaker turn.
let minSegmentDurationSeconds: Float = 0.25

let rawAudioTempPrefix = "steno-diarize-"
let rawAudioTempSuffix = ".f32le"
let rawAudioTempMaxAge: TimeInterval = 24 * 60 * 60

// A forced app exit can bypass loadSamplesViaFfmpeg's defer and leave a
// large raw Float32 file behind. Remove only this sidecar's exact file
// pattern, and only after it is far older than any supported run timeout.
func cleanupStaleRawAudioTempFiles(now: Date = Date()) {
    let fileManager = FileManager.default
    let tempDirectory = fileManager.temporaryDirectory
    guard let files = try? fileManager.contentsOfDirectory(
        at: tempDirectory,
        includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
        options: [.skipsHiddenFiles]
    ) else {
        return
    }

    for file in files {
        let name = file.lastPathComponent
        guard name.hasPrefix(rawAudioTempPrefix), name.hasSuffix(rawAudioTempSuffix) else {
            continue
        }
        guard let values = try? file.resourceValues(
            forKeys: [.contentModificationDateKey, .isRegularFileKey]
        ), values.isRegularFile == true, let modifiedAt = values.contentModificationDate else {
            continue
        }
        guard now.timeIntervalSince(modifiedAt) > rawAudioTempMaxAge else {
            continue
        }
        try? fileManager.removeItem(at: file)
    }
}

// SortformerConfig.highContextV2's chunk loader (SortformerFeatureLoader)
// requires a full chunkLen+rightContext window -- 340+40 frames at 0.08s
// each, 30.4s -- before it emits ANYTHING; audio shorter than that gets
// ZERO segments, not degraded ones (confirmed empirically: a 12.25s test
// clip returned {"speakers":{},"segments":[]} with highContextV2). This
// threshold gives real margin above that hard minimum before switching
// away from the always-safe .default config.
let sortformerHighContextMinDuration: Double = 90.0

func fail(_ message: String, code: Int32 = 1) -> Never {
    fputs("steno-diarize error: \(message)\n", stderr)
    exit(code)
}

func printJSON<T: Encodable>(_ value: T) throws {
    let encoded = try JSONEncoder().encode(value)
    guard let line = String(data: encoded, encoding: .utf8) else {
        throw CocoaError(.fileWriteUnknown)
    }
    print(line)
}

// Compute-unit override, primarily for one-off bulk backfill runs where
// throughput matters more than the power/thermal cost of spinning up the
// GPU (unlike live recording, where the default below is deliberately
// power-efficient). Unset -> unchanged default (.cpuAndNeuralEngine, see
// the call sites below for why that's forced rather than left at .all).
// STENOAI_DIARIZE_COMPUTE_UNITS: "all" | "cpuAndGPU" | "cpuOnly" |
// "cpuAndNeuralEngine" (default).
func resolveComputeUnits() -> MLComputeUnits {
    switch ProcessInfo.processInfo.environment["STENOAI_DIARIZE_COMPUTE_UNITS"] {
    case "all": return .all
    case "cpuAndGPU": return .cpuAndGPU
    case "cpuOnly": return .cpuOnly
    default: return .cpuAndNeuralEngine
    }
}

let commandArguments = Array(CommandLine.arguments.dropFirst())

if commandArguments == ["model-status"] {
    let status = ModelReadiness.status()
    do {
        try printJSON(status)
    } catch {
        fail("could not encode model status")
    }
    exit(status.ready ? 0 : 3)
}

let isPrepareModels = commandArguments == ["prepare-models"]
let inputPath: String?
if commandArguments.count == 2, commandArguments[0] == "diarize" {
    inputPath = commandArguments[1]
} else if commandArguments.count == 1, !isPrepareModels {
    inputPath = commandArguments[0]
} else if isPrepareModels {
    inputPath = nil
} else {
    fail("usage: steno-diarize diarize <audio-file> | model-status | prepare-models")
}

if let inputPath, !FileManager.default.fileExists(atPath: inputPath) {
    fail("file not found: \(inputPath)")
}
if inputPath != nil {
    cleanupStaleRawAudioTempFiles()
}

// Locate ffmpeg. The binary lives next to steno-diarize in the bundle;
// fall back to common Homebrew / system paths for terminal use.
func findFfmpeg() -> String? {
    let execDir = URL(fileURLWithPath: CommandLine.arguments[0])
        .resolvingSymlinksInPath()
        .deletingLastPathComponent()
        .path
    let candidates = [
        "\(execDir)/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

// Decode any audio format to 16 kHz mono Float32 using ffmpeg, writing
// output to a temp file.
//
// Uses terminationHandler + CheckedContinuation so the Task suspends
// instead of blocking a thread. ffmpeg stdin is redirected to /dev/null
// to prevent it from blocking on an inherited terminal.
func loadSamplesViaFfmpeg(path: String) async throws -> [Float] {
    guard let ffmpegPath = findFfmpeg() else {
        throw NSError(domain: "steno-diarize", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "ffmpeg not found"])
    }
    let tmpURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("\(rawAudioTempPrefix)\(UUID().uuidString)\(rawAudioTempSuffix)")
    defer { try? FileManager.default.removeItem(at: tmpURL) }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: ffmpegPath)
    process.arguments = [
        "-loglevel", "error",
        "-i", path,
        "-ar", "16000",
        "-ac", "1",
        "-f", "f32le",
        "-y",
        tmpURL.path,
    ]
    // Redirect stdin to /dev/null so ffmpeg never blocks waiting for
    // interactive input on an inherited terminal.
    process.standardInput = FileHandle.nullDevice
    // Redirect ffmpeg stderr to /dev/null. When steno-diarize is spawned by
    // Python with capture_output=True, our own stderr is a pipe that Python
    // only drains after we exit. ffmpeg inherits that pipe and fills the
    // buffer with progress/profiling lines, causing it to block — which means
    // terminationHandler never fires and steno-diarize hangs. /dev/null
    // prevents the buffer fill; ffmpeg errors are still visible via exit status.
    process.standardError = FileHandle(forWritingAtPath: "/dev/null")

    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        process.terminationHandler = { p in
            if p.terminationStatus == 0 {
                cont.resume()
            } else {
                cont.resume(throwing: NSError(
                    domain: "steno-diarize", code: Int(p.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: "ffmpeg exited \(p.terminationStatus)"]))
            }
        }
        do {
            try process.run()
        } catch {
            cont.resume(throwing: error)
        }
    }

    let rawData = try Data(contentsOf: tmpURL, options: .mappedIfSafe)

    guard !rawData.isEmpty else {
        throw NSError(domain: "steno-diarize", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "ffmpeg produced no output"])
    }

    // f32le on Apple Silicon (little-endian) — reinterpret bytes as Float directly.
    return rawData.withUnsafeBytes { ptr in
        Array(ptr.bindMemory(to: Float.self))
    }
}

// MARK: - Voiceprint embedding extraction (ported from
// github.com/pasrom/meeting-transcriber's FluidDiarizer+SortformerEmbeddings.swift
// and the buildOverlapExcludedMasks/resampleMask/aggregateCentroids helpers
// in their FluidDiarizer.swift, verified via GitHub's raw content API).

/// Build per-speaker activity masks (1.0/0.0) with overlap-exclusion: any
/// frame where >=2 speakers exceed `threshold` is zeroed across ALL
/// speakers, so impure (crosstalk) frames never reach embedding extraction.
/// DiariZen-style stage-5 design.
///
/// A margin-based variant (requiring the runner-up speaker's probability to
/// stay below a separate low ceiling, not just fail to cross `threshold`)
/// was tried and measured against real same-room audio (AMI Meeting
/// Corpus): no meaningful improvement over this simpler version. The
/// remaining same-room discrimination problem is in the raw waveform
/// (physical mic bleed), not in which frames get selected -- masking
/// chooses what to feed the model, it can't clean the audio itself.
/// Reverted to match the reference implementation
/// (pasrom/meeting-transcriber's `FluidDiarizer.swift`) rather than keep
/// unproven complexity.
///
/// - Parameters:
///   - predictions: flat [numFrames x numSpeakers] from DiarizerTimeline.finalizedPredictions.
///   - numSpeakers: speaker-slot count (Sortformer hardcodes 4).
///   - threshold: activity threshold (timeline.config.onsetThreshold).
/// - Returns: [numSpeakers] arrays of length numFrames.
func buildOverlapExcludedMasks(
    predictions: [Float],
    numSpeakers: Int,
    threshold: Float
) -> [[Float]] {
    guard numSpeakers > 0, !predictions.isEmpty else { return [] }
    let numFrames = predictions.count / numSpeakers
    guard numFrames > 0 else { return [] }
    var masks = Array(repeating: Array(repeating: Float(0.0), count: numFrames), count: numSpeakers)

    for frame in 0..<numFrames {
        let base = frame * numSpeakers
        var activeSlot = -1
        var activeCount = 0
        for s in 0..<numSpeakers where predictions[base + s] >= threshold {
            activeCount += 1
            activeSlot = s
            if activeCount > 1 { break }
        }
        if activeCount == 1 {
            masks[activeSlot][frame] = 1.0
        }
    }
    return masks
}

/// Nearest-neighbour resample a per-frame activity mask onto a target frame
/// grid. Bridges Sortformer's 12.5 Hz output (~125 frames/10s) to
/// WeSpeaker's expected segmentation-frame count (typically 589/10s).
func resampleMask(_ mask: [Float], to targetCount: Int) -> [Float] {
    guard !mask.isEmpty, targetCount > 0 else {
        return Array(repeating: Float(0.0), count: max(0, targetCount))
    }
    var out = Array(repeating: Float(0.0), count: targetCount)
    let srcCount = mask.count
    for i in 0..<targetCount {
        let srcIdx = min(i * srcCount / targetCount, srcCount - 1)
        out[i] = mask[srcIdx]
    }
    return out
}

/// L2-normalised running-mean of per-chunk embeddings -> one centroid per
/// speaker.
func aggregateCentroids(
    sums: [String: [Float]],
    counts: [String: Int]
) -> [String: [Float]] {
    var result = [String: [Float]](minimumCapacity: sums.count)
    for (label, sum) in sums {
        let count = Float(counts[label] ?? 1)
        var mean = sum.map { $0 / count }
        let norm = (mean.reduce(into: Float(0)) { $0 += $1 * $1 }).squareRoot()
        if norm > 1e-9 {
            mean = mean.map { $0 / norm }
        }
        result[label] = mean
    }
    return result
}

/// Walk the audio in 10s chunks, run WeSpeaker on the top-3 active speakers
/// per chunk (the model's mask shape only fits 3), accumulate running sums
/// + counts per global Sortformer speaker slot. Sortformer's 4th speaker
/// (when present) gets covered in chunks where they rank in the top-3 of
/// that window.
func accumulateChunkEmbeddings(
    audio: [Float],
    masks: [[Float]],
    frameDuration: Double,
    weSpeakerFrameCount: Int,
    extractor: EmbeddingExtractor
) -> (sums: [String: [Float]], counts: [String: Int]) {
    let chunkSamples = 160_000  // 10s @ 16kHz -- matches EmbeddingExtractor's waveform shape
    let framesPerChunk = max(1, Int(10.0 / frameDuration))
    let numSpeakers = masks.count
    let maskFrameCount = masks.first?.count ?? 0

    var sums = [String: [Float]](minimumCapacity: numSpeakers)
    var counts = [String: Int](minimumCapacity: numSpeakers)
    var failedChunks = 0

    // Progress reporting for the parent process (Python's _run_steno_diarize):
    // this loop is the single longest-running phase on a multi-hour recording
    // (~1300+ sequential 10s chunks measured on a real ~3.5h file, ~18 minutes
    // per channel) with no other checkpoint to report from. Emitted to STDERR
    // -- stdout carries exactly one JSON line on success (see the file header
    // comment) and must never be touched mid-loop.
    let totalChunks = max(1, (audio.count + chunkSamples - 1) / chunkSamples)
    var chunkIndex = 0

    var sampleStart = 0
    var frameStart = 0
    while sampleStart < audio.count, frameStart < maskFrameCount {
        let sampleEnd = min(sampleStart + chunkSamples, audio.count)
        let frameEnd = min(frameStart + framesPerChunk, maskFrameCount)
        let chunk = Array(audio[sampleStart..<sampleEnd])
        let chunkMasks: [[Float]] = (0..<numSpeakers).map { Array(masks[$0][frameStart..<frameEnd]) }
        let activity = (0..<numSpeakers).map { (slot: $0, sum: chunkMasks[$0].reduce(0, +)) }
        let topSlots = activity.sorted { $0.sum > $1.sum }.prefix(3).map(\.slot)
        let masksForCall = topSlots.map { resampleMask(chunkMasks[$0], to: weSpeakerFrameCount) }

        // A single chunk's embedding extraction can fail transiently --
        // measured on a real ~3.5h recording (~1300+ sequential 10s
        // chunks): an internal FluidAudio/E5RT error partway through,
        // without the surrounding chunks being unhealthy. The previous
        // `throws`-and-propagate behavior let ONE bad chunk discard every
        // OTHER chunk's already-accumulated embeddings, zeroing out
        // voiceprint data for the entire recording over a single transient
        // failure. Catch per-chunk instead: skip just that chunk and keep
        // going, so a long recording still gets a real (if very slightly
        // incomplete) centroid rather than nothing at all.
        do {
            let embs = try extractor.getEmbeddings(audio: chunk, masks: masksForCall)
            for (i, slot) in topSlots.enumerated() {
                let emb = embs[i]
                guard !emb.allSatisfy({ $0 == 0 }) else { continue }
                let label = "SPEAKER_\(slot)"
                sums[label] = sums[label].map { zip($0, emb).map(+) } ?? emb
                counts[label, default: 0] += 1
            }
        } catch {
            failedChunks += 1
            fputs("steno-diarize: chunk embedding extraction failed, skipping this chunk: \(error)\n", stderr)
        }
        chunkIndex += 1
        fputs("PROGRESS:embedding:\(chunkIndex)/\(totalChunks)\n", stderr)
        sampleStart = sampleEnd
        frameStart = frameEnd
    }
    if failedChunks > 0 {
        fputs("steno-diarize: \(failedChunks) chunk(s) failed embedding extraction and were skipped\n", stderr)
    }
    return (sums, counts)
}

/// Extract one voiceprint centroid per active Sortformer speaker from
/// `timeline`'s frame-level predictions and the already-decoded 16kHz
/// audio samples. Returns an empty dict (never throws) on any embedding
/// failure — voiceprint identification is a best-effort enhancement, the
/// diarization segments themselves are the load-bearing output.
func extractSortformerEmbeddings(
    audio: [Float],
    timeline: DiarizerTimeline,
    cacheDirectory: URL
) async -> [String: [Float]] {
    do {
        let models = try await DiarizerModels.load(
            from: cacheDirectory.appendingPathComponent("speaker-diarization", isDirectory: true),
            configuration: MLModelConfigurationUtils.defaultConfiguration(computeUnits: resolveComputeUnits())
        )
        let extractor = EmbeddingExtractor(embeddingModel: models.embeddingModel)

        // WeSpeaker expects masks shaped [3, weSpeakerFrameCount] where the
        // frame count is fixed by the companion pyannote segmentation
        // model. Query at runtime so a future model swap doesn't silently
        // mis-shape.
        guard
            let segShape = models.segmentationModel.modelDescription
                .outputDescriptionsByName["segments"]?.multiArrayConstraint?.shape,
            segShape.count >= 2
        else {
            fputs("steno-diarize: embedding skipped (unexpected segmentation model shape)\n", stderr)
            return [:]
        }
        let weSpeakerFrameCount = segShape[1].intValue

        let masks = buildOverlapExcludedMasks(
            predictions: timeline.finalizedPredictions,
            numSpeakers: timeline.config.numSpeakers,
            threshold: timeline.config.onsetThreshold
        )
        let maskFrameCount = masks.first?.count ?? 0
        guard maskFrameCount > 0 else { return [:] }

        let (sums, counts) = accumulateChunkEmbeddings(
            audio: audio,
            masks: masks,
            frameDuration: Double(timeline.config.frameDurationSeconds),
            weSpeakerFrameCount: weSpeakerFrameCount,
            extractor: extractor
        )
        return aggregateCentroids(sums: sums, counts: counts)
    } catch {
        fputs("steno-diarize: embedding extraction failed (segments still valid): \(error)\n", stderr)
        return [:]
    }
}

// Keep the main run loop alive so dispatch sources (including the
// process-exit source that drives terminationHandler) can fire normally.
// sema.wait() blocks the main thread, which prevents dispatch delivery
// and causes terminationHandler to never fire.
Task {
    do {
        if isPrepareModels {
            fputs("steno-diarize: preparing speaker diarization models\n", stderr)
            let status = try await ModelReadiness.prepare(computeUnits: resolveComputeUnits())
            try printJSON(status)
            exit(0)
        }

        guard let inputPath else {
            fail("missing audio file")
        }

        let cacheDirectory = ModelReadiness.runtimeCacheDirectory()
        let modelStatus = ModelReadiness.status(cacheDirectory: cacheDirectory)
        guard modelStatus.ready else {
            try printJSON(modelStatus)
            fail(
                "speaker diarization models are not prepared; run steno-diarize prepare-models",
                code: 3
            )
        }
        ModelReadiness.enableOfflineOnly()

        let samples = try await loadSamplesViaFfmpeg(path: inputPath)

        // .cpuAndNeuralEngine forces genuine ANE execution — the default
        // .all silently routes Sortformer to GPU instead (confirmed via
        // Activity Monitor during evaluation). resolveComputeUnits() keeps
        // that as the default but allows STENOAI_DIARIZE_COMPUTE_UNITS=all
        // (or =cpuAndGPU) to opt into GPU for one-off bulk backfill runs
        // where throughput matters more than the live-recording-path's
        // power/thermal efficiency.
        //
        // Sortformer config: this app only ever diarizes a fully-recorded,
        // already-finished channel (no live/streaming diarization exists
        // yet), so .default's low-latency 0.48s-per-invocation chunking
        // (tuned for real-time responsiveness this app has no use for)
        // costs ~56x more CoreML invocations than .highContextV2's
        // 27.2s-per-invocation chunking on the same audio (measured:
        // ~22,500 vs ~400 invocations for a 3-hour recording) — but
        // highContextV2 needs a full ~30.4s window before it emits
        // anything at all, so it's only used once the recording is
        // comfortably longer than that (see sortformerHighContextMinDuration).
        // V2, not V2.1: FluidAudio's own docs note V2.1 "may degrade when
        // many speakers are talking simultaneously" — a real risk given
        // this app's crosstalk/echo findings from earlier this session.
        // Both the model-loading config below AND SortformerDiarizer's own
        // config must match — its internal chunk/fifo/spkcache buffers are
        // sized from whatever config it's constructed with, independent of
        // which model weights get loaded.
        let durationSeconds = Double(samples.count) / 16000.0
        let sortformerConfig: SortformerConfig =
            durationSeconds >= sortformerHighContextMinDuration ? .highContextV2 : .default
        let models = try await SortformerModels.loadFromHuggingFace(
            config: sortformerConfig,
            cacheDirectory: cacheDirectory,
            computeUnits: resolveComputeUnits()
        )
        let diarizer = SortformerDiarizer(config: sortformerConfig)
        diarizer.initialize(models: models)

        let timeline = try diarizer.processComplete(samples, sourceSampleRate: nil)

        struct Segment: Encodable {
            let speakerId: String
            let start: Double
            let end: Double
        }
        struct Output: Encodable {
            let segments: [Segment]
            let speakers: [String: [Float]]
        }

        let segments = timeline.speakers.values
            .flatMap { $0.finalizedSegments }
            .filter { $0.duration >= minSegmentDurationSeconds }
            .map { seg in
                Segment(
                    speakerId: "SPEAKER_\(seg.speakerIndex)",
                    start: Double(seg.startTime),
                    end: Double(seg.endTime)
                )
            }
            .sorted { $0.start < $1.start }

        // Voiceprint centroids, one per active speaker slot. Best-effort:
        // extractSortformerEmbeddings never throws, returning [:] on any
        // failure so a voiceprint problem can never take down diarization
        // itself (the segments above are the load-bearing output).
        let speakers = await extractSortformerEmbeddings(
            audio: samples,
            timeline: timeline,
            cacheDirectory: cacheDirectory
        )

        let output = Output(segments: segments, speakers: speakers)
        try printJSON(output)
        exit(0)
    } catch {
        fputs("steno-diarize error: \(error)\n", stderr)
        exit(1)
    }
}

RunLoop.main.run()
