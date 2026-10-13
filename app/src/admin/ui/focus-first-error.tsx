// SPDX-License-Identifier: Apache-2.0

"use client";
// Moving focus to the first invalid control after a refused save (rulebook R20), the way the wizard
// does it: the submit handler records the id of the control the refusal named, and the effect below
// focuses it once the render that shows the error is done. A container (the radio group) focuses its
// first radio, which is the control a person can act on.
import { useEffect, useRef, type RefObject } from "react";

function focusControl(id: string) {
  const element = document.getElementById(id);
  if (element === null) return;
  if (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    element.focus();
    return;
  }
  element.querySelector<HTMLElement>('[role="radio"]')?.focus();
}

/** The ref of the control id to focus after the next render; set it in a submit handler. */
export function useFocusFirstError(): RefObject<string | null> {
  const target = useRef<string | null>(null);
  useEffect(() => {
    const id = target.current;
    if (id === null) return;
    target.current = null;
    focusControl(id);
  });
  return target;
}
