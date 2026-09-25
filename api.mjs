// Cadernos — API de sincronização (Netlify Functions + Netlify Blobs)
import { getStore } from "@netlify/blobs";

const COLLS = ["notebooks", "sections", "pages", "tags", "disciplines"];
const ID = /^[\w.~:@+-]{1,100}$/;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const emptyMeta = () => ({ v: 0, notebooks: {}, sections: {}, pages: {}, tags: {}, disciplines: {} });
async function readCards(store) {
  const c = (await store.get("cards", { type: "json" })) || { v: 0, items: {} };
  c.items = c.items || {};
  return c;
}
async function readMeta(store) {
  const m = (await store.get("meta", { type: "json" })) || emptyMeta();
  COLLS.forEach((c) => (m[c] = m[c] || {}));
  return m;
}

// Serializa as alterações do "meta" dentro desta instância da função.
let lock = Promise.resolve();
function withLock(fn) {
  const p = lock.then(fn, fn);
  lock = p.catch(() => {});
  return p;
}

export default async (req) => {
  const appKey = (globalThis.Netlify && Netlify.env.get("APP_KEY")) || process.env.APP_KEY;
  if (!appKey) return json({ error: "no_key_configured" }, 500);
  if (!safeEqual(req.headers.get("x-app-key") || "", appKey)) return json({ error: "unauthorized" }, 401);

  const store = getStore({ name: "cadernos", consistency: "strong" });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = req.method;

  try {
    if (path === "meta" && method === "GET") return json(await readMeta(store));

    if (path === "meta" && method === "POST") {
      const { ops } = await req.json();
      if (!Array.isArray(ops)) return json({ error: "bad_request" }, 400);
      return json(
        await withLock(async () => {
          const m = await readMeta(store);
          for (const o of ops) {
            if (!o || !COLLS.includes(o.coll) || !ID.test(String(o.id))) continue;
            const col = m[o.coll];
            if (o.op === "set") col[o.id] = o.data || {};
            else if (o.op === "update") { if (col[o.id]) col[o.id] = Object.assign({}, col[o.id], o.data || {}); }
            else if (o.op === "del") delete col[o.id];
          }
          m.v = (m.v || 0) + 1;
          await store.setJSON("meta", m);
          return m;
        })
      );
    }

    if (path === "meta-replace" && method === "POST") {
      const { meta } = await req.json();
      if (!meta || typeof meta !== "object") return json({ error: "bad_request" }, 400);
      return json(
        await withLock(async () => {
          const old = await readMeta(store);
          const m = emptyMeta();
          COLLS.forEach((c) => (m[c] = meta[c] && typeof meta[c] === "object" ? meta[c] : {}));
          m.v = (old.v || 0) + 1;
          await store.setJSON("meta", m);
          return m;
        })
      );
    }

    if (path === "cards" && method === "GET") {
      const c = await readCards(store);
      const since = url.searchParams.get("v");
      if (since !== null && Number(since) === c.v) return json({ v: c.v, same: true });
      return json(c);
    }

    if (path === "cards" && method === "POST") {
      const { ops } = await req.json();
      if (!Array.isArray(ops)) return json({ error: "bad_request" }, 400);
      return json(
        await withLock(async () => {
          const c = await readCards(store);
          const prev = c.v || 0;
          for (const o of ops) {
            if (!o || !ID.test(String(o.id))) continue;
            if (o.op === "set") c.items[o.id] = o.data || {};
            else if (o.op === "update") { if (c.items[o.id]) c.items[o.id] = Object.assign({}, c.items[o.id], o.data || {}); }
            else if (o.op === "del") delete c.items[o.id];
          }
          c.v = prev + 1;
          await store.setJSON("cards", c);
          return { v: c.v, prev };
        })
      );
    }

    if (path === "cards-replace" && method === "POST") {
      const { items } = await req.json();
      return json(
        await withLock(async () => {
          const old = await readCards(store);
          const c = { v: (old.v || 0) + 1, items: items && typeof items === "object" ? items : {} };
          await store.setJSON("cards", c);
          return { v: c.v };
        })
      );
    }

    if (path === "content") {
      const id = url.searchParams.get("page") || "";
      if (!ID.test(id)) return json({ error: "bad_id" }, 400);
      const key = "content/" + id;
      if (method === "GET") {
        const d = await store.get(key, { type: "json" });
        return json({ html: (d && d.html) || "" });
      }
      if (method === "PUT") {
        const { html } = await req.json();
        await store.setJSON(key, { html: String(html || ""), updatedAt: Date.now() });
        return json({ ok: true });
      }
      if (method === "DELETE") {
        await store.delete(key);
        return json({ ok: true });
      }
    }

    if (path === "content-batch" && method === "POST") {
      const { ids } = await req.json();
      const list = (Array.isArray(ids) ? ids : []).filter((id) => ID.test(String(id))).slice(0, 60);
      const out = {};
      await Promise.all(
        list.map(async (id) => {
          const d = await store.get("content/" + id, { type: "json" });
          out[id] = (d && d.html) || "";
        })
      );
      return json(out);
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    return json({ error: "server_error", message: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: "/api/*" };
