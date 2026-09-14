import { Context } from "effect"

/**
 * `ZONE`, `MAX_BYTES` and the two operator secrets as the handlers see them.
 * Read once from the Worker `env`; `zone` is also what the hostname classifier
 * matches against, so it is passed to `makeApp` as a plain value rather than
 * pulled out of the layer. An undefined `adminToken` takes the admin routes
 * away; an undefined `webhookSecret`, the billing webhook.
 */
export interface WorkerConfig {
  readonly zone: string
  readonly maxBytes: number
  readonly adminToken?: string | undefined
  readonly webhookSecret?: string | undefined
}

export class Config extends Context.Service<Config, WorkerConfig>()("handbill/Config") {}

/** Polar's own API, where a checkout session is created; the sandbox is a var away. */
export const DEFAULT_POLAR_API = "https://api.polar.sh"

/** 5 MB, the cap the CLI enforces before it uploads. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
