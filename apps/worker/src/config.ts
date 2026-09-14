import { Context } from "effect"

/**
 * The `env` vars as the handlers see them, read once. `zone` is also what the
 * hostname classifier matches against, so it is passed to `makeApp` as a plain
 * value rather than pulled out of the layer. Undefined takes something away: the
 * admin routes (`adminToken`), the billing webhook (`webhookSecret`), or what
 * health says about the deploy (`version`, `build`).
 */
export interface WorkerConfig {
  readonly zone: string
  readonly maxBytes: number
  readonly adminToken?: string | undefined
  readonly webhookSecret?: string | undefined
  readonly version?: string | undefined
  readonly build?: string | undefined
}

export class Config extends Context.Service<Config, WorkerConfig>()("handbill/Config") {}

/** Polar's own API, where a checkout session is created; the sandbox is a var away. */
export const DEFAULT_POLAR_API = "https://api.polar.sh"

/** 5 MB, the cap the CLI enforces before it uploads. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
