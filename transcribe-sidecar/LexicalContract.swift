import Foundation

@main
struct LexicalContract {
    static func main() {
        let cases: [(String, Bool)] = [
            ("", false), (" . ，… ", false), ("。", false),
            ("Hello, world.", true), ("你好。", true), ("42%", true),
            ("½", false), ("Ⅷ", false),
        ]
        for (text, expected) in cases {
            precondition(hasLexicalContent(text) == expected,
                         "Lexical contract failed for \(String(reflecting: text))")
        }
        var lateFinal = LivePartialTracker()
        precondition(lateFinal.action(text: "newer partial", isFinal: false, start: 3, end: 4,
                                      finalIdentity: "") == .segment)
        precondition(lateFinal.action(text: "earlier final", isFinal: true, start: 0, end: 2,
                                      finalIdentity: "earlier") == .segment)
        precondition(lateFinal.action(text: "", isFinal: false, start: 3, end: 4,
                                      finalIdentity: "") == .revoke)

        var duplicateFinal = LivePartialTracker()
        precondition(duplicateFinal.action(text: "old final", isFinal: true, start: 0, end: 4,
                                           finalIdentity: "old") == .segment)
        precondition(duplicateFinal.action(text: "newer partial", isFinal: false, start: 5, end: 7,
                                           finalIdentity: "") == .segment)
        precondition(duplicateFinal.action(text: "old final", isFinal: true, start: 0, end: 4,
                                           finalIdentity: "old") == .ignore)
        precondition(duplicateFinal.action(text: "", isFinal: false, start: 5, end: 7,
                                           finalIdentity: "") == .revoke)

        var retired = LivePartialTracker()
        precondition(retired.action(text: "partial", isFinal: false, start: 2, end: 4,
                                    finalIdentity: "") == .segment)
        precondition(retired.action(text: "final", isFinal: true, start: 0, end: 4,
                                    finalIdentity: "final") == .segment)
        precondition(retired.action(text: "", isFinal: false, start: 2, end: 4,
                                    finalIdentity: "") == .ignore)
        print("Swift lexical/live contract: \(cases.count + 10) cases passed")
    }
}
