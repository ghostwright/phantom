// Maps the operator-configured permissions block from phantom.yaml onto the
// Agent SDK query() option shape. Previously the runtime hardcoded
// permissionMode = "bypassPermissions"; this helper routes the dashboard
// Settings -> Permissions selection into every query() call so saves from
// /ui/dashboard/#/settings actually change agent behavior on the next
// message instead of silently updating yaml.

import type { PhantomConfig } from "../config/types.ts";

export type PermissionSdkOptions = {
	permissionMode: "default" | "acceptEdits" | "bypassPermissions";
	allowDangerouslySkipPermissions: boolean;
	allowedTools?: string[];
	disallowedTools?: string[];
};

export function permissionOptionsFromConfig(config: PhantomConfig): PermissionSdkOptions {
	const perms = config.permissions;
	const mode = perms?.default_mode ?? "bypassPermissions";
	const opts: PermissionSdkOptions = {
		permissionMode: mode,
		// The SDK gates bypass mode behind this ack when the process is
		// effectively unattended. Only set it when the operator actually chose
		// bypass; other modes are supposed to prompt / auto-edit and don't
		// need the skip-permissions ack.
		allowDangerouslySkipPermissions: mode === "bypassPermissions",
	};
	if (perms?.allow && perms.allow.length > 0) opts.allowedTools = [...perms.allow];
	if (perms?.deny && perms.deny.length > 0) opts.disallowedTools = [...perms.deny];
	return opts;
}
