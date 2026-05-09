"""8-agent character system.

Lives ALONGSIDE the legacy 7-step pipeline (collectors → refinery →
cognition → signals → executor → orchestrator → notifier). Strangler
Fig: nothing in this package modifies the legacy code. The 8 characters
read from existing tables (ai_scores, korea_market, news_with_sentiment,
market_briefs) and write to the new tables introduced by migrations
18-22:

    agent_outputs                — every agent's per-cycle output
    final_signals                — Soros' grade per ticker
    signal_change_events         — grade transition ledger
    daily_briefings              — Soros' day-opener card
    user_weight_settings         — per-user weights for the 6 voting agents
    weight_settings_history      — append-only weight ledger
    soros_weight_adjustments     — Soros' temporary ±50% overlays
    agent_knowledge              — long-term memory (M8 populates)

Module layout:

    agents/db/                   — table-row models + repository
    agents/weights/              — validation, normalization, overlays  (M1-T4)
    agents/llm/                  — callClaude wrapper                   (M1-T6)
    agents/observability/        — cost/usage telemetry                 (M1-T10)
    agents/characters/           — per-character implementations        (M2+)

Design source of truth: docs/quantsignal-design-docs/.
Implementation plan: docs/quantsignal-design-docs/M1-WORK-PLAN.md.
"""
__all__: list[str] = []
