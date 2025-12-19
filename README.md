# inlabs_assn (Railway)

Middleware HTTP para integração INLABS/DOU com GPT Actions sem estourar limite de resposta.

## Endpoints
- POST /dou/transmissao  -> index leve (snippet + metadados)
- POST /dou/item         -> detalhe (full_text) de 1 entry

## Variáveis (Railway -> Variables)
- INLABS_USER
- INLABS_PASS
- MIDDLEWARE_API_KEY

## Testes
Health:
curl -sS https://SEU-DOMINIO/health

Index leve:
curl -sS -X POST https://SEU-DOMINIO/dou/transmissao \
  -H "Content-Type: application/json" \
  -H "X-API-Key: SUA_KEY" \
  -d '{"date":"2025-12-18","max_items":25,"snippet_max_chars":900,"max_zips":6}'

Detalhe de item:
curl -sS -X POST https://SEU-DOMINIO/dou/item \
  -H "Content-Type: application/json" \
  -H "X-API-Key: SUA_KEY" \
  -d '{"date":"2025-12-18","zip_name":"2025-12-18-DO1.zip","entry_name":"515_20251218_23434977.xml"}'
