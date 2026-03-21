/**
 * nativePush.js — Capacitor native push notifications (iOS/Android)
 * Falls back gracefully in browser.
 */

function isNative() {
  return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
}

let _pushPlugin = null;

async function getPushPlugin() {
  if (_pushPlugin) return _pushPlugin;
  if (!isNative()) return null;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    _pushPlugin = PushNotifications;
    return _pushPlugin;
  } catch {
    return null;
  }
}

/**
 * Register for native push notifications and send token to server.
 * Only runs when inside Capacitor (native iOS/Android).
 */
export async function registerNativePush(nickname) {
  const Push = await getPushPlugin();
  if (!Push) return false;

  // Request permission
  const result = await Push.requestPermissions();
  if (result.receive !== 'granted') {
    console.log('[nativePush] Permission denied');
    return false;
  }

  // Listen for registration token (APNs device token)
  Push.addListener('registration', async (token) => {
    console.log('[nativePush] Device token:', token.value.slice(0, 12) + '...');
    try {
      await fetch('https://echo-private.com/push/native-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: nickname, token: token.value, platform: 'apns' }),
      });
    } catch (e) {
      console.warn('[nativePush] Failed to register token:', e);
    }
  });

  Push.addListener('registrationError', (err) => {
    console.warn('[nativePush] Registration error:', err);
  });

  // Handle foreground notifications
  Push.addListener('pushNotificationReceived', (notification) => {
    console.log('[nativePush] Foreground notification:', notification.title);
  });

  await Push.register();
  return true;
}

export function isRunningNative() {
  return isNative();
}
