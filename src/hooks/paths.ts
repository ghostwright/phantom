// Path helper for the settings.json file that holds the hooks slice.
// Reuses the plugins paths helper so both PR2 and PR3 read from the same
// canonical /home/phantom/.claude/settings.json.

import { getUserSettingsPath } from "../plugins/paths.ts";

export function getHooksSettingsPath(): string {
	return getUserSettingsPath();
}
