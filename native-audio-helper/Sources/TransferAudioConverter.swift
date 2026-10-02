@preconcurrency import AudioToolbox
import CryptoKit
import Darwin
import Foundation

/// Native helper boundary. The caller exclusively owns the borrowed descriptors
/// and removes partial output after every failure or cancellation.
public enum TransferAudioConverter {
    public struct Result: Codable, Sendable {
        public let codec: String
        public let operation: String
        public let sampleRate: Double
        public let channelCount: Int
        public let frameCount: Int64
        public let bitRate: UInt32?
        public let sourceSHA256: String
        public let outputSHA256: String
        public let byteCount: Int64
    }

    public enum Failure: Error { case invalidFiles, unsupportedContainer, sourceChanged, readFailed }

    public static func convert(
        source: Int32, destination: Int32,
        checkCancellation: @escaping () throws -> Void = { try Task.checkCancellation() }
    ) throws -> Result {
        try checkCancellation()
        var before = stat(), target = stat()
        guard fstat(source, &before) == 0, fstat(destination, &target) == 0,
              before.st_mode & S_IFMT == S_IFREG, before.st_size >= 12, before.st_size <= 16 * 1024 * 1024 * 1024,
              target.st_mode & S_IFMT == S_IFREG, target.st_size == 0,
              before.st_dev != target.st_dev || before.st_ino != target.st_ino
        else { throw Failure.invalidFiles }
        let sourceHash = try digest(source, byteCount: before.st_size, checkCancellation: checkCancellation)
        var header = [UInt8](repeating: 0, count: 12)
        guard pread(source, &header, header.count, 0) == header.count else { throw Failure.readFailed }
        let codec: String
        let operation: String
        let rate: Double
        let channels: Int
        let frames: Int64
        let bitRate: UInt32?
        if header.prefix(4).elementsEqual([0x1A, 0x45, 0xDF, 0xA3]) {
            let remux = try OpusCAFWriter.repackage(source: source, destination: destination, checkCancellation: checkCancellation)
            codec = "opus"
            operation = "repackaged-opus"
            rate = 48_000
            channels = Int(remux.info.channelCount)
            frames = remux.validFrameCount
            bitRate = nil
            try validateDecode(destination, expectedFrames: frames, channels: channels, checkCancellation: checkCancellation)
        } else {
            let container: CAFEncoder.InputContainer
            if header.prefix(8).elementsEqual([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]) {
                container = .caf
            } else if header.prefix(4).elementsEqual("RIFF".utf8), header.suffix(4).elementsEqual("WAVE".utf8) {
                container = .wave
            } else {
                throw Failure.unsupportedContainer
            }
            let encoded = try CAFEncoder.encode(source: source, destination: destination,
                inputContainer: container, checkCancellation: checkCancellation)
            codec = "aac"
            operation = "encoded-aac"
            rate = encoded.sampleRate
            channels = encoded.channelCount
            frames = encoded.frameCount
            bitRate = encoded.bitRate
        }
        var after = stat()
        guard fstat(source, &after) == 0, before.st_dev == after.st_dev,
              before.st_ino == after.st_ino, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              sourceHash == (try digest(source, byteCount: before.st_size, checkCancellation: checkCancellation))
        else { throw Failure.sourceChanged }
        guard fstat(destination, &target) == 0, target.st_size > 0, target.st_size <= 16 * 1024 * 1024 * 1024 else { throw Failure.invalidFiles }
        let outputHash = try digest(destination, byteCount: target.st_size, checkCancellation: checkCancellation)
        return Result(codec: codec, operation: operation, sampleRate: rate,
            channelCount: channels, frameCount: frames, bitRate: bitRate,
            sourceSHA256: sourceHash, outputSHA256: outputHash, byteCount: target.st_size)
    }

    private static func validateDecode(_ fd: Int32, expectedFrames: Int64, channels: Int,
                                       checkCancellation: () throws -> Void) throws {
        let context = Context(fd)
        try withExtendedLifetime(context) {
            var file: AudioFileID?
            func checked(_ status: OSStatus, line: UInt = #line) throws {
                guard status == noErr else { throw CAFEncoder.Failure.audio(status, line: line) }
            }
            try checked(AudioFileOpenWithCallbacks(Unmanaged.passUnretained(context).toOpaque(),
                readAudio, nil, audioSize, nil, kAudioFileCAFType, &file))
            guard let file else { throw Failure.invalidFiles }
            defer { AudioFileClose(file) }
            var reader: ExtAudioFileRef?
            try checked(ExtAudioFileWrapAudioFileID(file, false, &reader))
            guard let reader else { throw Failure.invalidFiles }
            defer { ExtAudioFileDispose(reader) }
            var length: Int64 = 0
            var size = UInt32(MemoryLayout.size(ofValue: length))
            try checked(ExtAudioFileGetProperty(reader, kExtAudioFileProperty_FileLengthFrames, &size, &length))
            guard length == expectedFrames else { throw Failure.invalidFiles }
            var pcm = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
                mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
                mBytesPerPacket: UInt32(channels * 2), mFramesPerPacket: 1,
                mBytesPerFrame: UInt32(channels * 2), mChannelsPerFrame: UInt32(channels),
                mBitsPerChannel: 16, mReserved: 0)
            try checked(ExtAudioFileSetProperty(reader, kExtAudioFileProperty_ClientDataFormat,
                UInt32(MemoryLayout.size(ofValue: pcm)), &pcm))
            let storage = UnsafeMutableRawPointer.allocate(byteCount: 8192 * channels * 2, alignment: 16)
            defer { storage.deallocate() }
            var read: Int64 = 0
            while read < length {
                try checkCancellation()
                var frames = UInt32(min(8192, length - read))
                var buffer = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
                    mNumberChannels: UInt32(channels), mDataByteSize: frames * pcm.mBytesPerFrame, mData: storage))
                try checked(ExtAudioFileRead(reader, &frames, &buffer))
                guard frames > 0 else { throw Failure.invalidFiles }
                read += Int64(frames)
            }
        }
    }

    private static func digest(_ fd: Int32, byteCount: Int64, checkCancellation: () throws -> Void) throws -> String {
        var hash = SHA256()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        var offset: Int64 = 0
        while offset < byteCount {
            try checkCancellation()
            let count = pread(fd, &buffer, min(buffer.count, Int(byteCount - offset)), offset)
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw Failure.readFailed }
            buffer.withUnsafeBytes { hash.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0[..<count])) }
            offset += Int64(count)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
