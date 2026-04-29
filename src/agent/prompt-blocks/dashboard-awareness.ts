// Dashboard awareness block: tells the agent that the operator has a
// dashboard at /ui/dashboard where they can edit skills, memory files,
// plugins, subagents, hooks, and settings. Paired with the show-my-tools
// built-in skill which enumerates the current catalog on demand. Budget:
// under 60 lines total per the PR3 builder brief.

export function buildDashboardAwarenessLines(publicUrl: string | undefined): string[] {
	const base = publicUrl?.replace(/\/$/, "") ?? "";
	const dash = base ? `${base}/ui/dashboard/` : "/ui/dashboard/";
	const skillsUrl = `${dash}#/skills`;
	const memoryUrl = `${dash}#/memory-files`;
	const pluginsUrl = `${dash}#/plugins`;
	const subagentsUrl = `${dash}#/subagents`;
	const hooksUrl = `${dash}#/hooks`;
	const settingsUrl = `${dash}#/settings`;

	const lines: string[] = [];
	lines.push("");
	lines.push("=== YOUR DASHBOARD ===");
	lines.push("");
	lines.push("Your operator has a dashboard they use to shape how you work. Six tabs are live:");
	lines.push(`- Skills: ${skillsUrl} (edit ~/.claude/skills/<name>/SKILL.md; live on next turn).`);
	lines.push(`- Memory files: ${memoryUrl} (edit CLAUDE.md, rules/*.md, memory/*.md; picked up on next session).`);
	lines.push(
		`- Plugins: ${pluginsUrl} (claude-plugins-official marketplace; trust modal on first install; four pre-installed: linear, notion, slack, claude-md-management; audited).`,
	);
	lines.push(
		`- Subagents: ${subagentsUrl} (flat files at ~/.claude/agents/<name>.md with frontmatter for tools, model, effort, color, prompt body; invoke via Task tool).`,
	);
	lines.push(
		`- Hooks: ${hooksUrl} (visual rule builder over 26 SDK events in ~/.claude/settings.json; command, prompt, agent, http types; live on next message).`,
	);
	lines.push(
		`- Settings: ${settingsUrl} (operator-facing form over phantom.yaml; six sections: identity, model + cost, evolution cadence, channels, memory, tool permissions; atomic writes, audited).`,
	);
	lines.push("");
	lines.push(
		`When the operator asks "what can I customize", "show me the dashboard", point them at ${dash} and fire the show-my-tools skill for the current catalog.`,
	);
	lines.push("");
	lines.push(
		'Intent routing: "install a plugin / add a capability" -> plugins. "add a hook / format on edit / block dangerous bash" -> hooks. "create a subagent / build a specialist" -> subagents. "change permissions / change my model" -> settings.',
	);
	return lines;
}
