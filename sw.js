// AI-Boltai service worker: shows push notifications and opens the right chat when tapped.
// Payloads come from the send-push Edge Function: { type, title, body, tag, url, callId?,
// repeat? } (repeat: a call ringing again because nobody answered yet).
// Nothing is cached here; the app always loads from the network.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const SAFARI = /Version\/[\d.]+.*Safari/.test(self.navigator.userAgent);
// Apple devices alert only for a notification with a new tag (they ignore "renotify"), so each
// ring round there gets its own tag; elsewhere the same tag replaces it and alerts again.
const APPLE =
  /iPhone|iPad|Macintosh/.test(self.navigator.userAgent) &&
  !/Chrome|CriOS|Firefox|FxiOS|Edg/.test(self.navigator.userAgent);

// Closes every notification of a call (its first ring and any rings again).
async function closeCall(callId) {
  for (const n of await self.registration.getNotifications()) {
    if (n.tag && n.tag.startsWith(`call-${callId}`)) n.close();
  }
}

// Open app windows report whether their live connection works (src/lib/live-status.ts), every
// 30 seconds. Only a connected window rings and shows messages by itself.
const live = new Map(); // window client id -> { ok, at }
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "live" && event.source && event.source.id) {
    live.set(event.source.id, { ok: data.ok === true, at: Date.now() });
  }
});
const isConnected = (client) => {
  const s = live.get(client.id);
  return !!s && s.ok && Date.now() - s.at < 90_000;
};

const VIBRATE = {
  call: [600, 300, 600, 300, 600, 300, 600, 300, 600],
  message: [200, 100, 200],
};

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let notice;
      try {
        notice = event.data ? event.data.json() : null;
      } catch {
        notice = null;
      }
      if (!notice || typeof notice.title !== "string") return;

      // While the app is open on screen and connected it shows messages and rings by itself.
      // (Open but disconnected, e.g. our server is blocked on this network: show the push.)
      // Safari, though, may withdraw permission when a push shows nothing, so there it's shown
      // silently and closed straight away.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const onScreen =
        notice.type !== "test" &&
        windows.some((w) => w.visibilityState === "visible" && isConnected(w));
      if (onScreen) {
        if (!SAFARI) return;
        await self.registration.showNotification(notice.title, { tag: notice.tag, silent: true });
        for (const n of await self.registration.getNotifications({ tag: notice.tag })) n.close();
        return;
      }

      const isCall = notice.type === "call";
      // A missed call replaces all of its ring notifications.
      if (notice.callId && !isCall) await closeCall(notice.callId);
      const tag = isCall && notice.repeat && APPLE ? `${notice.tag}-${notice.repeat}` : notice.tag;
      await self.registration.showNotification(notice.title, {
        body: notice.body,
        tag,
        renotify: notice.type === "message" || isCall,
        requireInteraction: isCall,
        // Browsers reject a vibration pattern on a silent notification.
        ...(notice.type === "missed"
          ? { silent: true }
          : { vibrate: isCall ? VIBRATE.call : VIBRATE.message }),
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        timestamp: Date.now(),
        data: { url: notice.url || "/app", type: notice.type, callId: notice.callId },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Answering from one ring notification clears the others of the same call.
  const callId = event.notification.data?.callId;
  if (callId) event.waitUntil(closeCall(callId));
  const url = new URL(event.notification.data?.url || "/app", self.location.origin).href;
  // A Telemost or Zoom call: open its meeting (send-push only sends their addresses here). On
  // Apple devices a Home Screen app would open the meeting inside itself and stay stuck on it
  // (no back button), so our join page opens instead; its button hands the link to Safari or
  // the Zoom / Telemost app. Elsewhere the meeting opens directly, in one tap.
  if (new URL(url).origin !== self.location.origin) {
    const target = APPLE ? `/join.html?u=${encodeURIComponent(url)}` : url;
    event.waitUntil(self.clients.openWindow(target));
    return;
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = windows.find((w) => w.url === url);
      if (same) return void (await same.focus());
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        // The app (re)loads the chat; an incoming call then shows its Accept/Decline card.
        if ("navigate" in open) await open.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
