"""Profile pictures: validate, normalise and store.

WHERE THE IMAGE LIVES, AND WHY
------------------------------
In `Profile.raw_inputs`, the JSON column the profile already uses, as a
`data:` URI. Three alternatives were considered and rejected:

  * A new `avatar` column would need an Alembic migration against a database
    that is shared and already at head. A picture is not worth a schema change.
  * The local filesystem does not survive a container restart — the API is
    deployed from a Dockerfile onto ephemeral disk, so an avatar written to
    /app would vanish on the next deploy and 404 for every user.
  * An object store (S3, Supabase Storage) means a bucket, credentials, a
    lifecycle policy and a second failure mode, for one small image per user.

Storing bytes in a row is only reasonable if the bytes stay small, so that is
enforced rather than hoped for: every upload is decoded, re-encoded and
downscaled to at most 256x256 before it is stored. A 4 MB phone photo becomes
roughly 15-25 KB of JPEG. The stored string is hard-capped as a last line of
defence.

Pillow does the decoding, which is also the real validation: a file is an image
if and only if an image library can decode it. Checking the Content-Type header
alone would accept anything a client cared to mislabel.
"""
from __future__ import annotations

import base64
import io
from typing import Tuple

try:
    from PIL import Image, UnidentifiedImageError
except ImportError:  # pragma: no cover - Pillow is a declared dependency
    Image = None
    UnidentifiedImageError = Exception


class AvatarError(ValueError):
    """A rejected upload, with a message written for the person who sent it."""


# What a browser may send. Kept narrow on purpose: these three cover every
# camera and screenshot path, and excluding SVG excludes a scriptable format.
ALLOWED_CONTENT_TYPES = {
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/jpg": "JPEG",
    "image/webp": "WEBP",
}

# Generous for a phone photo, small enough that a mistake cannot fill a row.
MAX_UPLOAD_BYTES = 4 * 1024 * 1024        # 4 MB in
AVATAR_SIZE = 256                          # px, square
MAX_STORED_CHARS = 400_000                 # ~300 KB of base64; never reached in practice

# The first bytes of each accepted format. A Content-Type header is a claim by
# the client; this is evidence.
_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"\xff\xd8\xff", "JPEG"),
)


def _sniff(data: bytes) -> str | None:
    for prefix, kind in _MAGIC:
        if data.startswith(prefix):
            return kind
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def process_upload(data: bytes, content_type: str | None) -> str:
    """Validate and normalise an uploaded image into a stored data URI.

    Raises AvatarError with a message safe to show the user.
    """
    if Image is None:
        raise AvatarError(
            "Image processing is unavailable on this server. Ask an administrator "
            "to install Pillow."
        )
    if not data:
        raise AvatarError("That file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise AvatarError(
            "That image is %.1f MB. Please choose one under %d MB."
            % (len(data) / 1024 / 1024, MAX_UPLOAD_BYTES // 1024 // 1024)
        )

    declared = (content_type or "").split(";")[0].strip().lower()
    if declared and declared not in ALLOWED_CONTENT_TYPES:
        raise AvatarError("Use a PNG, JPG or WebP image.")
    if _sniff(data) is None:
        # The bytes are not any format we accept, whatever the header said.
        raise AvatarError("That file does not look like a PNG, JPG or WebP image.")

    try:
        with Image.open(io.BytesIO(data)) as img:
            img.load()                       # force a full decode, not just the header
            has_alpha = img.mode in ("RGBA", "LA", "P")
            img = img.convert("RGBA" if has_alpha else "RGB")
            img = _square(img)
            img = img.resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)

            out = io.BytesIO()
            if has_alpha:
                img.save(out, format="PNG", optimize=True)
                mime = "image/png"
            else:
                img.save(out, format="JPEG", quality=86, optimize=True)
                mime = "image/jpeg"
    except AvatarError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise AvatarError("That image could not be read. Try a different file.") from exc

    encoded = base64.b64encode(out.getvalue()).decode("ascii")
    uri = "data:%s;base64,%s" % (mime, encoded)
    if len(uri) > MAX_STORED_CHARS:
        # Unreachable for a 256px image; here so a future size change cannot
        # quietly start writing megabytes into a JSON column.
        raise AvatarError("That image could not be compressed small enough.")
    return uri


def _square(img):
    """Centre-crop to a square so the circular avatar never distorts a face."""
    w, h = img.size
    if w == h:
        return img
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def get_avatar(profile) -> str | None:
    raw = profile.raw_inputs if isinstance(profile.raw_inputs, dict) else {}
    value = raw.get("avatar")
    return value if isinstance(value, str) and value.startswith("data:image/") else None


def set_avatar(profile, uri: str | None) -> None:
    """Write or clear the avatar.

    Reassigns raw_inputs rather than mutating it: SQLAlchemy does not track
    in-place changes to a JSON column, so mutating the dict would look like it
    worked and then not persist.
    """
    raw = dict(profile.raw_inputs) if isinstance(profile.raw_inputs, dict) else {}
    if uri:
        raw["avatar"] = uri
    else:
        raw.pop("avatar", None)
    profile.raw_inputs = raw


def initials_for(profile, username: str | None = None) -> str:
    """The fallback shown when there is no picture.

    Up to two letters from the display name, falling back to the email's local
    part, and finally to a neutral dot rather than an empty circle.
    """
    source = (getattr(profile, "persona", None) or "").strip()
    if not source:
        raw = profile.raw_inputs if isinstance(profile.raw_inputs, dict) else {}
        source = str(raw.get("full_name") or "").strip()
    if not source:
        source = (username or "").split("@")[0].replace(".", " ").strip()

    parts = [p for p in source.split() if p and p[0].isalnum()]
    if not parts:
        return "·"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()
