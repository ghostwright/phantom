// Phantom chat Service Worker
// Scope: /chat/
// Handles offline caching for static assets and push notification display.
// Never intercepts /ui/* paths or SSE streams.

const VERSION = "0.1.0";
const SHELL_CACHE = "phantom-chat-shell-" + VERSION;

// Agent name posted by the client on every AppShell mount. Used as the
// fallback notification title when the push payload omits one. If nothing
// has been posted yet (push lands before first AppShell mount), we fall
// back to a neutral "Message" literal rather than echoing data.body,
// which would render title and body as the same string.
var agentName = "";

// Avatar URL posted by the client. Null or empty means "use favicon.svg".
// Falls through /chat/icon which is the PWA-scope-friendly mirror of
// /ui/avatar; the fetch still works if the scope is installed as a PWA.
var avatarUrl = "";

self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k.startsWith("phantom-chat-") && k !== SHELL_CACHE;
            })
            .map(function (k) {
              return caches.delete(k);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  // Never intercept requests outside chat scope
  if (!url.pathname.startsWith("/chat/")) return;

  // Never intercept the SW script itself
  if (url.pathname === "/chat/sw.js") return;

  // Never intercept SSE stream
  if (url.pathname === "/chat/stream") return;

  // API calls: let the browser handle normally (no SW interception)
  if (
    url.pathname.startsWith("/chat/push/") ||
    url.pathname === "/chat/bootstrap" ||
    url.pathname === "/chat/sessions" ||
    url.pathname.startsWith("/chat/sessions/") ||
    url.pathname.startsWith("/chat/events/") ||
    url.pathname === "/chat/focus"
  ) {
    return;
  }

  // Static assets: cache-first with background revalidation
  if (
    url.pathname.startsWith("/chat/assets/") ||
    url.pathname.startsWith("/chat/fonts/")
  ) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        if (cached) {
          fetch(event.request)
            .then(function (res) {
              if (res.ok) {
                caches.open(SHELL_CACHE).then(function (c) {
                  c.put(event.request, res);
                });
              }
            })
            .catch(function () {});
          return cached;
        }
        return fetch(event.request).then(function (res) {
          if (res.ok && res.type === "basic") {
            var clone = res.clone();
            caches.open(SHELL_CACHE).then(function (c) {
              c.put(event.request, clone);
            });
          }
          return res;
        });
      }),
    );
    return;
  }
});

self.addEventListener("push", function (event) {
  var data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }
  // Fallback order: payload title, posted agent name, neutral "Message".
  // Using data.body here caused title=body duplication when the client
  // had not yet posted the agent name (push landed before first mount).
  var title = data.title || agentName || "Message";
  var icon = avatarUrl || "/chat/icon";
  var options = {
    body: data.body || "",
    icon: icon,
    badge: icon,
    tag: data.tag,
    data: data.data || {},
    requireInteraction: data.requireInteraction || false,
    silent: data.silent || false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "/chat/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientsList) {
        for (var i = 0; i < clientsList.length; i++) {
          var client = clientsList[i];
          if (
            client.url.startsWith(self.location.origin) &&
            "focus" in client
          ) {
            client.focus();
            client.postMessage({
              type: "notification-click",
              url: target,
              data: event.notification.data,
            });
            return;
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data && event.data.type === "SET_AGENT_NAME" && typeof event.data.agentName === "string") {
    agentName = event.data.agentName;
  }
  if (event.data && event.data.type === "SET_AVATAR_URL") {
    // Null / empty string means "no avatar; fall back to /chat/icon (which
    // 404s if no avatar is uploaded) and then the SVG default".
    avatarUrl = typeof event.data.url === "string" ? event.data.url : "";
  }
});
