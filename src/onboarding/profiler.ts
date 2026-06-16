export type OwnerProfile = {
	name: string;
	title: string | null;
	timezone: string | null;
	status: string | null;
	isAdmin: boolean;
	isOwner: boolean;
	teamName: string | null;
	channels: string[];
};

type UserInfoResult = {
	user?: {
		real_name?: string;
		name?: string;
		tz_label?: string;
		is_admin?: boolean;
		is_owner?: boolean;
		profile?: {
			title?: string;
			status_text?: string;
		};
	};
};

type TeamInfoResult = {
	team?: { name?: string };
};

type ConversationsResult = {
	channels?: Array<{ name?: string }>;
};

export type SlackProfileClient = {
	users: {
		info: (args: { user: string }) => Promise<UserInfoResult>;
		conversations: (args: {
			user: string;
			types: string;
			exclude_archived: boolean;
			limit: number;
		}) => Promise<ConversationsResult>;
	};
	team: {
		info: () => Promise<TeamInfoResult>;
	};
};

/**
 * Fetch the owner's Slack profile, workspace name, and channel memberships.
 * All API calls are best-effort - failures degrade gracefully to null fields.
 */
export async function profileOwner(client: SlackProfileClient, ownerUserId: string): Promise<OwnerProfile> {
	const logWarn = (api: string) => (err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[onboarding] Slack ${api} failed for ${ownerUserId}: ${msg}`);
		return null;
	};
	const [userResult, teamResult, channelsResult] = await Promise.all([
		client.users.info({ user: ownerUserId }).catch(logWarn("users.info")),
		client.team.info().catch(logWarn("team.info")),
		client.users
			.conversations({
				user: ownerUserId,
				types: "public_channel",
				exclude_archived: true,
				limit: 100,
			})
			.catch(logWarn("users.conversations")),
	]);

	const user = userResult?.user;
	const profile = user?.profile;

	return {
		name: user?.real_name || user?.name || "there",
		title: profile?.title || null,
		timezone: user?.tz_label || null,
		status: profile?.status_text || null,
		isAdmin: user?.is_admin ?? false,
		isOwner: user?.is_owner ?? false,
		teamName: teamResult?.team?.name || null,
		channels: channelsResult?.channels?.map((c) => c.name).filter((n): n is string => !!n) || [],
	};
}

/** True when the profile has enough data for a personalized intro. */
export function hasPersonalizationData(profile: OwnerProfile): boolean {
	return profile.name !== "there" || profile.title !== null || profile.channels.length > 0;
}
