import { formatArtifactSize } from "@/lib/chat-artifacts";
import type { ChatArtifactView } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { Copy, ExternalLink, FileText } from "lucide-react";

export function ArtifactTray({ artifacts }: { artifacts: ChatArtifactView[] }) {
	if (artifacts.length === 0) return null;

	return (
		<div className="mt-3 space-y-2">
			<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Artifacts</div>
			<div className="grid gap-2">
				{artifacts.map((artifact) => (
					<ArtifactCard key={artifact.id} artifact={artifact} />
				))}
			</div>
		</div>
	);
}

function ArtifactCard({ artifact }: { artifact: ChatArtifactView }) {
	const size = formatArtifactSize(artifact.sizeBytes);
	return (
		<div className="flex flex-col gap-3 rounded border border-border bg-card px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex min-w-0 items-start gap-3">
				<div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
					<FileText className="h-4 w-4" />
				</div>
				<div className="min-w-0 space-y-1">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<span className="truncate text-sm font-medium text-foreground">{artifact.title}</span>
						<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
							Page
						</span>
						{size && <span className="text-xs text-muted-foreground">{size}</span>}
					</div>
					<div className="break-all font-mono text-xs text-muted-foreground">{artifact.path ?? artifact.url}</div>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<a
					href={artifact.url}
					target="_blank"
					rel="noopener noreferrer"
					className={cn(
						"inline-flex min-h-8 items-center gap-1.5 rounded border border-border px-2.5 text-xs font-medium text-foreground",
						"hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					)}
				>
					<ExternalLink className="h-3.5 w-3.5" />
					Open
				</a>
				<button
					type="button"
					onClick={() => void navigator.clipboard.writeText(artifact.url)}
					className={cn(
						"inline-flex min-h-8 items-center gap-1.5 rounded border border-border px-2.5 text-xs font-medium text-foreground",
						"hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					)}
				>
					<Copy className="h-3.5 w-3.5" />
					Copy URL
				</button>
			</div>
		</div>
	);
}
