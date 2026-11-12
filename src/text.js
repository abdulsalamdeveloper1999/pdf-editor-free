// Shared find/replace primitives. Used by both the highlighter and Replace all,
// so the matching rule lives in exactly one place.
const fold = (s, matchCase) => (matchCase ? s : s.toLowerCase());

export function countMatches(str, find, matchCase) {
  if (!find) return 0;
  const h = fold(str, matchCase);
  const n = fold(find, matchCase);
  let c = 0;
  for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) c++;
  return c;
}

export function replaceMatches(str, find, replace, matchCase) {
  if (!find) return str;
  const h = fold(str, matchCase);
  const n = fold(find, matchCase);
  let out = '';
  let i = 0;
  for (let j = h.indexOf(n); j !== -1; j = h.indexOf(n, i)) {
    out += str.slice(i, j) + replace;
    i = j + n.length;
  }
  return out + str.slice(i);
}
