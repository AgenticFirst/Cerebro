"""Local embedding computation — TF-IDF with hashing trick (zero-setup default)."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Optional

import numpy as np

EMBED_DIM = 384
_embedder: Optional["TFIDFEmbedder"] = None


def get_embedder() -> "TFIDFEmbedder":
    global _embedder
    if _embedder is None:
        _embedder = TFIDFEmbedder()
    return _embedder


class TFIDFEmbedder:
    """Lightweight local embedder using TF-IDF with hashing trick.

    Produces fixed-dimension dense vectors from text. No model download required.
    Uses a hashing trick to project term frequencies into a fixed-size vector space.
    """

    def __init__(self, dim: int = EMBED_DIM):
        self.dim = dim

    def _tokenize(self, text: str) -> list[str]:
        """Simple whitespace + punctuation tokenizer with lowercasing."""
        text = text.lower()
        # Split on non-alphanumeric, keep tokens of length >= 2
        tokens = re.findall(r"[a-z0-9]+", text)
        return [t for t in tokens if len(t) >= 2]

    def _hash_token(self, token: str) -> int:
        """Hash a token to a bucket index."""
        h = hashlib.md5(token.encode()).hexdigest()
        return int(h, 16) % self.dim

    def _sign_hash(self, token: str) -> int:
        """Determine sign (+1 or -1) for the hashing trick."""
        h = hashlib.sha1(token.encode()).hexdigest()
        return 1 if int(h, 16) % 2 == 0 else -1

    def embed(self, text: str) -> np.ndarray:
        """Compute a fixed-dimension embedding for the given text."""
        tokens = self._tokenize(text)
        vec = np.zeros(self.dim, dtype=np.float32)

        if not tokens:
            return vec

        # Count term frequencies
        tf: dict[str, int] = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1

        # Apply hashing trick with TF-IDF-like weighting
        for token, count in tf.items():
            bucket = self._hash_token(token)
            sign = self._sign_hash(token)
            # Log-scaled TF weight
            weight = 1.0 + math.log(count)
            vec[bucket] += sign * weight

        # L2 normalize
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm

        return vec

    def embed_batch(self, texts: list[str]) -> list[np.ndarray]:
        """Embed multiple texts."""
        return [self.embed(t) for t in texts]

    def similarity(self, query: np.ndarray, candidates: list[np.ndarray]) -> np.ndarray:
        """Compute cosine similarities between query and candidates."""
        if not candidates:
            return np.array([], dtype=np.float32)
        mat = np.stack(candidates)
        return mat @ query
