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
