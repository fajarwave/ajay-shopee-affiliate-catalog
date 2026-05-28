function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" }
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slugify(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchProductPage(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept-language": "id-ID,id;q=0.9,en;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`Gagal mengambil halaman produk. Status ${response.status}`);
  }

  return await response.text();
}

function matchMeta(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function parseProductMetadata(pageHtml, sourceUrl) {
  const title =
    matchMeta(pageHtml, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"]+)["']/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"]+)["']/i,
      /<title>([^<]+)<\/title>/i
    ]) || "Produk Affiliate";

  const image =
    matchMeta(pageHtml, [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"]+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"]+)["']/i
    ]) || "";

  const description =
    matchMeta(pageHtml, [
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"]+)["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"]+)["']/i
    ]) || "";

  const price =
    matchMeta(pageHtml, [
      /"price"\s*:\s*"([^"]+)"/i,
      /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"]+)["']/i
    ]) || "";

  const currency =
    matchMeta(pageHtml, [
      /"priceCurrency"\s*:\s*"([^"]+)"/i,
      /<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"]+)["']/i
    ]) || "IDR";

  const brand = matchMeta(pageHtml, [/"brand"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i]) || "";
  const category = matchMeta(pageHtml, [/"category"\s*:\s*"([^"]+)"/i]) || "Shopee";

  return {
    title,
    image,
    description,
    price,
    currency,
    brand,
    category,
    sourceUrl
  };
}

async function generateMarketingCopy(env, product) {
  const prompt = `
Kamu adalah copywriter SEO untuk katalog affiliate Shopee berbahasa Indonesia.

Data produk:
- Judul: ${product.title}
- Harga: ${product.price || "-"}
- Mata uang: ${product.currency || "IDR"}
- Brand: ${product.brand || "-"}
- Kategori: ${product.category || "-"}
- Deskripsi awal: ${product.description || "-"}

Tugas:
1. Buat seo_title maksimal 80 karakter
2. Buat seo_description 140-160 karakter
3. Buat cta_text pendek dan menarik
4. Buat tags berupa 6 keyword singkat dipisahkan koma
5. Buat thumbnail_text maksimal 5 kata

Balas HANYA JSON valid seperti ini:
{
  "seo_title": "",
  "seo_description": "",
  "cta_text": "",
  "tags": "",
  "thumbnail_text": ""
}
`.trim();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini error ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const cleaned = text.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      seo_title: product.title,
      seo_description: product.description || "Lihat detail produk dan cek harga terbaru.",
      cta_text: "Cek di Shopee",
      tags: "shopee, affiliate, produk, promo, belanja, rekomendasi",
      thumbnail_text: "CEK PRODUK"
    };
  }
}

async function sendTelegramMessage(env, chatId, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
}

async function handleTelegramWebhook(request, env) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || secret !== env.TELEGRAM_SECRET) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const update = await request.json();
  const message = update?.message?.text?.trim();
  const chatId = update?.message?.chat?.id;

  if (!message || !chatId) {
    return json({ ok: true, skipped: "No text message" });
  }

  if (!/^https?:\/\//i.test(message)) {
    await sendTelegramMessage(
      env,
      chatId,
      "Kirim link affiliate Shopee yang valid, misalnya https://...."
    );
    return json({ ok: true, skipped: "Invalid URL text" });
  }

  let pageHtml = "";
  let parsed = null;
  let ai = null;

  try {
    pageHtml = await fetchProductPage(message);
    parsed = parseProductMetadata(pageHtml, message);
    ai = await generateMarketingCopy(env, parsed);
  } catch (error) {
    await sendTelegramMessage(
      env,
      chatId,
      `Gagal memproses link.\n\nError: ${error.message}`
    );
    return json({ ok: false, error: error.message }, 500);
  }

  const slug = slugify(ai.seo_title || parsed.title || `produk-${Date.now()}`);

  await env.DB.prepare(
    `INSERT INTO products (
      source_url,
      affiliate_url,
      title,
      slug,
      price,
      currency,
      brand,
      category,
      main_image,
      image_list,
      seo_title,
      seo_description,
      cta_text,
      tags,
      thumbnail_text,
      short_video_url,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      message,
      message,
      parsed.title,
      slug,
      parsed.price,
      parsed.currency,
      parsed.brand,
      parsed.category,
      parsed.image,
      JSON.stringify(parsed.image ? [parsed.image] : []),
      ai.seo_title,
      ai.seo_description,
      ai.cta_text,
      ai.tags,
      ai.thumbnail_text,
      "",
      "published"
    )
    .run();

  const productUrl = `${env.SITE_URL}/produk/${slug}`;

  await sendTelegramMessage(
    env,
    chatId,
    `✅ Produk berhasil diposting\n\nJudul: ${ai.seo_title || parsed.title}\nURL katalog: ${productUrl}\nHarga: ${parsed.price || "-"} ${parsed.currency || ""}`
  );

  return json({ ok: true, slug, productUrl });
}

async function handleApiProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, slug, price, currency, brand, category, main_image, seo_title, seo_description, cta_text, tags, thumbnail_text, status, created_at
     FROM products
     WHERE status = 'published'
     ORDER BY id DESC`
  ).all();

  return json(results || []);
}

async function renderHome(env) {
  const { results } = await env.DB.prepare(
    `SELECT title, slug, price, currency, main_image, seo_title, seo_description, cta_text
     FROM products
     WHERE status = 'published'
     ORDER BY id DESC
     LIMIT 24`
  ).all();

  const cards = (results || [])
    .map(
      (item) => `
      <article class="card">
        <a href="/produk/${encodeURIComponent(item.slug)}" class="card-link">
          <img src="${escapeHtml(item.main_image || "https://placehold.co/600x600?text=Produk")}" alt="${escapeHtml(item.seo_title || item.title)}" class="thumb"/>
          <div class="card-body">
            <h2>${escapeHtml(item.seo_title || item.title)}</h2>
            <p>${escapeHtml(item.seo_description || "")}</p>
            <div class="price">${escapeHtml(item.price || "")} ${escapeHtml(item.currency || "")}</div>
            <span class="btn">Lihat Produk</span>
          </div>
        </a>
      </article>`
    )
    .join("");

  return html(`<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Katalog Affiliate Ajay</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <h1>Katalog Affiliate Ajay</h1>
      <p>Rekomendasi produk pilihan dengan tombol langsung ke Shopee.</p>
    </div>
  </header>
  <main class="wrap">
    <section class="grid">
      ${cards || "<p>Belum ada produk. Kirim link affiliate ke bot Telegram untuk menambah produk pertama.</p>"}
    </section>
  </main>
</body>
</html>`);
}

async function renderProduct(env, slug) {
  const row = await env.DB.prepare(
    `SELECT *
     FROM products
     WHERE slug = ?
     LIMIT 1`
  ).bind(slug).first();

  if (!row) {
    return html(`<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/styles.css"><title>Produk tidak ditemukan</title></head><body><main class="wrap"><h1>Produk tidak ditemukan</h1><p>Slug: ${escapeHtml(slug)}</p><p><a href="/">Kembali ke katalog</a></p></main></body></html>`, 404);
  }

  return html(`<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(row.seo_title || row.title)}</title>
  <meta name="description" content="${escapeHtml(row.seo_description || "")}">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="wrap product-page">
    <p><a href="/">← Kembali ke katalog</a></p>
    <div class="product-layout">
      <img src="${escapeHtml(row.main_image || "https://placehold.co/800x800?text=Produk")}" alt="${escapeHtml(row.seo_title || row.title)}" class="product-image"/>
      <div>
        <span class="badge">${escapeHtml(row.category || "Produk")}</span>
        <h1>${escapeHtml(row.seo_title || row.title)}</h1>
        <p>${escapeHtml(row.seo_description || "")}</p>
        <div class="price big">${escapeHtml(row.price || "")} ${escapeHtml(row.currency || "")}</div>
        <p><strong>Brand:</strong> ${escapeHtml(row.brand || "-")}</p>
        <p><strong>Tag:</strong> ${escapeHtml(row.tags || "-")}</p>
        <a href="${escapeHtml(row.affiliate_url)}" target="_blank" rel="nofollow sponsored noopener" class="btn primary">${escapeHtml(row.cta_text || "Cek di Shopee")}</a>
      </div>
    </div>
  </main>
</body>
</html>`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/telegram-webhook") {
      return handleTelegramWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/products") {
      return handleApiProducts(env);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "affiliate-catalog-worker" });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return renderHome(env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/produk/")) {
      const slug = decodeURIComponent(url.pathname.replace("/produk/", "").trim());
      return renderProduct(env, slug);
    }

    return env.ASSETS.fetch(request);
  }
};
