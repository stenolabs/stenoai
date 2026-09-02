import AVFAudio
import CoreMedia
import Foundation
import Speech

private enum SidecarError: LocalizedError {
    case usage
    case unavailable
    case unsupportedLocale(String)
    case assetUnavailable(String)
    case incompatibleAudioFormat
    case invalidAudioFrame

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: steno-transcribe status [locale] | prepare [locale] | transcribe-file <wav> [locale] | stream [locale]"
        case .unavailable:
            return "Apple on-device transcription is unavailable on this Mac."
        case .unsupportedLocale(let locale):
            return "Apple on-device transcription does not support locale \(locale)."
        case .assetUnavailable(let locale):
            return "The Apple speech asset for \(locale) could not be installed."
        case .incompatibleAudioFormat:
            return "Apple SpeechTranscriber did not accept 16 kHz mono Int16 audio."
        case .invalidAudioFrame:
            return "Could not allocate an Apple speech audio buffer."
        }
    }
}

private struct StatusOutput: Encodable {
    let success: Bool
    let available: Bool
    let supported: Bool
    let installed: Bool
    let locale: String?
    let displayName: String
    let systemManaged: Bool

    enum CodingKeys: String, CodingKey {
        case success, available, supported, installed, locale
        case displayName = "display_name"
        case systemManaged = "system_managed"
    }
}

private struct ErrorOutput: Encodable {
    let success = false
    let error: String
}

private struct TranscriptSegment: Encodable {
    let text: String
    let start: Double
    let end: Double
}

private struct TranscriptOutput: Encodable {
    let text: String
    let segments: [TranscriptSegment]
    let durationSeconds: Double
    let detectedLanguage: String
    let detectedLanguageProbability: Double?

    enum CodingKeys: String, CodingKey {
        case text, segments
        case durationSeconds = "duration_seconds"
        case detectedLanguage = "detected_language"
        case detectedLanguageProbability = "detected_language_probability"
    }
}

private struct CollectedTranscript {
    let text: String
    let segments: [TranscriptSegment]
}

private let lexicalCharacterSet: CharacterSet = {
    var set = CharacterSet.letters
    set.formUnion(.decimalDigits)
    return set
}()

private func hasLexicalContent(_ text: String) -> Bool {
    for scalar in text.unicodeScalars {
        if CharacterSet.whitespacesAndNewlines.contains(scalar) {
            continue
        }
        if lexicalCharacterSet.contains(scalar) {
            return true
        }
    }
    return false
}

private actor LineEmitter {
    func emit(_ line: String) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        FileHandle.standardOutput.write(data)
    }

    func emitLiveError(stage: String, message: String) {
        let payload: [String: Any] = ["stage": stage, "message": message]
        guard let json = try? JSONSerialization.data(withJSONObject: payload),
              let str = String(data: json, encoding: .utf8) else { return }
        emit("LIVE_ERROR:\(str)")
    }
}

@main
private struct StenoTranscribe {
    private static let displayName = "Apple On-Device"
    private static let inputFrameBytes = MemoryLayout<Float>.size * 2
    private static let readChunkBytes = 8 * 1024
    private static let defaultLocaleIdentifiers = [
        "en": "en_US",
        "es": "es_ES",
        "fr": "fr_FR",
        "de": "de_DE",
        "pt": "pt_PT",
        "ja": "ja_JP",
        "ko": "ko_KR",
        "hi": "hi_IN",
        "zh-Hans": "zh_CN",
        "zh-Hant": "zh_TW",
    ]

    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        let command = arguments.first ?? ""
        do {
            switch command {
            case "status":
                await printStatus(requestedLocale: arguments.count > 1 ? arguments[1] : "auto")
            case "prepare":
                let locale = try await resolveLocale(arguments.count > 1 ? arguments[1] : "auto")
                try await ensureAsset(for: locale)
                writeJSON(StatusOutput(
                    success: true,
                    available: true,
                    supported: true,
                    installed: true,
                    locale: locale.identifier,
                    displayName: displayName,
                    systemManaged: true
                ))
            case "transcribe-file":
                guard arguments.count >= 2 else { throw SidecarError.usage }
                let requestedLocale = arguments.count > 2 ? arguments[2] : "auto"
                let locale = try await resolveLocale(requestedLocale)
                try await requireInstalledAsset(for: locale)
                let output = try await transcribeFile(
                    URL(fileURLWithPath: arguments[1]),
                    locale: locale
                )
                writeJSON(output)
            case "stream":
                let requestedLocale = arguments.count > 1 ? arguments[1] : "auto"
                let locale = try await resolveLocale(requestedLocale)
                try await requireInstalledAsset(for: locale)
                try await stream(locale: locale)
            default:
                throw SidecarError.usage
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription
                ?? "Apple transcription failed."
            if command == "stream" {
                await LineEmitter().emitLiveError(stage: "native", message: message)
            } else {
                writeJSON(ErrorOutput(error: message))
            }
            Foundation.exit(1)
        }
    }

    private static func printStatus(requestedLocale: String) async {
        guard SpeechTranscriber.isAvailable else {
            writeJSON(StatusOutput(
                success: true,
                available: false,
                supported: false,
                installed: false,
                locale: nil,
                displayName: displayName,
                systemManaged: true
            ))
            return
        }

        do {
            let locale = try await resolveLocale(requestedLocale)
            let installed = await Set(SpeechTranscriber.installedLocales.map(\.identifier))
            writeJSON(StatusOutput(
                success: true,
                available: true,
                supported: true,
                installed: installed.contains(locale.identifier),
                locale: locale.identifier,
                displayName: displayName,
                systemManaged: true
            ))
        } catch {
            writeJSON(StatusOutput(
                success: true,
                available: true,
                supported: false,
                installed: false,
                locale: nil,
                displayName: displayName,
                systemManaged: true
            ))
        }
    }

    private static func resolveLocale(_ requested: String) async throws -> Locale {
        guard SpeechTranscriber.isAvailable else { throw SidecarError.unavailable }
        let candidate: Locale
        if requested == "auto" {
            candidate = Locale.current
        } else if Locale.current.language.languageCode?.identifier == requested {
            candidate = Locale.current
        } else {
            candidate = Locale(
                identifier: defaultLocaleIdentifiers[requested] ?? requested
            )
        }
        guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: candidate) else {
            throw SidecarError.unsupportedLocale(requested)
        }
        let supported = await Set(SpeechTranscriber.supportedLocales.map(\.identifier))
        guard supported.contains(resolved.identifier) else {
            throw SidecarError.unsupportedLocale(requested)
        }
        return resolved
    }

    private static func requireInstalledAsset(for locale: Locale) async throws {
        let installed = await Set(SpeechTranscriber.installedLocales.map(\.identifier))
        guard installed.contains(locale.identifier) else {
            throw SidecarError.assetUnavailable(locale.identifier)
        }
    }

    private static func ensureAsset(for locale: Locale) async throws {
        let installed = await Set(SpeechTranscriber.installedLocales.map(\.identifier))
        if installed.contains(locale.identifier) { return }

        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        guard let request = try await AssetInventory.assetInstallationRequest(
            supporting: [transcriber]
        ) else {
            throw SidecarError.assetUnavailable(locale.identifier)
        }
        try await request.downloadAndInstall()

        let installedAfterDownload = await Set(
            SpeechTranscriber.installedLocales.map(\.identifier)
        )
        guard installedAfterDownload.contains(locale.identifier) else {
            throw SidecarError.assetUnavailable(locale.identifier)
        }
    }

    private static func transcribeFile(
        _ url: URL,
        locale: Locale
    ) async throws -> TranscriptOutput {
        let file = try AVAudioFile(forReading: url)
        let duration = file.fileFormat.sampleRate > 0
            ? Double(file.length) / file.fileFormat.sampleRate
            : 0
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        async let collected = collectFinalResults(from: transcriber)

        let analyzer = SpeechAnalyzer(
            modules: [transcriber],
            options: .init(priority: .userInitiated, modelRetention: .whileInUse)
        )
        if let lastSample = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
            await analyzer.cancelAndFinishNow()
        }

        let result = try await collected
        return TranscriptOutput(
            text: result.text.trimmingCharacters(in: .whitespacesAndNewlines),
            segments: result.segments,
            durationSeconds: duration,
            detectedLanguage: locale.language.languageCode?.identifier ?? locale.identifier,
            detectedLanguageProbability: nil
        )
    }

    private static func collectFinalResults(
        from transcriber: SpeechTranscriber
    ) async throws -> CollectedTranscript {
        var fullText = ""
        var segments: [TranscriptSegment] = []
        var seen: Set<String> = []
        for try await result in transcriber.results {
            guard result.isFinal else { continue }
            let rawText = String(result.text.characters)
            let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, hasLexicalContent(text) else { continue }
            let start = safeSeconds(result.range.start)
            let end = start + safeSeconds(result.range.duration)
            let identity = "\(result.range.start.value):\(result.range.duration.value):\(text)"
            guard seen.insert(identity).inserted else { continue }
            fullText += rawText
            segments.append(TranscriptSegment(text: text, start: start, end: end))
        }
        return CollectedTranscript(text: fullText, segments: segments)
    }

    private static func stream(locale: Locale) async throws {

        let leftTranscriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.audioTimeRange, .transcriptionConfidence]
        )
        let rightTranscriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.audioTimeRange, .transcriptionConfidence]
        )
        let modules: [any SpeechModule] = [leftTranscriber, rightTranscriber]
        let naturalFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: true
        )
        guard let naturalFormat,
              let format = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: modules,
                considering: naturalFormat
              ),
              format.sampleRate == 16_000,
              format.channelCount == 1,
              format.commonFormat == .pcmFormatInt16 else {
            throw SidecarError.incompatibleAudioFormat
        }

        let leftAnalyzer = SpeechAnalyzer(
            modules: [leftTranscriber],
            options: .init(priority: .userInitiated, modelRetention: .whileInUse)
        )
        let rightAnalyzer = SpeechAnalyzer(
            modules: [rightTranscriber],
            options: .init(priority: .userInitiated, modelRetention: .whileInUse)
        )
        try await leftAnalyzer.prepareToAnalyze(in: format)
        try await rightAnalyzer.prepareToAnalyze(in: format)

        let (leftInput, leftContinuation) = AsyncStream<AnalyzerInput>.makeStream(
            bufferingPolicy: .bufferingNewest(32)
        )
        let (rightInput, rightContinuation) = AsyncStream<AnalyzerInput>.makeStream(
            bufferingPolicy: .bufferingNewest(32)
        )
        let emitter = LineEmitter()
        let leftResults = Task {
            await forwardResults(leftTranscriber, speaker: "You", emitter: emitter)
        }
        let rightResults = Task {
            await forwardResults(rightTranscriber, speaker: "Others", emitter: emitter)
        }
        let leftAnalysis = Task {
            try await leftAnalyzer.start(inputSequence: leftInput)
        }
        let rightAnalysis = Task {
            try await rightAnalyzer.start(inputSequence: rightInput)
        }

        await emitter.emit("LIVE_READY:\(locale.identifier)")
        do {
            var pending = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: readChunkBytes),
                  !chunk.isEmpty {
                pending.append(chunk)
                let completeBytes = pending.count - (pending.count % inputFrameBytes)
                guard completeBytes > 0 else { continue }
                let block = Data(pending.prefix(completeBytes))
                pending.removeFirst(completeBytes)
                let frameCount = completeBytes / inputFrameBytes
                let leftResult = leftContinuation.yield(AnalyzerInput(
                    buffer: try makeMonoBuffer(
                        from: block,
                        channel: 0,
                        frameCount: frameCount,
                        format: format
                    )
                ))
                let rightResult = rightContinuation.yield(AnalyzerInput(
                    buffer: try makeMonoBuffer(
                        from: block,
                        channel: 1,
                        frameCount: frameCount,
                        format: format
                    )
                ))
                if case .dropped = leftResult {
                    await emitter.emitLiveError(
                        stage: "transcribe",
                        message: "Live audio buffer overflow — processing fell behind and some audio was dropped."
                    )
                } else if case .dropped = rightResult {
                    await emitter.emitLiveError(
                        stage: "transcribe",
                        message: "Live audio buffer overflow — processing fell behind and some audio was dropped."
                    )
                }
                if case .terminated = leftResult {
                    throw CancellationError()
                }
                if case .terminated = rightResult {
                    throw CancellationError()
                }
            }

            leftContinuation.finish()
            rightContinuation.finish()
            async let finishLeft: Void = leftAnalyzer.finalizeAndFinishThroughEndOfInput()
            async let finishRight: Void = rightAnalyzer.finalizeAndFinishThroughEndOfInput()
            try await finishLeft
            try await finishRight
            try await leftAnalysis.value
            try await rightAnalysis.value
            await leftResults.value
            await rightResults.value
        } catch {
            leftContinuation.finish()
            rightContinuation.finish()
            leftAnalysis.cancel()
            rightAnalysis.cancel()
            leftResults.cancel()
            rightResults.cancel()
            await leftAnalyzer.cancelAndFinishNow()
            await rightAnalyzer.cancelAndFinishNow()
            throw error
        }
    }

    private static func forwardResults(
        _ transcriber: SpeechTranscriber,
        speaker: String,
        emitter: LineEmitter
    ) async {
        var seenFinals: Set<String> = []
        do {
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty, hasLexicalContent(text) else { continue }
                if result.isFinal {
                    let identity = "\(result.range.start.value):\(result.range.duration.value):\(text)"
                    guard seenFinals.insert(identity).inserted else { continue }
                }
                let start = safeSeconds(result.range.start)
                let payload: [String: Any] = [
                    "text": text,
                    "start": start,
                    "end": start + safeSeconds(result.range.duration),
                    "is_final": result.isFinal,
                    "speaker": speaker,
                ]
                guard let data = try? JSONSerialization.data(withJSONObject: payload),
                      let json = String(data: data, encoding: .utf8) else { continue }
                await emitter.emit("LIVE_SEG:\(json)")
            }
        } catch is CancellationError {
            return
        } catch {
            await emitter.emitLiveError(
                stage: "transcribe",
                message: "Apple live transcription stopped unexpectedly."
            )
        }
    }

    private static func makeMonoBuffer(
        from stereoData: Data,
        channel: Int,
        frameCount: Int,
        format: AVAudioFormat
    ) throws -> AVAudioPCMBuffer {
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
        ), let samples = buffer.int16ChannelData?[0] else {
            throw SidecarError.invalidAudioFrame
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        stereoData.withUnsafeBytes { raw in
            for frame in 0..<frameCount {
                let byteOffset = (frame * 2 + channel) * MemoryLayout<Float>.size
                let value = raw.loadUnaligned(fromByteOffset: byteOffset, as: Float.self)
                let finite = value.isFinite ? value : 0
                let clamped = min(1, max(-1, finite))
                let scaled = clamped >= 0 ? clamped * 32_767 : clamped * 32_768
                samples[frame] = Int16(scaled)
            }
        }
        return buffer
    }

    private static func safeSeconds(_ time: CMTime) -> Double {
        let seconds = CMTimeGetSeconds(time)
        return seconds.isFinite ? max(0, seconds) : 0
    }

    private static func writeJSON<T: Encodable>(_ value: T) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
