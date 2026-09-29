// scripts/assert-package-surface.mjs
// Every subpath a host can import must resolve inside the packed tree.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"

const SERVER = "./.medusa/server/"
const SOURCES = "./.medusa/server/src/"

// The admin i18n catalogs (src/admin/i18n/json/{en,zhCN}.json) are never shipped as
// files: the admin build inlines them into the bundle below as
// `const i18nTranslations0 = …`, wired through `const i18nModule = { resources: … }`.
// The exports check only sees that the file is packed, so a silent build regression
// dropping the catalogs would pass it and the production admin would render raw
// translation keys (e.g. `planOffers.list.title`). The markers below are real catalog
// entries matched verbatim — the zh marker is Chinese by construction.
const ADMIN_BUNDLE = SERVER + "src/admin/index.mjs"
const I18N_WIRING = "i18nModule"
const I18N_MARKERS = ["planOffers.list.title", "Plans & Offers", "计划与优惠"]

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
  // Both guards always run: one failing must not hide what the other would report.
  const surface = assertSurface(root)
  const adminI18n = assertAdminI18nBundle(root)
  status = surface || adminI18n
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

// Asserts the packed admin bundle still inlines the i18n catalogs. See the
// ADMIN_BUNDLE comment for why the exports check cannot cover this: it verifies the
// file is packed, not what the build put inside it.
function assertAdminI18nBundle(root) {
  const bundle = join(root, ADMIN_BUNDLE)
  if (!existsSync(bundle)) {
    console.error(
      `the packed admin bundle ${ADMIN_BUNDLE} is missing: the "./admin" import target ` +
        `would not resolve, and no i18n catalog could be inlined either`
    )
    return 1
  }
  const content = readFileSync(bundle, "utf8")
  const problems = []
  if (!content.includes(I18N_WIRING)) {
    problems.push(
      `no "${I18N_WIRING}" wiring: the admin build dropped the i18n module, ` +
        `so the production admin would render raw translation keys`
    )
  }
  if (!/i18nTranslations\d+\s*=/.test(content)) {
    problems.push(
      "no inlined translations catalog (no i18nTranslations<N> = …): " +
        "src/admin/i18n/json/{en,zhCN}.json were not inlined into the bundle"
    )
  }
  const missingMarkers = I18N_MARKERS.filter((marker) => !content.includes(marker))
  if (missingMarkers.length) {
    problems.push(
      `inlined catalog is missing known marker(s) ${missingMarkers
        .map((marker) => JSON.stringify(marker))
        .join(", ")}: the catalogs were dropped or emptied, ` +
        `so the production admin would render raw translation keys`
    )
  }
  // Empty-catalog regression, scoped to the i18nModule declaration itself so a
  // `resources: {}` belonging to some other module can never fail this guard.
  const wiring = content.match(/i18nModule\s*=\s*\{[^{}]*\}/)?.[0]
  if (wiring && /resources:\s*\{\s*\}/.test(wiring)) {
    problems.push(
      `i18nModule wires an empty catalog ("${wiring}"): ` +
        `the production admin would render raw translation keys`
    )
  }
  if (problems.length) {
    console.error(
      `the admin bundle ${ADMIN_BUNDLE} fails the i18n inlining guard:\n  ${problems.join("\n  ")}`
    )
    return 1
  }
  console.log(
    `admin bundle i18n ok (${ADMIN_BUNDLE} wires i18nModule with the inlined catalogs, all markers present)`
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
