# Changelog

All notable changes to QuantSignal are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Version: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Bootstrap project scaffold (Prompt 01):
  - Folder tree (collectors / refinery / cognition / signal / executor /
    orchestrator / notifier / db / apps/api / apps/web / tests)
  - Supabase CLI config + 8 initial migrations (extensions, core tables,
    executor tables, user tables, RLS policies, RPC functions, triggers,
    seed weight config)
  - Seed data: 50 KR watchlist stocks + US-KR mapping matrix (SKILL.md §4)
  - Shared `db/` clients (Supabase admin + anon, Storage helpers)
  - FastAPI entrypoint `apps/api/index.py` (health, telegram webhook,
    backtest dispatch — Vercel Serverless)
  - Pipeline entrypoint `orchestrator/pipeline.py` (skeleton)
  - GitHub Actions: `ci.yml`, `migrate.yml`, `daily-pipeline.yml`,
    `backtest.yml`
  - `vercel.json`, `.env.example`, `.gitignore`, `pyproject.toml`, `README.md`
