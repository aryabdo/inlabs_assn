import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

function safeMsg(err) {
  // Não vazar detalhes sensíveis; log interno pode existir no Railway
  return err instanceof Error ? err.message : String(err);
}

async function safeClose(obj) {
  try {
    if (obj) await obj.close();
  } catch (_) {
    // ignora
  }
}

/**
 * Login forçado no INLABS:
 * - Sessão limpa (novo browserContext)
 * - Acessa /acessar.php
 * - Preenche campos dentro de form[action='logar.php'] usando #email e #password
 * - Submete e valida sucesso por sinais objetivos
 *
 * Retorna:
 * - { ok: true } se logado
 * - { ok: false, code: "...", message: "..." } se falhar
 */
async function loginInlabs(page, context, { user, pass }) {
  await page.goto("https://inlabs.in.gov.br/acessar.php", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Detecção genérica de captcha/validação humana (sem bypass)
  const hasCaptcha =
    (await page.locator("iframe[src*='captcha']").count()) > 0 ||
    (await page.locator("iframe[src*='recaptcha']").count()) > 0 ||
    (await page.locator("text=/não sou um robô/i").count()) > 0 ||
    (await page.locator("text=/recaptcha/i").count()) > 0;

  if (hasCaptcha) {
    return {
      ok: false,
      code: "AUTH_REQUIRED_HUMAN",
      message: "Captcha/validação humana detectada no login.",
    };
  }

  // Âncora no form correto: <form action="logar.php" method="post">
  const loginForm = page.locator("form[action='logar.php']").first();
  await loginForm.waitFor({ state: "visible", timeout: 30000 });

  const emailField = loginForm.locator("#email");
  const passField = loginForm.locator("#password");

  await emailField.waitFor({ state: "visible", timeout: 30000 });
  await passField.waitFor({ state: "visible", timeout: 30000 });

  // Botão: <input class="btn btn-primary" type="submit" value="Logar">
  const submitBtn = loginForm.locator("input[type='submit'][value='Logar']").first();

  await emailField.fill(user);
  await passField.fill(pass);

  // Submeter e aguardar (nem sempre há navegação; pode atualizar a mesma página)
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
    submitBtn.click({ timeout: 30000 }),
  ]);

  // Pós-submit: detectar captcha/MFA que apareceu depois
  const captchaAfter =
    (await page.locator("iframe[src*='captcha']").count()) > 0 ||
    (await page.locator("iframe[src*='recaptcha']").count()) > 0 ||
    (await page.locator("text=/não sou um robô/i").count()) > 0;

  if (captchaAfter) {
    return {
      ok: false,
      code: "AUTH_REQUIRED_HUMAN",
      message: "Captcha/validação humana detectada após submit.",
    };
  }

  // Validação objetiva de login:
  // 1) URL não está em /acessar.php nem logar.php
  // 2) Existem sinais de área logada (ex.: "Sair/Logout")
  // 3) Form de login não está mais presente (heurística auxiliar)
  const url = page.url();
  const successByUrl = !url.includes("/acessar.php") && !url.includes("logar.php");

  const hasLogoutWord =
    (await page.locator("text=/sair|logout/i").count()) > 0 ||
    (await page.locator("a:has-text('Sair'), button:has-text('Sair')").count()) > 0;

  const stillHasLoginForm = (await page.locator("form[action='logar.php']").count()) > 0;

  const loggedIn = successByUrl || hasLogoutWord || !stillHasLoginForm;

  if (!loggedIn) {
    const invalidMsg =
      (await page.locator("text=/inválid|incorret|senha|usuário|usuario/i").count()) > 0;

    return {
      ok: false,
      code: invalidMsg ? "AUTH_INVALID" : "AUTH_BLOCKED",
      message: "Falha de autenticação no INLABS.",
    };
  }

  return { ok: true };
}

app.post("/dou/transmissao", async (req, res) => {
  let browser = null;
  let context = null;

  try {
    // 1) Proteção do endpoint
    const apiKey = req.header("X-API-Key");
    if (!apiKey || apiKey !== process.env.MIDDLEWARE_API_KEY) {
      return res.status(401).json({ error_code: "UNAUTHORIZED", message: "API key inválida." });
    }

    // 2) Entradas
    const date = req.body?.date ?? null; // YYYY-MM-DD ou null
    const includePdf = req.body?.include_pdf ?? true;

    // 3) Credenciais do INLABS (Railway Variables)
    const user = process.env.INLABS_USER;
    const pass = process.env.INLABS_PASS;
    if (!user || !pass) {
      return res.status(500).json({
        error_code: "CONFIG_FAIL",
        message: "INLABS_USER/INLABS_PASS não configurados no ambiente.",
      });
    }

    // 4) Sessão limpa + login forçado
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    context = await browser.newContext(); // sessão limpa
    const page = await context.newPage();

    const login = await loginInlabs(page, context, { user, pass });
    if (!login.ok) {
      const status = login.code === "AUTH_REQUIRED_HUMAN" ? 409 : 401;
      return res.status(status).json({ error_code: login.code, message: login.message });
    }

    // 5) TODO: Implementar navegação/extração do DOU no INLABS pós-login
    // - Resolver date_used (dia/última/data)
    // - Listar publicações + abrir cada uma e coletar full_text
    // - Aplicar filtros de transmissão (suas listas)
    // - (Opcional) gerar PDF e retornar base64
    //
    // Por enquanto, retornamos payload básico para confirmar que autenticou.
    return res.json({
      date_used: date ?? "AUTO",
      edition_info: "TODO: implementar coleta do DOU após login",
      source: "INLABS",
      items: [],
      // pdf: { filename: "...", content_base64: "..." }  // quando implementar
    });
  } catch (err) {
    return res.status(500).json({
      error_code: "FETCH_FAIL",
      message: "Falha geral no middleware.",
      detail: safeMsg(err),
    });
  } finally {
    await safeClose(context);
    await safeClose(browser);
  }
});

// Railway injeta a porta em process.env.PORT
const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`listening:${port}`);
});
