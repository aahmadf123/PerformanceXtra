import { onRequest as handleApiRequest } from "./functions/api/[[route]].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return handleApiRequest({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  }
};