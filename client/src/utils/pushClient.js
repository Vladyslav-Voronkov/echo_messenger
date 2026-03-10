/**
 * pushClient.js — Web Push subscription helper
 *
 * 1. Register the service worker (sw.js in /public)
 * 2. Request notification permission
 * 3. Subscribe to push via VAPID
 * 4. POST subscription to server
 */

let swRegistration = null;

/**
 * Register the service worker once. Returns the registration.
 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  if (swRegistration) return swRegistration;

  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('[push] Service worker registered:', swRegistration.scope);
    return swRegistration;
  } catch (err) {
    console.warn('[push] Service worker registration failed:', err);
    return null;
  }
}

/**
 * Subscribe the current device to push notifications for the given nickname.
 * Returns true if successful, false otherwise.
 */
export async function subscribeToPush(nickname) {
  if (!('PushManager' in window)) {
    console.warn('[push] PushManager not supported');
    return false;
  }

  // Request notification permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    console.log('[push] Notification permission denied');
    return false;
  }

  const reg = await registerServiceWorker();
  if (!reg) return false;

  try {
    // Get VAPID public key from server
    const res = await fetch('/push/vapid-public-key');
    if (!res.ok) return false;
    const { publicKey } = await res.json();
    if (!publicKey) return false;

    // Check for existing subscription
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Re-register existing sub in case server lost it
      await sendSubscriptionToServer(nickname, sub);
      return true;
    }

    // Create new subscription
    sub = await reg.pushManager.subscribe({
      userVisibleOnly:       true,
      applicationServerKey:  urlBase64ToUint8Array(publicKey),
    });

    await sendSubscriptionToServer(nickname, sub);
    console.log('[push] Subscribed:', sub.endpoint.slice(0, 40) + '...');
    return true;
  } catch (err) {
    console.warn('[push] Subscribe failed:', err);
    return false;
  }
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush(nickname) {
  const reg = swRegistration || await navigator.serviceWorker.getRegistration?.();
  if (!reg) return;

  try {
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;

    await fetch('/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: nickname, endpoint: sub.endpoint }),
    });

    await sub.unsubscribe();
    console.log('[push] Unsubscribed');
  } catch (err) {
    console.warn('[push] Unsubscribe failed:', err);
  }
}

async function sendSubscriptionToServer(nickname, subscription) {
  const res = await fetch('/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nick:         nickname,
      subscription: subscription.toJSON(),
    }),
  });
  if (!res.ok) console.warn('[push] Failed to register subscription on server');
}

/** Convert base64 URL-encoded VAPID key to Uint8Array */
function urlBase64ToUint8Array(base64String) {
  const padding  = '='.repeat((4 - base64String.length % 4) % 4);
  const base64   = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData  = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}
