// Full-bleed drop overlay shown when dragging files over the chat area.
// Renders a centered message with indigo border animation.

import { Upload } from "lucide-react";

export function DropOverlay({ visible }: { visible: boolean }) {
	if (!visible) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
			aria-hidden="true"
		>
			<div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/50 bg-card p-12 shadow-lg">
				<Upload className="h-10 w-10 text-primary" />
				<p className="text-lg font-medium text-foreground">Drop files here</p>
				<p className="text-sm text-muted-foreground">
					Images, PDFs, and text files are supported
				</p>
			</div>
		</div>
	);
}
