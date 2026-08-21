import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { Monitor } from "../supabase/functions/shared/monitor.ts";

interface Hit {
  path: string;
  method: string;
  begin: number;
  end: number;
}

/** Runs a job against a stub healthchecks endpoint, recording each ping's in-flight window */
async function record(
  run: (monitor: Monitor) => Promise<void>,
  startDelayMs = 0,
): Promise<Hit[]> {
  const hits: Hit[] = [];
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      // Model the DNS/TLS cost the first request to healthchecks.io pays
      if (new URL(req.url).pathname.endsWith("/start") && startDelayMs) {
        await new Promise((r) => setTimeout(r, startDelayMs));
      }
      return new Response("OK");
    },
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const begin = performance.now();
    const res = await realFetch(input, init);
    hits.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      begin,
      end: performance.now(),
    });
    return res;
  };

  try {
    const port = (server.addr as Deno.NetAddr).port;
    await run(new Monitor("cleanup-monitor-data", {
      healthcheckUrl: `http://localhost:${port}/ping`,
    }));
  } finally {
    globalThis.fetch = realFetch;
    ac.abort();
    await server.finished;
  }
  return hits;
}

const cronReq = () =>
  new Request("http://job", { headers: { "X-Cron-Run": "true" } });

Deno.test("instant job pings start before success, spaced apart", async () => {
  const hits = await record(async (m) => {
    await m.start(cronReq());
    await m.success("done");
  });

  assertEquals(hits.length, 2);
  assert(hits[0].path.endsWith("/start"), "start must be sent first");
  assertEquals(hits[1].path.endsWith("/start"), false);
  assert(
    hits[1].begin - hits[0].end >= 100,
    `pings must be >=100ms apart, got ${hits[1].begin - hits[0].end}ms`,
  );
});

Deno.test("a slow start ping still completes before success is sent", async () => {
  const hits = await record(async (m) => {
    await m.start(cronReq());
    await m.success("done");
  }, 300);

  assert(
    hits[1].begin >= hits[0].end,
    "pings must never be in flight at the same time",
  );
});

Deno.test("failing job pings start before fail", async () => {
  const hits = await record(async (m) => {
    await m.start(cronReq());
    await m.fail(new Error("boom"));
  });

  assertEquals(hits.length, 2);
  assert(hits[0].path.endsWith("/start"));
  assert(hits[1].path.endsWith("/fail"));
  assert(hits[1].begin >= hits[0].end);
});

Deno.test("non-cron runs are not reported", async () => {
  const hits = await record(async (m) => {
    await m.start(new Request("http://job"));
    await m.success("manual");
  });

  assertEquals(hits.length, 0);
});

Deno.test("a run stays reportable after an earlier non-cron run", async () => {
  const hits = await record(async (m) => {
    await m.start(new Request("http://job"));
    await m.success("manual");
    await m.start(cronReq());
    await m.success("cron");
  });

  assertEquals(hits.length, 2);
  assert(hits[0].path.endsWith("/start"));
});
