"""RAG (Retrieval-Augmented Generation) — investment thesis chunk store.

Each chunk is a *self-contained investment hypothesis* — see SKILL.md §7.
Format on disk: YAML files under cognition/rag/chunks/<sector>/<chunk_id>.yaml.
Storage: Supabase `rag_chunks` table with 1536-dim embedding.

Public surface:
  - load_chunks(): read all YAML chunks from disk
  - embed_and_upsert(): embed bodies + write to rag_chunks
  - retrieve(query, ticker, top_k): semantic search via match_rag_chunks RPC
"""
from cognition.rag.loader import RawChunk, load_chunks
from cognition.rag.retriever import RetrievedChunk, retrieve

__all__ = [
    "RawChunk",
    "RetrievedChunk",
    "load_chunks",
    "retrieve",
]
