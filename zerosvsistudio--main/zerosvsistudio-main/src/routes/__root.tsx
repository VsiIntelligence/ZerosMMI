import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="zx-system">
      <div>
        <h1>404</h1>
        <h2>This page isn't here</h2>
        <p>The page you're looking for doesn't exist or has moved.</p>
        <div className="zx-system__actions">
          <Link to="/" className="zx-btn zx-btn--primary zx-btn--lg">Back to Zeros</Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="zx-system">
      <div>
        <h2>This page didn't load</h2>
        <p>Something went wrong on our end. Try again, or head back home.</p>
        <div className="zx-system__actions">
          <button type="button" className="zx-btn zx-btn--primary zx-btn--lg" onClick={() => { router.invalidate(); reset(); }}>Try again</button>
          <a href="/" className="zx-btn zx-btn--secondary zx-btn--lg">Go home</a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Zeros — World's First MMI" },
      {
        name: "description",
        content:
          "Zeros is the world's first MMI (Multi-Modular Intelligence) by VsiStudio — built to crush complex tasks. Generate 3D models, songs, websites, images, videos, animations, and full conversations. Capabilities no single AI can match alone.",
      },
      { name: "author", content: "VsiStudio" },
      { name: "application-name", content: "Zeros" },
      { property: "og:site_name", content: "Zeros" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: "Zeros — World's First MMI" },
      {
        property: "og:description",
        content:
          "Zeros is the world's first MMI (Multi-Modular Intelligence) by VsiStudio — built to crush complex tasks. Generate 3D models, songs, websites, images, videos, animations, and full conversations.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Zeros — World's First MMI" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),

  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </QueryClientProvider>
  );
}
