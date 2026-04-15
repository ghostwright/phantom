// Drag and drop handler for file attachments.
// Manages drag state and extracts files on drop.

import { useCallback, useEffect, useRef, useState } from "react";

export function useDragDrop(addFiles: (files: File[]) => void): {
	isDragging: boolean;
	dropRef: React.RefObject<HTMLDivElement | null>;
} {
	const [isDragging, setIsDragging] = useState(false);
	const dropRef = useRef<HTMLDivElement | null>(null);
	const dragCounter = useRef(0);

	const onDragEnter = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current++;
		if (e.dataTransfer?.types.includes("Files")) {
			setIsDragging(true);
		}
	}, []);

	const onDragOver = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
	}, []);

	const onDragLeave = useCallback((e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter.current--;
		if (dragCounter.current <= 0) {
			dragCounter.current = 0;
			setIsDragging(false);
		}
	}, []);

	const onDrop = useCallback(
		(e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			dragCounter.current = 0;
			setIsDragging(false);

			const dt = e.dataTransfer;
			if (!dt?.files.length) return;

			const files = Array.from(dt.files);
			addFiles(files);
		},
		[addFiles],
	);

	useEffect(() => {
		const el = dropRef.current;
		if (!el) return;

		el.addEventListener("dragenter", onDragEnter);
		el.addEventListener("dragover", onDragOver);
		el.addEventListener("dragleave", onDragLeave);
		el.addEventListener("drop", onDrop);

		return () => {
			el.removeEventListener("dragenter", onDragEnter);
			el.removeEventListener("dragover", onDragOver);
			el.removeEventListener("dragleave", onDragLeave);
			el.removeEventListener("drop", onDrop);
		};
	}, [onDragEnter, onDragOver, onDragLeave, onDrop]);

	return { isDragging, dropRef };
}
