import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import {
  AccountGroup,
  AdminGroup,
  AliasesGroup,
  BillingGroup,
  KeysGroup,
  MetaGroup,
  PagesGroup
} from "./groups"

/**
 * The whole API, and the single source of truth for it: the Worker implements it
 * with `HttpApiBuilder`, the CLI consumes it with `HttpApiClient.make`, and
 * `OpenApi.fromApi` generates the spec. Nobody hand-writes a fetch or a status code.
 */
export class HandbillApi extends HttpApi.make("handbill")
  .add(PagesGroup)
  .add(AliasesGroup)
  .add(KeysGroup)
  .add(AccountGroup)
  .add(AdminGroup)
  .add(BillingGroup)
  .add(MetaGroup)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "handbill",
      version: "0.5.0-dev",
      description:
        "Hand someone a page: one self-contained HTML file at an unguessable, immutable URL."
    })
  ) {}
