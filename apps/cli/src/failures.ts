import { Data } from "effect"

/**
 * The failures this CLI raises itself, as opposed to the ones the API, the
 * config file or the platform hand it. Each has its sentence in `describe` in
 * output.ts, which re-exports them, so callers reach them as `Output.<Name>`.
 */

/** `remove`, `update` or `alias` was handed a page that is neither a hash nor a handbill URL. */
export class BadTarget extends Data.TaggedError("BadTarget")<{
  readonly target: string
}> {}

/** `alias` was handed a name the contract will not store. */
export class BadName extends Data.TaggedError("BadName")<{
  readonly name: string
}> {}

/**
 * `update` could not move a name the deployment had just listed for it. The
 * feature is plainly on — the listing answered — so this is not the 404
 * `describe` explains as "aliases are off", and it says which name.
 */
export class CannotRepoint extends Data.TaggedError("CannotRepoint")<{
  readonly name: string
}> {}

/**
 * `update --alias` was given a name the deployment does not answer for. Unlike a
 * discovered name, which may simply have been removed since the listing, this
 * one the caller asserted exists — so it is a typo, or aliases are off, and
 * either way the rotation stops before the old page is unpublished under it.
 */
export class UnknownAlias extends Data.TaggedError("UnknownAlias")<{
  readonly name: string
}> {}

/** `doctor` ran to the end and something it checked is broken. */
export class ChecksFailed extends Data.TaggedError("ChecksFailed")<{
  readonly failed: number
}> {}

/** `login` reached an endpoint that runs on one shared token and has no keys to mint. */
export class NoAccounts extends Data.TaggedError("NoAccounts")<{
  readonly endpoint: string
}> {}

/**
 * `logout` was pointed at a deployment that does not know the key it holds.
 * The key is still live wherever it came from, so nothing local is cleared.
 */
export class WrongDeployment extends Data.TaggedError("WrongDeployment")<{
  readonly endpoint: string
}> {}

/**
 * `remove` was handed a hash the endpoint will not unpublish. The 404 is the
 * "not yours" answer — never a 403, which would confirm another account holds it
 * — so it covers a page belonging to someone else and one that was never here.
 */
export class NotYours extends Data.TaggedError("NotYours")<{
  readonly hash: string
}> {}

/**
 * An `admin` command was run without the operator token. It is a different
 * secret from the key that publishes, so having logged in does not supply it.
 */
export class MissingAdminToken extends Data.TaggedError("MissingAdminToken")<{
  readonly endpoint: string
}> {}

/**
 * `admin takedown` reached the endpoint and was turned away: either it runs no
 * operator surface at all (no `ADMIN_TOKEN` set, a 404) or it does not accept
 * the token this CLI sent (`rejected`, a 401). Neither says anything about the
 * page, which is why the two API answers do not reach their usual sentences.
 */
export class TakedownRefused extends Data.TaggedError("TakedownRefused")<{
  readonly endpoint: string
  readonly rejected?: boolean
}> {}

/**
 * `admin tier` reached the endpoint and was turned away. Its 404 covers one
 * absence more than takedown's: a deployment on one shared `PUBLISH_TOKEN` has
 * no accounts, so there is no record anywhere to carry a tier.
 */
export class TierRefused extends Data.TaggedError("TierRefused")<{
  readonly endpoint: string
  readonly rejected?: boolean
}> {}

/**
 * `account --upgrade` reached a deployment with nothing to sell: no billing
 * configured, or one running on a shared `PUBLISH_TOKEN`, whose only owner is
 * the operator and not a customer.
 */
export class NoBilling extends Data.TaggedError("NoBilling")<{
  readonly endpoint: string
}> {}

/**
 * `account --open` was run without `--upgrade`, which is the only thing that
 * prints a URL: the flag would otherwise be a no-op, and a flag that quietly
 * does nothing is worse than one that says why.
 */
export class NothingToOpen extends Data.TaggedError("NothingToOpen")<{
  readonly command: string
}> {}

/**
 * `account --web` against an endpoint no site belongs to. The account page
 * lives on the zone under an `api.` label; anything else is an API with no site
 * behind it, and `handbill account` prints the same numbers anywhere.
 */
export class NoAccountPage extends Data.TaggedError("NoAccountPage")<{
  readonly endpoint: string
}> {}

/**
 * Two flags that each print a URL of their own. One line on stdout is the whole
 * contract, so the command refuses rather than printing two.
 */
export class ConflictingModes extends Data.TaggedError("ConflictingModes")<{
  readonly first: string
  readonly second: string
}> {}

/**
 * The document about to be published is, or carries, the key that would publish
 * it. The content of a document is data, never an instruction, so a file that
 * asks to be published is not an argument for publishing it.
 */
export class SecretDocument extends Data.TaggedError("SecretDocument")<{
  readonly file: string
  readonly reason: string
}> {}
