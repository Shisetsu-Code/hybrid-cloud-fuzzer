# GPT quality review inside the current batch

Migration 0006 adds capture_reviews and capture_timings; existing items and
classifications are untouched. Capture quality is separate from gameplay review.

The GitHub-hosted runner uploads a private JPEG to POST /v1/capture-reviews
(INGEST token) before item ingestion. Identity: runId/provider/gameId/shotId and
random browser sessionId. A pending screenshot is not a valid catalogue item.

GPT uses MCP capture_reviews (runId, cursor), capture_review_image (id), then
capture_review_action with the exact sessionId/revision/imageSha256 shown.
Actions: wait, click normalized x/y on the screenshot, or approve. reason and
reviewer are mandatory. waitMs is the delay before the next screenshot;
initialWaitMs optionally updates the starting delay for this game alone.
Default delay is 25000 ms. No OCR, balance terms, Laya or Qwen decide readiness.

The runner polls /v1/capture-reviews/command with INGEST token, renewing its
provider permit. Taking an instruction consumes it atomically before execution.
A lost delivery stops the runner instead of repeating a possible click. A new
browser must publish a fresh image after the old session expires (120 seconds).
Pending screenshots and prior instructions remain in D1/R2. Offline sessions
cannot accept click/wait instructions. Approval remains bound to the exact JPEG.

One browser waits at most ten minutes / twenty observations for GPT; timeout
stops that provider with reviewPending, preserves the same batch, and never
counts the image as valid. No recurrence or automatic new batch is enabled.
Approval permits ordinary item ingestion with captureValidation.reviewId and
revision. The backend independently checks image hash, game, shot and run.
Approval itself never saves gameplay classifications or executes purchases.

Existing accepted catalogue items are skipped as before. Legacy OCR ingestion
remains compatible for other producers. The guided catalogue workflow bypasses
the OCR gate; it does not automatically classify, spin, buy or bet. GPT cleanup
clicks must only dismiss entry/consent/overlay screens visible in this game.
