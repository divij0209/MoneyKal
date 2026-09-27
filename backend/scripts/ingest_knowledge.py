"""
Ingestion script: loads the financial knowledge base into ChromaDB.

Run once (and re-run whenever the knowledge base is updated):
    python -m backend.scripts.ingest_knowledge

This populates the vector DB so the RAG pipeline can answer financial questions.
"""
import sys
import os
import logging

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def ingest():
    logger.info("Starting knowledge base ingestion...")

    # Import the knowledge base and the RAG service
    from backend.data.knowledge.india_personal_finance import KNOWLEDGE_CHUNKS
    from backend.services.rag_service import rag_service

    logger.info(f"Found {len(KNOWLEDGE_CHUNKS)} knowledge chunks to ingest.")

    ids = [chunk[0] for chunk in KNOWLEDGE_CHUNKS]
    documents = [chunk[1] for chunk in KNOWLEDGE_CHUNKS]
    metadatas = [chunk[2] for chunk in KNOWLEDGE_CHUNKS]

    # Check if already ingested to avoid duplicates on re-run
    existing = rag_service.collection.get(ids=ids)
    existing_ids = set(existing.get("ids", []))
    
    new_ids = [i for i in ids if i not in existing_ids]
    if not new_ids:
        logger.info("All chunks are already in the database. Nothing to add.")
        logger.info("To re-ingest, delete the data/chroma_db directory and run again.")
        return

    # Only ingest the new chunks
    new_docs = [documents[ids.index(i)] for i in new_ids]
    new_meta = [metadatas[ids.index(i)] for i in new_ids]

    logger.info(f"Ingesting {len(new_ids)} new chunks (skipping {len(existing_ids)} already present)...")
    rag_service.add_documents(documents=new_docs, ids=new_ids, metadatas=new_meta)
    
    total = rag_service.collection.count()
    logger.info(f"Done! ChromaDB now contains {total} total knowledge chunks.")
    logger.info("RAG pipeline is ready.")


if __name__ == "__main__":
    ingest()
