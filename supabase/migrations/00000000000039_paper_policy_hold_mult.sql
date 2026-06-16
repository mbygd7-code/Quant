-- 00000000000039_paper_policy_hold_mult.sql
-- Seed HOLD grade into the trading policy so HOLD-discretionary fills
-- (paper_trader_bot._is_buyable for HOLD + weighted_score ≥ +0.10) get
-- a smaller, sensible position size instead of falling back to BUY's
-- multiplier or zero.
--
-- Why this fix: the bot only ordered 2 positions in practice because
-- BUY_GRADES = ("STRONG_BUY", "BUY") was the entire eligibility gate
-- and the consensus rarely issues those grades in mild-bullish regimes.
-- Admitting HOLD-positive as a junior fill keeps the book engaged.
--
-- This migration appends a NEW version (never mutates history) so the
-- learner's evolution trail stays append-only and auditable.

DO $$
DECLARE
    latest_version  BIGINT;
    latest_params   JSONB;
    latest_episodes INT;
    new_params      JSONB;
BEGIN
    -- Most recent policy version (may not exist on a fresh DB).
    SELECT version, params, n_episodes
      INTO latest_version, latest_params, latest_episodes
      FROM paper_policy_state
      ORDER BY version DESC
      LIMIT 1;

    IF latest_version IS NULL THEN
        -- No policy yet: nothing to migrate; the bot's hardcoded
        -- DEFAULT_PARAMS already includes HOLD=0.40 after this PR.
        RETURN;
    END IF;

    -- Only act when the live policy has no HOLD entry yet (idempotent).
    IF latest_params #> '{grade_mult, HOLD}' IS NOT NULL THEN
        RETURN;
    END IF;

    new_params := jsonb_set(
        latest_params,
        '{grade_mult, HOLD}',
        '0.40'::jsonb,
        true
    );

    INSERT INTO paper_policy_state (params, evidence, notes, n_episodes)
    VALUES (
        new_params,
        jsonb_build_object(
            'migration', '00000000000039_paper_policy_hold_mult',
            'reason',    'HOLD-discretionary fill enabled — bot was '
                         'stuck at 2 positions because BUY_GRADES gated '
                         'eligibility too tightly in mild-bullish regimes',
            'inherits_from_version', latest_version
        ),
        'HOLD 신뢰배수 0.40 추가 — STRONG_BUY/BUY가 드문 시기에도 '
        '책상이 일을 하도록, 단 BUY(0.65)보다 작은 배분으로',
        COALESCE(latest_episodes, 0)
    );
END $$;

NOTIFY pgrst, 'reload schema';
