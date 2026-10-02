const EXAM_CLIENT_MATCH = self.registration.scope;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const action = event.action || "open-exam";
  const data = event.notification.data || {};

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    let target = clients.find(client => client.url.startsWith(EXAM_CLIENT_MATCH)) || clients[0];

    if (target) {
      try { await target.focus(); } catch (_) {}
      target.postMessage({
        type: "exam-notification-action",
        action,
        data
      });
      return;
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow("./");
    }
  })());
});
