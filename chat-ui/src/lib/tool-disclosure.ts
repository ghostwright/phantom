import type { ChatToolStateValue } from "./chat-types";

export type ToolDisclosureState = {
	isOpen: boolean;
	lastToolState: ChatToolStateValue;
	userInteracted: boolean;
};

function shouldAutoOpenToolState(state: ChatToolStateValue): boolean {
	return state === "error" || state === "blocked";
}

function shouldAutoCloseToolState(state: ChatToolStateValue): boolean {
	return state === "result" || state === "aborted";
}

export function initialToolDisclosureState(toolState: ChatToolStateValue): ToolDisclosureState {
	return {
		isOpen: shouldAutoOpenToolState(toolState),
		lastToolState: toolState,
		userInteracted: false,
	};
}

export function toggleToolDisclosure(state: ToolDisclosureState): ToolDisclosureState {
	return {
		...state,
		isOpen: !state.isOpen,
		userInteracted: true,
	};
}

export function reconcileToolDisclosureState(
	state: ToolDisclosureState,
	nextToolState: ChatToolStateValue,
): ToolDisclosureState {
	if (state.lastToolState === nextToolState) {
		return state;
	}

	if (state.userInteracted) {
		return {
			...state,
			lastToolState: nextToolState,
		};
	}

	if (shouldAutoOpenToolState(nextToolState)) {
		return {
			isOpen: true,
			lastToolState: nextToolState,
			userInteracted: false,
		};
	}

	if (shouldAutoCloseToolState(nextToolState)) {
		return {
			isOpen: false,
			lastToolState: nextToolState,
			userInteracted: false,
		};
	}

	return {
		...state,
		lastToolState: nextToolState,
	};
}
