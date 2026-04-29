import { Link } from "react-router-dom";

export function NotFoundRoute() {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <h1 className="text-2xl font-semibold text-foreground">404</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Page not found.
      </p>
      <Link
        to="/"
        className="mt-4 text-sm text-primary underline underline-offset-2 hover:text-primary/80"
      >
        Back to chat
      </Link>
    </div>
  );
}
