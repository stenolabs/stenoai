@preconcurrency import AudioToolbox
import Darwin
import Foundation

/// Streaming AAC-LC encoding. File descriptors are borrowed, never closed or truncated.
/// The caller owns source integrity checks, an empty exclusive output, and cleanup.
public enum CAFEncoder {
    public struct Result: Codable, Sendable {
        public let sampleRate: Double
        public let channelCount: Int
        public let frameCount: Int64
        public let bitRate: UInt32
    }

    public enum InputContainer: Sendable { case caf, wave }

    public enum Failure: Error { case invalidFiles, unsupportedFormat, audio(OSStatus, line: UInt) }

    public static func encode(
        source: Int32, destination: Int32,
        inputContainer: InputContainer = .caf,
        checkCancellation: () throws -> Void = { try Task.checkCancellation() }
    ) throws -> Result {
        try checkCancellation()
        var inputStat = stat(), outputStat = stat()
        guard fstat(source, &inputStat) == 0, fstat(destination, &outputStat) == 0,
              inputStat.st_mode & S_IFMT == S_IFREG,
              outputStat.st_mode & S_IFMT == S_IFREG, outputStat.st_size == 0,
              inputStat.st_dev != outputStat.st_dev || inputStat.st_ino != outputStat.st_ino
        else { throw Failure.invalidFiles }
        let input = Context(source), output = Context(destination)
        return try withExtendedLifetime((input, output)) {
            var sourceFile: AudioFileID?
            try checked(AudioFileOpenWithCallbacks(Unmanaged.passUnretained(input).toOpaque(),
                readAudio, nil, audioSize, nil, inputContainer == .caf ? kAudioFileCAFType : kAudioFileWAVEType, &sourceFile))
            guard let sourceFile else { throw Failure.invalidFiles }
            defer { AudioFileClose(sourceFile) }
            var reader: ExtAudioFileRef?
            try checked(ExtAudioFileWrapAudioFileID(sourceFile, false, &reader))
            guard let reader else { throw Failure.invalidFiles }
            defer { ExtAudioFileDispose(reader) }
            var format = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout.size(ofValue: format))
            try checked(ExtAudioFileGetProperty(reader, kExtAudioFileProperty_FileDataFormat, &size, &format))
            guard format.mFormatID == kAudioFormatLinearPCM,
                  (1...2).contains(format.mChannelsPerFrame),
                  format.mSampleRate.isFinite, format.mSampleRate > 0
            else { throw Failure.unsupportedFormat }
            var frames: Int64 = 0
            size = UInt32(MemoryLayout.size(ofValue: frames))
            try checked(ExtAudioFileGetProperty(reader, kExtAudioFileProperty_FileLengthFrames, &size, &frames))
            guard frames > 0 else { throw Failure.unsupportedFormat }
            var aac = AudioStreamBasicDescription()
            aac.mSampleRate = format.mSampleRate
            aac.mFormatID = kAudioFormatMPEG4AAC
            aac.mChannelsPerFrame = format.mChannelsPerFrame
            size = UInt32(MemoryLayout.size(ofValue: aac))
            try checked(AudioFormatGetProperty(kAudioFormatProperty_FormatInfo, 0, nil, &size, &aac))
            var targetFile: AudioFileID?
            try checked(AudioFileInitializeWithCallbacks(Unmanaged.passUnretained(output).toOpaque(),
                readAudio, writeAudio, audioSize, setAudioSize, kAudioFileCAFType, &aac, [], &targetFile))
            guard let targetFile else { throw Failure.invalidFiles }
            var targetClosed = false
            defer { if !targetClosed { AudioFileClose(targetFile) } }
            var writer: ExtAudioFileRef?
            try checked(ExtAudioFileWrapAudioFileID(targetFile, true, &writer))
            guard let writer else { throw Failure.invalidFiles }
            var writerClosed = false
            defer { if !writerClosed { ExtAudioFileDispose(writer) } }
            var pcm = AudioStreamBasicDescription(mSampleRate: format.mSampleRate,
                mFormatID: kAudioFormatLinearPCM,
                mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                mBytesPerPacket: 4 * format.mChannelsPerFrame, mFramesPerPacket: 1,
                mBytesPerFrame: 4 * format.mChannelsPerFrame,
                mChannelsPerFrame: format.mChannelsPerFrame, mBitsPerChannel: 32, mReserved: 0)
            let pcmSize = UInt32(MemoryLayout.size(ofValue: pcm))
            try checked(ExtAudioFileSetProperty(reader, kExtAudioFileProperty_ClientDataFormat, pcmSize, &pcm))
            try checked(ExtAudioFileSetProperty(writer, kExtAudioFileProperty_ClientDataFormat, pcmSize, &pcm))
            var converter: AudioConverterRef?
            size = UInt32(MemoryLayout.size(ofValue: converter))
            try checked(ExtAudioFileGetProperty(writer, kExtAudioFileProperty_AudioConverter, &size, &converter))
            guard let converter else { throw Failure.unsupportedFormat }
            var bitRate: UInt32 = format.mChannelsPerFrame == 1 ? 64_000 : 128_000
            // AAC-LC has lower bitrate ceilings at low sample rates. Preserve the
            // source rate instead of upsampling just to reach the preferred bitrate.
            var rateSize: UInt32 = 0
            try checked(AudioConverterGetPropertyInfo(converter, kAudioConverterApplicableEncodeBitRates, &rateSize, nil))
            var ranges = [AudioValueRange](repeating: AudioValueRange(), count: Int(rateSize) / MemoryLayout<AudioValueRange>.size)
            try checked(AudioConverterGetProperty(converter, kAudioConverterApplicableEncodeBitRates, &rateSize, &ranges))
            guard let selectedRate = ranges.map({ min(max(Double(bitRate), $0.mMinimum), $0.mMaximum) })
                .min(by: { abs($0 - Double(bitRate)) < abs($1 - Double(bitRate)) }),
                selectedRate.isFinite, selectedRate > 0, selectedRate <= Double(UInt32.max)
            else { throw Failure.unsupportedFormat }
            bitRate = UInt32(selectedRate)
            try checked(AudioConverterSetProperty(converter, kAudioConverterEncodeBitRate,
                UInt32(MemoryLayout.size(ofValue: bitRate)), &bitRate))
            let capacity: UInt32 = 8192
            let bytes = Int(capacity * pcm.mBytesPerFrame)
            let storage = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 16)
            defer { storage.deallocate() }
            var consumed: Int64 = 0
            while true {
                try checkCancellation()
                var count = capacity
                var buffers = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
                    mNumberChannels: pcm.mChannelsPerFrame, mDataByteSize: UInt32(bytes), mData: storage))
                try checked(ExtAudioFileRead(reader, &count, &buffers))
                if count == 0 { break }
                try checked(ExtAudioFileWrite(writer, count, &buffers))
                consumed += Int64(count)
            }
            guard consumed == frames else { throw Failure.invalidFiles }
            writerClosed = true
            try checked(ExtAudioFileDispose(writer))
            targetClosed = true
            try checked(AudioFileClose(targetFile))
            try checkCancellation()
            return Result(sampleRate: format.mSampleRate, channelCount: Int(format.mChannelsPerFrame),
                frameCount: frames, bitRate: bitRate)
        }
    }

    private static func checked(_ status: OSStatus, line: UInt = #line) throws {
        if status != noErr { throw Failure.audio(status, line: line) }
    }
}
