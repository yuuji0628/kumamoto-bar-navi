function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function cleanText(value, max = 4000) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, max);
}

function toInt(value, fallback = null) {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function slugify(value) {
  const s = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, "-and-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return s || `shop-${Date.now()}`;
}

function hasAccess(request) {
  return Boolean(
    request.headers.get("Cf-Access-Authenticated-User-Email") ||
    request.headers.get("Cf-Access-Jwt-Assertion")
  );
}

function shopPayload(body) {
  return {
    slug: slugify(body.slug || body.name),
    name: cleanText(body.name, 150),
    name_kana: cleanText(body.name_kana, 150),
    area: cleanText(body.area, 80),
    address: cleanText(body.address, 300),
    hours: cleanText(body.hours, 150),
    holiday: cleanText(body.holiday, 120),
    instagram: cleanText(body.instagram, 500),
    genre: cleanText(body.genre, 120),
    features: cleanText(body.features, 1000),
    description: cleanText(body.description, 5000),
    budget_min: toInt(body.budget_min),
    budget_max: toInt(body.budget_max),
    seats: toInt(body.seats),
    phone: cleanText(body.phone, 80),
    is_recruiting: body.is_recruiting ? 1 : 0,
    is_published: body.is_published === false || body.is_published === 0 ? 0 : 1,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.DB && url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "D1_NOT_BOUND" }, { status: 503 });
    }

    // ---------- Public read API ----------
    if (url.pathname === "/api/shops" && request.method === "GET") {
      let sql = `
        SELECT id, slug, name, name_kana, area, address, hours, holiday,
               instagram, genre, features, description, budget_min, budget_max,
               seats, phone, is_recruiting, is_published, created_at, updated_at
        FROM shops
        WHERE is_published = 1
      `;
      const values = [];

      const area = cleanText(url.searchParams.get("area"), 80);
      const genre = cleanText(url.searchParams.get("genre"), 120);
      if (area) { sql += " AND area = ?"; values.push(area); }
      if (genre) { sql += " AND genre = ?"; values.push(genre); }
      sql += " ORDER BY created_at DESC";

      const stmt = env.DB.prepare(sql);
      const result = values.length ? await stmt.bind(...values).all() : await stmt.all();
      return json({ ok: true, shops: result.results || [] });
    }

    if (url.pathname.startsWith("/api/shops/") && request.method === "GET") {
      const slug = decodeURIComponent(url.pathname.replace("/api/shops/", ""));
      const shop = await env.DB.prepare(`
        SELECT id, slug, name, name_kana, area, address, hours, holiday,
               instagram, genre, features, description, budget_min, budget_max,
               seats, phone, is_recruiting, is_published, created_at, updated_at
        FROM shops
        WHERE slug = ? AND is_published = 1
        LIMIT 1
      `).bind(slug).first();

      if (!shop) return json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
      return json({ ok: true, shop });
    }

    // ---------- Admin API ----------
    if (url.pathname.startsWith("/api/admin/")) {
      // Cloudflare Access is the primary protection.
      // This header check is an extra safeguard.
      if (!hasAccess(request)) {
        return json({ ok: false, error: "ACCESS_REQUIRED" }, { status: 401 });
      }

      if (url.pathname === "/api/admin/shops" && request.method === "GET") {
        const result = await env.DB.prepare(`
          SELECT id, slug, name, name_kana, area, address, hours, holiday,
                 instagram, genre, features, description, budget_min, budget_max,
                 seats, phone, is_recruiting, is_published, created_at, updated_at
          FROM shops
          ORDER BY id DESC
        `).all();
        return json({ ok: true, shops: result.results || [] });
      }

      if (url.pathname === "/api/admin/shops" && request.method === "POST") {
        let body;
        try { body = await request.json(); }
        catch { return json({ ok: false, error: "INVALID_JSON" }, { status: 400 }); }

        const s = shopPayload(body);
        if (!s.name || !s.area) {
          return json({ ok: false, error: "NAME_AND_AREA_REQUIRED" }, { status: 400 });
        }

        try {
          const result = await env.DB.prepare(`
            INSERT INTO shops (
              slug, name, name_kana, area, address, hours, holiday, instagram,
              genre, features, description, budget_min, budget_max, seats,
              phone, is_recruiting, is_published
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            s.slug, s.name, s.name_kana, s.area, s.address, s.hours, s.holiday,
            s.instagram, s.genre, s.features, s.description, s.budget_min,
            s.budget_max, s.seats, s.phone, s.is_recruiting, s.is_published
          ).run();
          return json({ ok: true, id: result.meta?.last_row_id, slug: s.slug }, { status: 201 });
        } catch (e) {
          const msg = String(e);
          if (msg.includes("UNIQUE")) {
            return json({ ok: false, error: "SLUG_ALREADY_EXISTS" }, { status: 409 });
          }
          return json({ ok: false, error: "CREATE_FAILED" }, { status: 500 });
        }
      }

      const m = url.pathname.match(/^\/api\/admin\/shops\/(\d+)$/);
      if (m && request.method === "PUT") {
        const id = Number(m[1]);
        let body;
        try { body = await request.json(); }
        catch { return json({ ok: false, error: "INVALID_JSON" }, { status: 400 }); }

        const existing = await env.DB.prepare("SELECT * FROM shops WHERE id = ?").bind(id).first();
        if (!existing) return json({ ok: false, error: "NOT_FOUND" }, { status: 404 });

        const merged = { ...existing, ...body };
        const s = shopPayload(merged);
        if (!s.name || !s.area) {
          return json({ ok: false, error: "NAME_AND_AREA_REQUIRED" }, { status: 400 });
        }

        try {
          await env.DB.prepare(`
            UPDATE shops SET
              slug=?, name=?, name_kana=?, area=?, address=?, hours=?, holiday=?,
              instagram=?, genre=?, features=?, description=?, budget_min=?,
              budget_max=?, seats=?, phone=?, is_recruiting=?, is_published=?,
              updated_at=CURRENT_TIMESTAMP
            WHERE id=?
          `).bind(
            s.slug, s.name, s.name_kana, s.area, s.address, s.hours, s.holiday,
            s.instagram, s.genre, s.features, s.description, s.budget_min,
            s.budget_max, s.seats, s.phone, s.is_recruiting, s.is_published, id
          ).run();
          return json({ ok: true, id, slug: s.slug });
        } catch (e) {
          if (String(e).includes("UNIQUE")) {
            return json({ ok: false, error: "SLUG_ALREADY_EXISTS" }, { status: 409 });
          }
          return json({ ok: false, error: "UPDATE_FAILED" }, { status: 500 });
        }
      }

      if (m && request.method === "DELETE") {
        const id = Number(m[1]);
        const result = await env.DB.prepare(`
          UPDATE shops
          SET is_published = 0, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(id).run();
        return json({ ok: true, id, unpublished: true });
      }

      return json({ ok: false, error: "ADMIN_ROUTE_NOT_FOUND" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  }
};
