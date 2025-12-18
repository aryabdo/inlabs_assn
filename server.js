import express from "express";
import { chromium } from "playwright";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import PDFDocument from "pdfkit";

const app = express();
app.use(express.json({ limit: "6mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

async function safeClose(obj) {
  try { if (obj) await obj.close(); } catch (_) {}
}

function norm(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

/** ===== Filtros ===== **/
const ENTIDADES = [
  "ISA ENERGIA",
  "ISA ENERGIA BRASIL",
  "ISA ENERGIA BRASIL S.A.",
  "CTEEP",
  "COMPANHIA DE TRANSMISSAO DE ENERGIA ELETRICA PAULISTA",
  "CONCESSIONARIAS DE TRANSMISSAO",
  "ABRATE",
  "ASSOCIACAO BRASILEIRA DE TRANSMISSORAS DE ENERGIA",
];

const INTER_NOMES = [
  "IVAI","AGUAPEI","EVRECY","ITAUNAS","BIGUACU",
  "JAGUAR 6","JAGUAR 8","JAGUAR 9",
  "SERRA DO JAPI","MINAS GERAIS","NORTE E NORDESTE",
  "PINHEIROS","RIACHO GRANDE","SUL","TIBAGI",
  "ITAPURA","ITAQUERE","GARANHUNS","AIMORES","PARAGUACU"
];

const TERMOS_SETOR = [
  "ENERGIA ELETRICA","SETOR ELETRICO","ANEEL","TRANSMISSAO","GERACAO","SUBESTACAO",
  "CDE","CONTA DE DESENVOLVIMENTO ENERGETICO","PROINFA","TFSEE","RGR","CCEE","ONS"
];

const TERMOS_TIPICOS = [
  "RESOLUCAO NORMATIVA",
  "RESOLUCAO AUTORIZATIVA",
  "RESOLUCAO HOMOLOGATORIA",
  "REVISAO TARIFARIA PERIODICA",
  "REVISAO ANUAL",
  "CONTA DE DESENVOLVIMENTO ENERGETICO",
  "CDE","PROINFA","TFSEE","MEZ","RGR",
  "AGENDA REGULATORIA",
  "ABRATE",
  "LRCAP"
];

const TERMOS_TRANSMISSAO_CONTEXT = [
  "TRANSMISSAO","LINHA DE TRANSMISSAO","LT ",
  "SUBESTACAO","SE ",
  "REDE BASICA","RB ",
  "RAP","RECEITA ANUAL PERMITIDA",
  "INSTALACOES DE TRANSMISSAO",
  "REFORCOS","MELHORIAS",
  "SIN","SISTEMA INTERLIGADO",
  "ONS"
];

function matchInterligacoes(t) {
  const hits = [];
  if (t.includes("INTERLIGACAO ELETRICA")) {
    for (const n of INTER_NOMES) if (t.includes(n)) hits.push(`INTERLIGACAO ELETRICA + ${n}`);
  }
  if (/\bIE\b/.test(t)) {
    for (const n of INTER_NOMES) if (t.includes(n)) hits.push(`IE + ${n}`);
  }
  return hits;
}

function gatilhos(t) {
  const g = [];

  for (const e of ENTIDADES) if (t.includes(e)) g.push(`ENTIDADE:${e}`);
  g.push(...matchInterligacoes(t).map(x => `INTERLIG:${x}`));

  const hasAny = (arr) => arr.some(x => t.includes(x));

  if (t.includes("DESPACHO") && hasAny(TERMOS_SETOR)) g.push("DESPACHO_SETOR");
  if (t.includes("PORTARIA") && hasAny(TERMOS_SETOR)) g.push("PORTARIA_SETOR");

  if (t.includes("AUDIENCIA PUBLICA") && hasAny([...TERMOS_SETOR, "EPE","EMPRESA DE PESQUISA ENERGETICA"])) g.push("AUDIENCIA_PUBLICA_SETOR");
  if (t.includes("CONSULTA PUBLICA") && hasAny([...TERMOS_SETOR, "EPE","EMPRESA DE PESQUISA ENERGETICA"])) g.push("CONSULTA_PUBLICA_SETOR");
  if (t.includes("CONSULTA EXTERNA") && hasAny(["ENERGIA ELETRICA","SETOR ELETRICO","ANEEL","EPE","EMPRESA DE PESQUISA ENERGETICA","CCEE","ONS"])) g.push("CONSULTA_EXTERNA_SETOR");
  if (t.includes("TOMADA DE SUBSIDIOS") && hasAny([...TERMOS_SETOR, "EPE","EMPRESA DE PESQUISA ENERGETICA"])) g.push("TOMADA_SUBSIDIOS_SETOR");

  if (t.includes("RETIFICACAO") && hasAny(["LEILAO", ...TERMOS_SETOR])) g.push("RETIFICACAO_SETOR");

  if (t.includes("REIDI") && hasAny(["ENERGIA ELETRICA","TRANSMISSAO","GERACAO","SUBESTACAO","CCEE","ONS"])) {
    const antiGas = ["GASODUTO","GAS","DISTRIBUIDORA DE GAS","COMBUSTIVEL","OLEO"];
    if (!antiGas.some(x => t.includes(x))) g.push("REIDI_ELETRICO");
  }

  for (const k of TERMOS_TIPICOS) if (t.includes(k)) g.push(`TERMO:${k}`);

  if (t.includes("LEILAO") && (t.includes("ANEEL") || t.includes("ENERGIA ELETRICA") || t.includes("SETOR ELETRICO"))) g.push("LEILAO_ELETRICO");
  if (t.includes("LEILAO") && t.includes("TRANSMISSAO")) g.push("LEILAO_TRANSMISSAO");
  if (t.includes("RESERVA DE CAPACIDADE")) g.push("RESERVA_CAPACIDADE");

  if (t.includes("CHAMADA PUBLICA") && (t.includes("ANEEL") || t.includes("P&D") || t.includes("PESQUISA E DESENVOLVIMENTO") || t.includes("EFICIENCIA ENERGETICA"))) {
    g.push("CHAMADA_PD_EFIC");
  }

  return uniq(g);
}

function entidadesMatchedFromTriggers(trigs) {
  return uniq(trigs.filter(x => x.startsWith("ENTIDADE:")).map(x => x.replace("ENTIDADE:","")));
}

function isRelevant(tNorm, trigs) {
  const hasEnt = trigs.some(x => x.startsWith("ENTIDADE:")) || trigs.some(x => x.startsWith("INTERLIG:"));
  if (hasEnt) return true;

  const hasCore =
    trigs.some(x =>
      ["DESPACHO_SETOR","PORTARIA_SETOR","AUDIENCIA_PUBLICA_SETOR","CONSULTA_PUBLICA_SETOR","CONSULTA_EXTERNA_SETOR","TOMADA_SUBSIDIOS_SETOR","RETIFICACAO_SETOR","REIDI_ELETRICO","LEILAO_ELETRICO","LEILAO_TRANSMISSAO","RESERVA_CAPACIDADE"].includes(x)
    ) || trigs.some(x => x.startsWith("TERMO:"));

  if (!hasCore) return false;

  const isStorageOrCap = tNorm.includes("LRCAP") || tNorm.includes("ARMAZENAMENTO") || tNorm.includes("RESERVA DE CAPACIDADE");
  if (isStorageOrCap) return true;

  return TERMOS_TRANSMISSAO_CONTEXT.some(k => tNorm.includes(k));
}

/** ===== Extração ZIP ===== **/
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function stripTags(s) {
  return (s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenText(obj, limit = 800000) {
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

function splitIntoItemsFromText(text) {
  const t = (text || "").replace(/\r/g, "\n");
  const markers = [
    "\nPORTARIA", "\nDESPACHO", "\nRESOLUCAO", "\nRESOLUÇÃO", "\nAVISO", "\nEDITAL",
    "\nINSTRUCAO NORMATIVA", "\nINSTRUÇÃO NORMATIVA", "\nRETIFICACAO", "\nRETIFICAÇÃO",
    "\nAUDIENCIA PUBLICA", "\nAUDIÊNCIA PÚBLICA", "\nCONSULTA PUBLICA", "\nCONSULTA PÚBLICA",
    "\nTOMADA DE SUBSIDIOS", "\nTOMADA DE SUBSÍDIOS"
  ];

  let parts = [t];
  for (const m of markers) {
    const newParts = [];
    for (const p of parts) {
      const re = new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
      const chunks = p.split(re);
      if (chunks.length > 1) {
        newParts.push(chunks[0]);
        for (let i = 1; i < chunks.length; i++) newParts.push(m.trim() + chunks[i]);
      } else {
        newParts.push(p);
      }
    }
    parts = newParts;
  }

  return parts.map(x => x.replace(/\s+/g, " ").trim()).filter(x => x.length > 600);
}

function extractCandidatesFromZip(buffer, fileOrigin) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const candidates = [];

  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName.toLowerCase();
    if (!(name.endsWith(".xml") || name.endsWith(".html") || name.endsWith(".htm") || name.endsWith(".txt"))) continue;

    const raw = e.getData().toString("utf-8");
    let text = raw;

    if (name.endsWith(".xml")) {
      try {
        const parsed = xmlParser.parse(raw);
        const flat = flattenText(parsed);
        text = flat || stripTags(raw);
      } catch {
        text = stripTags(raw);
      }
    } else {
      text = stripTags(raw);
    }

    const parts = splitIntoItemsFromText(text);
    for (const p of parts) {
      candidates.push({ file_origin: `${fileOrigin}::${e.entryName}`, text: p });
    }
  }

  if (candidates.length === 0) {
    const allNames = entries.filter(x => !x.isDirectory).map(x => x.entryName).slice(0, 50).join(", ");
    candidates.push({
      file_origin: `${fileOrigin}::(no-text-entries)`,
      text: `ZIP sem entradas textuais detectadas. Arquivos (amostra): ${allNames}`
    });
  }

  return candidates;
}

/** ===== PDF ===== **/
async function buildPdfBase64(items, dateUsed) {
  return await new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ autoFirstPage: false, margin: 40 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          filename: `DOU_Transmissao_${dateUsed}.pdf`,
          content_base64: buf.toString("base64"),
        });
      });

      doc.addPage();
      doc.fontSize(18).text("DOU – Dossiê (Transmissão)", { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Data: ${dateUsed}`, { align: "center" });
      doc.moveDown(1.5);
      doc.fontSize(10).text(`Itens incluídos: ${items.length}`, { align: "center" });

      for (const it of items) {
        doc.addPage();
        doc.fontSize(12).text(it.title || "Publicação", { underline: true });
        doc.moveDown(0.3);
        doc.fontSize(9).text(`Seção: ${it.section || "N/D"} | Tipo: ${it.act_type || "N/D"}`);
        doc.fontSize(9).text(`Origem: ${it.file_origin || "N/D"}`);
        doc.moveDown(0.4);
        doc.fontSize(9).text(`Triggers: ${(it.triggers || []).join("; ")}`);
        doc.fontSize(9).text(`Entidades: ${(it.entities_matched || []).join("; ")}`);
        doc.moveDown(0.8);
        doc.fontSize(9).text(it.full_text || "");
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** ===== Navegação + Download ===== **/
async function fetchBinary(page, absoluteUrl) {
  const resp = await page.request.get(absoluteUrl, { timeout: 120000 });
  if (!resp.ok()) throw new Error(`Falha ao baixar ${absoluteUrl} (${resp.status()})`);
  return await resp.body();
}

function isDateFolderName(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test((s || "").trim());
}

function guessSectionFromFilename(nameUpper) {
  if (nameUpper.includes("DO1")) return "DO1";
  if (nameUpper.includes("DO2")) return "DO2";
  if (nameUpper.includes("DO3")) return "DO3";
  return "N/D";
}

function guessActType(textNorm) {
  const types = [
    "RESOLUCAO NORMATIVA","RESOLUCAO AUTORIZATIVA","RESOLUCAO HOMOLOGATORIA",
    "RESOLUCAO","PORTARIA","DESPACHO","EDITAL","AVISO","INSTRUCAO NORMATIVA",
    "RETIFICACAO","AUDIENCIA PUBLICA","CONSULTA PUBLICA","TOMADA DE SUBSIDIOS"
  ];
  for (const t of types) if (textNorm.includes(t)) return t;
  return "ATO";
}

function guessTitle(text) {
  const lines = (text || "").split(/\n|\r/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) return "Publicação";
  return lines[0].slice(0, 180);
}

/** ===== Login ===== **/
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

/** ===== Endpoint ===== **/
app.post("/dou/transmissao", async (req, res) => {
  let browser = null;
  let context = null;
  let stage = "init";

  try {
    stage = "auth_middleware";
    const apiKey = req.header("X-API-Key");
    if (!apiKey || apiKey !== process.env.MIDDLEWARE_API_KEY) {
      return res.status(401).json({ error_code: "UNAUTHORIZED", message: "API key inválida." });
    }

    const requestedDate = (req.body?.date || "").trim();
    const includePdf = req.body?.include_pdf ?? true;

    const user = (process.env.INLABS_USER || "").trim();
    const pass = (process.env.INLABS_PASS || "").trim();
    if (!user || !pass) {
      return res.status(500).json({ error_code: "CONFIG_FAIL", message: "INLABS_USER/INLABS_PASS não configurados." });
    }

    stage = "launch_browser";
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

    stage = "login_inlabs";
    const login = await loginInlabs(page, { user, pass });
    if (!login.ok) {
      const status = login.code === "AUTH_REQUIRED_HUMAN" ? 409 : 401;
      return res.status(status).json({ error_code: login.code, message: login.message, debug: login.debug });
    }

    stage = "list_date_folders";
    // após login, normalmente já está na listagem de pastas; se não estiver, tenta ir para raiz do origin
    const origin = new URL(page.url()).origin;
    await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    const folders = await page.$$eval("a", (as) =>
      as
        .map(a => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") }))
        .filter(x => x.text && x.href)
    );

    const dateFolders = folders.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.text));
    if (dateFolders.length === 0) {
      return res.status(500).json({ error_code: "PARSE_FAIL", message: "Não localizei pastas por data após login.", stage });
    }

    let dateUsed = requestedDate && isDateFolderName(requestedDate) ? requestedDate : null;
    const datesAvailable = dateFolders.map(x => x.text).sort().reverse();

    if (!dateUsed) dateUsed = datesAvailable[0];
    if (!datesAvailable.includes(dateUsed)) dateUsed = datesAvailable[0];

    const folderObj = dateFolders.find(x => x.text === dateUsed) || dateFolders.find(x => x.text === datesAvailable[0]);
    if (!folderObj) {
      return res.status(500).json({ error_code: "PARSE_FAIL", message: "Não consegui resolver o link da pasta da data.", stage });
    }

    stage = "enter_date_folder";
    const folderUrl = new URL(folderObj.href, page.url()).toString();
    await page.goto(folderUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    stage = "list_files";
    const fileLinks = await page.$$eval("a[href]", (as) =>
      as
        .map(a => ({ text: (a.textContent || "").trim(), href: a.getAttribute("href") }))
        .filter(x => x.text && x.href && x.text !== ".." && x.text !== ".")
    );

    const zipFiles = fileLinks
      .filter(x => x.text.toLowerCase().endsWith(".zip"))
      .map(x => ({
        name: x.text,
        url: new URL(x.href, page.url()).toString()  // <<< CORREÇÃO: sem document.baseURI
      }));

    if (zipFiles.length === 0) {
      return res.status(500).json({
        error_code: "FETCH_FAIL",
        message: "Nenhum .zip encontrado dentro da pasta da data.",
        date_used: dateUsed,
        stage
      });
    }

    stage = "download_and_extract";
    const candidates = [];
    for (const z of zipFiles) {
      const bin = await fetchBinary(page, z.url);   // <<< CORREÇÃO: usa url real do link
      const c = extractCandidatesFromZip(bin, z.name);
      candidates.push(...c);
    }

    stage = "filter_items";
    const maxChars = Number(process.env.FULL_TEXT_MAX_CHARS || 400000);

    const items = [];
    for (const c of candidates) {
      const t = c.text || "";
      const tNorm = norm(t);
      const trigs = gatilhos(tNorm);
      if (!isRelevant(tNorm, trigs)) continue;

      const entities = entidadesMatchedFromTriggers(trigs);
      const actType = guessActType(tNorm);
      const title = guessTitle(t);
      const section = guessSectionFromFilename(norm(c.file_origin || ""));

      const fullText = t.length > maxChars ? t.slice(0, maxChars) + "\n\n[...TRUNCADO...]" : t;

      items.push({
        section,
        organ: null,
        act_type: actType,
        title,
        url: null,
        file_origin: c.file_origin,
        full_text: fullText,
        full_text_truncated: t.length > maxChars,
        triggers: trigs,
        entities_matched: entities
      });
    }

    if (items.length === 0) {
      return res.json({
        date_used: dateUsed,
        edition_info: `ZIPs analisados: ${zipFiles.map(z => z.name).join(", ")}`,
        source: "INLABS",
        items: []
      });
    }

    stage = "pdf_optional";
    let pdf = undefined;
    if (includePdf) {
      pdf = await buildPdfBase64(items, dateUsed);
    }

    return res.json({
      date_used: dateUsed,
      edition_info: `ZIPs analisados: ${zipFiles.map(z => z.name).join(", ")}`,
      source: "INLABS",
      items,
      pdf
    });

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
