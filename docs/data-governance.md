# Data Governance Runbook

This project captures conversation and model behavior records across engineers.

## Minimum Controls

1. Consent and notification
- Engineers should know what is captured and why.

2. Data minimization
- Keep only fields needed for model improvement and reliability analysis.

3. Redaction
- Keep `TELEMETRY_REDACT=true`.
- Add org-specific patterns for internal identifiers.

4. Retention
- Set retention windows for `data/ingested` and `data/training`.
- Delete stale raw logs after dataset curation.

5. Access control
- Restrict ingestion and export jobs to approved service identities.

6. Training gate
- Run policy filters and legal review before using exports in post-training.
