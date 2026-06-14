const DATA_DIR = Deno.env.get("DATA_DIR") || "./data";
const DATA_FILE = `${DATA_DIR}/routes.json`;
const DATA_KEY_RE = /^[a-zA-Z0-9_-]{1,80}$/;

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

async function readData(key: string): Promise<unknown> {
  try {
    return JSON.parse(await Deno.readTextFile(`${DATA_DIR}/data_${key}.json`));
  } catch {
    return null;
  }
}

async function writeData(key: string, data: unknown): Promise<void> {
  await Deno.mkdir(DATA_DIR, { recursive: true });
  await Deno.writeTextFile(`${DATA_DIR}/data_${key}.json`, JSON.stringify(data));
}

type Obj = Record<string, unknown>;

function mergeByTs(ex: Obj, inc: Obj, tsField: string): Obj {
  const out: Obj = { ...ex };
  for (const [k, v] of Object.entries(inc)) {
    const exTs = ((out[k] as Obj)?.[tsField] as string) || "";
    const incTs = ((v as Obj)?.[tsField] as string) || "";
    if (incTs >= exTs) out[k] = v;
  }
  return out;
}

function mergeData(key: string, existing: unknown, incoming: unknown): unknown {
  if (!existing || typeof existing !== "object") return incoming;
  if (!incoming || typeof incoming !== "object") return incoming;

  // Events list: merge array by ID
  if (key === "events") {
    if (!Array.isArray(existing) || !Array.isArray(incoming)) return incoming;
    const byId: Obj = {};
    for (const e of [...existing, ...incoming]) {
      if (e && typeof e === "object" && "id" in e) byId[(e as { id: string }).id] = e;
    }
    return Object.values(byId);
  }

  // Pins: union — never remove a pin a device has placed
  if (key.startsWith("pins_")) {
    return { ...(existing as Obj), ...(incoming as Obj) };
  }

  // Routes: merge by route ID, latest updatedAt wins
  if (key.startsWith("routes_")) {
    const out: Obj = { ...(existing as Obj) };
    for (const [id, r] of Object.entries(incoming as Obj)) {
      const exTs = ((out[id] as Obj)?.updatedAt as string) || "";
      const incTs = ((r as Obj)?.updatedAt as string) || "";
      if (incTs >= exTs) out[id] = r;
    }
    return out;
  }

  // State: field-level merge
  if (key.startsWith("state_")) {
    const ex = existing as Obj;
    const inc = incoming as Obj;

    // Union flags (once true, stays true)
    const completed = { ...(ex.completed as Obj || {}), ...(inc.completed as Obj || {}) };
    const reviewed = { ...(ex.reviewed as Obj || {}), ...(inc.reviewed as Obj || {}) };

    // Notes: latest noteMeta.ts wins per ref
    const mergedNotes: Obj = { ...(ex.notes as Obj || {}) };
    const mergedNoteMeta: Obj = { ...(ex.noteMeta as Obj || {}) };
    for (const ref of Object.keys(inc.notes as Obj || {})) {
      const exTs = ((ex.noteMeta as Obj)?.[ref] as Obj)?.ts as string || "";
      const incTs = ((inc.noteMeta as Obj)?.[ref] as Obj)?.ts as string || "";
      if (incTs >= exTs) {
        mergedNotes[ref] = (inc.notes as Obj)[ref];
        mergedNoteMeta[ref] = (inc.noteMeta as Obj)[ref];
      }
    }

    // cardEdits / cardEditSummary: latest _ts wins per ref
    const cardEdits = mergeByTs(ex.cardEdits as Obj || {}, inc.cardEdits as Obj || {}, "_ts");
    const cardEditSummary = mergeByTs(ex.cardEditSummary as Obj || {}, inc.cardEditSummary as Obj || {}, "_ts");

    // Tags: union per card ref
    const tags: Record<string, string[]> = { ...(ex.tags as Record<string, string[]> || {}) };
    for (const [ref, arr] of Object.entries(inc.tags as Record<string, string[]> || {})) {
      tags[ref] = [...new Set([...(tags[ref] || []), ...(arr || [])])];
    }

    // obstacleCapacity: merge by ref (union)
    const obstacleCapacity = { ...(ex.obstacleCapacity as Obj || {}), ...(inc.obstacleCapacity as Obj || {}) };

    // customCards: merge by ref
    const customCardsByRef: Obj = {};
    for (const c of [...(ex.customCards as unknown[] || []), ...(inc.customCards as unknown[] || [])]) {
      if (c && typeof c === "object" && "ref" in c) customCardsByRef[(c as { ref: string }).ref] = c;
    }

    // Audit: merge and deduplicate by ts+ref+action
    type AuditEntry = { ts: string; ref: string; action: string };
    const exAudit = (ex.audit || []) as AuditEntry[];
    const incAudit = (inc.audit || []) as AuditEntry[];
    const seen = new Set(exAudit.map((e) => `${e.ts}|${e.ref}|${e.action}`));
    const mergedAudit = [
      ...exAudit,
      ...incAudit.filter((e) => !seen.has(`${e.ts}|${e.ref}|${e.action}`)),
    ].sort((a, b) => (a.ts > b.ts ? 1 : -1));

    return {
      ...ex,
      ...inc,
      completed,
      reviewed,
      notes: mergedNotes,
      noteMeta: mergedNoteMeta,
      cardEdits,
      cardEditSummary,
      tags,
      obstacleCapacity,
      customCards: Object.values(customCardsByRef),
      audit: mergedAudit,
    };
  }

  // Default: incoming replaces existing
  return incoming;
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

  if (pathname.startsWith("/api/data/") && req.method === "GET") {
    const key = pathname.slice("/api/data/".length);
    if (DATA_KEY_RE.test(key)) {
      const data = await readData(key);
      return Response.json(data, { headers: { ...CORS, "Cache-Control": "no-store" } });
    }
  }

  if (pathname.startsWith("/api/data/") && req.method === "PUT") {
    const key = pathname.slice("/api/data/".length);
    if (DATA_KEY_RE.test(key)) {
      const incoming = await req.json();
      const existing = await readData(key);
      const data = existing !== null ? mergeData(key, existing, incoming) : incoming;
      await writeData(key, data);
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
