// Phantom chat Service Worker
// Scope: /chat/
// Handles offline caching for static assets and push notification display.
// Never intercepts /ui/* paths or SSE streams.

const VERSION = "0.1.0";
const SHELL_CACHE = "phantom-chat-shell-" + VERSION;

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
  var title = data.title || "Phantom";
  var options = {
    body: data.body || "",
    icon: "/chat/favicon.svg",
    badge: "/chat/favicon.svg",
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
});
