// Thumbnail strip shown above the textarea when files are attached.
// Renders a horizontal scrollable row of attachment tiles.

import type { PendingAttachment } from "@/hooks/use-attachments";
import { AttachmentTile } from "./attachment-tile";

export function AttachmentStrip({
	files,
	onRemove,
}: {
	files: PendingAttachment[];
	onRemove: (id: string) => void;
}) {
	if (files.length === 0) return null;

	return (
		<div className="flex gap-2 overflow-x-auto px-2 pb-2" role="list" aria-label="Attached files">
			{files.map((file) => (
				<div key={file.id} role="listitem">
					<AttachmentTile attachment={file} onRemove={onRemove} />
				</div>
			))}
		</div>
	);
}
