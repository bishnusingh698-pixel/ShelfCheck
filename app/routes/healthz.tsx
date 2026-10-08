import { db } from "../db.server.js";

/**
 * `GET /healthz`: 200 with DB reachability; no secrets, no version details
 * beyond what is needed (spec <api> + <file_layout>). Also the readiness
 * probe for the Playwright webServer.
 */
export async function loader(): Promise<Response> {
  const headers = { "content-type": "application/json" };
  try {
    await db.$queryRaw`SELECT 1`;
    return new Response(JSON.stringify({ db: "ok" }), { headers });
  } catch {
    return new Response(JSON.stringify({ db: "unavailable" }), { status: 503, headers });
  }
}

