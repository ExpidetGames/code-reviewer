// SPDX-License-Identifier: LicenseRef-Proprietary

// Klaro bringt keine Typen mit; nur was src/lib/consent.ts nutzt.
declare module "klaro/dist/klaro-no-css" {
  export interface ConsentManager {
    confirmed: boolean;
    getConsent(service: string): boolean;
    watch(watcher: { update(manager: ConsentManager, name: string, data: unknown): void }): void;
  }
  export function setup(config: object): void;
  export function show(config?: object, modal?: boolean): boolean;
  export function getManager(config?: object): ConsentManager;
}
