import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

async function safeClose(obj) {
  try { if (obj) await obj.close(); } catch (_) {}
}

function containsAuthInvalid(text) {
  // Procure termos realmente de erro, não “Senha/Usuário” (labels do form)
  const t = (text || "").toLowerCase();
  return (
    t.includes("inválid") ||
    t.includes("invalid") ||
    t.includes("incorret") ||
    t.includes("não confere") ||
    t.includes("nao confere") ||
    t.includes("tente novamente") ||
    t.includes("dados incorretos") ||
    t.includes("falha ao autenticar")
  );
}

async function loginInlabs(page, context, { user, pass }) {
  await page.goto("https://inlabs.in.gov.br/acessar.php", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Captcha / challenge (sem bypass)
  const hasCaptcha =
    (await page.locator("iframe[src*='captcha']").count()) > 0 ||
    (await page.locator("iframe[src*='recaptcha']").count()) > 0 ||
    (await page.locator("text=/não sou um robô/i").count()) > 0 ||
    (await page.locator("text=/recaptcha/i").count()) > 0;

  if (hasCaptcha) {
    return { ok: false, code: "AUTH_REQUIRED_HUMAN", message: "Captcha/validação humana detectada no login." };
  }

  // Form correto
  const loginForm = page.locator("form[action='logar.php']").first();
  await loginForm.waitFor({ state: "visible", timeout: 30000 });

  const emailField = loginForm.locator("#email");
  const passField  = loginForm.locator("#password");
  const submitBtn  = loginForm.locator("input[type='submit'][value='Logar']").first();

  await emailField.waitFor({ state: "visible", timeout: 30000 });
  await passField.waitFor({ state: "visible", timeout: 30000 });

  await emailField.fill(user);
  await passField.fill(pass);

  // Submit (pode ou não navegar)
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
    submitBtn.click({ timeout: 30000 }),
  ]);

  // Pós-submit: captcha
  const hasCaptchaAfter =
    (await page.locator("iframe[src*='captcha']").count()) > 0 ||
    (await page.locator("iframe[src*='recaptcha']").count()) > 0 ||
    (await page.locator("text=/não sou um robô/i").count()) > 0;

  if (hasCaptchaAfter) {
    return { ok: false, code: "AUTH_REQUIRED_HUMAN", message: "Captcha/validação humana detectada após submit." };
  }

  // Capturar possíveis alertas/erros (sem dados sensíveis)
  const alertTextParts = await page
    .locator(".alert, .text-danger, .invalid-feedback, .help-block")
    .allTextContents()
    .catch(() => []);

  const alertText = (alertTextParts || []).join(" | ").trim();

  // Validação objetiva de login (genérica)
  const urlAfter = page.url();
  const stillHasLoginForm = (await page.locator("form[action='logar.php']").count()) > 0;

  const hasLogoutWord =
    (await page.locator("text=/sair|logout/i").count()) > 0 ||
    (await page.locator("a:has-text('Sair'), button:has-text('Sair')").count()) > 0;

  const successByUrl =
    !urlAfter.includes("/acessar.php") &&
    !urlAfter.includes("logar.php");

  // Critério de sucesso: URL mudou para área logada OU aparece “Sair/Logout”
  const loggedIn = successByUrl || hasLogoutWord;

  if (!loggedIn) {
    // Classificar erro com base em mensagem real, não em labels
    const invalid = containsAuthInvalid(alertText);

    return {
      ok: false,
      code: invalid ? "AUTH_INVALID" : "AUTH_BLOCKED",
      message: "Falha de autenticação no INLABS.",
      debug: {
        url_after_submit: urlAfter,
        still_has_login_form: stillHasLoginForm,
        alert_text: alertText || null
      }
    };
  }

  return { ok: true, debug: { url_after_submit: urlAfter } };
}

app.post("/dou/transmissao", async (req, res) => {
  let browser = null;
  let context = null;

  try {
    // 1) API key do middleware
    const apiKey = req.header("X-API-Key");
    if (!apiKey || apiKey !== process.env.MIDDLEWARE_API_KEY) {
      return res.status(401).json({ error_code: "UNAUTHORIZED", message: "API key inválida." });
    }

    // 2) Inputs
    const date = req.body?.date ?? null; // YYYY-MM-DD ou null
    const includePdf = req.body?.include_pdf ?? true;

    // 3) Credenciais do INLABS via Railway Variables
    const user = (process.env.INLABS_USER || "").trim();
    const pass = (process.env.INLABS_PASS || "").trim();

    if (!user || !pass) {
      return res.status(500).json({
        error_code: "CONFIG_FAIL",
        message: "INLABS_USER/INLABS_PASS não configurados no ambiente."
      });
    }

    // 4) Browser + sessão limpa
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    context = await browser.newContext({
      locale: "pt-BR",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    });

    // reduzir sinalização de automação (não é bypass; só compatibilidade)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();

    // 5) Login
    const login = await loginInlabs(page, context, { user, pass });
    if (!login.ok) {
      const status = login.code === "AUTH_REQUIRED_HUMAN" ? 409 : 401;
      return res.status(status).json({
        error_code: login.code,
        message: login.message,
        debug: login.debug || undefined
      });
    }

    // 6) TODO: coleta do DOU pós-login
    return res.json({
      date_used: date ?? "AUTO",
      edition_info: "TODO: implementar coleta do DOU após login",
      source: "INLABS",
      items: []
      // pdf: { filename: "...", content_base64: "..." }
    });

  } catch (err) {
    return res.status(500).json({
      error_code: "FETCH_FAIL",
      message: "Falha geral no middleware."
    });
  } finally {
    await safeClose(context);
    await safeClose(browser);
  }
});

// Railway injeta a porta em process.env.PORT
const port = Number(process.env.PORT || 8080);
app.listen(port, "0.0.0.0", () => console.log(`listening:${port}`));
