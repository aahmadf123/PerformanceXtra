import { onRequest as handleApiRequest, serveMedia } from "./functions/api/[[route]].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return handleApiRequest({ request, env, ctx });
    }

    // CMS media library objects (R2). Keys are content-addressed by a random id, so
    // responses are cached immutably; repeat views come from the browser/edge cache.
    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      return serveMedia(url, env);
    }

    return env.ASSETS.fetch(request);
  }
};