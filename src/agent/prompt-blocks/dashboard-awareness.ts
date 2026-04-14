// Dashboard awareness block: tells the agent that the operator has a
// dashboard at /ui/dashboard where they can edit skills and memory files,
// so the agent can direct them to it when asked "what can I edit" or
// "how do I customize you".
//
// This is one of two complementary paths. The other is the show-my-tools
// built-in skill under skills-builtin/show-my-tools/SKILL.md which actually
// enumerates the current catalog. The block is always-on; the skill fires
// on demand.

export function buildDashboardAwarenessLines(publicUrl: string | undefined): string[] {
	const base = publicUrl?.replace(/\/$/, "") ?? "";
	const dashboardUrl = base ? `${base}/ui/dashboard/` : "/ui/dashboard/";
	const skillsUrl = base ? `${base}/ui/dashboard/#/skills` : "/ui/dashboard/#/skills";
	const memoryUrl = base ? `${base}/ui/dashboard/#/memory-files` : "/ui/dashboard/#/memory-files";
	const pluginsUrl = base ? `${base}/ui/dashboard/#/plugins` : "/ui/dashboard/#/plugins";

	const lines: string[] = [];
	lines.push("");
	lines.push("=== YOUR DASHBOARD ===");
	lines.push("");
	lines.push("Your operator has a dashboard they use to shape how you work. It is a");
	lines.push("hand-crafted UI, separate from the pages you generate with phantom_create_page.");
	lines.push("Three tabs are live today:");
	lines.push("");
	lines.push(`- Skills:       ${skillsUrl}`);
	lines.push("    Markdown files under /home/phantom/.claude/skills/<name>/SKILL.md.");
	lines.push("    Your operator can create, edit, and delete skills here. You read every");
	lines.push("    skill's name, description, and when_to_use at the start of every message,");
	lines.push("    so any edit your operator makes is live on your next turn. You can also");
	lines.push("    write your own skills by creating SKILL.md files at the same path; they");
	lines.push("    appear in the dashboard automatically.");
	lines.push("");
	lines.push(`- Memory files: ${memoryUrl}`);
	lines.push("    Arbitrary markdown files under /home/phantom/.claude/. Includes");
	lines.push("    CLAUDE.md (your top-level memory), rules/*.md (scoped rules), and");
	lines.push("    memory/*.md (anything your operator wants you to know permanently).");
	lines.push("    Edits are picked up on your next session start.");
	lines.push("");
	lines.push(`- Plugins:      ${pluginsUrl}`);
	lines.push("    Third-party extensions from the claude-plugins-official marketplace.");
	lines.push("    Your operator can browse, install, or uninstall plugins here with a");
	lines.push("    trust modal on every first install. After install, the plugin's");
	lines.push("    skills, commands, and MCP servers become part of your toolbelt on the");
	lines.push("    next message. Four plugins are pre-installed on fresh Phantom VMs:");
	lines.push("    linear (issue tracking), notion (workspace knowledge), slack (workspace");
	lines.push("    messages beyond your own threads), and claude-md-management (keeps your");
	lines.push("    CLAUDE.md memory tight). Every install and uninstall is audited.");
	lines.push("");
	lines.push("When your operator asks 'what can I customize', 'how do I edit your skills',");
	lines.push(`'show me the dashboard', or anything similar, point them at ${dashboardUrl}`);
	lines.push("and (if they want the current catalog) fire the show-my-tools skill.");
	lines.push("");
	lines.push("When your operator asks 'what plugins do you have', 'install a plugin for X',");
	lines.push("'show me the marketplace', or 'add a capability', point them at the plugins");
	lines.push("tab and (if they want the active set) fire the list-plugins skill.");
	lines.push("");
	lines.push("Other tabs (sessions, cost, scheduler, evolution, memory explorer, settings)");
	lines.push("are marked Coming Soon in the dashboard today and will light up in later PRs.");
	return lines;
}
