import { Schema } from "effect"
import { Hash } from "./schemas"

/**
 * The request body does not hash to the hash in the URL. `expected` is what the
 * bytes actually hash to, so a client can retry against the right URL instead of
 * guessing.
 */
export class HashMismatch extends Schema.TaggedError<HashMismatch>()(
  "HashMismatch",
  {
    expected: Hash
  },
  { httpApiStatus: 400 }
) {}

/** Missing or wrong bearer token. Publishing needs one; reading a page never does. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  {
    httpApiStatus: 401
  }
) {}

/**
 * No such page. Raised by the page-serving path on a hash hostname (which is not
 * part of the API) and, from 0.2, by alias lookups.
 */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  {},
  {
    httpApiStatus: 404
  }
) {}

/** The document is over the Worker's byte cap. `maxBytes` is that cap, so the message can name it. */
export class TooLarge extends Schema.TaggedError<TooLarge>()(
  "TooLarge",
  {
    maxBytes: Schema.Natural
  },
  { httpApiStatus: 413 }
) {}
