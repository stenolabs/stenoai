import Darwin
import Foundation

public struct WebMOpusAudio: Equatable, Sendable {
    public let magicCookie: Data
    public let sampleRate: Double
    public let channelCount: UInt32
    public let packets: [Data]

    public init(
        magicCookie: Data,
        sampleRate: Double,
        channelCount: UInt32,
        packets: [Data]
    ) {
        self.magicCookie = magicCookie
        self.sampleRate = sampleRate
        self.channelCount = channelCount
        self.packets = packets
    }
}

public enum WebMLacing: String, Equatable, Sendable {
    case none
    case xiph
    case fixedSize
    case ebml
}

public enum WebMOpusReaderError: Error, Equatable, Sendable {
    case emptyInput
    case invalidEBMLHeader
    case unsupportedDocumentType(String)
    case missingSegment
    case malformedElement(String)
    case missingOpusTrack
    case multipleOpusTracks
    case invalidOpusHead
    case unsupportedLacing(WebMLacing)
    case unsupportedTiming(String)
    case resourceLimit
    case readFailed
}

public enum WebMOpusReader {
    public static func read(from url: URL) throws -> WebMOpusAudio {
        try read(Data(contentsOf: url, options: [.mappedIfSafe]))
    }

    public static func read(_ data: Data) throws -> WebMOpusAudio {
        guard !data.isEmpty else { throw WebMOpusReaderError.emptyInput }
        var cursor = EBMLCursor(data: data)

        let header = try cursor.readElementHeader()
        guard header.id == ElementID.ebml.rawValue,
              let headerEnd = header.contentEnd else {
            throw WebMOpusReaderError.invalidEBMLHeader
        }
        try readEBMLHeader(cursor: &cursor, end: headerEnd)

        let segment = try cursor.readElementHeader()
        guard segment.id == ElementID.segment.rawValue else {
            throw WebMOpusReaderError.missingSegment
        }
        let segmentEnd = segment.contentEnd ?? data.count
        var tracks: [Track] = []
        var blocks: [Block] = []
        try readSegment(
            cursor: &cursor,
            end: segmentEnd,
            tracks: &tracks,
            blocks: &blocks
        )

        let opusTracks = tracks.filter { $0.type == 2 && $0.codecID == "A_OPUS" }
        guard !opusTracks.isEmpty else {
            throw WebMOpusReaderError.missingOpusTrack
        }
        guard opusTracks.count == 1 else {
            throw WebMOpusReaderError.multipleOpusTracks
        }
        let track = opusTracks[0]
        guard let trackNumber = track.number,
              let magicCookie = track.codecPrivate,
              let sampleRate = track.sampleRate,
              sampleRate.isFinite,
              sampleRate > 0,
              let channelCount = track.channelCount,
              channelCount > 0 else {
            throw WebMOpusReaderError.malformedElement("Incomplete A_OPUS track")
        }
        guard magicCookie.count >= 19,
              magicCookie.starts(with: Data("OpusHead".utf8)),
              magicCookie[8] == 1,
              magicCookie[9] == UInt8(exactly: channelCount) else {
            throw WebMOpusReaderError.invalidOpusHead
        }

        let selectedBlocks = blocks.filter { $0.trackNumber == trackNumber }
        if let laced = selectedBlocks.first(where: { $0.lacing != .none }) {
            throw WebMOpusReaderError.unsupportedLacing(laced.lacing)
        }
        return WebMOpusAudio(
            magicCookie: magicCookie,
            sampleRate: sampleRate,
            channelCount: channelCount,
            packets: selectedBlocks.map(\.payload)
        )
    }
}

private extension WebMOpusReader {
    static func readEBMLHeader(cursor: inout EBMLCursor, end: Int) throws {
        var documentType: String?
        while cursor.offset < end {
            let element = try cursor.readElementHeader(limit: end)
            guard let contentEnd = element.contentEnd else {
                throw WebMOpusReaderError.invalidEBMLHeader
            }
            if element.id == ElementID.documentType.rawValue {
                documentType = try cursor.readString(until: contentEnd)
            } else {
                cursor.offset = contentEnd
            }
        }
        guard cursor.offset == end, let documentType else {
            throw WebMOpusReaderError.invalidEBMLHeader
        }
        guard documentType == "webm" else {
            throw WebMOpusReaderError.unsupportedDocumentType(documentType)
        }
    }

    static func readSegment(
        cursor: inout EBMLCursor,
        end: Int,
        tracks: inout [Track],
        blocks: inout [Block]
    ) throws {
        while cursor.offset < end {
            let element = try cursor.readElementHeader(limit: end)
            switch element.id {
            case ElementID.tracks.rawValue:
                guard let contentEnd = element.contentEnd else {
                    throw WebMOpusReaderError.malformedElement("Tracks has unknown size")
                }
                try readTracks(cursor: &cursor, end: contentEnd, tracks: &tracks)
            case ElementID.cluster.rawValue:
                try readCluster(
                    cursor: &cursor,
                    end: element.contentEnd ?? end,
                    hasUnknownSize: element.contentEnd == nil,
                    blocks: &blocks
                )
            default:
                try cursor.skip(element, name: "segment child")
            }
        }
    }

    static func readTracks(
        cursor: inout EBMLCursor,
        end: Int,
        tracks: inout [Track]
    ) throws {
        while cursor.offset < end {
            let element = try cursor.readElementHeader(limit: end)
            if element.id == ElementID.trackEntry.rawValue {
                guard let contentEnd = element.contentEnd else {
                    throw WebMOpusReaderError.malformedElement("TrackEntry has unknown size")
                }
                guard tracks.count < 64 else { throw WebMOpusReaderError.resourceLimit }
                tracks.append(try readTrack(cursor: &cursor, end: contentEnd))
            } else {
                try cursor.skip(element, name: "Tracks child")
            }
        }
    }

    static func readTrack(cursor: inout EBMLCursor, end: Int) throws -> Track {
        var track = Track()
        var seen: Set<UInt64> = []
        while cursor.offset < end {
            let element = try cursor.readElementHeader(limit: end)
            guard let contentEnd = element.contentEnd else {
                throw WebMOpusReaderError.malformedElement("Track child has unknown size")
            }
            guard seen.insert(element.id).inserted || element.id == 0xEC else {
                throw WebMOpusReaderError.malformedElement("Duplicate track field")
            }
            switch element.id {
            case ElementID.trackNumber.rawValue:
                track.number = try cursor.readUnsignedInteger(until: contentEnd)
            case ElementID.trackType.rawValue:
                track.type = try cursor.readUnsignedInteger(until: contentEnd)
            case ElementID.codecID.rawValue:
                track.codecID = try cursor.readString(until: contentEnd)
            case ElementID.codecPrivate.rawValue:
                guard contentEnd - cursor.offset <= 65_536 else { throw WebMOpusReaderError.resourceLimit }
                track.codecPrivate = try cursor.readData(until: contentEnd)
            case 0x56AA: // CodecDelay, nanoseconds
                track.codecDelay = try cursor.readUnsignedInteger(until: contentEnd)
            case 0x23314F: // TrackTimestampScale
                track.timestampScale = try cursor.readFloat(until: contentEnd)
            case 0x6D80: // ContentEncodings (compression/encryption)
                track.hasContentEncodings = true
                cursor.offset = contentEnd
            case ElementID.audio.rawValue:
                try readAudio(cursor: &cursor, end: contentEnd, track: &track)
            default:
                cursor.offset = contentEnd
            }
        }
        return track
    }

    static func readAudio(
        cursor: inout EBMLCursor,
        end: Int,
        track: inout Track
    ) throws {
        var seen: Set<UInt64> = []
        while cursor.offset < end {
            let element = try cursor.readElementHeader(limit: end)
            guard let contentEnd = element.contentEnd else {
                throw WebMOpusReaderError.malformedElement("Audio child has unknown size")
            }
            guard seen.insert(element.id).inserted || element.id == 0xEC else {
                throw WebMOpusReaderError.malformedElement("Duplicate audio field")
            }
            switch element.id {
            case ElementID.samplingFrequency.rawValue:
                track.sampleRate = try cursor.readFloat(until: contentEnd)
            case ElementID.channels.rawValue:
                let channels = try cursor.readUnsignedInteger(until: contentEnd)
                guard let channelCount = UInt32(exactly: channels) else {
                    throw WebMOpusReaderError.malformedElement("Invalid channel count")
                }
                track.channelCount = channelCount
            default:
                cursor.offset = contentEnd
            }
        }
    }

    static func readCluster(
        cursor: inout EBMLCursor,
        end: Int,
        hasUnknownSize: Bool,
        blocks: inout [Block],
        process: ((UInt64, Block) throws -> Void)? = nil
    ) throws {
        var timecode: UInt64?
        while cursor.offset < end {
            let elementStart = cursor.offset
            let element = try cursor.readElementHeader(limit: end)
            if hasUnknownSize && isSegmentLevelElement(element.id) {
                cursor.offset = elementStart
                break
            }
            switch element.id {
            case ElementID.clusterTimecode.rawValue:
                guard timecode == nil, let contentEnd = element.contentEnd else {
                    throw WebMOpusReaderError.malformedElement("Invalid Cluster Timecode")
                }
                timecode = try cursor.readUnsignedInteger(until: contentEnd)
            case ElementID.simpleBlock.rawValue, ElementID.blockGroup.rawValue:
                let block = element.id == ElementID.simpleBlock.rawValue
                    ? try readBlock(cursor: &cursor, element: element)
                    : try readBlockGroup(cursor: &cursor, element: element)
                if let process {
                    guard let timecode else { throw WebMOpusReaderError.unsupportedTiming("Timecode must precede blocks") }
                    try process(timecode, block)
                } else { blocks.append(block) }
            default:
                try cursor.skip(element, name: "Cluster child")
            }
        }
        guard timecode != nil else {
            throw WebMOpusReaderError.malformedElement("Cluster has no Timecode")
        }
    }

    static func readBlockGroup(cursor: inout EBMLCursor, element: EBMLElementHeader) throws -> Block {
        guard let end = element.contentEnd else {
            throw WebMOpusReaderError.malformedElement("BlockGroup has unknown size")
        }
        var block: Block?
        var discardPadding: Int64 = 0
        var hasPadding = false
        var hasOtherFields = false
        while cursor.offset < end {
            let child = try cursor.readElementHeader(limit: end)
            if child.id == ElementID.block.rawValue {
                guard block == nil else { throw WebMOpusReaderError.malformedElement("Duplicate Block") }
                block = try readBlock(cursor: &cursor, element: child)
            } else if child.id == 0x75A2 { // signed DiscardPadding in nanoseconds
                guard !hasPadding, let childEnd = child.contentEnd else {
                    throw WebMOpusReaderError.malformedElement("Invalid DiscardPadding")
                }
                let count = childEnd - cursor.offset
                let raw = try cursor.readUnsignedInteger(until: childEnd)
                let shift = 64 - count * 8
                discardPadding = Int64(bitPattern: raw << shift) >> shift
                hasPadding = true
            } else {
                if child.id != 0xEC && child.id != 0xBF { hasOtherFields = true }
                try cursor.skip(child, name: "BlockGroup child")
            }
        }
        guard var block else { throw WebMOpusReaderError.malformedElement("BlockGroup has no Block") }
        block.discardPadding = discardPadding
        block.hasUnsupportedTiming = block.hasUnsupportedTiming || hasOtherFields
        return block
    }

    static func readBlock(
        cursor: inout EBMLCursor,
        element: EBMLElementHeader
    ) throws -> Block {
        guard let end = element.contentEnd else {
            throw WebMOpusReaderError.malformedElement("Block has unknown size")
        }
        let trackNumber = try cursor.readVariableIntegerValue(limit: end)
        guard end - cursor.offset >= 3 else {
            throw WebMOpusReaderError.malformedElement("Block header is truncated")
        }
        let high = try cursor.readByte(limit: end)
        let low = try cursor.readByte(limit: end)
        let relativeTimecode = Int16(bitPattern: UInt16(high) << 8 | UInt16(low))
        let flags = try cursor.readByte(limit: end)
        let lacing: WebMLacing = switch (flags & 0x06) >> 1 {
        case 0: .none
        case 1: .xiph
        case 2: .fixedSize
        default: .ebml
        }
        return Block(
            trackNumber: trackNumber,
            lacing: lacing,
            payload: try cursor.readData(until: end),
            relativeTimecode: relativeTimecode,
            hasUnsupportedTiming: flags & 0x08 != 0
        )
    }

    static func isSegmentLevelElement(_ id: UInt64) -> Bool {
        switch id {
        case 0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1F43B675,
             0x1C53BB6B, 0x1941A469, 0x1043A770, 0x1254C367:
            true
        default:
            false
        }
    }
}

private struct Track {
    var number: UInt64?
    var type: UInt64?
    var codecID: String?
    var codecPrivate: Data?
    var sampleRate: Double?
    var channelCount: UInt32?
    var codecDelay: UInt64?
    var timestampScale: Double = 1
    var hasContentEncodings = false
}

private struct Block {
    let trackNumber: UInt64
    let lacing: WebMLacing
    let payload: Data
    let relativeTimecode: Int16
    var discardPadding: Int64 = 0
    var hasUnsupportedTiming = false
}

private enum ElementID: UInt64 {
    case ebml = 0x1A45DFA3
    case documentType = 0x4282
    case segment = 0x18538067
    case tracks = 0x1654AE6B
    case trackEntry = 0xAE
    case trackNumber = 0xD7
    case trackType = 0x83
    case codecID = 0x86
    case codecPrivate = 0x63A2
    case audio = 0xE1
    case samplingFrequency = 0xB5
    case channels = 0x9F
    case cluster = 0x1F43B675
    case clusterTimecode = 0xE7
    case simpleBlock = 0xA3
    case blockGroup = 0xA0
    case block = 0xA1
}

private struct EBMLElementHeader {
    let id: UInt64
    let contentEnd: Int?
}

private struct EBMLCursor {
    let source: WebMByteSource
    var offset = 0

    init(data: Data) { source = WebMByteSource(data: data) }
    init(source: WebMByteSource) { self.source = source }

    mutating func readElementHeader(limit: Int? = nil) throws -> EBMLElementHeader {
        try source.checkElement()
        let boundary = limit ?? source.count
        guard offset <= boundary, boundary <= source.count else {
            throw WebMOpusReaderError.malformedElement("Invalid parent boundary")
        }
        let id = try readID(limit: boundary)
        let size = try readSize(limit: boundary)
        let contentEnd: Int?
        if let size {
            guard size <= UInt64(boundary - offset),
                  let byteCount = Int(exactly: size) else {
                throw WebMOpusReaderError.malformedElement("Element exceeds its parent")
            }
            contentEnd = offset + byteCount
        } else {
            contentEnd = nil
        }
        return EBMLElementHeader(id: id, contentEnd: contentEnd)
    }

    mutating func skip(_ element: EBMLElementHeader, name: String) throws {
        guard let contentEnd = element.contentEnd else {
            throw WebMOpusReaderError.malformedElement("Unknown-size \(name)")
        }
        offset = contentEnd
    }

    mutating func readData(until end: Int) throws -> Data {
        guard offset <= end, end <= source.count else {
            throw WebMOpusReaderError.malformedElement("Invalid data range")
        }
        defer { offset = end }
        return try source.read(offset: offset, count: end - offset)
    }

    mutating func readString(until end: Int) throws -> String {
        let bytes = try readData(until: end)
        guard let value = String(data: bytes, encoding: .utf8) else {
            throw WebMOpusReaderError.malformedElement("String is not UTF-8")
        }
        return value
    }

    mutating func readUnsignedInteger(until end: Int) throws -> UInt64 {
        let count = end - offset
        guard (1...8).contains(count) else {
            throw WebMOpusReaderError.malformedElement("Invalid unsigned integer size")
        }
        var value: UInt64 = 0
        while offset < end {
            value = (value << 8) | UInt64(try readByte(limit: end))
        }
        return value
    }

    mutating func readFloat(until end: Int) throws -> Double {
        let count = end - offset
        switch count {
        case 4:
            let bits = UInt32(try readUnsignedInteger(until: end))
            return Double(Float(bitPattern: bits))
        case 8:
            return Double(bitPattern: try readUnsignedInteger(until: end))
        default:
            throw WebMOpusReaderError.malformedElement("Invalid floating-point size")
        }
    }

    mutating func readVariableIntegerValue(limit: Int) throws -> UInt64 {
        let first = try readByte(limit: limit)
        guard first != 0 else {
            throw WebMOpusReaderError.malformedElement("Invalid variable integer")
        }
        let length = first.leadingZeroBitCount + 1
        guard length <= 8, offset + length - 1 <= limit else {
            throw WebMOpusReaderError.malformedElement("Truncated variable integer")
        }
        var value = UInt64(first & (0xFF >> length))
        for _ in 1..<length {
            value = (value << 8) | UInt64(try readByte(limit: limit))
        }
        return value
    }

    mutating func readByte(limit: Int) throws -> UInt8 {
        guard offset < limit, offset < source.count else {
            throw WebMOpusReaderError.malformedElement("Unexpected end of data")
        }
        defer { offset += 1 }
        return try source.byte(at: offset)
    }

    private mutating func readID(limit: Int) throws -> UInt64 {
        let first = try readByte(limit: limit)
        guard first != 0 else {
            throw WebMOpusReaderError.malformedElement("Invalid element ID")
        }
        let length = first.leadingZeroBitCount + 1
        guard length <= 4, offset + length - 1 <= limit else {
            throw WebMOpusReaderError.malformedElement("Truncated element ID")
        }
        var value = UInt64(first)
        for _ in 1..<length {
            value = (value << 8) | UInt64(try readByte(limit: limit))
        }
        return value
    }

    private mutating func readSize(limit: Int) throws -> UInt64? {
        let first = try readByte(limit: limit)
        guard first != 0 else {
            throw WebMOpusReaderError.malformedElement("Invalid element size")
        }
        let length = first.leadingZeroBitCount + 1
        guard length <= 8, offset + length - 1 <= limit else {
            throw WebMOpusReaderError.malformedElement("Truncated element size")
        }
        let mask = UInt8(0xFF >> length)
        var value = UInt64(first & mask)
        var isUnknown = (first & mask) == mask
        for _ in 1..<length {
            let byte = try readByte(limit: limit)
            value = (value << 8) | UInt64(byte)
            isUnknown = isUnknown && byte == 0xFF
        }
        return isUnknown ? nil : value
    }
}

/// One bounded read window for the FD path. The legacy Data API remains available.
private final class WebMByteSource {
    let count: Int
    let data: Data?
    let descriptor: Int32?
    let checkCancellation: () throws -> Void
    var window = Data()
    var windowStart = -1
    var elements = 0

    init(data: Data) {
        self.data = data
        count = data.count
        descriptor = nil
        checkCancellation = { try Task.checkCancellation() }
    }

    init(descriptor: Int32, checkCancellation: @escaping () throws -> Void) throws {
        var status = stat()
        guard fstat(descriptor, &status) == 0, status.st_mode & S_IFMT == S_IFREG,
              status.st_size > 0, status.st_size <= 16 * 1024 * 1024 * 1024 else {
            throw WebMOpusReaderError.resourceLimit
        }
        count = Int(status.st_size)
        self.descriptor = descriptor
        self.checkCancellation = checkCancellation
        data = nil
    }

    func checkElement() throws {
        try checkCancellation()
        elements += 1
        guard elements <= 4_000_000 else { throw WebMOpusReaderError.resourceLimit }
    }

    func byte(at offset: Int) throws -> UInt8 {
        if let data { return data[offset] }
        if offset < windowStart || offset >= windowStart + window.count {
            window = try read(offset: offset, count: min(65_536, count - offset))
            windowStart = offset
        }
        return window[offset - windowStart]
    }

    func read(offset: Int, count: Int) throws -> Data {
        guard count >= 0, count <= 1_048_576 else { throw WebMOpusReaderError.resourceLimit }
        if let data { return data.subdata(in: offset..<(offset + count)) }
        guard let descriptor else { throw WebMOpusReaderError.readFailed }
        var bytes = Data(count: count)
        try bytes.withUnsafeMutableBytes { buffer in
            var consumed = 0
            while consumed < count {
                try checkCancellation()
                let n = pread(descriptor, buffer.baseAddress!.advanced(by: consumed), count - consumed, off_t(offset + consumed))
                if n < 0, errno == EINTR { continue }
                guard n > 0 else { throw WebMOpusReaderError.readFailed }
                consumed += n
            }
        }
        return bytes
    }
}

public struct WebMOpusStreamInfo: Sendable {
    public let magicCookie: Data
    public let channelCount: UInt32
    public let preSkip: UInt32
}

public struct WebMOpusStreamSummary: Sendable {
    public let info: WebMOpusStreamInfo
    public let packetCount: Int
    public let encodedFrameCount: Int64
    public let remainderFrames: UInt32
    public var validFrameCount: Int64 { encodedFrameCount - Int64(info.preSkip) - Int64(remainderFrames) }
}

extension WebMOpusReader {
    /// Strict, bounded remux subset: one 48 kHz family-0 Opus track, contiguous
    /// timestamps starting at zero, no lacing, and positive end-only discard.
    /// Unsupported timelines fail rather than concatenating across a capture gap.
    public static func stream(
        from descriptor: Int32,
        checkCancellation: @escaping () throws -> Void = { try Task.checkCancellation() },
        onHeader: (WebMOpusStreamInfo) throws -> Void,
        onPacket: @escaping (Data, UInt32) throws -> Void
    ) throws -> WebMOpusStreamSummary {
        let source = try WebMByteSource(descriptor: descriptor, checkCancellation: checkCancellation)
        var cursor = EBMLCursor(source: source)
        let header = try cursor.readElementHeader()
        guard header.id == ElementID.ebml.rawValue, let headerEnd = header.contentEnd else {
            throw WebMOpusReaderError.invalidEBMLHeader
        }
        try readEBMLHeader(cursor: &cursor, end: headerEnd)
        let segment = try cursor.readElementHeader()
        guard segment.id == ElementID.segment.rawValue else { throw WebMOpusReaderError.missingSegment }
        let end = segment.contentEnd ?? source.count
        guard end == source.count else { throw WebMOpusReaderError.malformedElement("Trailing data after Segment") }
        var selected: Track?
        var info: WebMOpusStreamInfo?
        var timestampScale: UInt64 = 1_000_000
        var sawInfo = false
        var packets = 0
        var frames: Int64 = 0
        var remainder: UInt32 = 0
        while cursor.offset < end {
            let element = try cursor.readElementHeader(limit: end)
            switch element.id {
            case 0x1549A966: // Info
                guard !sawInfo, packets == 0, let infoEnd = element.contentEnd else {
                    throw WebMOpusReaderError.unsupportedTiming("Info must occur once before audio")
                }
                sawInfo = true
                var sawScale = false
                while cursor.offset < infoEnd {
                    let child = try cursor.readElementHeader(limit: infoEnd)
                    guard let childEnd = child.contentEnd else { throw WebMOpusReaderError.malformedElement("Unknown-size Info child") }
                    if child.id == 0x2AD7B1 {
                        guard !sawScale else { throw WebMOpusReaderError.unsupportedTiming("Duplicate TimestampScale") }
                        sawScale = true
                        timestampScale = try cursor.readUnsignedInteger(until: childEnd)
                        guard (1...1_000_000).contains(timestampScale) else {
                            throw WebMOpusReaderError.unsupportedTiming("TimestampScale must not exceed 1 ms")
                        }
                    } else { cursor.offset = childEnd }
                }
            case ElementID.tracks.rawValue:
                guard selected == nil, packets == 0, let tracksEnd = element.contentEnd else {
                    throw WebMOpusReaderError.malformedElement("Tracks must occur once before audio")
                }
                var tracks: [Track] = []
                try readTracks(cursor: &cursor, end: tracksEnd, tracks: &tracks)
                guard tracks.count == 1 else { throw WebMOpusReaderError.multipleOpusTracks }
                let track = tracks[0]
                guard track.type == 2, track.codecID == "A_OPUS", let number = track.number, number > 0 else {
                    throw WebMOpusReaderError.missingOpusTrack
                }
                guard track.sampleRate == 48_000, track.timestampScale == 1, !track.hasContentEncodings else {
                    throw WebMOpusReaderError.unsupportedTiming("Requires an unencoded 48 kHz track at scale 1")
                }
                guard let cookie = track.codecPrivate, let channels = track.channelCount,
                      (1...2).contains(channels), cookie.count == 19,
                      cookie.prefix(8).elementsEqual("OpusHead".utf8), cookie[8] == 1,
                      cookie[9] == UInt8(channels), cookie[16] == 0, cookie[17] == 0, cookie[18] == 0 else {
                    throw WebMOpusReaderError.invalidOpusHead
                }
                let inputRate = (0..<4).reduce(UInt32(0)) { $0 | UInt32(cookie[12 + $1]) << (8 * $1) }
                guard inputRate == 0 || inputRate == 48_000 else { throw WebMOpusReaderError.invalidOpusHead }
                let preSkip = UInt32(cookie[10]) | UInt32(cookie[11]) << 8
                let delay = Double(preSkip) * 1_000_000_000 / 48_000
                guard abs(Double(track.codecDelay ?? 0) - delay) <= 1 else {
                    throw WebMOpusReaderError.unsupportedTiming("CodecDelay does not match Opus pre-skip")
                }
                let value = WebMOpusStreamInfo(magicCookie: cookie, channelCount: channels, preSkip: preSkip)
                selected = track
                info = value
                try onHeader(value)
            case ElementID.cluster.rawValue:
                guard let selected else { throw WebMOpusReaderError.malformedElement("Tracks must precede Cluster") }
                var unused: [Block] = []
                try readCluster(cursor: &cursor, end: element.contentEnd ?? end,
                    hasUnknownSize: element.contentEnd == nil, blocks: &unused) { clusterTime, block in
                    try checkCancellation()
                    guard block.trackNumber == selected.number else { throw WebMOpusReaderError.missingOpusTrack }
                    guard !block.hasUnsupportedTiming else { throw WebMOpusReaderError.unsupportedTiming("Unsupported block metadata") }
                    guard block.lacing == .none else { throw WebMOpusReaderError.unsupportedLacing(block.lacing) }
                    guard remainder == 0 else { throw WebMOpusReaderError.unsupportedTiming("DiscardPadding is not final") }
                    guard packets < 1_000_000, let count = OpusCAFWriter.opusFrameCount(block.payload) else {
                        throw WebMOpusReaderError.resourceLimit
                    }
                    let ticks = Double(clusterTime) + Double(block.relativeTimecode)
                    let time = ticks * Double(timestampScale)
                    let expectedTime = Double(frames) * 1_000_000_000 / 48_000
                    guard ticks >= 0, time <= 86_400_000_000_000,
                          (packets != 0 || ticks == 0), abs(time - expectedTime) <= Double(timestampScale) else {
                        throw WebMOpusReaderError.unsupportedTiming("Non-contiguous packet timestamps")
                    }
                    if block.discardPadding != 0 {
                        let discarded = Double(block.discardPadding) * 48_000 / 1_000_000_000
                        guard discarded > 0, discarded <= Double(count),
                              abs(discarded - discarded.rounded()) <= 0.0001 else {
                            throw WebMOpusReaderError.unsupportedTiming("Unsupported DiscardPadding")
                        }
                        remainder = UInt32(discarded.rounded())
                    }
                    try onPacket(block.payload, count)
                    packets += 1
                    frames += Int64(count)
                }
            default:
                try cursor.skip(element, name: "Segment child")
            }
        }
        guard let info, packets > 0, frames > Int64(info.preSkip) + Int64(remainder) else {
            throw WebMOpusReaderError.emptyInput
        }
        return WebMOpusStreamSummary(info: info, packetCount: packets,
            encodedFrameCount: frames, remainderFrames: remainder)
    }
}
