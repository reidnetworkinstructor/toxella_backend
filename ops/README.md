# Toxella Backend (API + Worker)

This folder contains two Cloud Run services:

- `api/` — HTTP API for signed upload URLs, job creation, status, and report fetch.
- `worker/` — Pub/Sub worker that OCRs images, runs analysis, writes the report, and purges images.

Deploy each directory as a separate Cloud Run service.
