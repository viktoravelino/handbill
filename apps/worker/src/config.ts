import { Context } from "effect"

/**
 * `ZONE` and `MAX_BYTES` as the handlers see them. Read once from the Worker
 * `env`; `zone` is also what the hostname classifier matches against, so it is
 * passed to `makeApp` as a plain value rather than pulled out of the layer.
 */
export interface WorkerConfig {
  readonly zone: string
  readonly maxBytes: number
}

export class Config extends Context.Service<Config, WorkerConfig>()("handbill/Config") {}

/** 5 MB, the cap the CLI enforces before it uploads. */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
