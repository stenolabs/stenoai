import Foundation
import FoundationModels

@main
struct StenoAppleLM {
    static func main() async {
        let command = CommandLine.arguments.dropFirst().first ?? "status"
        do {
            switch command {
            case "status":
                try printStatus()
            case "complete":
                try await printComplete()
            case "stream":
                try await printStream()
            default:
                FileHandle.standardError.write(Data("usage: steno-apple-lm status | complete | stream\n".utf8))
                exit(2)
            }
        } catch {
            emitError()
            exit(1)
        }
    }
}

private func readStdinPrompt() -> String {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    return String(data: data, encoding: .utf8) ?? ""
}

private func printJSON(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func emitError() {
    // Fixed keys only — never echo the prompt or model output.
    try? printJSON(["error": "apple_lm_failed"])
}

private func printStatus() throws {
    guard #available(macOS 26.0, *) else {
        try printJSON(["available": false, "reason": "unsupported_os"])
        return
    }
    let model = SystemLanguageModel.default
    switch model.availability {
    case .available:
        var payload: [String: Any] = ["available": true]
        if #available(macOS 27.0, *) {
            let variant = model.variant
            if variant == .coreAdvanced3 {
                payload["variant"] = "coreAdvanced3"
            } else if variant == .core3 {
                payload["variant"] = "core3"
            } else {
                payload["variant"] = "unknown"
            }
            payload["display_name"] = variant.displayName
        } else {
            payload["variant"] = "core3"
            payload["display_name"] = "Apple Intelligence"
        }
        try printJSON(payload)
    case .unavailable(let reason):
        try printJSON([
            "available": false,
            "reason": unavailableReasonName(reason),
        ])
    }
}

@available(macOS 26.0, *)
private func unavailableReasonName(
    _ reason: SystemLanguageModel.Availability.UnavailableReason
) -> String {
    switch reason {
    case .deviceNotEligible:
        return "deviceNotEligible"
    case .appleIntelligenceNotEnabled:
        return "appleIntelligenceNotEnabled"
    case .modelNotReady:
        return "modelNotReady"
    @unknown default:
        return "unavailable"
    }
}

private func printComplete() async throws {
    guard #available(macOS 26.0, *) else {
        try printJSON(["error": "apple_lm_failed", "reason": "unsupported_os"])
        exit(1)
    }
    let model = SystemLanguageModel.default
    guard model.isAvailable else {
        try printJSON(["error": "apple_lm_failed", "reason": "unavailable"])
        exit(1)
    }
    let session = LanguageModelSession(model: model)
    let response = try await session.respond(to: readStdinPrompt())
    try printJSON(["text": response.content])
}

private func printStream() async throws {
    guard #available(macOS 26.0, *) else {
        try printJSON(["error": "apple_lm_failed", "reason": "unsupported_os"])
        exit(1)
    }
    let model = SystemLanguageModel.default
    guard model.isAvailable else {
        try printJSON(["error": "apple_lm_failed", "reason": "unavailable"])
        exit(1)
    }
    let session = LanguageModelSession(model: model)
    var previous = ""
    let stream = session.streamResponse(to: readStdinPrompt())
    for try await snapshot in stream {
        let current = stringContent(snapshot.content)
        let delta: String
        if current.hasPrefix(previous) {
            delta = String(current.dropFirst(previous.count))
        } else {
            delta = current
        }
        previous = current
        if !delta.isEmpty {
            try printJSON(["delta": delta])
        }
    }
    try printJSON(["done": true])
}

private func stringContent(_ value: some Any) -> String {
    if let text = value as? String {
        return text
    }
    return String(describing: value)
}
