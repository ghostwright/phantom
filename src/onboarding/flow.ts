import type { Database } from "bun:sqlite";
import { enrichOwner } from "../agent/research/enrich-owner.ts";
import type { OwnerResearchResult } from "../agent/research/types.ts";
import type { SlackTransport } from "../channels/slack-transport.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { type OwnerProfile, type SlackProfileClient, hasPersonalizationData, profileOwner } from "./profiler.ts";
import { isIntroSent, markIntroSent, markOnboardingStarted } from "./state.ts";

export type OnboardingTarget = { type: "channel"; channelId: string } | { type: "dm"; userId: string };

/** Result of an onboarding run. The caller uses both the OwnerProfile
 * (Slack-side personalization) and the OwnerResearchResult (Phase 12
 * public-source enrichment) to compose the system-prompt overlay. */
export type StartOnboardingResult = {
	profile: OwnerProfile | null;
	research: OwnerResearchResult | null;
	skipped: boolean;
};

function buildGenericIntro(phantomName: string, _role: RoleTemplate): string {
	return [
		`Hey there. I'm ${phantomName}, just got spun up on my own machine.`,
		"",
		"I can dig into just about anything: research, code, data, writing, building tools," +
			" automating workflows. I learn from every conversation and get better over time.",
		"",
		"What are you working on? I'll start there.",
	].join("\n");
}

function buildPersonalizedIntro(phantomName: string, _role: RoleTemplate, profile: OwnerProfile): string {
	const parts: string[] = [];

	if (profile.teamName) {
		parts.push(
			`Hey ${profile.name}. I'm ${phantomName}, just got spun up on my own machine in the ${profile.teamName} workspace.`,
		);
	} else {
		parts.push(`Hey ${profile.name}. I'm ${phantomName}, just got spun up on my own machine.`);
	}

	parts.push("");
	parts.push(
		"I can dig into just about anything: research, code, data, writing, building tools," +
			" automating workflows. I learn from every conversation and get better over time.",
	);
	parts.push("");
	parts.push("What are you working on right now? I'll start there.");

	return parts.join("\n");
}

/**
 * Append the Phase 12 "What I learned" research section to an intro
 * message. Returns the original message unchanged when research yielded
 * no bullets; we never fabricate, so an empty result means the section
 * does not render at all (architect invariant: don't fabricate).
 */
export function appendResearchSection(intro: string, research: OwnerResearchResult | null): string {
	if (!research || !research.bullets || research.bullets.length === 0) {
		return intro;
	}
	const bulletLines = research.bullets.map((b) => `  - ${b}`);
	return [intro, "", "What I learned about you so far:", ...bulletLines].join("\n");
}

export interface StartOnboardingOptions {
	/** PHANTOM_OWNER_EMAIL. Phase 12 research input. */
	ownerEmail?: string;
	/** PHANTOM_OWNER_NAME. Optional. */
	ownerName?: string;
	/** PHANTOM_OWNER_LINKEDIN_URL. Optional, future wizard step. */
	ownerLinkedinUrl?: string;
	/** When false, skip Phase 12 research entirely (operator escape
	 * hatch via PHANTOM_OWNER_RESEARCH_ENABLED=false). Defaults to true. */
	researchEnabled?: boolean;
	/** Inject a research function for tests. Defaults to enrichOwner. */
	enrichImpl?: typeof enrichOwner;
}

/**
 * Start the onboarding flow by profiling the owner and sending a
 * personalized DM. Falls back to generic intro if profiling fails or no
 * owner is configured. Phase 12: also runs the public-source research
 * subroutine and appends a "What I learned" section to the intro.
 *
 * Idempotency (Phase 12 fix for the LOW bug at phantom CLAUDE.md:284):
 * if the firstboot ledger already records intro_sent_at, the function
 * returns immediately with skipped=true. Both the research probe AND
 * the DM send are skipped, so a process restart never re-introduces
 * the agent.
 */
export async function startOnboarding(
	slack: SlackTransport,
	target: OnboardingTarget,
	phantomName: string,
	role: RoleTemplate,
	db: Database,
	slackClient?: SlackProfileClient,
	options: StartOnboardingOptions = {},
): Promise<StartOnboardingResult> {
	if (isIntroSent(db)) {
		console.log("[onboarding] firstboot ledger says intro_sent_at is set; skipping intro DM and research");
		return { profile: null, research: null, skipped: true };
	}

	markOnboardingStarted(db);

	// If we have a DM target and a slack client, profile the owner for personalization
	let profile: OwnerProfile | null = null;
	if (target.type === "dm" && slackClient) {
		try {
			profile = await profileOwner(slackClient, target.userId);
			console.log(`[onboarding] Profiled owner: ${profile.name}${profile.title ? ` (${profile.title})` : ""}`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[onboarding] Failed to profile owner: ${msg}. Using generic intro.`);
		}
	}

	// Phase 12 research subroutine. Time-bounded inside enrichOwner;
	// budget elapsed -> partial result -> we still send the DM. Anything
	// thrown by the research path is caught here so a transient network
	// failure cannot break onboarding for the owner.
	const research = await runResearch(options, profile);

	const baseIntro =
		profile !== null && hasPersonalizationData(profile)
			? buildPersonalizedIntro(phantomName, role, profile)
			: buildGenericIntro(phantomName, role);
	const intro = appendResearchSection(baseIntro, research);
	const hasUsefulProfile = profile !== null && hasPersonalizationData(profile);

	if (target.type === "dm") {
		await slack.sendDm(target.userId, intro);
		console.log(`[onboarding] Introduction sent as DM to user ${target.userId}`);
	} else {
		await slack.postToChannel(target.channelId, intro);
		console.log(`[onboarding] Introduction posted to channel ${target.channelId}`);
	}

	// Mark the intro as sent only AFTER the Slack call succeeds. If
	// sendDm or postToChannel throws, we want the next process start to
	// retry the DM, not skip it because of a stale ledger row.
	markIntroSent(db, research?.outcome ?? "disabled");

	return {
		profile: hasUsefulProfile ? profile : null,
		research,
		skipped: false,
	};
}

async function runResearch(
	options: StartOnboardingOptions,
	profile: OwnerProfile | null,
): Promise<OwnerResearchResult | null> {
	const enabled = options.researchEnabled !== false;
	const email = (options.ownerEmail ?? "").trim();
	if (!enabled || !email) {
		// No email -> nothing to research. We could still surface the
		// Slack profile but that is already in the personalized intro.
		return null;
	}

	const enrichFn = options.enrichImpl ?? enrichOwner;
	try {
		// Prefer the explicit PHANTOM_OWNER_NAME (operator-set); fall
		// back to the Slack profile's real_name when present so the
		// research path has something to work with even when phantomd
		// has not yet stamped PHANTOM_OWNER_NAME.
		const nameFromProfile = profile?.name && profile.name !== "there" ? profile.name : undefined;
		const name = options.ownerName?.trim() || nameFromProfile;
		return await enrichFn({ email, name, linkedinUrl: options.ownerLinkedinUrl?.trim() || undefined });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[onboarding] Phase 12 research subroutine threw: ${msg}. Continuing without bullets.`);
		return { bullets: null, sources: [], outcome: "error" };
	}
}
