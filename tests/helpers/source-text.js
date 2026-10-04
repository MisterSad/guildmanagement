/**
 * tests/helpers/source-text.js
 *
 * For the tests that assert on source text: compare code by its tokens, not
 * its layout. A formatter (Biome, M6) re-wraps calls, breaks method chains
 * over lines and adds trailing commas; none of that changes what the code
 * does, and none of it should fail a test.
 *
 *   expect(squash(source)).toContain(squash('fetchAllRows(admin, "x"'))
 */

/**
 * Collapses whitespace, drops it inside ( ) and [ ] and before `.method`, and
 * drops trailing commas. Braces keep their inner spaces (`{ a }`), as both the
 * hand-written and the formatted code have them.
 */
export function squash(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/ \.(?=[A-Za-z_$])/g, '.')
    .replace(/([([]) /g, '$1')
    .replace(/ ([)\]])/g, '$1')
    .replace(/, ?([)\]])/g, '$1')
    .replace(/, \}/g, ' }')
    .trim();
}
