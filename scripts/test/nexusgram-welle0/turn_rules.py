"""One source of truth for NexusGram streamed-turn filtering.

Both Pyrofork's reusable ``BotWaiter`` and Welle-0's one-shot turn runner use
these rules.  A placeholder must never satisfy a content probe, whereas any
non-empty bot activity (including a placeholder) violates expect-silence.
"""

from __future__ import annotations

import re


ANIMATION_MARKERS = (
    "Denke nach",
    "Brauche länger",
    "🧠",
    "🐌",
    "◐",
    "◓",
    "◑",
    "◒",
    "⏳",
    "…",
    # Voice acknowledgement emitted before transcription completes.
    "Transcribing",
)
_AUXILIARY_MARKER_RE = re.compile(r"^⏱\s+~?\d+\s*(Min|s)$")


def is_animation_placeholder(text: str) -> bool:
    """Whether a short message is a thinking/transcribing animation."""
    return len(text) < 80 and any(marker in text for marker in ANIMATION_MARKERS)


def is_trail_emoji(text: str) -> bool:
    """Whether a short, non-alphanumeric pointer bubble follows real content."""
    return len(text) <= 4 and bool(text) and not any(char.isalnum() for char in text)


def is_auxiliary_footer(text: str) -> bool:
    """Whether text is the separate RF-6 latency footer, not an answer."""
    return bool(_AUXILIARY_MARKER_RE.match(text.strip()))


def is_substantive_reply(text: str) -> bool:
    """Content that may satisfy a normal reply probe."""
    stripped = text.strip()
    return bool(stripped) and not (
        is_animation_placeholder(stripped)
        or is_trail_emoji(stripped)
        or is_auxiliary_footer(stripped)
    )


def has_unexpected_silence_activity(text: str) -> bool:
    """Every visible bot message, placeholders included, violates silence."""
    return bool(text.strip())
