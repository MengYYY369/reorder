// scripts/assert-package-surface.mjs
// Every subpath a host can import must resolve inside the packed tree.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"

const SERVER = "./.medusa/server/"
const SOURCES = "./.medusa/server/src/"

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
  // Git Bash ships an MSYS tar that rejects backslash paths, and both it and
  // System32 bsdtar accept the forward-slash form, so tar gets forward slashes.
  const tar = spawnSync("tar", ["-xzf", tgz.replaceAll("\\", "/"), "-C", temp.replaceAll("\\", "/")])
  if (tar.status !== 0) {
    rmSync(temp, { recursive: true, force: true })
    fail(
      `could not extract ${tgz}: ${tar.error?.message ?? `tar exited ${tar.status}: ${tar.stderr?.toString().trim()}`}`
    )
  }
  return { root: join(temp, "package"), temp }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function assertSurface(root) {
  const { exports: map } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const files = new Set(
    readdirSync(root, { recursive: true })
      .filter((name) => statSync(join(root, name)).isFile())
      .map((name) => "./" + name.split(sep).join("/"))
  )

  const targets = []
  const walk = (value) => {
    if (typeof value === "string") targets.push(value)
    else if (value) Object.values(value).forEach(walk)
  }
  walk(map)

  const packed = targets.filter((target) => target.startsWith(SERVER))
  const checked = packed.filter((target) => target.startsWith(SOURCES))
  const outside = packed.filter((target) => !target.startsWith(SOURCES))
  const skipped = targets.filter((target) => !target.startsWith(SERVER))
  const missing = []
  const unresolved = []

  for (const target of checked) {
    if (target.includes("*")) {
      if (!matchesSome(files, target)) unresolved.push(target)
    } else if (!files.has(target)) {
      missing.push(target)
    }
  }

  if (skipped.length) {
    console.log(`skipped, not under ${SERVER}: ${skipped.join(", ")}`)
  }
  if (unresolved.length) {
    console.log(
      `patterns matching nothing in the packed tree (pre-existing, not a "files" regression): ${unresolved.join(", ")}`
    )
  }
  if (outside.length) {
    console.error(
      `exports targets outside ${SOURCES}, which "files" no longer packs:\n  ${outside.join("\n  ")}`
    )
  }
  if (missing.length) {
    console.error(`missing packed exports targets:\n  ${missing.join("\n  ")}`)
  }
  if (missing.length || outside.length) return 1

  console.log(
    `packed exports ok (${checked.length} targets checked, ${unresolved.length} unresolved, ${skipped.length} skipped)`
  )
  return 0
}

// A target's "*" is substituted with the whole matched subpath, slashes included.
function matchesSome(files, pattern) {
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").split("*").join(".*") + "$"
  )
  return [...files].some((file) => re.test(file))
}
