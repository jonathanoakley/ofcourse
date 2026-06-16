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

// Merge two arrays of objects keyed by `keyField`, keeping whichever side's entry has the
// later modification timestamp (modTsField, falling back to fallbackField). Entries are
// never dropped — a deletion must be represented as a `deleted:true` flag with a fresh
// timestamp, otherwise a stale device re-pushing its old copy resurrects the deleted item.
function mergeByKeyTs(
  ex: unknown[],
  inc: unknown[],
  keyField: string,
  modTsField: string,
  fallbackField: string,
): unknown[] {
  const byKey: Obj = {};
  for (const e of [...(ex || []), ...(inc || [])]) {
    if (!e || typeof e !== "object" || !(keyField in e)) continue;
    const obj = e as Obj;
    const key = obj[keyField] as string;
    const ts = (obj[modTsField] as string) || (obj[fallbackField] as string) || "";
    const cur = byKey[key] as Obj | undefined;
    const curTs = cur ? ((cur[modTsField] as string) || (cur[fallbackField] as string) || "") : "";
    if (!cur || ts >= curTs) byKey[key] = obj;
  }
  return Object.values(byKey);
}

// Last-modified-per-key timestamp maps (e.g. tagsMeta) — the value is the ISO ts itself.
function mergeTsMap(ex: Obj, inc: Obj): Obj {
  const out: Obj = { ...ex };
  for (const [k, v] of Object.entries(inc)) {
    const exTs = (out[k] as string) || "";
    const incTs = (v as string) || "";
    if (incTs >= exTs) out[k] = v;
  }
  return out;
}

// Merge two ref-keyed data objects using sibling *Meta timestamp maps to decide which side's
// whole value wins per ref. Falls back to preferring incoming when neither side has recorded
// a timestamp for that ref (legacy data written before *Meta existed).
function mergeMetaKeyed(exData: Obj, incData: Obj, exMeta: Obj, incMeta: Obj): Obj {
  const data: Obj = {};
  const keys = new Set([...Object.keys(exData || {}), ...Object.keys(incData || {})]);
  for (const k of keys) {
    const exTs = (exMeta?.[k] as string) || "";
    const incTs = (incMeta?.[k] as string) || "";
    if (!exTs && !incTs) data[k] = (k in (incData || {})) ? incData[k] : exData[k];
    else if (incTs >= exTs) data[k] = incData[k];
    else data[k] = exData[k];
  }
  return data;
}

type User = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  name: string;
  roleGroup: "cruk_staff" | "cruk_freelancer" | "volunteer";
  active: boolean;
  createdAt: string;
};
type Session = { userId: string; createdAt: string; expiresAt: string };

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — field tool, avoid re-login friction

async function readUsers(): Promise<User[]> {
  return (await readData("users")) as User[] || [];
}
async function writeUsers(users: User[]): Promise<void> {
  await writeData("users", users);
}
async function readSessions(): Promise<Record<string, Session>> {
  return (await readData("sessions")) as Record<string, Session> || {};
}
async function writeSessions(sessions: Record<string, Session>): Promise<void> {
  await writeData("sessions", sessions);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(byteLen: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLen)).buffer);
}

async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltHex || randomHex(16);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return { hash: toHex(bits), salt };
}

function publicUser(u: User): Omit<User, "passwordHash" | "salt"> {
  const { passwordHash: _ph, salt: _s, ...rest } = u;
  return rest;
}

async function getSessionUser(req: Request): Promise<User | null> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const sessions = await readSessions();
  const session = sessions[token];
  if (!session || session.expiresAt < new Date().toISOString()) return null;
  const users = await readUsers();
  return users.find((u) => u.id === session.userId) || null;
}

async function requireStaff(req: Request): Promise<User | null> {
  const user = await getSessionUser(req);
  if (!user || !user.active || user.roleGroup !== "cruk_staff") return null;
  return user;
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

    // Tags: whole list per ref, freshest tagsMeta[ref] wins (lets deletions stick)
    const tagsMeta = mergeTsMap(ex.tagsMeta as Obj || {}, inc.tagsMeta as Obj || {});
    const tags = mergeMetaKeyed(
      ex.tags as Obj || {}, inc.tags as Obj || {},
      ex.tagsMeta as Obj || {}, inc.tagsMeta as Obj || {},
    );

    // obstacleCapacity: whole zones list per ref, freshest obstacleCapacityMeta[ref] wins
    const obstacleCapacityMeta = mergeTsMap(ex.obstacleCapacityMeta as Obj || {}, inc.obstacleCapacityMeta as Obj || {});
    const obstacleCapacity = mergeMetaKeyed(
      ex.obstacleCapacity as Obj || {}, inc.obstacleCapacity as Obj || {},
      ex.obstacleCapacityMeta as Obj || {}, inc.obstacleCapacityMeta as Obj || {},
    );

    // customCards: merge by ref, latest _ts (fallback createdAt) wins — deletions are a
    // deleted:true flag with a fresh _ts, not removal from the array.
    const customCards = mergeByKeyTs(
      ex.customCards as unknown[] || [], inc.customCards as unknown[] || [],
      "ref", "_modTs", "createdAt",
    );

    // Audit: merge and deduplicate by ts+ref+action — append-only, never tombstoned.
    type AuditEntry = { ts: string; ref: string; action: string };
    const exAudit = (ex.audit || []) as AuditEntry[];
    const incAudit = (inc.audit || []) as AuditEntry[];
    const seen = new Set(exAudit.map((e) => `${e.ts}|${e.ref}|${e.action}`));
    const mergedAudit = [
      ...exAudit,
      ...incAudit.filter((e) => !seen.has(`${e.ts}|${e.ref}|${e.action}`)),
    ].sort((a, b) => (a.ts > b.ts ? 1 : -1));

    // ecConfig: last-write-wins per field (shallow merge)
    const ecConfig = { ...(ex.ecConfig as Obj || {}), ...(inc.ecConfig as Obj || {}) };

    // controlLogs: merge by id, latest _ts (fallback ts) wins — thread deletes are a
    // deleted:true flag with a fresh _ts, not removal from the array.
    type ControlLog = { id: string; ts: string };
    const controlLogs = (mergeByKeyTs(
      ex.controlLogs as unknown[] || [], inc.controlLogs as unknown[] || [],
      "id", "_modTs", "ts",
    ) as ControlLog[]).sort((a, b) => (a.ts > b.ts ? 1 : -1));

    // marshalBoard: per-position, per-slot merge keyed by slot id, latest statusTs wins.
    // Slot removal is a deleted:true flag with a fresh statusTs, not removal from the array.
    const exBoard = (ex.marshalBoard as Obj) || {};
    const incBoard = (inc.marshalBoard as Obj) || {};
    const marshalBoard: Obj = {};
    for (const code of new Set([...Object.keys(exBoard), ...Object.keys(incBoard)])) {
      const exSlots = ((exBoard[code] as Obj)?.slots as unknown[]) || [];
      const incSlots = ((incBoard[code] as Obj)?.slots as unknown[]) || [];
      marshalBoard[code] = { slots: mergeByKeyTs(exSlots, incSlots, "id", "statusTs", "statusTs") };
    }

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
      tagsMeta,
      obstacleCapacity,
      obstacleCapacityMeta,
      customCards,
      audit: mergedAudit,
      controlLogs,
      ecConfig,
      marshalBoard,
    };
  }

  // Default: incoming replaces existing
  return incoming;
}

const html = await Deno.readTextFile("./index.html");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

Deno.serve({ port: 80 }, async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (pathname === "/health") {
    return new Response("ok", { headers: { "Content-Type": "text/plain" } });
  }

  if (pathname === "/api/auth/bootstrap" && req.method === "GET") {
    const users = await readUsers();
    return Response.json({ empty: users.length === 0 }, { headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  if (pathname === "/api/auth/register" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Obj | null;
    const username = ((body?.username as string) || "").trim().toLowerCase();
    const password = (body?.password as string) || "";
    const name = ((body?.name as string) || "").trim();
    let roleGroup = (body?.roleGroup as string) || "volunteer";
    if (!username || !password || !name) {
      return Response.json({ error: "name, username and password are required" }, { status: 400, headers: CORS });
    }
    const users = await readUsers();
    const isBootstrap = users.length === 0;
    if (!isBootstrap) {
      const staff = await requireStaff(req);
      if (!staff) return Response.json({ error: "Staff login required" }, { status: 403, headers: CORS });
    } else {
      roleGroup = "cruk_staff"; // first account always becomes Staff, prevents lockout
    }
    if (!["cruk_staff", "cruk_freelancer", "volunteer"].includes(roleGroup)) roleGroup = "volunteer";
    if (users.some((u) => u.username === username)) {
      return Response.json({ error: "Username already taken" }, { status: 409, headers: CORS });
    }
    const { hash, salt } = await hashPassword(password);
    const user: User = {
      id: randomHex(8), username, passwordHash: hash, salt, name,
      roleGroup: roleGroup as User["roleGroup"], active: true, createdAt: new Date().toISOString(),
    };
    users.push(user);
    await writeUsers(users);
    return Response.json({ user: publicUser(user) }, { headers: CORS });
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const body = await req.json().catch(() => null) as Obj | null;
    const username = ((body?.username as string) || "").trim().toLowerCase();
    const password = (body?.password as string) || "";
    const users = await readUsers();
    const user = users.find((u) => u.username === username);
    if (!user || !user.active) {
      return Response.json({ error: "Invalid username or password" }, { status: 401, headers: CORS });
    }
    const { hash } = await hashPassword(password, user.salt);
    if (hash !== user.passwordHash) {
      return Response.json({ error: "Invalid username or password" }, { status: 401, headers: CORS });
    }
    const token = randomHex(32);
    const sessions = await readSessions();
    sessions[token] = {
      userId: user.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    };
    await writeSessions(sessions);
    return Response.json({ token, user: publicUser(user) }, { headers: CORS });
  }

  if (pathname === "/api/auth/me" && req.method === "GET") {
    const user = await getSessionUser(req);
    if (!user || !user.active) return Response.json({ error: "Invalid session" }, { status: 401, headers: CORS });
    return Response.json({ user: publicUser(user) }, { headers: CORS });
  }

  if (pathname === "/api/auth/users" && req.method === "GET") {
    const staff = await requireStaff(req);
    if (!staff) return Response.json({ error: "Staff login required" }, { status: 403, headers: CORS });
    const users = await readUsers();
    return Response.json({ users: users.map(publicUser) }, { headers: { ...CORS, "Cache-Control": "no-store" } });
  }

  if (pathname.startsWith("/api/auth/users/") && req.method === "PUT") {
    const staff = await requireStaff(req);
    if (!staff) return Response.json({ error: "Staff login required" }, { status: 403, headers: CORS });
    const id = pathname.slice("/api/auth/users/".length);
    const body = await req.json().catch(() => null) as Obj | null;
    const users = await readUsers();
    const user = users.find((u) => u.id === id);
    if (!user) return Response.json({ error: "Not found" }, { status: 404, headers: CORS });
    if (typeof body?.name === "string") user.name = body.name;
    if (typeof body?.active === "boolean") user.active = body.active;
    if (typeof body?.roleGroup === "string" && ["cruk_staff", "cruk_freelancer", "volunteer"].includes(body.roleGroup)) {
      user.roleGroup = body.roleGroup as User["roleGroup"];
    }
    await writeUsers(users);
    return Response.json({ user: publicUser(user) }, { headers: CORS });
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
