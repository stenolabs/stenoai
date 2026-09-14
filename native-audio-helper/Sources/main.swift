import Darwin
import Foundation
#if !STENO_STANDALONE_HELPER
import StenoAudioEncoding
#endif

// Version 2 borrows inherited descriptors; the parent owns atomic publication and cleanup.
do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--version"] {
        print("steno-audio-encode 2")
    } else {
        guard arguments.count == 4, arguments[0] == "--input-fd",
              arguments[2] == "--output-fd", let source = Int32(arguments[1]),
              let destination = Int32(arguments[3]), source > 2, destination > 2,
              source != destination else {
            throw CLIError.usage
        }
        let result = try TransferAudioConverter.convert(source: source, destination: destination)
        let json = try JSONEncoder().encode(result)
        FileHandle.standardOutput.write(json + Data([10]))
    }
} catch {
    FileHandle.standardError.write(Data("Audio encoding failed: \(error)\n".utf8))
    exit(1)
}
private enum CLIError: Error { case usage }
