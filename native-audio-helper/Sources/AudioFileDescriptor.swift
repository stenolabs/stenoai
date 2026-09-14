@preconcurrency import AudioToolbox
import Darwin


final class Context {
    let fd: Int32
    init(_ fd: Int32) { self.fd = fd }
}
let readAudio: AudioFile_ReadProc = { context, position, requested, buffer, actual in
    let fd = Unmanaged<Context>.fromOpaque(context).takeUnretainedValue().fd
    actual.pointee = 0
    guard position >= 0 else { return kAudioFileInvalidFileError }
    while actual.pointee < requested {
        let (offset, overflow) = position.addingReportingOverflow(Int64(actual.pointee))
        guard !overflow else { return kAudioFileInvalidFileError }
        let n = pread(fd, buffer.advanced(by: Int(actual.pointee)), Int(requested - actual.pointee), offset)
        if n < 0 { if errno == EINTR { continue }; return OSStatus(errno) }
        if n == 0 { break }
        actual.pointee += UInt32(n)
    }
    return noErr
}
let writeAudio: AudioFile_WriteProc = { context, position, requested, buffer, actual in
    let fd = Unmanaged<Context>.fromOpaque(context).takeUnretainedValue().fd
    actual.pointee = 0
    guard position >= 0 else { return kAudioFileInvalidFileError }
    while actual.pointee < requested {
        let (offset, overflow) = position.addingReportingOverflow(Int64(actual.pointee))
        guard !overflow else { return kAudioFileInvalidFileError }
        let n = pwrite(fd, buffer.advanced(by: Int(actual.pointee)), Int(requested - actual.pointee), offset)
        if n < 0 { if errno == EINTR { continue }; return OSStatus(errno) }
        if n == 0 { return kAudioFileInvalidFileError }
        actual.pointee += UInt32(n)
    }
    return noErr
}
let audioSize: AudioFile_GetSizeProc = { context in
    var value = stat()
    let fd = Unmanaged<Context>.fromOpaque(context).takeUnretainedValue().fd
    return fstat(fd, &value) == 0 ? value.st_size : 0
}
let setAudioSize: AudioFile_SetSizeProc = { context, size in
    let fd = Unmanaged<Context>.fromOpaque(context).takeUnretainedValue().fd
    return ftruncate(fd, size) == 0 ? noErr : OSStatus(errno)
}
