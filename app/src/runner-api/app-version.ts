// SPDX-License-Identifier: Apache-2.0

// The build of this app as the version call reports it (`VersionResponse.appVersion`, for logs): the
// `version` of app/package.json, which a bundle carries with it.
import packageJson from "../../package.json";

export const APP_VERSION: string = packageJson.version;
