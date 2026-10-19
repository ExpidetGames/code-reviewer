// SPDX-License-Identifier: Apache-2.0

/**
 * A measured cost in a text: the 0.0001 US dollars the fake reports with every answer (written out or as `1e-4`), or a
 * figure after the name of a cost field. The name of a cost field with no figure (`"costUsd":null`) is no leak.
 *
 * `1e-4` counts only as a whole number: no letter, digit or underscore may touch it. In an id such as `…a91e-4284…`
 * it is the end of one hexadecimal group and the first digit of the next one, and in a hash or a chunk file name
 * (`app-z1e-4q.js`) it is part of a word, so a text that lists ids must not fail by chance.
 */
export const MEASURED_COST =
  /0\.0001\d*|(?<!\w)1e-4(?!\w)|(?:costUsd|costMicroUsd|cost_micro_usd)[\\"\s:]*\d/;
