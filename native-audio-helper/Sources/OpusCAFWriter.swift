import AudioToolbox
import Darwin
import Foundation

public enum OpusCAFWriteMode: Equatable, Sendable {
    case repackagedOpus
}

public enum OpusCAFWriterError: Error, Equatable, Sendable {
    case invalidSampleRate
    case invalidChannelCount
    case invalidMagicCookie
    case emptyPacket(Int)
    case invalidOpusPacket(Int)
    case dataTooLarge
    case audioFileOperation(operation: String, status: OSStatus)
    case partialPacketWrite(expected: UInt32, actual: UInt32)
}

public enum OpusCAFWriter {
    /// Writes the encoded packets without decoding them. The native Opus CAF path is
    /// covered by an AVFoundation readability test, so no PCM fallback is needed on
    /// the supported macOS version.
    public static func write(
        _ audio: WebMOpusAudio,
        to url: URL
    ) throws -> OpusCAFWriteMode {
        try validate(audio)

        var format = AudioStreamBasicDescription(
            mSampleRate: audio.sampleRate,
            mFormatID: kAudioFormatOpus,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 0,
            mBytesPerFrame: 0,
            mChannelsPerFrame: audio.channelCount,
            mBitsPerChannel: 0,
            mReserved: 0
        )
        var audioFile: AudioFileID?
        try requireNoError(
            AudioFileCreateWithURL(
                url as CFURL,
                kAudioFileCAFType,
                &format,
                .eraseFile,
                &audioFile
            ),
            operation: "AudioFileCreateWithURL"
        )
        guard let file = audioFile else {
            throw OpusCAFWriterError.audioFileOperation(
                operation: "AudioFileCreateWithURL returned no file",
                status: kAudio_ParamError
            )
        }

        do {
            try audio.magicCookie.withUnsafeBytes { bytes in
                guard let baseAddress = bytes.baseAddress else {
                    throw OpusCAFWriterError.invalidMagicCookie
                }
                try requireNoError(
                    AudioFileSetProperty(
                        file,
                        kAudioFilePropertyMagicCookieData,
                        UInt32(bytes.count),
                        baseAddress
                    ),
                    operation: "AudioFileSetProperty(MagicCookieData)"
                )
            }
            try writePackets(audio.packets, to: file)
            try requireNoError(
                AudioFileClose(file),
                operation: "AudioFileClose"
            )
        } catch {
            AudioFileClose(file)
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        return .repackagedOpus
    }
}

extension OpusCAFWriter {
    static let packetsPerWrite = 1_024

    static func validate(_ audio: WebMOpusAudio) throws {
        guard audio.sampleRate.isFinite, audio.sampleRate > 0 else {
            throw OpusCAFWriterError.invalidSampleRate
        }
        guard audio.channelCount > 0, audio.channelCount <= UInt32(UInt8.max) else {
            throw OpusCAFWriterError.invalidChannelCount
        }
        guard audio.magicCookie.count >= 19,
              audio.magicCookie.starts(with: Data("OpusHead".utf8)),
              audio.magicCookie[8] == 1,
              audio.magicCookie[9] == UInt8(audio.channelCount) else {
            throw OpusCAFWriterError.invalidMagicCookie
        }
        for (index, packet) in audio.packets.enumerated() {
            guard !packet.isEmpty else {
                throw OpusCAFWriterError.emptyPacket(index)
            }
            guard opusFrameCount(packet) != nil else {
                throw OpusCAFWriterError.invalidOpusPacket(index)
            }
        }
    }

    @discardableResult
    static func writePackets(
        _ packets: [Data],
        to file: AudioFileID,
        startingAt: Int64 = 0
    ) throws -> Int64 {
        var startingPacket: Int64 = startingAt
        var startIndex = 0
        while startIndex < packets.count {
            let endIndex = min(startIndex + packetsPerWrite, packets.count)
            let chunk = packets[startIndex..<endIndex]
            var data = Data()
            var descriptions: [AudioStreamPacketDescription] = []
            descriptions.reserveCapacity(chunk.count)

            for packet in chunk {
                guard let byteCount = UInt32(exactly: packet.count),
                      let frameCount = opusFrameCount(packet) else {
                    throw OpusCAFWriterError.dataTooLarge
                }
                descriptions.append(AudioStreamPacketDescription(
                    mStartOffset: Int64(data.count),
                    mVariableFramesInPacket: frameCount,
                    mDataByteSize: byteCount
                ))
                data.append(packet)
            }
            guard let dataByteCount = UInt32(exactly: data.count),
                  let expectedPacketCount = UInt32(exactly: descriptions.count) else {
                throw OpusCAFWriterError.dataTooLarge
            }
            var writtenPacketCount = expectedPacketCount
            let status = descriptions.withUnsafeBufferPointer { packetDescriptions in
                data.withUnsafeBytes { bytes in
                    guard let baseAddress = bytes.baseAddress else {
                        return kAudio_ParamError
                    }
                    return AudioFileWritePackets(
                        file,
                        false,
                        dataByteCount,
                        packetDescriptions.baseAddress,
                        startingPacket,
                        &writtenPacketCount,
                        baseAddress
                    )
                }
            }
            try requireNoError(status, operation: "AudioFileWritePackets")
            guard writtenPacketCount == expectedPacketCount else {
                throw OpusCAFWriterError.partialPacketWrite(
                    expected: expectedPacketCount,
                    actual: writtenPacketCount
                )
            }
            startingPacket += Int64(writtenPacketCount)
            startIndex = endIndex
        }
        return startingPacket
    }

    static func opusFrameCount(_ packet: Data) -> UInt32? {
        guard let tableOfContents = packet.first else { return nil }
        let configuration = tableOfContents >> 3
        let samplesPerFrame: UInt32
        switch configuration {
        case 0...11:
            samplesPerFrame = [480, 960, 1_920, 2_880][Int(configuration & 0x03)]
        case 12...15:
            samplesPerFrame = (configuration & 0x01) == 0 ? 480 : 960
        default:
            samplesPerFrame = [120, 240, 480, 960][Int(configuration & 0x03)]
        }

        let frameCount: UInt32
        switch tableOfContents & 0x03 {
        case 0:
            frameCount = 1
        case 1, 2:
            frameCount = 2
        default:
            guard packet.count >= 2 else { return nil }
            frameCount = UInt32(packet[1] & 0x3F)
            guard frameCount > 0 else { return nil }
        }
        let (total, overflow) = samplesPerFrame.multipliedReportingOverflow(by: frameCount)
        guard !overflow, total <= 5_760 else { return nil }
        return total
    }

    static func requireNoError(_ status: OSStatus, operation: String) throws {
        guard status == noErr else {
            throw OpusCAFWriterError.audioFileOperation(
                operation: operation,
                status: status
            )
        }
    }
}

extension OpusCAFWriter {
    /// Remuxes a bounded, timing-validated WebM stream into an empty borrowed FD.
    /// The caller removes partial output on failure; no pathname is ever opened.
    public static func repackage(
        source: Int32, destination: Int32,
        checkCancellation: @escaping () throws -> Void = { try Task.checkCancellation() }
    ) throws -> WebMOpusStreamSummary {
        var original = stat(), target = stat()
        guard fstat(source, &original) == 0, fstat(destination, &target) == 0,
              original.st_mode & S_IFMT == S_IFREG, target.st_mode & S_IFMT == S_IFREG,
              target.st_size == 0, original.st_dev != target.st_dev || original.st_ino != target.st_ino else {
            throw CAFEncoder.Failure.invalidFiles
        }
        let context = Context(destination)
        return try withExtendedLifetime(context) {
            var file: AudioFileID?
            defer { if let file { AudioFileClose(file) } }
            var buffered: [Data] = []
            var bufferedBytes = 0
            var startingPacket: Int64 = 0
            func flush() throws {
                try checkCancellation()
                guard let file else { throw OpusCAFWriterError.invalidMagicCookie }
                startingPacket = try writePackets(buffered, to: file, startingAt: startingPacket)
                buffered.removeAll(keepingCapacity: true)
                bufferedBytes = 0
            }
            let summary = try WebMOpusReader.stream(from: source, checkCancellation: checkCancellation,
                onHeader: { info in
                    var format = AudioStreamBasicDescription(mSampleRate: 48_000,
                        mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
                        mFramesPerPacket: 0, mBytesPerFrame: 0, mChannelsPerFrame: info.channelCount,
                        mBitsPerChannel: 0, mReserved: 0)
                    try requireNoError(AudioFileInitializeWithCallbacks(Unmanaged.passUnretained(context).toOpaque(),
                        readAudio, writeAudio, audioSize, setAudioSize, kAudioFileCAFType, &format, [], &file),
                        operation: "AudioFileInitializeWithCallbacks")
                    guard let file else { throw OpusCAFWriterError.invalidMagicCookie }
                    try info.magicCookie.withUnsafeBytes { bytes in
                        try requireNoError(AudioFileSetProperty(file, kAudioFilePropertyMagicCookieData,
                            UInt32(bytes.count), bytes.baseAddress!), operation: "MagicCookieData")
                    }
                }, onPacket: { packet, _ in
                    if !buffered.isEmpty && (bufferedBytes + packet.count > 65_536 || buffered.count == 128) { try flush() }
                    buffered.append(packet)
                    bufferedBytes += packet.count
                })
            if !buffered.isEmpty { try flush() }
            guard let opened = file else { throw OpusCAFWriterError.invalidMagicCookie }
            var table = AudioFilePacketTableInfo(mNumberValidFrames: summary.validFrameCount,
                mPrimingFrames: Int32(summary.info.preSkip), mRemainderFrames: Int32(summary.remainderFrames))
            try requireNoError(AudioFileSetProperty(opened, kAudioFilePropertyPacketTableInfo,
                UInt32(MemoryLayout.size(ofValue: table)), &table), operation: "PacketTableInfo")
            file = nil
            try requireNoError(AudioFileClose(opened), operation: "AudioFileClose")
            try checkCancellation()
            return summary
        }
    }
}
