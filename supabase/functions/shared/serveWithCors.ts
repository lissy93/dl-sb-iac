// File: ./shared/serveWithCors.ts
import { serve as stdServe } from "https://deno.land/std@0.168.0/http/server.ts";
import { Logger } from "./logger.ts";

const logger = new Logger("http-serve");

const DEFAULT_CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/* Merge CORS & custom headers */
function addCorsHeaders(init: ResponseInit = {}): ResponseInit {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(DEFAULT_CORS)) headers.set(k, v);
  return { ...init, headers };
}

/* Re-emit a response with CORS headers applied */
function withCors(res: Response): Response {
  return new Response(res.body, addCorsHeaders({
    status: res.status,
    headers: res.headers,
  }));
}

/* Drop-in replacement for `serve` with built-in CORS & error handling */
export function serve(
  handler: (req: Request) => Promise<Response>,
  allowedMethods: string[] = ["POST", "OPTIONS"],
) {
  stdServe(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, addCorsHeaders({ status: 204 }));
    }

    // Handle not allowed HTTP methods
    if (!allowedMethods.includes(req.method)) {
      return new Response(
        JSON.stringify({
          error: `Sorry, ${req.method} method are not allowed here 🫷`,
        }),
        addCorsHeaders({ status: 405 }),
      );
    }

    try {
      return withCors(await handler(req));
    } catch (err: unknown) {
      // Handlers signal client errors by throwing a Response, so honour it
      if (err instanceof Response) return withCors(err);

      logger.error(
        `Uncaught error while serving: ${
          (err as Error)?.message || err || "mystery error"
        }`,
      );
      return new Response(
        JSON.stringify({ error: "Internal Server Error 💀" }),
        addCorsHeaders({ status: 500 }),
      );
    }
  });
}
