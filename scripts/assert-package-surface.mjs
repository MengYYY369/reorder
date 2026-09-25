// scripts/assert-package-surface.mjs
// Every subpath a host can import must resolve inside the packed tree.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"

const SERVER = "./.medusa/server/"
const SOURCES = "./.medusa/server/src/"

// The only pattern targets this script tolerates matching no packed file, named one
// by one. The script knows nothing about tarball history — what it knows is that this
// list is maintained by hand, so any *other* pattern that stops matching is the exact
// regression it exists to catch (a `modules/` tree dropped from `files` makes
// `@mengyyy369/reorder/modules/subscription` unresolvable) and has to fail.
// `./providers/*` is listed because the plugin ships no providers at all:
// `src/providers/` holds only the Medusa template README, so
// `@mengyyy369/reorder/providers/<name>` never resolves.
const EMPTY_PATTERN_ALLOWLIST = new Set(["./.medusa/server/src/providers/*/index.js"])

const { root, temp } = unpack(process.argv[2] ?? "package")
let status = 0
try {
  status = assertSurface(root)
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true })
}
process.exit(status)

// Accepts an unpacked package directory, a .tgz, or a directory holding exactly one .tgz.
function unpack(input) {
  const kind = statSync(input, { throwIfNoEntry: false })
  if (kind?.isFile() && input.endsWith(".tgz")) return extract(input)
  if (kind?.isDirectory()) {
    if (existsSync(join(input, "package.json"))) return { root: input, temp: null }
    const tarballs = readdirSync(input).filter((name) => name.endsWith(".tgz"))
    if (tarballs.length !== 1) {
      fail(
        `${input} holds ${tarballs.length || "no"} tarballs, expected exactly one: ${tarballs.join(", ") || "none"}`
      )
    }
    return extract(join(input, tarballs[0]))
  }
  fail(`${input} is neither an unpacked package directory nor a .tgz`)
}

function extract(tgz) {
  const temp = mkdtempSync(join(tmpdir(), "reorder-package-"))
  // Measured with spawnSync and array args on the two tar binaries reachable here,
  // MSYS GNU tar 1.35 (`/usr/bin/tar`) and System32 bsdtar 3.5.2, each invoked with
  // the same two arguments this function builds:
  //   * a backslash path only survives bsdtar — GNU tar forwards it half escaped
  //     (`C\:\\Users\\… Cannot open`, exit 2) — so both get forward slashes;
  //   * a forward slash is not enough for GNU tar: with a drive-letter archive
  //     argument (`D:/…/reorder-1.6.0.tgz`) it still applies its `[user@host:]file`
  //     syntax and shells out to rsh (`tar (child): Cannot connect to D: resolve
  //     failed`, exit 2), where bsdtar opens the file. `--force-local` disables that
  //     parse on GNU tar and is rejected by bsdtar (`Option --force-local is not
  //     supported`, exit 1), so it can only be a retry after the plain call fails,
  //     never an unconditional flag.
  // The `-C` destination is a forward-slash absolute path, which both accept.
  const archive = tgz.replaceAll("\\", "/")
  const dest = temp.replaceAll("\\", "/")
  const failures = []
  for (const flags of [[], ["--force-local"]]) {
    const tar = spawnSync("tar", [...flags, "-xzf", archive, "-C", dest])
    if (tar.status === 0) return { root: join(temp, "package"), temp }
    failures.push(
      `tar ${flags.join(" ")} exited ${tar.status ?? tar.signal}: ${
        tar.error?.message ?? tar.stderr?.toString().trim() ?? "no output"
      }`
    )
  }
  rmSync(temp, { recursive: true, force: true })
  fail(`could not extract ${tgz}\n  ${failures.join("\n  ")}`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function assertSurface(root) {
  const map = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    console.error(
      `the packed package.json at ${root} declares no "exports" map: there is nothing to check, so this is reported as a failure rather than an empty pass`
    )
    return 1
  }
  const files = new Set(
    readdirSync(root, { recursive: true })
      .filter((name) => statSync(join(root, name)).isFile())
      .map((name) => "./" + name.split(sep).join("/"))
  )

  const targets = []
  const walk = (value, key) => {
    if (typeof value === "string") targets.push({ key, target: value })
    else if (value && typeof value === "object") {
      for (const [condition, nested] of Object.entries(value)) walk(nested, `${key} ${condition}`)
    }
  }
  for (const [key, value] of Object.entries(map)) walk(value, key)

  const underServer = ({ target }) => target.startsWith(SERVER)
  const checked = targets.filter((t) => underServer(t) && t.target.startsWith(SOURCES))
  const outside = targets.filter((t) => underServer(t) && !t.target.startsWith(SOURCES))
  const skipped = targets.filter((t) => !underServer(t))
  const missing = []
  const emptyPatterns = []
  const allowlisted = []

  for (const entry of checked) {
    if (entry.target.includes("*")) {
      if (!matchesSome(files, entry.target)) {
        ;(EMPTY_PATTERN_ALLOWLIST.has(entry.target) ? allowlisted : emptyPatterns).push(entry)
      }
    } else if (!files.has(entry.target)) {
      missing.push(entry)
    }
  }

  if (!checked.length) {
    console.error(
      `no exports target resolves under ${SOURCES}, so the check would be vacuous. Targets found:\n  ${describe(
        targets
      ).join("\n  ")}`
    )
    return 1
  }
  if (skipped.length) {
    console.log(`skipped, not under ${SERVER}: ${describe(skipped).join(", ")}`)
  }
  if (allowlisted.length) {
    console.log(
      `patterns matching nothing, exempted only because EMPTY_PATTERN_ALLOWLIST names them: ${describe(
        allowlisted
      ).join(", ")}`
    )
  }
  if (emptyPatterns.length) {
    console.error(
      `exports patterns matching no packed file, and not allowlisted:\n  ${describe(
        emptyPatterns
      ).join("\n  ")}`
    )
  }
  if (outside.length) {
    console.error(
      `exports targets outside ${SOURCES}, which "files" no longer packs:\n  ${describe(
        outside
      ).join("\n  ")}`
    )
  }
  if (missing.length) {
    console.error(`missing packed exports targets:\n  ${describe(missing).join("\n  ")}`)
  }
  if (missing.length || outside.length || emptyPatterns.length) return 1

  console.log(
    `packed exports ok (${checked.length} targets checked, ${
      new Set(checked.map((entry) => entry.target)).size
    } distinct, ${allowlisted.length} allowlisted empty pattern, ${skipped.length} skipped)`
  )
  return 0
}

// One line per distinct target, labelled with every exports key that resolves to it,
// so two keys sharing a target print once instead of duplicating the line.
function describe(entries) {
  const byTarget = new Map()
  for (const { key, target } of entries) {
    if (!byTarget.has(target)) byTarget.set(target, new Set())
    byTarget.get(target).add(key)
  }
  return [...byTarget].map(([target, keys]) => `${target} (keys: ${[...keys].join(", ")})`)
}

// A target's "*" is substituted with the whole matched subpath, slashes included.
function matchesSome(files, pattern) {
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").split("*").join(".*") + "$"
  )
  return [...files].some((file) => re.test(file))
}
