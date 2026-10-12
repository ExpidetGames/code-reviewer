// SPDX-License-Identifier: Apache-2.0

// jsdom is missing a handful of browser APIs that the Radix primitives (Dialog, AlertDialog,
// Tooltip, Tabs, Select, DropdownMenu) and the shadcn Sidebar touch. The component tests of the kit
// (#167) run in the jsdom environment, so this setup file installs the missing pieces once. It is
// inert in the Node environment (the colour, licence and other CI tests): it does nothing unless a
// `window` exists.
//
// It is test setup, not a design test suite (the epic decided against axe/screenshot suites). The
// shims mirror what jsdom omits; nothing here changes production behaviour.

if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string): MediaQueryList => {
        const list = {
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        };
        return list as unknown as MediaQueryList;
      },
    });
  }

  if (typeof globalThis.ResizeObserver !== "function") {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver =
      ResizeObserverStub as unknown as typeof ResizeObserver;
  }

  if (typeof window.PointerEvent !== "function") {
    // Enough of a PointerEvent for Radix and user-event: a MouseEvent with a pointerId.
    class PointerEventStub extends window.MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    Object.defineProperty(window, "PointerEvent", {
      writable: true,
      value: PointerEventStub,
    });
  }

  // Radix calls these on elements; jsdom defines none of them.
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
