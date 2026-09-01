import { Context } from "effect"

/**
 * `ZONE`, `MAX_BYTES` and `ADMIN_TOKEN` as the handlers see them. Read once from
 * the Worker `env`; `zone` is also what the hostname classifier matches against,
 * so it is passed to `makeApp` as a plain value rather than pulled out of the
 * layer. An undefined `adminToken` is what takes the takedown route away.
 */
export interface WorkerConfig {
  readonly zone: string
  readonly maxBytes: number
  readonly adminToken?: string | undefined
}

export class Config extends Context.Service<Config, WorkerConfig>()("handbill/Config") {}

/** 5 MB, the cap the CLI enforces before it uploads. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
