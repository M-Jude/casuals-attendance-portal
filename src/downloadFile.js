// Triggers a browser download for an endpoint that requires the portal's
// Bearer token. A plain `window.open(url)` / `<a href>` navigation can't
// attach an Authorization header, so the API would just 401 — this fetches
// the file with the header attached, then hands the browser the bytes as a
// blob: URL.
export async function downloadAuthenticated(url, token, filenameFallback) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Download failed.');
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] || filenameFallback;

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
