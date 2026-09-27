import os
import chromadb
from chromadb.config import Settings
import logging
from typing import List, Dict, Any

from backend.services.gemini_service import gemini_service

logger = logging.getLogger(__name__)

# Initialize ChromaDB in the backend/data directory
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "chroma_db")
os.makedirs(DB_PATH, exist_ok=True)

class RagService:
    def __init__(self):
        self.client = chromadb.PersistentClient(path=DB_PATH)
        self.collection_name = "financial_knowledge"
        
        # We use a custom embedding function because we want to use Gemini's text-embedding API
        # instead of Chroma's default sentence-transformers (which downloads a large model locally).
        self.collection = self.client.get_or_create_collection(name=self.collection_name)

    def _get_embedding(self, text: str) -> List[float]:
        """Call Gemini to get an embedding for the text."""
        if not gemini_service.client:
            raise RuntimeError("Gemini client not configured")
        
        from google.genai import types
        # text-embedding-004 is the recommended embedding model for Gemini
        response = gemini_service.client.models.embed_content(
            model='models/gemini-embedding-001',
            contents=text,
            config=types.EmbedContentConfig(
                task_type="RETRIEVAL_DOCUMENT"
            )
        )
        return response.embeddings[0].values

    def _get_query_embedding(self, text: str) -> List[float]:
        if not gemini_service.client:
            raise RuntimeError("Gemini client not configured")
        
        from google.genai import types
        response = gemini_service.client.models.embed_content(
            model='models/gemini-embedding-001',
            contents=text,
            config=types.EmbedContentConfig(
                task_type="RETRIEVAL_QUERY"
            )
        )
        return response.embeddings[0].values

    def add_documents(self, documents: List[str], ids: List[str], metadatas: List[Dict[str, Any]] = None):
        """Add chunks of text to the vector database."""
        logger.info(f"Embedding {len(documents)} documents...")
        embeddings = [self._get_embedding(doc) for doc in documents]
        self.collection.add(
            documents=documents,
            embeddings=embeddings,
            ids=ids,
            metadatas=metadatas
        )
        logger.info("Successfully added documents to ChromaDB.")

    def search(self, query: str, top_k: int = 3) -> List[str]:
        """Search the vector database for the most relevant documents to a query."""
        logger.info(f"Searching RAG for: '{query}'")
        query_embedding = self._get_query_embedding(query)
        results = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k
        )
        
        if not results or not results['documents']:
            return []
            
        return results['documents'][0]

rag_service = RagService()
