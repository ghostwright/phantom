// Clipboard paste handler for image attachments.
// Listens for paste events and extracts image files.

import { useEffect } from "react";

export function usePaste(
	addFiles: (files: File[]) => void,
	elementRef?: React.RefObject<HTMLElement | null>,
): void {
	useEffect(() => {
		const target = elementRef?.current ?? document;

		const onPaste = (e: Event): void => {
			const event = e as ClipboardEvent;
			const items = event.clipboardData?.items;
			if (!items) return;

			const imageItems = Array.from(items).filter((i) => i.type.startsWith("image/"));
			if (imageItems.length === 0) return;

			event.preventDefault();

			const files = imageItems
				.map((i) => i.getAsFile())
				.filter((f): f is File => f !== null)
				.map((f) => renameForPaste(f));

			if (files.length > 0) addFiles(files);
		};

		target.addEventListener("paste", onPaste);
		return () => target.removeEventListener("paste", onPaste);
	}, [addFiles, elementRef]);
}

function renameForPaste(file: File): File {
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
	return new File([file], `paste-${ts}.${ext}`, { type: file.type });
}
