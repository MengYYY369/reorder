import { MedusaError } from "@medusajs/framework/utils"

import {
  assertDiscordMembership,
  DISCORD_GATE_REFUSAL,
  DISCORD_GATE_SENTINEL,
} from "../discord-gate"

/**
 * T13 单测（2026-10-02 走查）：引擎侧门槛判定——未配置/表缺失/成员/非成员/
 * 从未检查/换 guild。全部用假 knex，不打库。
 */

type RawFn = (
  sql: string,
  bindings?: unknown[]
) => Promise<{ rows?: Array<Record<string, unknown>> }>

const containerWith = (raw: RawFn) =>
  ({ resolve: () => ({ raw }) }) as unknown as Parameters<
    typeof assertDiscordMembership
  >[0]

const gateOn = (membershipRow: Record<string, unknown> | undefined): RawFn => {
  return async (_sql, bindings) => {
    if (bindings?.[0] === DISCORD_GATE_SENTINEL) {
      return { rows: [{ guild_id: "g1" }] }
    }
    return { rows: membershipRow ? [membershipRow] : [] }
  }
}

describe("assertDiscordMembership (T13)", () => {
  it("allows when the gate is not configured (no sentinel row)", async () => {
    const container = containerWith(async () => ({ rows: [] }))
    await expect(
      assertDiscordMembership(container, "cus_1")
    ).resolves.toBeUndefined()
  })

  it("allows when the plugin's table is missing (fail-open)", async () => {
    const container = containerWith(async () => {
      throw Object.assign(new Error("relation does not exist"), { code: "42P01" })
    })
    await expect(
      assertDiscordMembership(container, "cus_1")
    ).resolves.toBeUndefined()
  })

  it("allows a customer the plugin last saw as a member", async () => {
    const container = containerWith(
      gateOn({ guild_id: "g1", is_member: true })
    )
    await expect(
      assertDiscordMembership(container, "cus_1")
    ).resolves.toBeUndefined()
  })

  it("refuses a customer the plugin last saw as a non-member", async () => {
    const container = containerWith(
      gateOn({ guild_id: "g1", is_member: false })
    )
    await expect(assertDiscordMembership(container, "cus_1")).rejects.toMatchObject(
      {
        type: MedusaError.Types.INVALID_DATA,
        message: DISCORD_GATE_REFUSAL,
      }
    )
  })

  it("refuses a customer that was never checked (a direct API call)", async () => {
    const container = containerWith(gateOn(undefined))
    await expect(assertDiscordMembership(container, "cus_1")).rejects.toMatchObject(
      {
        type: MedusaError.Types.INVALID_DATA,
        message: DISCORD_GATE_REFUSAL,
      }
    )
  })

  it("refuses when the cached row belongs to a different guild", async () => {
    const container = containerWith(
      gateOn({ guild_id: "g2", is_member: true })
    )
    await expect(assertDiscordMembership(container, "cus_1")).rejects.toMatchObject(
      {
        type: MedusaError.Types.INVALID_DATA,
        message: DISCORD_GATE_REFUSAL,
      }
    )
  })
})
