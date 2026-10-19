# Codex — desplegar el repositorio ya terminado

Repositorio oficial: https://github.com/Shisetsu-Code/hybrid-cloud-fuzzer
Rama: `main`. **No hay ZIP ni parche que integrar.** El código completo, el
MCP nuevo, las pruebas y las migraciones ya están en este repositorio.

## Tarea

1. Hacer `git clone` o `git pull --ff-only` de `main`.
2. `npm ci && npm run check && npm test`. Requiere **28/28 pruebas**.
3. En la cuenta Cloudflare que autorice el usuario, ejecutar `npx wrangler whoami`,
   `npx wrangler r2 bucket list` y `npx wrangler d1 list`. Crear **solo si faltan**:
   - R2 `hybrid-fuzzer-images`
   - D1 `hybrid-cloud-fuzzer`
4. Copiar el `database_id` real de D1 en `wrangler.toml`; no usar el placeholder.
   Los bindings deben ser `DB` e `IMAGES`.
5. Aplicar las migraciones con `npx wrangler d1 migrations apply hybrid-cloud-fuzzer --remote`.
6. Configurar los secretos distintos `INGEST_TOKEN`, `REVIEW_TOKEN` y `MCP_TOKEN`
   mediante `npx wrangler secret put ...` **solo si faltan**. Nunca escribir ni
   mostrar sus valores; no regenerar secretos activos sin autorización.
7. Desplegar `npx wrangler deploy`. Verificar `GET /health` y ejecutar
   `npm run verify:deploy` configurando `HYBRID_FUZZER_URL`, `HYBRID_MCP_TOKEN`
   y `HYBRID_REVIEW_TOKEN` de manera privada. Confirmar que `tools/list` contiene
   `next_item`, `save_classification`, `save_and_next`, `get_item`, `release_item`, `queue_stats`.
8. Conectar el **nuevo** MCP (HTTP `/mcp` o `node mcp/stdio.mjs`) solo después de
   comprobar su funcionamiento. Guiarse por `docs/MCP_QUICKSTART.md`.

## Compatibilidad

El MCP **Cloud-Fuzzer antiguo** es independiente y debe permanecer conectado y
operativo. Este despliegue usa otro Worker, otra D1, otra R2 y otro MCP. No borres
ni modifiques `Shisetsu-Code/Cloud-Fuzzer` ni `Fuzzer-Manual`, no cambies sus
credenciales y no migres/borras datos automáticamente. Cuando el MCP híbrido esté
verificado, el usuario decidirá si deja el antiguo como respaldo o lo desconecta.

Las capturas antiguas pueden migrarse por separado con:

```powershell
node .\local\import-github.mjs --out=outbox
```

Luego sincronizar con `local/sync.mjs` si el usuario lo autoriza. No se ejecutan
juegos, tiradas ni compras reales durante despliegue o verificación.

## Respuesta final de Codex

Informar solamente: SHA de `main`, estado CI, resultado de 28 tests, URL real del
Worker, estado R2/D1, health y MCP; bloqueos concretos si existen.
No afirmar despliegue sin una versión confirmada por Wrangler.
