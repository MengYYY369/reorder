import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"

/**
 * Discord 服务器门槛的**引擎侧权威校验**（T13，2026-10-02 走查）。
 *
 * 数据源 = 插件（medusa-better-auth）的 `ba_discord_membership` 表（同一个库）：
 *   - 哨兵行 `customer_id = '__gate__'` 存当前 gate 的 guildId —— 有它 = 门槛开着；
 *   - 客户行存最近一次检查的 `is_member`。
 * 店面侧负责提示与刷新（5 分钟 TTL），引擎侧只做「能不能放行」的判定，因此
 * **不需要第二份配置**、不需要跨插件 HTTP。
 *
 * 契约（fail-open）：表缺失（插件未装/旧版）、哨兵行缺失（门槛未配置）、读库
 * 异常——一律放行。门槛是营销条件，基础设施抖动不该把顾客挡在门外。反之：
 * 门槛开着而客户**没有行**（从未检查过，典型是绕过店面直调 API）或最近一次
 * 检查**不是成员**，一律拒绝（固定文案，店面按文案映射提示）。
 *
 * 陈旧但为成员的行**放行**（不做过期判定）：退服后未再检查的顾客保留试用，
 * 比让已入服的会员被一条过期记录拦下更可接受。
 */

/** 哨兵行主键（与插件 `discord-membership.ts` 的 DISCORD_GATE_SENTINEL 同值）。 */
export const DISCORD_GATE_SENTINEL = "__gate__"

/** 领取被门槛拒绝时的固定文案（店面按它映射本地化提示）。 */
export const DISCORD_GATE_REFUSAL =
  "This trial requires joining the Discord server first."

/** knex 直连的最小面（`ContainerRegistrationKeys.PG_CONNECTION`）。 */
type KnexLike = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows?: Array<Record<string, unknown>> }>
}

export async function assertDiscordMembership(
  container: MedusaContainer,
  customerId: string
): Promise<void> {
  let gateGuildId: string | null = null
  let isMember: boolean | null = null

  try {
    const knex = container.resolve<KnexLike>(
      ContainerRegistrationKeys.PG_CONNECTION
    )
    const sentinel = await knex.raw(
      "select guild_id from ba_discord_membership where customer_id = ?",
      [DISCORD_GATE_SENTINEL]
    )
    gateGuildId = (sentinel?.rows?.[0]?.guild_id as string | undefined) ?? null
    if (!gateGuildId) return

    const rows = await knex.raw(
      "select guild_id, is_member from ba_discord_membership where customer_id = ?",
      [customerId]
    )
    const row = rows?.rows?.[0]
    if (row && row.guild_id === gateGuildId) {
      isMember = Boolean(row.is_member)
    }
  } catch {
    // 表缺失（42P01，插件未装/旧版）或 DB 抖动：fail-open
    return
  }

  if (isMember !== true) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, DISCORD_GATE_REFUSAL)
  }
}
