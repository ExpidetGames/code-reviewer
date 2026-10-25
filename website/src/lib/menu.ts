// SPDX-License-Identifier: LicenseRef-Proprietary

// The mobile menu: opens from the hamburger, closes with Escape, a link or a wider screen. While it is open the
// page behind it is inert (no focus, no scrolling) and Tab stays inside the header.
const header = document.querySelector<HTMLElement>("[data-site-header]");
const toggle = header?.querySelector<HTMLButtonElement>("[data-menu-toggle]");
const menu = document.getElementById("site-menu");

if (header && toggle && menu) {
  const outside = [document.getElementById("main"), document.getElementById("site-footer")];

  const setOpen = (open: boolean) => {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    menu.toggleAttribute("data-open", open);
    menu.toggleAttribute("inert", !open);
    for (const element of outside) element?.toggleAttribute("inert", open);
    document.documentElement.style.overflow = open ? "hidden" : "";
  };
  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";

  toggle.addEventListener("click", () => setOpen(!isOpen()));
  for (const link of menu.querySelectorAll("a")) link.addEventListener("click", () => setOpen(false));

  document.addEventListener("keydown", (event) => {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      setOpen(false);
      toggle.focus();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...header.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")].filter(
      (element) => element.offsetParent !== null,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (!header.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.matchMedia("(min-width: 768px)").addEventListener("change", (query) => {
    if (query.matches) setOpen(false);
  });
}
