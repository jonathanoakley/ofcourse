const DATA_DIR = Deno.env.get("DATA_DIR") || "./data";
const DATA_FILE = `${DATA_DIR}/routes.json`;

async function readRoutes(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Deno.readTextFile(DATA_FILE));
  } catch {
    return {};
  }
}

async function writeRoute(id: string, route: unknown): Promise<void> {
  await Deno.mkdir(DATA_DIR, { recursive: true });
  const routes = await readRoutes();
  routes[id] = route;
  await Deno.writeTextFile(DATA_FILE, JSON.stringify(routes));
}

async function readChecks(eventId: string): Promise<unknown[]> {
  try {
    return JSON.parse(await Deno.readTextFile(`${DATA_DIR}/checks_${eventId}.json`));
  } catch {
    return [];
  }
}

async function appendCheck(eventId: string, check: unknown): Promise<void> {
  await Deno.mkdir(DATA_DIR, { recursive: true });
  const checks = await readChecks(eventId);
  checks.push(check);
  await Deno.writeTextFile(`${DATA_DIR}/checks_${eventId}.json`, JSON.stringify(checks));
}

const html = await Deno.readTextFile("./index.html");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Deno.serve({ port: 80 }, async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (pathname === "/health") {
    return new Response("ok", { headers: { "Content-Type": "text/plain" } });
  }

  if (pathname === "/api/routes" && req.method === "GET") {
    const routes = await readRoutes();
    return Response.json(routes, {
      headers: { ...CORS, "Cache-Control": "no-store" },
    });
  }

  if (pathname.startsWith("/api/routes/") && req.method === "PUT") {
    const id = pathname.slice("/api/routes/".length);
    if (id && !id.includes("/") && !id.includes(".")) {
      const route = await req.json();
      await writeRoute(id, route);
      return Response.json({ ok: true }, { headers: CORS });
    }
  }

  if (pathname.startsWith("/api/checks/") && req.method === "GET") {
    const eventId = pathname.slice("/api/checks/".length);
    if (eventId && !eventId.includes("/") && !eventId.includes(".")) {
      const checks = await readChecks(eventId);
      return Response.json(checks, {
        headers: { ...CORS, "Cache-Control": "no-store" },
      });
    }
  }

  if (pathname.startsWith("/api/checks/") && req.method === "POST") {
    const eventId = pathname.slice("/api/checks/".length);
    if (eventId && !eventId.includes("/") && !eventId.includes(".")) {
      const check = await req.json();
      await appendCheck(eventId, check);
      return Response.json({ ok: true }, { headers: CORS });
    }
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
});
