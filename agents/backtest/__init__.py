"""Mini-backtest for the M4 character pipeline.

Two scripts live here:
  * ``replay_m4`` runs the M4 cycle for past ``cycle_at`` dates and
    captures every output (per-character + final signal) to a CSV
    instead of the live DB.
  * ``evaluate`` joins those captures with ``korea_market`` to compute
    forward returns and per-grade hit rates.

The replay is **idempotent** — already-completed (ticker, cycle_at)
pairs are skipped — and **cost-capped** by an explicit USD budget.

Lookahead-bias caveat: ``daily_quotes`` and ``global_quotes`` accept
an ``as_of`` cut-off and are patched per-replay-date. ``latest_funda-
mentals``, ``recent_financials``, ``macro_betas``, and ``sector_betas``
do not — they always return today's snapshot. For a 30-day mini-
backtest this is acceptable (fundamentals/betas change slowly), but
production validation will require a deeper time-machine.
"""
