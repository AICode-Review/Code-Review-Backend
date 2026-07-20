const SPECIAL_CHARS = new Set(["\\", "^", "$", ".", "|", "+", "(", ")", "[", "]", "{", "}"]);

/** Minimal glob support for `.review.yml`-style ignoredPaths: `*` (no `/`), `**` (any depth), literal segments. */
function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (c === "?") {
      pattern += "[^/]";
    } else if (SPECIAL_CHARS.has(c)) {
      pattern += `\\${c}`;
    } else {
      pattern += c;
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

export function matchesIgnoredPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}
