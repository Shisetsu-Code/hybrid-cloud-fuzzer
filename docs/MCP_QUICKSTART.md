# Hybrid Fuzzer MCP — integración y clasificación rápida

**Remoto**: `https://<YOUR_SUBDOMAIN>.workers.dev/mcp` (HTTP POST stateless).
Header `Authorization: Bearer <MCP_TOKEN>`. Solo el operador debe conocer el token.

**Codex stdio**: iniciar `node mcp/stdio.mjs` con estas variables de entorno
protegidas, nunca persistidas en Git:

- `HYBRID_FUZZER_URL` = URL completa del Worker, sin `/mcp`.
- `HYBRID_MCP_TOKEN` = valor privado de `MCP_TOKEN` guardado en Cloudflare.

Conectar el ejecutable como servidor MCP stdio desde la configuración de Codex.
Si el cliente admite MCP remoto stateless con Bearer, usar `/mcp` directamente.
La conexión debe probarse con `initialize` y `tools/list`, **no solo `/health`**.

## Bucle rápido recomendado

1. `next_item({runId,leaseSeconds:300})` → una lista compacta de candidatos.
2. Si `mode=structured`, decidir IDs sin abrir una imagen.
3. Si `mode=hybrid/visual`, revisar el JPEG y agregar coordenadas normalizadas.
4. `save_and_next` con los mismos `id`, `leaseId`, `revision`, `sourceSha256` y
   **todas** las selecciones/marks de esa pantalla, más `runId` para reclamar la
   siguiente dentro de la misma llamada.
5. Repetir usando `next.item`; si devuelve `next.empty=true`, terminar.

`save_classification` permanece disponible por compatibilidad.
`get_item({id,leaseId,includeImage:true})` entrega una captura de respaldo bajo
lease válido incluso cuando el elemento llegó en modo estructurado y se subió
una imagen opcional.

Estados permitidos: `classified` y `needs_review`. `needs_review` no es una
compra confirmada y se puede revisar manualmente después. Las marcas no se
convierten en clicks por sí mismas: el ejecutor local consume el feed D1 de
forma independiente y debe validar la versión de origen.

La clasificación dura menos al evitar imágenes completas y commits por cada
juego. No inventar métricas de velocidad: informar segundos reales por elemento.
