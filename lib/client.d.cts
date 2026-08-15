
import { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
//#region src/client/index.d.ts
declare const inject: readonly ["locale", "settingsScope", "connection", "remote"];
declare function apply(ctx: ClientContext): void;
//#endregion
export { apply, inject };
