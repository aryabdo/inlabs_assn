import express from "express";
import { chromium } from "playwright";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

function norm(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function stripTags(s) {
  return (s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeClose(p) {
  return p?.close?.().catch(() => {});
}

function hasToken(tNorm, token) {
  const tk = norm(token).replace(/\s+/g, " ").trim();
  if (!tk) return false;
  if (tk.length <= 5 && /^[A-Z0-9]+$/.test(tk)) {
    const re = new RegExp(`(^|[^A-Z0-9])${tk}([^A-Z0-9]|$)`);
    return re.test(tNorm);
  }
  return tNorm.includes(tk);
}

function anyToken(tNorm, tokens) {
  return tokens.some((x) => hasToken(tNorm, x));
}

const ENTIDADES = [
  "ISA ENERGIA",
  "ISA ENERGIA BRASIL",
  "ISA ENERGIA BRASIL S.A.",
  "CTEEP",
  "COMPANHIA DE TRANSMISSAO DE ENERGIA ELETRICA PAULISTA",
  "ABRATE",
  "ASSOCIACAO BRASILEIRA DE TRANSMISSORAS DE ENERGIA"
];

const INTER_NOMES = [
  "IVAI","AGUAPEI","EVRECY","ITAUNAS","BIGUACU",
  "JAGUAR 6","JAGUAR 8","JAGUAR 9",
  "SERRA DO JAPI","MINAS GERAIS","NORTE E NORDESTE",
  "PINHEIROS","RIACHO GRANDE","SUL","TIBAGI",
  "ITAPURA","ITAQUERE","GARANHUNS","AIMORES","PARAGUACU"
];

const SIGLAS_ELETRICAS = ["ANEEL","ONS","CCEE","CDE","RGR","TFSEE","SIN","RAP"];
const TERMOS_FORTES = [
  "ENERGIA ELETRICA",
  "SETOR ELETRICO",
  "TRANSMISSAO",
  "LINHA DE TRANSMISSAO",
  "SUBESTACAO",
  "REDE BASICA",
  "INSTALACOES DE TRANSMISSAO",
  "RECEITA ANUAL PERMITIDA",
  "INTERLIGACAO ELETRICA",
  "REFORCOS",
  "MELHORIAS",
  "LEILAO DE TRANSMISSAO",
  "LEILAO",
  "ARMAZENAMENTO",
  "RESERVA DE CAPACIDADE",
  "LRCAP"
];

function matchEntidades(tNorm) {
  const hits = [];
  for (const e of ENTIDADES) if (tNorm.includes(norm(e))) hits.push(e);
  return hits;
}

function matchInterligacoes(tNorm) {
  const hits = [];
  if (tNorm.includes("INTERLIGACAO ELETRICA") || hasToken(tNorm, "IE")) {
    for (const n of INTER_NOMES) if (tNorm.includes(norm(n))) hits.push(n);
  }
  return hits;
}

function isEnergyTransmission(tNorm) {
  if (anyToken(tNorm, TERMOS_FORTES)) return true;
  if (anyToken(tNorm, SIGLAS_ELETRICAS)) return true;
  return false;
}

function inferActType(tNorm) {
  const types = [
    "RESOLUCAO NORMATIVA",
    "RESOLUCAO AUTORIZATIVA",
    "RESOLUCAO HOMOLOGATORIA",
    "RESOLUCAO",
    "PORTARIA",
    "DESPACHO",
    "AVISO",
    "EDITAL",
    "RETIFICACAO",
    "CONSULTA PUBLICA",
    "AUDIENCIA PUBLICA",
    "TOMADA DE SUBSIDIOS"
  ];
  for (const t of types) if (tNorm.includes(t)) return t;
  return "ATO";
}

function makeSnippet(textPlain, maxChars) {
  const t = (textPlain || "").replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "...";
}

function scoreItem(tNorm, entities, inters) {
  let s = 0;
  if (entities.length) s += 100;
  if (inters.length) s += 80;
  if (hasToken(tNorm, "LRCAP")) s += 70;
  if (tNorm.includes("RESERVA DE CAPACIDADE")) s += 60;
  if (tNorm.includes("LEILAO") && tNorm.includes("TRANSMISSAO")) s += 50;
  if (tNorm.includes("RECEITA ANUAL PERMITIDA") || hasToken(tNorm, "RAP")) s += 45;
  if (tNorm.includes("REDE BASICA")) s += 40;
  if (tNorm.includes("LINHA DE TRANSMISSAO")) s += 35;
  if (tNorm.includes("SUBESTACAO")) s += 35;
  if (anyToken(tNorm, SIGLAS_ELETRICAS)) s += 25;
  return s;
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function flattenText(obj, limit = 600000) {
  const out = [];
  const stack = [obj];
  while (stack.length && out.join(" ").length < limit) {
    const cur = stack.pop();
    if (cur == null) continue;
    if (typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") {
      out.push(String(cur));
      continue;
    }
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      continue;
    }
    if (typeof cur === "object") {
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function extractEntryPlainText(entryName, raw) {
  const lower = entryName.toLowerCase();
  if (lower.endsWith(".xml")) {
    try {
      const parsed = xmlParser.parse(raw);
      const flat = flattenText(parsed);
      if (flat) return flat;
    } catch (_) {}
    return stripTags(raw);
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return stripTags(raw);
  return raw.replace(/\s+/g, " ").trim();
}

function splitCandidates(plain) {
  const p = (plain || "").replace(/\r/g, "\n");
  const re = /\b(PORTARIA|DESPACHO|RESOLUCAO|RESOLUÇÃO|AVISO|EDITAL|RETIFICACAO|RETIFICAÇÃO|CONSULTA PUBLICA|CONSULTA PÚBLICA|AUDIENCIA PUBLICA|AUDIÊNCIA PÚBLICA|TOMADA DE SUBSIDIOS|TOMADA DE SUBSÍDIOS)\b/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(p)) !== null) {
    const idx = m.index;
    if (idx > last) {
      const seg = p.slice(last, idx).trim();
      if (seg.length > 800) parts.push(seg);
    }
    last = idx;
  }
  const tail = p.slice(last).trim();
  if (tail.length > 800) parts.push(tail);
  if (!parts.length && p.trim().length > 800) return [p.trim()];
  return parts.slice(0, 8);
}

const ZIP_CACHE_TTL_MS = 5 * 60 * 1000;
const ZIP_CACHE_MAX_BYTES = 60 * 1024 * 1024;
const zipCache = new Map();

function cacheKey(date, zipName) {
  return `${date}::${zipName}`;
}

function cacheCleanup() {
  const now = Date.now();
  let total = 0;
  for (const [k, v] of zipCache.entries()) {
    if (now - v.ts > ZIP_CACHE_TTL_MS) zipCache.delete(k);
    else total += v.size;
  }
  if (total > ZIP_CACHE_MAX_BYTES) {
    const arr = [...zipCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [k, v] of arr) {
      zipCache.delete(k);
      total -= v.size;
      if (total <= ZIP_CACHE_MAX_BYTES) break;
    }
  }
}

async function fetchBinary(page, absoluteUrl) {
  const resp = await page.request.get(absoluteUrl, { timeout: 120000 });
  if (!resp.ok()) throw new Error(`Falha ao baixar ${absoluteUrl} (${resp.status()})`);
  return await resp.body();
}

async function loginInlabs(page, { user, pass }) {
  await page.goto("https://inlabs.in.gov.br/acessar.php", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const hasCaptcha =
    (await page.locator("iframe[src*='captcha']").count()) > 0 ||
    (await page.locator("iframe[src*='recaptcha']").count()) > 0 ||
    (await page.locator("text=/não sou um robô/i").count()) > 0;

  if (hasCaptcha) {
    return { ok: false, code: "AUTH_REQUIRED_HUMAN", message: "Captcha/validação humana detectada no login." };
  }

  const loginForm = page.locator("form[action='logar.php']").first();
  await loginForm.waitFor({ state: "visible", timeout: 30000 });

  await loginForm.locator("#email").fill(user);
  await loginForm.locator("#password").fill(pass);

  const submitBtn = loginForm.locator("input[type='submit'][value='Logar']").first();

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
    submitBtn.click({ timeout: 30000 }),
  ]);

  const hasSair =
    (await page.locator("text=/\\bSair\\b/i").count()) > 0 ||
    (await page.locator("a:has-text('Sair')").count()) > 0;

  if (!hasSair) {
    const alertText = (await page.locator(".alert, .text-danger").allTextContents().catch(() => []))
      .join(" | ")
      .trim();

    return {
      ok: false,
      code: "AUTH_INVALID",
      message: "Falha de autenticação no INLABS.",
      debug: { url_after_submit: page.url(), alert_text: alertText || null }
    };
  }
  return { ok: true };
}

async function listDateFolders(page) {
  const anchors = await page.$$eval("a[href]", (as) =>
    as
      .map((a) => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") }))
      .filter((x) => x.text && x.href)
  );
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  return anchors.filter((x) => dateRe.test(x.text));
}

function pickDate(dateFolders, requestedDate) {
  const dates = dateFolders.map((x) => x.text).sort().reverse();
  if (!dates.length) return null;
  if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && dates.includes(requestedDate)) return requestedDate;
  return dates[0];
}

async function listFiles(page) {
  return await page.$$eval("a[href]", (as) =>
    as
      .map((a) => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") }))
      .filter((x) => x.text && x.href && x.text !== "." && x.text !== "..")
  );
}

function preferZipFiles(files, maxZips = 6) {
  const zips = files.filter((f) => f.text.toLowerCase().endsWith(".zip"));
  const order = [/DO1/i, /DO2E/i, /DO2/i, /DO3/i];
  const scored = zips.map((z) => {
    let s = 10;
    for (let i = 0; i < order.length; i++) if (order[i].test(z.text)) s += (order.length - i) * 10;
    return { ...z, _score: s };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, maxZips);
}

function buildIndexItemsFromZip(zipBuf, zipName, opts) {
  const zip = new AdmZip(zipBuf);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);

  const out = [];
  for (const e of entries) {
    const n = e.entryName.toLowerCase();
    if (!(n.endsWith(".xml") || n.endsWith(".html") || n.endsWith(".htm") || n.endsWith(".txt"))) continue;

    const raw = e.getData().toString("utf-8");
    const plain = extractEntryPlainText(e.entryName, raw);
    const candidates = splitCandidates(plain);

    for (const cand of candidates) {
      const tNorm = norm(cand);
      const entities = matchEntidades(tNorm);
      const inters = matchInterligacoes(tNorm);

      const ok = entities.length || inters.length || isEnergyTransmission(tNorm);
      if (!ok) continue;

      const actType = inferActType(tNorm);
      const title = makeSnippet(stripTags(cand), 160);
      const snippet = makeSnippet(stripTags(cand), opts.snippetMaxChars);
      const score = scoreItem(tNorm, entities, inters);

      out.push({
        id: `${zipName}::${e.entryName}`,
        zip_name: zipName,
        entry_name: e.entryName,
        section: /DO1/i.test(zipName) ? "DO1" : /DO2E/i.test(zipName) ? "DO2E" : /DO2/i.test(zipName) ? "DO2" : /DO3/i.test(zipName) ? "DO3" : "N/D",
        act_type: actType,
        title,
        snippet,
        triggers: [
          ...entities.map((x) => `ENTIDADE:${x}`),
          ...inters.map((x) => `INTERLIG:${x}`),
          ...(hasToken(tNorm, "LRCAP") ? ["LRCAP"] : []),
          ...(tNorm.includes("RESERVA DE CAPACIDADE") ? ["RESERVA_CAPACIDADE"] : []),
          ...(tNorm.includes("LEILAO") ? ["LEILAO"] : []),
          ...(tNorm.includes("TRANSMISSAO") ? ["TRANSMISSAO"] : []),
          ...(anyToken(tNorm, SIGLAS_ELETRICAS) ? ["SIGLAS_ELETRICAS"] : [])
        ],
        entities_matched: entities,
        _score: score
      });
    }
  }
  return out;
}

function uniqueById(items) {
  const m = new Map();
  for (const it of items) {
    const prev = m.get(it.id);
    if (!prev || (it._score ?? 0) > (prev._score ?? 0)) m.set(it.id, it);
  }
  return [...m.values()];
}

function checkMiddlewareKey(req) {
  const got = (req.header("X-API-Key") || "").trim();
  const exp = (process.env.MIDDLEWARE_API_KEY || "").trim();
  return got && exp && got === exp;
}

app.post("/dou/transmissao", async (req, res) => {
  let browser, context;
  let stage = "init";

  try {
    stage = "auth";
    if (!checkMiddlewareKey(req)) {
      return res.status(401).json({ error_code: "UNAUTHORIZED", message: "API key inválida." });
    }

    const requestedDate = (req.body?.date || "").trim();
    const maxItems = Number(req.body?.max_items ?? 40);
    const maxZips = Number(req.body?.max_zips ?? 6);
    const snippetMaxChars = Number(req.body?.snippet_max_chars ?? 900);

    const user = (process.env.INLABS_USER || "").trim();
    const pass = (process.env.INLABS_PASS || "").trim();
    if (!user || !pass) {
      return res.status(500).json({ error_code: "CONFIG_FAIL", message: "INLABS_USER/INLABS_PASS não configurados." });
    }

    stage = "launch";
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });

    context = await browser.newContext({
      locale: "pt-BR",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();

    stage = "login";
    const login = await loginInlabs(page, { user, pass });
    if (!login.ok) {
      const status = login.code === "AUTH_REQUIRED_HUMAN" ? 409 : 401;
      return res.status(status).json({ error_code: login.code, message: login.message, debug: login.debug });
    }

    stage = "folders";
    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    const dateFolders = await listDateFolders(page);
    if (!dateFolders.length) {
      return res.status(500).json({ error_code: "PARSE_FAIL", message: "Não localizei pastas de data após login.", stage });
    }

    const dateUsed = pickDate(dateFolders, requestedDate);
    const folder = dateFolders.find((x) => x.text === dateUsed) || dateFolders[0];
    const folderUrl = new URL(folder.href, page.url()).toString();

    stage = "enter_folder";
    await page.goto(folderUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    stage = "list_files";
    const files = await listFiles(page);
    const zipChoices = preferZipFiles(files, maxZips);
    if (!zipChoices.length) {
      return res.status(500).json({ error_code: "FETCH_FAIL", message: "Nenhum .zip encontrado na pasta da data.", date_used: dateUsed, stage });
    }

    stage = "download_parse";
    const opts = { snippetMaxChars };
    let items = [];
    for (const z of zipChoices) {
      const zipUrl = new URL(z.href, page.url()).toString();
      const buf = await fetchBinary(page, zipUrl);

      cacheCleanup();
      zipCache.set(cacheKey(dateUsed, z.text), { buf, ts: Date.now(), size: buf.length });

      items.push(...buildIndexItemsFromZip(buf, z.text, opts));
    }

    items = uniqueById(items);
    items.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
    items = items.slice(0, maxItems).map(({ _score, ...rest }) => rest);

    return res.json({ date_used: dateUsed, source: "INLABS", items });

  } catch (e) {
    return res.status(500).json({
      error_code: "FETCH_FAIL",
      message: "Falha geral no middleware.",
      stage,
      detail: `${e?.name || "Error"}: ${(e?.message || "").slice(0, 200)}`
    });
  } finally {
    await safeClose(context);
    await safeClose(browser);
  }
});

app.post("/dou/item", async (req, res) => {
  let browser, context;
  let stage = "init";

  try {
    stage = "auth";
    if (!checkMiddlewareKey(req)) {
      return res.status(401).json({ error_code: "UNAUTHORIZED", message: "API key inválida." });
    }

    const date = (req.body?.date || "").trim();
    const zipName = (req.body?.zip_name || "").trim();
    const entryName = (req.body?.entry_name || "").trim();
    const maxChars = Number(req.body?.full_text_max_chars ?? 250000);

    if (!date || !zipName || !entryName) {
      return res.status(400).json({ error_code: "BAD_REQUEST", message: "Campos obrigatórios: date, zip_name, entry_name." });
    }

    const user = (process.env.INLABS_USER || "").trim();
    const pass = (process.env.INLABS_PASS || "").trim();
    if (!user || !pass) {
      return res.status(500).json({ error_code: "CONFIG_FAIL", message: "INLABS_USER/INLABS_PASS não configurados." });
    }

    cacheCleanup();
    const ck = cacheKey(date, zipName);
    let zipBuf = zipCache.get(ck)?.buf;

    stage = "launch";
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });

    context = await browser.newContext({
      locale: "pt-BR",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();

    stage = "login";
    const login = await loginInlabs(page, { user, pass });
    if (!login.ok) {
      const status = login.code === "AUTH_REQUIRED_HUMAN" ? 409 : 401;
      return res.status(status).json({ error_code: login.code, message: login.message, debug: login.debug });
    }

    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    stage = "folders";
    const dateFolders = await listDateFolders(page);
    const folder = dateFolders.find((x) => x.text === date);
    if (!folder) {
      return res.status(404).json({ error_code: "NOT_FOUND", message: "Pasta de data não encontrada no INLABS.", date });
    }

    stage = "enter_folder";
    await page.goto(new URL(folder.href, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: 60000 });

    stage = "find_zip";
    const files = await listFiles(page);
    const zip = files.find((f) => f.text === zipName) || files.find((f) => f.text.toLowerCase() === zipName.toLowerCase());
    if (!zip) {
      return res.status(404).json({ error_code: "NOT_FOUND", message: "ZIP não encontrado na pasta da data.", zip_name: zipName });
    }

    if (!zipBuf) {
      stage = "download_zip";
      zipBuf = await fetchBinary(page, new URL(zip.href, page.url()).toString());
      cacheCleanup();
      zipCache.set(ck, { buf: zipBuf, ts: Date.now(), size: zipBuf.length });
    }

    stage = "extract_entry";
    const z = new AdmZip(zipBuf);
    const entry = z.getEntry(entryName);
    if (!entry) {
      return res.status(404).json({ error_code: "NOT_FOUND", message: "Entry não encontrada dentro do ZIP.", entry_name: entryName });
    }

    const raw = entry.getData().toString("utf-8");
    let fullPlain = stripTags(extractEntryPlainText(entryName, raw));
    const truncated = fullPlain.length > maxChars;
    if (truncated) fullPlain = fullPlain.slice(0, maxChars) + "\n\n[...TRUNCADO...]";

    return res.json({ full_text: fullPlain, full_text_truncated: truncated });

  } catch (e) {
    return res.status(500).json({
      error_code: "FETCH_FAIL",
      message: "Falha geral no middleware.",
      stage,
      detail: `${e?.name || "Error"}: ${(e?.message || "").slice(0, 200)}`
    });
  } finally {
    await safeClose(context);
    await safeClose(browser);
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => console.log(`listening:${port}`));
