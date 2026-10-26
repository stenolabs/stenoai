import Foundation

private let lexicalCharacterSet: CharacterSet = {
    var set = CharacterSet.letters
    set.formUnion(.decimalDigits)
    return set
}()

func hasLexicalContent(_ text: String) -> Bool {
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

enum LiveTextAction: Equatable {
    case segment
    case revoke
    case ignore
}

struct LivePartialTracker {
    private var partialStart: Double?
    private var seenFinals: Set<String> = []

    mutating func action(
        text: String,
        isFinal: Bool,
        start: Double,
        end: Double,
        finalIdentity: String
    ) -> LiveTextAction {
        guard hasLexicalContent(text) else {
            guard partialStart != nil else { return .ignore }
            partialStart = nil
            return .revoke
        }
        if isFinal {
            // A duplicate is not emitted, so it cannot retire the partial
            // still visible in main/renderer. A late earlier final only
            // retires a partial whose start is at or before its end.
            guard seenFinals.insert(finalIdentity).inserted else { return .ignore }
            if let partialStart, partialStart <= end {
                self.partialStart = nil
            }
        } else {
            partialStart = start
        }
        return .segment
    }
}
