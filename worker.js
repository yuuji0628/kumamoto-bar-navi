export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // D1接続後に使う公開読み取りAPI
    if (url.pathname === "/api/shops" && request.method === "GET") {
      if (!env.DB) {
        return Response.json(
          { ok: false, error: "D1_NOT_BOUND" },
          { status: 503 }
        );
      }

      const result = await env.DB.prepare(`
        SELECT
          id, slug, name, name_kana, area, address, hours, holiday,
          instagram, genre, features, description,
          budget_min, budget_max, seats, phone,
          is_recruiting, created_at, updated_at
        FROM shops
        WHERE is_published = 1
        ORDER BY created_at DESC
      `).all();

      return Response.json({
        ok: true,
        shops: result.results || []
      });
    }

    if (url.pathname.startsWith("/api/shops/") && request.method === "GET") {
      if (!env.DB) {
        return Response.json(
          { ok: false, error: "D1_NOT_BOUND" },
          { status: 503 }
        );
      }

      const slug = decodeURIComponent(
        url.pathname.replace("/api/shops/", "")
      );

      const shop = await env.DB.prepare(`
        SELECT
          id, slug, name, name_kana, area, address, hours, holiday,
          instagram, genre, features, description,
          budget_min, budget_max, seats, phone,
          is_recruiting, created_at, updated_at
        FROM shops
        WHERE slug = ? AND is_published = 1
        LIMIT 1
      `).bind(slug).first();

      if (!shop) {
        return Response.json(
          { ok: false, error: "NOT_FOUND" },
          { status: 404 }
        );
      }

      return Response.json({ ok: true, shop });
    }

    // 管理APIはまだ無効
    if (url.pathname.startsWith("/api/admin/")) {
      return Response.json(
        { ok: false, error: "ADMIN_API_DISABLED" },
        { status: 403 }
      );
    }

    // 既存サイトはそのまま表示
    return env.ASSETS.fetch(request);
  }
};
