"""Database models + repository for the 8-agent system.

Re-exports the most common types so callers can write::

    from agents.db import AgentName, AgentOutput, AgentRepository

instead of reaching into the submodules.
"""
from agents.db.models import (
    AgentKnowledge,
    AgentKnowledgeNew,
    AgentName,
    AgentOutput,
    AgentOutputNew,
    DailyBriefing,
    DailyBriefingNew,
    FinalSignal,
    FinalSignalNew,
    KnowledgeType,
    SignalChangeEvent,
    SignalChangeEventNew,
    SignalGrade,
    SorosWeightAdjustment,
    SorosWeightAdjustmentNew,
    UserWeightSettings,
    UserWeightSettingsNew,
    WeightsBundle,
    WeightSettingsHistory,
    WeightSettingsHistoryNew,
    WeightSource,
)
from agents.db.repository import AgentRepository, get_agent_repository

__all__ = [
    "AgentKnowledge",
    "AgentKnowledgeNew",
    "AgentName",
    "AgentOutput",
    "AgentOutputNew",
    "AgentRepository",
    "DailyBriefing",
    "DailyBriefingNew",
    "FinalSignal",
    "FinalSignalNew",
    "KnowledgeType",
    "SignalChangeEvent",
    "SignalChangeEventNew",
    "SignalGrade",
    "SorosWeightAdjustment",
    "SorosWeightAdjustmentNew",
    "UserWeightSettings",
    "UserWeightSettingsNew",
    "WeightSettingsHistory",
    "WeightSettingsHistoryNew",
    "WeightSource",
    "WeightsBundle",
    "get_agent_repository",
]
