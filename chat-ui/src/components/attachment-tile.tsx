// Individual attachment thumbnail tile.
// Shows image preview, document icon, or file icon with filename.

import { FileText, File as FileIcon, X, Loader2 } from "lucide-react";
import type { PendingAttachment } from "@/hooks/use-attachments";

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function AttachmentTile({
	attachment,
	onRemove,
}: {
	attachment: PendingAttachment;
	onRemove: (id: string) => void;
}) {
	const isImage = IMAGE_MIMES.has(attachment.file.type);
	const isPdf = attachment.file.type === "application/pdf";
	const isUploading = attachment.status === "uploading";

	return (
		<div className="group relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
			{isImage && attachment.previewUrl ? (
				<img
					src={attachment.previewUrl}
					alt={attachment.file.name}
					className="h-full w-full object-cover"
				/>
			) : isPdf ? (
				<div className="flex flex-col items-center gap-0.5">
					<FileText className="h-5 w-5 text-muted-foreground" />
					<span className="max-w-[56px] truncate text-[9px] text-muted-foreground">
						{attachment.file.name}
					</span>
				</div>
			) : (
				<div className="flex flex-col items-center gap-0.5">
					<FileIcon className="h-5 w-5 text-muted-foreground" />
					<span className="max-w-[56px] truncate text-[9px] text-muted-foreground">
						{attachment.file.name}
					</span>
				</div>
			)}

			{isUploading && (
				<div className="absolute inset-0 flex items-center justify-center bg-background/60">
					<Loader2 className="h-5 w-5 animate-spin text-primary" />
				</div>
			)}

			<button
				type="button"
				onClick={() => onRemove(attachment.id)}
				className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
				aria-label={`Remove ${attachment.file.name}`}
			>
				<X className="h-2.5 w-2.5" />
			</button>
		</div>
	);
}
