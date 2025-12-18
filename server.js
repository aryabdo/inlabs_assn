import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "4mb" }));

// Healthcheck simples
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * POST /dou/transmissao
 * - Protegido por X-API-Key
 * - Faz sessão limpa + login forçado no INLABS
 * - TODO: navegar/raspar o DOU e filtrar
 */
app.post("/dou/transmissao", async (req, res) => {
  try {
    // 1) Autorização do middleware
    const apiKey = req.header("X-API-Key");
    if (!apiKey || apiKey !== process.env.MIDDLEWARE_API_KEY) {
      return res.status(401).json({ error_code: "UNAUTHORIZED", message: "API key inválida." });
    }

    // 2) Entradas
    const date = req.body?.date ?? null; // YYYY-MM-DD ou null
    const includePdf = req.body?.include_pdf ?? true;

    // 3) Credenciais do INLABS via env vars (Railway Variables)
    const user = process.env.INLABS_USER;
    const pass = process.env.INLABS_PASS;

    if (!user || !pass) {
      return res.status(500).json({
        error_code: "CONFIG_FAIL",
        message: "INLABS_USER/INLABS_PASS não configurados no ambiente."
      });
    }

    // 4) Sessão limpa + login forçado
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext(); // sessão limpa
    const page = await context.newPage();

    // Evite logs verbosos; não logar headers/body nem credenciais.
    await page.goto("https://inlabs.in.gov.br/acessar.php", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Detecção genérica de captcha/validação humana (sem bypass)
    const hasCaptcha =
      (await page.locator("iframe[src*='captcha']").count()) > 0 ||
      (await page.locator("text=/não sou um robô/i").count()) > 0;

    if (hasCaptcha) {
      await context.close();
      await browser.close();
      return res.status(409).json({
        error_code: "AUTH_REQUIRED_HUMAN",
        message: "Captcha/validação humana detectada no login."
      });
    }

    // Seletores do INLABS podem variar. Ajuste conforme necessário.
    // Preferência: selecionar por name/id/label quando possível.
    const userField = page.locator("input[name='usuario'], input[type='email'], input[name='email']").first();
    const passField = page.locator("input[name='senha'], input[type='password'], input[name='password']").first();
    const submitBtn = page.locator("button[type='submit'], input[type='submit'], button:has-text('Acessar')").first();

    await userField.fill(user);
    await passField.fill(pass);

    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      submitBtn.click()
    ]);

    // 5) Validação objetiva de login
    const successByUrl = !page.url().includes("/acessar.php");
    const successByUi =
      (await page.locator("text=/sair|logout/i").count()) > 0 ||
      (await page.locator("a:has-text('Sair'), button:has-text('Sair')").count()) > 0;

    if (!successByUrl && !successByUi) {
      const invalid =
        (await page.locator("text=/inválid|incorret|senha|usuário/i").count()) > 0;
      await context.close();
      await browser.close();
      return res.status(401).json({
        error_code: invalid ? "AUTH_INVALID" : "AUTH_BLOCKED",
        message: "Falha de autenticação no INLABS."
      });
    }

    // 6) TODO: Implementar navegação até a edição do DOU e extração/filtragem
    // Sugestão: a partir daqui, navegue para a página de edições e selecione date/dia/última,
    // depois extraia itens, abra cada publicação, capture full_text e aplique filtros.
    // Retorne: items[] com metadados + texto integral, e opcionalmente um PDF compilado.

    await context.close();
    await browser.close();

    return res.json({
      date_used: date ?? "AUTO",
      edition_info: "TODO: implementar coleta do DOU após login",
      source: "INLABS",
      items: []
    });
  } catch (e) {
    return res.status(500).json({ error_code: "FETCH_FAIL", message: "Falha geral no middleware." });
  }
});

// Railway injeta a porta em process.env.PORT
const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`listening:${port}`);
});
