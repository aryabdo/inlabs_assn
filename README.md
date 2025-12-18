# inlabs_assn

Middleware HTTP para autenticar no INLABS (DOU) com **sessão limpa + login forçado** usando Playwright,
e expor um endpoint REST que o ChatGPT (Custom Action) consegue chamar.

> **Segurança**
> - NÃO coloque credenciais no código.
> - Configure as variáveis no Railway: `INLABS_USER`, `INLABS_PASS`, `MIDDLEWARE_API_KEY`.
> - O endpoint exige `X-API-Key`.

## Endpoints

- `GET /health` → `{ ok: true }`
- `POST /dou/transmissao` → Busca o DOU via INLABS (placeholder de coleta; login implementado)

### POST /dou/transmissao
**Headers**
- `X-API-Key: <sua chave>`
- `Content-Type: application/json`

**Body (opcional)**
```json
{ "date": "YYYY-MM-DD", "include_pdf": true }
```

**Resposta (200)**
```json
{
  "date_used": "YYYY-MM-DD|AUTO",
  "edition_info": "TODO",
  "source": "INLABS",
  "items": []
}
```

## Rodando localmente (opcional)
Requer Node 18+.

```bash
npm install
export INLABS_USER="..."
export INLABS_PASS="..."
export MIDDLEWARE_API_KEY="uma-chave-forte"
export PORT=8080
npm start
```

Teste:
```bash
curl -sS -X POST "http://localhost:8080/dou/transmissao" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $MIDDLEWARE_API_KEY" \
  -d '{"date":"2025-12-18"}'
```

## Deploy no Railway (resumo)
1. Crie um projeto no Railway e faça **Deploy from GitHub Repo**.
2. Garanta que o Railway detectou o `Dockerfile`.
3. Em **Variables**, configure:
   - `INLABS_USER`
   - `INLABS_PASS`
   - `MIDDLEWARE_API_KEY`
4. Em **Settings → Networking**, habilite **Public Networking** e gere um domínio.
5. Teste com curl usando o domínio público.

## Custom Action (OpenAPI)
Use o arquivo `openapi.yaml` no GPT Builder. No campo `servers.url`, coloque seu domínio público do Railway.
Autenticação: **API Key** via header `X-API-Key`.
