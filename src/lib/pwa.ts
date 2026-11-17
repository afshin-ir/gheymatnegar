import { Capacitor } from '@capacitor/core'

export type ServiceWorkerState = 'unsupported' | 'dev' | 'installing' | 'ready' | 'error'

export async function registerAppServiceWorker(onState?: (state: ServiceWorkerState) => void) {
  // Native assets are bundled in the APK and updated together with the app.
  if (Capacitor.isNativePlatform()) return null
  if (!('serviceWorker' in navigator)) {
    onState?.('unsupported')
    return null
  }

  if (!import.meta.env.PROD) {
    onState?.('dev')
    return null
  }

  try {
    onState?.('installing')
    const url = new URL('./sw.js', window.location.href)
    const registration = await navigator.serviceWorker.register(url.href, { scope: './' })
    await navigator.serviceWorker.ready
    onState?.('ready')
    return registration
  } catch (error) {
    console.error('Service worker registration failed', error)
    onState?.('error')
    return null
  }
}
