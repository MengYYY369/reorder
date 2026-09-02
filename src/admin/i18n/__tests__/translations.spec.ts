import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

const I18N_DIR = join(__dirname, "..")
const ADMIN_DIR = join(I18N_DIR, "..")

type Tree = { [k: string]: string | Tree }

const en = JSON.parse(readFileSync(join(I18N_DIR, "json/en.json"), "utf-8")) as Tree
const zh = JSON.parse(readFileSync(join(I18N_DIR, "json/zhCN.json"), "utf-8")) as Tree

const PREFIXES = [
  "menuItems", "common", "subscriptions", "planOffers", "renewals",
  "dunning", "cancellations", "activityLog", "analytics", "settings",
]

function flat(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === "object" && v !== null
      ? flat(v, `${prefix}${k}.`)
      : [[`${prefix}${k}`, v as string]]
  )
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(full)
    }
    return /\.tsx?$/.test(entry) && !entry.endsWith(".d.ts") ? [full] : []
  })
}

const KEY_RE = new RegExp(
  `["']((${PREFIXES.join("|")})(?:\\.[A-Za-z0-9_]+)+)["']`,
  "g"
)

// Backend subscription event-type identifiers (event-bus contract strings),
// not translation keys. They collide with the "dunning" domain prefix by
// coincidence of the domain name and are excluded from the key-literal net.
const NON_TRANSLATION_KEYS = new Set([
  "dunning.started",
  "dunning.retry_executed",
  "dunning.recovered",
  "dunning.unrecovered",
  "dunning.retry_schedule_updated",
])

function usedKeys(): Array<{ key: string; file: string }> {
  return sourceFiles(ADMIN_DIR).flatMap((file) => {
    const src = readFileSync(file, "utf-8")
    const found: Array<{ key: string; file: string }> = []
    let m: RegExpExecArray | null
    while ((m = KEY_RE.exec(src)) !== null) {
      if (!NON_TRANSLATION_KEYS.has(m[1])) {
        found.push({ key: m[1], file })
      }
    }
    return found
  })
}

function routeConfigs(): Array<{ file: string; label: string; ns: boolean }> {
  return sourceFiles(join(ADMIN_DIR, "routes"))
    .map((file) => {
      const src = readFileSync(file, "utf-8")
      const label = src.match(/label:\s*"((?:menuItems\.)[A-Za-z0-9_.]+)"/)
      return label
        ? { file, label: label[1], ns: src.includes('translationNs: "reorder"') }
        : null
    })
    .filter((x): x is { file: string; label: string; ns: boolean } => x !== null)
}

describe("translation catalogs", () => {
  it("registers en and zhCN under the reorder namespace", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(I18N_DIR, "index.ts").replace(/\.ts$/, ""))

    expect(Object.keys(mod.default ?? mod).sort()).toEqual(["en", "zhCN"])
    expect(Object.keys((mod.default ?? mod).en)).toContain("reorder")
    expect(Object.keys((mod.default ?? mod).zhCN)).toContain("reorder")
  })

  it("keeps en and zhCN key sets identical", () => {
    const enKeys = flat(en).map(([k]) => k).sort()
    const zhKeys = flat(zh).map(([k]) => k).sort()

    expect(zhKeys.filter((k) => !enKeys.includes(k))).toEqual([])
    expect(enKeys.filter((k) => !zhKeys.includes(k))).toEqual([])
  })

  it("has no empty values", () => {
    const empty = [...flat(en), ...flat(zh)].filter(
      ([, v]) => typeof v !== "string" || v.trim() === ""
    )

    expect(empty).toEqual([])
  })

  it("resolves every translation-key literal used in src/admin", () => {
    const known = new Set(flat(en).map(([k]) => k))
    const missing = usedKeys()
      .filter(({ key }) => !known.has(key))
      .map(({ key, file }) => `${key} (${file})`)

    expect(missing).toEqual([])
  })

  it("uses translationNs on every sidebar route config", () => {
    const bad = routeConfigs().filter((r) => !r.ns)

    expect(bad.map((r) => r.file)).toEqual([])
  })
})
