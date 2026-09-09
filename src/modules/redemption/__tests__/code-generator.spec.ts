import {
  generateRedemptionCode,
  generateUniqueRedemptionCodes,
  normalizeCustomRedemptionCode,
  normalizeRedemptionCode,
} from "../utils/code-generator"

describe("code-generator", () => {
  describe("normalizeRedemptionCode", () => {
    it("trims and uppercases input", () => {
      expect(normalizeRedemptionCode("  rdm-abcd-1234-wxyz ")).toBe(
        "RDM-ABCD-1234-WXYZ"
      )
    })
  })

  describe("generateRedemptionCode", () => {
    it("produces the grouped prefix format", () => {
      const code = generateRedemptionCode({ prefix: "RDM" })
      expect(code).toMatch(/^RDM(-[2-9A-HJKMNP-Z]{4}){3}$/)
    })

    it("avoids ambiguous characters", () => {
      for (let i = 0; i < 50; i++) {
        const code = generateRedemptionCode()
        expect(code).not.toMatch(/[01OIL]/)
      }
    })

    it("uses the injected random source", () => {
      let call = 0
      const sequence = [0, 0.5, 0.999]
      const code = generateRedemptionCode({
        random: () => sequence[call++ % sequence.length],
      })
      const charset = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
      const first = charset[0]
      const mid = charset[Math.floor(0.5 * charset.length)]
      const last = charset[Math.floor(0.999 * charset.length)]
      expect(code).toBe(
        `RDM-${`${first}${mid}${last}${first}`}-${`${mid}${last}${first}${mid}`}-${`${last}${first}${mid}${last}`}`
      )
    })
  })

  describe("normalizeCustomRedemptionCode", () => {
    it("accepts alphanumeric with inner hyphens", () => {
      expect(normalizeCustomRedemptionCode("black-friday-2026")).toBe(
        "BLACK-FRIDAY-2026"
      )
    })

    it("rejects leading/trailing hyphens and single characters", () => {
      expect(normalizeCustomRedemptionCode("-abc")).toBeNull()
      expect(normalizeCustomRedemptionCode("abc-")).toBeNull()
      expect(normalizeCustomRedemptionCode("a")).toBeNull()
    })

    it("rejects symbols outside alphanumerics and hyphens", () => {
      expect(normalizeCustomRedemptionCode("AB CD")).toBeNull()
      expect(normalizeCustomRedemptionCode("AB@CD")).toBeNull()
    })
  })

  describe("generateUniqueRedemptionCodes", () => {
    it("generates the requested count of unique codes", () => {
      const codes = generateUniqueRedemptionCodes(25, [], { prefix: "RDM" })
      expect(codes).toHaveLength(25)
      expect(new Set(codes).size).toBe(25)
      for (const code of codes) {
        expect(code).toMatch(/^RDM(-[2-9A-HJKMNP-Z]{4}){3}$/)
      }
    })

    it("regenerates until it avoids an existing collision", () => {
      // A constant random always produces the same candidate; occupying that
      // exact candidate forces the rejection loop to exhaust and throw.
      const constantCandidate = generateRedemptionCode({ random: () => 0.5 })
      expect(() =>
        generateUniqueRedemptionCodes(1, [constantCandidate.toLowerCase()], {
          random: () => 0.5,
        })
      ).toThrow(/Unable to generate/)
      // With an occupied candidate and a random that alternates between two
      // values, the generator must never return the occupied code.
      let flip = false
      const occupied = generateRedemptionCode({ random: () => 0.1 })
      const codes = generateUniqueRedemptionCodes(1, [occupied], {
        random: () => (flip ? 0.1 : 0.9),
      })
      expect(codes).toHaveLength(1)
      expect(codes[0]).not.toBe(occupied)
    })
  })
})
