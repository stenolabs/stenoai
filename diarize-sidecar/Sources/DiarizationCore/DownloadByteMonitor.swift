import Foundation

/// Measures an in-flight model download by watching URLSession's temp file.
///
/// FluidAudio fetches each file with the async `URLSession.download(for:)`,
/// whose session-delegate byte callbacks never fire, so its own progress only
/// moves once per file -- and the Sortformer model is one ~243 MB file. The
/// bytes are still visible: URLSession streams the download into a
/// `CFNetworkDownload_*.tmp` file in the user's temp directory. This polls the
/// size of such files created after `start()` and reports the fraction of
/// `expectedBytes`, capped below 1 so only FluidAudio's own completion event
/// can finish the download band.
public final class DownloadByteMonitor: @unchecked Sendable {
    public static let tempFilePrefix = "CFNetworkDownload"

    private let directory: URL
    private let expectedBytes: Double
    private let onFraction: @Sendable (Double) -> Void
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var startDate = Date.distantPast

    public init(directory: URL, expectedBytes: Double, onFraction: @escaping @Sendable (Double) -> Void) {
        self.directory = directory
        self.expectedBytes = expectedBytes
        self.onFraction = onFraction
    }

    public func start(interval: TimeInterval = 0.5) {
        lock.lock()
        defer { lock.unlock() }
        // A second of slack for filesystems with coarse creation timestamps.
        startDate = Date().addingTimeInterval(-1)
        let source = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { [weak self] in self?.poll() }
        source.resume()
        timer = source
    }

    public func stop() {
        lock.lock()
        defer { lock.unlock() }
        timer?.cancel()
        timer = nil
    }

    /// One measurement; public so tests can drive it without a timer.
    public func poll() {
        let bytes = Self.inFlightBytes(in: directory, createdAfter: startDate)
        guard bytes > 0, expectedBytes > 0 else { return }
        onFraction(min(Double(bytes) / expectedBytes, 0.99))
    }

    static func inFlightBytes(in directory: URL, createdAfter start: Date) -> Int64 {
        let keys: [URLResourceKey] = [.creationDateKey, .fileSizeKey, .isRegularFileKey]
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: keys
        ) else { return 0 }
        return entries.reduce(Int64(0)) { total, url in
            guard url.lastPathComponent.hasPrefix(tempFilePrefix),
                  let values = try? url.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true,
                  let created = values.creationDate, created >= start,
                  let size = values.fileSize else { return total }
            return total + Int64(size)
        }
    }
}
