export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Public read-only API
    if (url.pathname === "/api/shops" && request.method === "GET") {
      const area = url.searchParams.get("area");
      const genre = url.searchParams.get("genre");

      let sql = `
        SELECT
          id, slug, name, name_kana, area, address, hours, holiday,
          instagram, genre, features, description,
          budget_min, budget_max, seats, phone,
          is_recruiting, created_at, updated_at
        FROM shops
        WHERE is_published = 1
      `;
      const values = [];

      if (area) {
        sql += " AND area = ?";
        values.push(area);
      }
      if (genre) {
        sql += " AND genre = ?";
        values.push(genre);
      }

      sql += " ORDER BY created_at DESC";

      const stmt = env.DB.prepare(sql);
      const result = values.length
        ? await stmt.bind(...values).all()
        : await stmt.all();

      return Response.json({
        ok: true,
        shops: result.results ?? []
      });
    }

    if (url.pathname.startsWith("/api/shops/") && request.method === "GET") {
      const slug = decodeURIComponent(url.pathname.replace("/api/shops/", ""));
      const result = await env.DB.prepare(`
        SELECT
          id, slug, name, name_kana, area, address, hours, holiday,
          instagram, genre, features, description,
          budget_min, budget_max, seats, phone,
          is_recruiting, created_at, updated_at
        FROM shops
        WHERE slug = ? AND is_published = 1
        LIMIT 1
      `).bind(slug).first();

      if (!result) {
        return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      }

      return Response.json({ ok: true, shop: result });
    }

    // IMPORTANT:
    // Admin write APIs are intentionally NOT enabled yet.
    // They will be added after /api/admin/* is protected by Cloudflare Access.
    if (url.pathname.startsWith("/api/admin/")) {
      return Response.json(
        { ok: false, error: "admin_api_not_enabled_yet" },
        { status: 403 }
      );
    }

    // Serve static assets through Workers Assets binding
    return env.ASSETS.fetch(request);
  }
};
