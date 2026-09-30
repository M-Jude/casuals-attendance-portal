import { useEffect, useState } from 'react';

// Installable-app plumbing: the service worker, the browser's "install"
// prompt, and online/offline state.

// The install prompt can fire before anyone is signed in, so it is caught
// here at start-up and handed to whichever screen offers "Install app".
let deferredPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

// Requests from the installed (home-screen) app are tagged so the audit
// log's device column can say so.
function tagApiRequests() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.startsWith('/api/') || !isStandalone()) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined));
    headers.set('X-Client-Mode', 'app');
    return nativeFetch(input, { ...init, headers });
  };
}

export function initPwa() {
  tagApiRequests();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // offered from the More menu instead of the browser's banner
    deferredPrompt = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });

  // Dev builds skip the worker so Vite's hot reload is never served stale.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// iPhones and iPads have no install prompt — people add the app from
// Safari's Share menu, so the More menu explains that instead.
export function isIos() {
  const ua = window.navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  return {
    canInstall: Boolean(deferredPrompt),
    showIosHint: !deferredPrompt && isIos() && !isStandalone(),
    async install() {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
      notify();
    }
  };
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
