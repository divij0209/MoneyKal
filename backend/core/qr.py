"""
QR Code (model 2) encoder — byte mode, error correction level M, versions 1-10.

Written here rather than pulled in as a dependency. The only QR MoneyKal draws
is the demo UPI payment code in checkout: one short ASCII payload, one error
correction level, one encoding mode. A QR library carries kanji modes, ECI,
micro-QR, structured append and image rendering that none of that needs, and
backend/requirements.txt is deliberately short.

What comes out is a square matrix of 0/1 ints. Rendering is the caller's job —
backend/services/billing_service.py hands the matrix to the browser, which
draws it as SVG, so nothing here depends on Pillow or on a file being written.

The algorithm is ISO/IEC 18004. The tables below are that standard's, trimmed
to level M and the ten smallest versions (up to 213 payload bytes, where a UPI
URI is about 110).
"""
from typing import List, Tuple

# ---------------------------------------------------------------------------
# Standard tables (error correction level M only)
# ---------------------------------------------------------------------------

# version -> (EC codewords per block, [(block count, data codewords per block)])
_EC_BLOCKS = {
    1:  (10, [(1, 16)]),
    2:  (16, [(1, 28)]),
    3:  (26, [(1, 44)]),
    4:  (18, [(2, 32)]),
    5:  (24, [(2, 43)]),
    6:  (16, [(4, 27)]),
    7:  (18, [(4, 31)]),
    8:  (22, [(2, 38), (2, 39)]),
    9:  (22, [(3, 36), (2, 37)]),
    10: (26, [(4, 43), (1, 44)]),
}

# Row/column centres of the alignment patterns.
_ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

# Bits of padding after the last codeword, so the data region fills exactly.
_REMAINDER_BITS = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0}

MAX_VERSION = 10


class QREncodeError(ValueError):
    """The payload does not fit in the versions this encoder supports."""


# ---------------------------------------------------------------------------
# GF(256) — the field Reed-Solomon works in, x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
# ---------------------------------------------------------------------------

_EXP = [0] * 512
_LOG = [0] * 256
_v = 1
for _i in range(255):
    _EXP[_i] = _v
    _LOG[_v] = _i
    _v <<= 1
    if _v & 0x100:
        _v ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _generator(degree: int) -> List[int]:
    """The Reed-Solomon generator polynomial for `degree` EC codewords."""
    poly = [1]
    for i in range(degree):
        nxt = [0] * (len(poly) + 1)
        for j, coef in enumerate(poly):
            nxt[j] ^= coef
            nxt[j + 1] ^= _mul(coef, _EXP[i])
        poly = nxt
    return poly


def _ec_codewords(data: List[int], count: int) -> List[int]:
    gen = _generator(count)
    rem = list(data) + [0] * count
    for i in range(len(data)):
        coef = rem[i]
        if coef:
            for j, g in enumerate(gen):
                rem[i + j] ^= _mul(g, coef)
    return rem[len(data):]


# ---------------------------------------------------------------------------
# Data encoding
# ---------------------------------------------------------------------------

def _push(bits: List[int], value: int, length: int) -> None:
    for i in range(length - 1, -1, -1):
        bits.append((value >> i) & 1)


def _capacity_bytes(version: int) -> int:
    _, groups = _EC_BLOCKS[version]
    data_codewords = sum(count * size for count, size in groups)
    header_bits = 4 + (8 if version <= 9 else 16)
    return data_codewords - (header_bits + 7) // 8


def _choose_version(length: int) -> int:
    for version in range(1, MAX_VERSION + 1):
        if length <= _capacity_bytes(version):
            return version
    raise QREncodeError(
        "%d bytes does not fit in a version %d QR at level M (max %d)."
        % (length, MAX_VERSION, _capacity_bytes(MAX_VERSION))
    )


def _encode(payload: bytes, version: int) -> List[int]:
    """Payload -> the final interleaved bit stream for this version."""
    ec_per_block, groups = _EC_BLOCKS[version]
    capacity = sum(count * size for count, size in groups) * 8

    bits = []
    _push(bits, 0b0100, 4)                                  # byte mode
    _push(bits, len(payload), 8 if version <= 9 else 16)    # character count
    for byte in payload:
        _push(bits, byte, 8)
    bits.extend([0] * min(4, capacity - len(bits)))         # terminator
    while len(bits) % 8:
        bits.append(0)
    pads = (0xEC, 0x11)
    i = 0
    while len(bits) < capacity:
        _push(bits, pads[i % 2], 8)
        i += 1

    codewords = []
    for k in range(0, capacity, 8):
        byte = 0
        for bit in bits[k:k + 8]:
            byte = (byte << 1) | bit
        codewords.append(byte)

    blocks = []
    ecs = []
    pos = 0
    for count, size in groups:
        for _ in range(count):
            block = codewords[pos:pos + size]
            pos += size
            blocks.append(block)
            ecs.append(_ec_codewords(block, ec_per_block))

    # Interleave: one codeword from each block in turn, data first then EC.
    interleaved = []
    for i in range(max(len(b) for b in blocks)):
        for block in blocks:
            if i < len(block):
                interleaved.append(block[i])
    for i in range(ec_per_block):
        for ec in ecs:
            interleaved.append(ec[i])

    out = []
    for cw in interleaved:
        _push(out, cw, 8)
    out.extend([0] * _REMAINDER_BITS[version])
    return out


# ---------------------------------------------------------------------------
# Symbol layout
# ---------------------------------------------------------------------------

def _function_patterns(version: int) -> Tuple[List[List[int]], List[List[bool]]]:
    """The finder, timing and alignment patterns, and which modules they own.

    The returned `fixed` map also covers the format and version information
    areas: those are written after masking, but must never take data.
    """
    size = version * 4 + 17
    m = [[0] * size for _ in range(size)]
    fixed = [[False] * size for _ in range(size)]

    def put(row: int, col: int, value: int) -> None:
        if 0 <= row < size and 0 <= col < size:
            m[row][col] = value
            fixed[row][col] = True

    # Finder patterns and their separators.
    for r0, c0 in ((0, 0), (0, size - 7), (size - 7, 0)):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                inside = 0 <= dr <= 6 and 0 <= dc <= 6
                ring = dr in (0, 6) or dc in (0, 6) or (2 <= dr <= 4 and 2 <= dc <= 4)
                put(r0 + dr, c0 + dc, 1 if (inside and ring) else 0)

    # Timing patterns.
    for i in range(size):
        if not fixed[6][i]:
            put(6, i, 1 - i % 2)
        if not fixed[i][6]:
            put(i, 6, 1 - i % 2)

    # Alignment patterns, except the three that would sit on a finder.
    centres = _ALIGNMENT[version]
    if centres:
        last = centres[-1]
        for r in centres:
            for c in centres:
                if (r, c) in ((6, 6), (6, last), (last, 6)):
                    continue
                for dr in range(-2, 3):
                    for dc in range(-2, 3):
                        put(r + dr, c + dc, 0 if max(abs(dr), abs(dc)) == 1 else 1)

    # Reserve the format information areas, and set the always-dark module.
    for i in range(9):
        if not fixed[8][i]:
            put(8, i, 0)
        if not fixed[i][8]:
            put(i, 8, 0)
    for i in range(8):
        put(8, size - 1 - i, 0)
        put(size - 1 - i, 8, 0)
    put(size - 8, 8, 1)

    # Reserve the version information areas.
    if version >= 7:
        for i in range(18):
            a, b = size - 11 + i % 3, i // 3
            put(b, a, 0)
            put(a, b, 0)

    return m, fixed


def _place_data(m: List[List[int]], fixed: List[List[bool]], bits: List[int]) -> None:
    """Zigzag from the bottom-right, two columns at a time, skipping column 6."""
    size = len(m)
    i = 0
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                col = right - j
                upward = ((right + 1) & 2) == 0
                row = (size - 1 - vert) if upward else vert
                if not fixed[row][col] and i < len(bits):
                    m[row][col] = bits[i]
                    i += 1
        right -= 2


def _mask_bit(mask: int, row: int, col: int) -> bool:
    if mask == 0:
        return (row + col) % 2 == 0
    if mask == 1:
        return row % 2 == 0
    if mask == 2:
        return col % 3 == 0
    if mask == 3:
        return (row + col) % 3 == 0
    if mask == 4:
        return (row // 2 + col // 3) % 2 == 0
    if mask == 5:
        return (row * col) % 2 + (row * col) % 3 == 0
    if mask == 6:
        return ((row * col) % 2 + (row * col) % 3) % 2 == 0
    return ((row + col) % 2 + (row * col) % 3) % 2 == 0


def _format_bits(mask: int) -> int:
    # Level M is 0b00, so the five-bit value is just the mask.
    data = mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    return ((data << 10) | (rem & 0x3FF)) ^ 0x5412


def _draw_format(m: List[List[int]], mask: int) -> None:
    size = len(m)
    bits = _format_bits(mask)
    for i in range(15):
        bit = (bits >> i) & 1
        if i <= 5:
            m[i][8] = bit
        elif i == 6:
            m[7][8] = bit
        elif i == 7:
            m[8][8] = bit
        elif i == 8:
            m[8][7] = bit
        else:
            m[8][14 - i] = bit
        if i < 8:
            m[8][size - 1 - i] = bit
        else:
            m[size - 15 + i][8] = bit


def _draw_version(m: List[List[int]], version: int) -> None:
    if version < 7:
        return
    size = len(m)
    rem = version
    for _ in range(12):
        rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
    bits = (version << 12) | (rem & 0xFFF)
    for i in range(18):
        bit = (bits >> i) & 1
        a, b = size - 11 + i % 3, i // 3
        m[b][a] = bit
        m[a][b] = bit


_N3_PATTERN = bytes((1, 0, 1, 1, 1, 0, 1))


def _n3_occurrences(line: bytes, size: int) -> int:
    """Rule 3: the 1:1:3:1:1 finder ratio with four light modules beside it.

    The symbol edge counts as light: a pattern flush against it is just as
    likely to be mistaken for a finder as one with four white modules next to
    it, which is what the rule is there to discourage.
    """
    score = 0
    idx = line.find(_N3_PATTERN)
    while idx != -1:
        after = idx + 7
        if (idx in (0, size - 7)
                or not any(line[max(idx - 4, 0):idx])
                or not any(line[after:after + 4])):
            score += 40
        else:
            # No light run either side. The next possible match starts inside
            # this one, at its third dark module.
            after = idx + 4
        idx = line.find(_N3_PATTERN, after)
    return score


def _penalty(m: List[List[int]]) -> int:
    """How badly a masked symbol scans. Lower is better.

    The four features and their weights are ISO/IEC 18004 Table 11.
    """
    size = len(m)
    lines = [bytes(row) for row in m] + [bytes(col) for col in zip(*m)]
    score = 0

    # Rule 1 — runs of five or more same-coloured modules, 3 points plus one
    # for every module past the fifth.
    for line in lines:
        run, prev = 1, line[0]
        for value in line[1:]:
            if value == prev:
                run += 1
            else:
                if run >= 5:
                    score += run - 2
                run, prev = 1, value
        if run >= 5:
            score += run - 2

    # Rule 2 — 2x2 blocks of one colour.
    for r in range(size - 1):
        row, below = m[r], m[r + 1]
        for c in range(size - 1):
            v = row[c]
            if v == row[c + 1] == below[c] == below[c + 1]:
                score += 3

    # Rule 3 — finder-like patterns in any row or column.
    for line in lines:
        score += _n3_occurrences(line, size)

    # Rule 4 — how far the dark share is from half, in five-point steps.
    dark = sum(sum(row) for row in m)
    score += 10 * int(abs(dark * 100.0 / (size * size) - 50) / 5)
    return score


# ---------------------------------------------------------------------------
# Public
# ---------------------------------------------------------------------------

def matrix(payload: str) -> List[List[int]]:
    """Encode `payload` and return the symbol as rows of 0/1 ints, no quiet zone.

    The quiet zone is the renderer's to add: the browser draws it as padding
    around the SVG rather than as four more rows of white modules.
    """
    data = payload.encode("utf-8")
    version = _choose_version(len(data))
    bits = _encode(data, version)

    best_score = None
    best = None
    for mask in range(8):
        m, fixed = _function_patterns(version)
        _place_data(m, fixed, bits)
        for r in range(len(m)):
            for c in range(len(m)):
                if not fixed[r][c] and _mask_bit(mask, r, c):
                    m[r][c] ^= 1
        _draw_format(m, mask)
        _draw_version(m, version)
        score = _penalty(m)
        if best_score is None or score < best_score:
            best_score, best = score, m
    return best


def rows(payload: str) -> List[str]:
    """The symbol as one string of '0'/'1' per row — compact to send as JSON."""
    return ["".join(str(v) for v in row) for row in matrix(payload)]
