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

const html = await Deno.readTextFile("./index.html");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
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

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
});
