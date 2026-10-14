# SPDX-License-Identifier: Apache-2.0

"""Characters that render as nothing, ignored (never removed) when matching tool-result text (#243).

`DEFAULT_IGNORABLE_RANGES` is the Unicode `Default_Ignorable_Code_Point` property, which the
standard library's `unicodedata` does not expose. It is a static table taken from
`DerivedCoreProperties.txt` of Unicode 15.1.0
(https://www.unicode.org/Public/15.1.0/ucd/DerivedCoreProperties.txt, dated 2023-08-07), the Unicode
version of the runner's Python 3.13 (`unicodedata.unidata_version == "15.1.0"`). The ranges are
merged where adjacent. Characters assigned in a later Unicode version are not in the table; update
it with the Python version.

`CONTROL_RANGES` adds the C0 and C1 control characters except tab, line feed and carriage return:
they render as nothing in most renderers and a model's tokenizer drops or skips them just the same.
"""

# Inclusive (first, last) code points, ascending.
DEFAULT_IGNORABLE_RANGES: tuple[tuple[int, int], ...] = (
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)

CONTROL_RANGES: tuple[tuple[int, int], ...] = (
    (0x00, 0x08),
    (0x0B, 0x0C),
    (0x0E, 0x1F),
    (0x7F, 0x9F),
)


def character_class(ranges: tuple[tuple[int, int], ...]) -> str:
    """The body of a regular expression character class holding the ranges."""
    return "".join(
        f"\\U{first:08x}" if first == last else f"\\U{first:08x}-\\U{last:08x}"
        for first, last in ranges
    )
