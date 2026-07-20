import { onRequest as handleApiRequest, serveMedia } from "./functions/api/[[route]].js";

function withSecurityHeaders(request, response) {
  const headers = new Headers(response.headers);
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' https://challenges.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: https:",
        "connect-src 'self' https://challenges.cloudflare.com",
        "frame-src 'self' https:",
        "frame-ancestors 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join("; ")
    );
  }
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!headers.has("X-Content-Type-Options")) headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "SAMEORIGIN");
  if (!headers.has("Permissions-Policy")) headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (new URL(request.url).protocol === "https:" && !headers.has("Strict-Transport-Security")) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return withSecurityHeaders(request, await handleApiRequest({ request, env, ctx }));
    }

    // CMS media library objects (R2). Keys are content-addressed by a random id, so
    // responses are cached immutably; repeat views come from the browser/edge cache.
    if (url.pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
      return withSecurityHeaders(request, await serveMedia(request, url, env));
    }

    return withSecurityHeaders(request, await env.ASSETS.fetch(request));
  }
};