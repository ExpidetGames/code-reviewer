// SPDX-License-Identifier: LicenseRef-Proprietary

// The look of a section link in a row of sections (the settings sections, the sections of a project),
// as the design board draws its tabs (#633): a pill in 14px semibold, muted at rest, on surface while
// hovered and on raised for the current page (`aria-current="page"`). The current page is told by the
// fill, the text colour and the attribute; a touch screen gets a 44px row.
export const PILL_LINK_CLASS =
  "inline-flex min-h-9 items-center rounded-full px-3 py-2 text-sm font-semibold text-muted-foreground no-underline transition-all hover:bg-surface hover:text-foreground aria-[current=page]:bg-raised aria-[current=page]:text-foreground pointer-coarse:min-h-11";
