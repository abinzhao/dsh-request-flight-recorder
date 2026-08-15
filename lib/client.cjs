window.__ModuleLoader__.load({
  id: "dsh-request-flight-recorder",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/client/locale-sync.ts
const CLIENT_LOCALE_NAMESPACE = "locale";
const CLIENT_LOCALE_FIELD = "preference";
function readPreference(value) {
	if (typeof value !== "object" || value === null || !Object.hasOwn(value, "preference")) return;
	return value[CLIENT_LOCALE_FIELD];
}
function normalizeClientLocale(value) {
	return value === "en" ? "en" : "zh";
}
async function synchronizeInitialLocale(scope, active) {
	const before = scope.getSnapshot();
	if (before.status !== "ready" || before.mode !== "host" || !before.writable) return "unavailable";
	if (readPreference(before.user) !== void 0) return "preserved";
	await scope.set(CLIENT_LOCALE_FIELD, active);
	const accepted = readPreference(scope.getSnapshot().user);
	if (accepted === active) return "written";
	if (accepted !== void 0) return "preserved";
	return "unavailable";
}
//#endregion
//#region src/client/index.ts
const inject = [
	"locale",
	"settingsScope",
	"connection",
	"remote"
];
function apply(ctx) {
	const scope = ctx.settingsScope.bind({ namespace: CLIENT_LOCALE_NAMESPACE });
	let attempted = false;
	const logger = ctx.logger("request-flight-recorder");
	const sync = async () => {
		if (attempted) return;
		if (scope.getSnapshot().status === "loading") return;
		attempted = true;
		try {
			await synchronizeInitialLocale(scope, normalizeClientLocale(ctx.locale.getSnapshot().active));
		} catch {
			logger.warn("initial locale synchronization failed");
		}
	};
	ctx.effect(() => {
		const unsubscribe = scope.subscribe(() => {
			sync();
		});
		sync();
		return unsubscribe;
	});
}
//#endregion
exports.apply = apply;
exports.inject = inject;

    return module.exports;
  }
});