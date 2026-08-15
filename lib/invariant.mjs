//#region src/invariant.ts
const PACKAGE_NAME = "dsh-request-flight-recorder";
/** Cordis companion plugin name. */
const name = "request-flight-recorder-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: retention capacity is enforced synchronously by the
* owning store and has no independent authoritative event stream against
* which a companion could validate the same relationship.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
