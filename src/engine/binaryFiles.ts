/**
 * Extensions that are never worth sending to the LLM as review context:
 * images/fonts/media/archives/compiled binaries (base64-decoding these to
 * "text" produces garbage that can only confuse a pass into hallucinating
 * findings) and dependency lockfiles (real text, but line-by-line review of
 * an auto-generated lockfile is pure noise, not a genuine language gap).
 * This is a fixed baseline, separate from the user-configurable
 * `.review.yml` ignoredPaths — it never restricts a *programming* language,
 * only non-source content.
 */
const SKIP_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "avif", "heic",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // media
  "mp4", "mp3", "wav", "mov", "avi", "webm", "flac", "ogg",
  // archives / packages
  "zip", "tar", "gz", "tgz", "7z", "rar", "jar", "war", "whl",
  // compiled / binary artifacts
  "exe", "dll", "so", "dylib", "class", "pyc", "o", "a", "bin", "wasm",
  // documents
  "pdf", "docx", "xlsx", "pptx",
  // misc binary formats that occasionally show up in diffs
  "sqlite", "db", "parquet", "ttc",
]);

const SKIP_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
]);

/**
 * Vendored/installed dependency and build-output directories. These are sometimes committed
 * to a repo (accidentally or otherwise), and when they are, both the PR-diff context assembly
 * and the whole-repo indexer would otherwise walk straight into them — reviewing or embedding
 * someone else's compiled/minified library code is never useful, and doing so on something
 * like a WASM-bundled dependency can be large enough to exhaust process memory outright.
 */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "target",
  "venv",
  ".venv",
  "__pycache__",
]);

export function isReviewableSourcePath(path: string): boolean {
  const segments = path.split("/");
  const basename = (segments[segments.length - 1] ?? path).toLowerCase();
  if (SKIP_BASENAMES.has(basename)) return false;
  if (segments.some((seg) => SKIP_DIR_NAMES.has(seg.toLowerCase()))) return false;
  const ext = basename.includes(".") ? (basename.split(".").pop() ?? "") : "";
  return !SKIP_EXTENSIONS.has(ext);
}
