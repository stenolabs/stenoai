// Keep the first sentence and, where marked, the parenthetical qualification.
export function taste(text) {
  return text.split(/(?<=[.!?]|[.!?]\))\s+(?=[A-Z“"(])/).map((text, index) => ({
    text,
    folded: index > 0 && !text.startsWith("("),
  }));
}
