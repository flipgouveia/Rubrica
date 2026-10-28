// Proximity query syntax (CONTRACTS v1.2.0 §3): terms split on spaces, `"…"` is one exact-phrase
// term, `-term` (or `-"…"`) excludes. This mirrors what the engine parses so the term chips show
// exactly the terms (and the colour positions) the highlights will use: the colour index of a
// positive term is its position among the POSITIVE terms.

export interface QueryTerm {
  text: string;
  excluded: boolean;
  /** Position among the positive terms (the colour slot); `-1` for an excluded term. */
  index: number;
}

export function parseQueryTerms(text: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  let positives = 0;
  const add = (value: string, excluded: boolean) => {
    if (!value) return;
    terms.push({ text: value, excluded, index: excluded ? -1 : positives++ });
  };
  for (const match of text.matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    const quoted = match[2];
    const bare = match[3];
    if (quoted !== undefined) add(quoted.trim(), match[1] === "-");
    else if (bare.startsWith("-") && bare.length > 1) add(bare.slice(1), true);
    else if (bare !== "-") add(bare, false);
  }
  return terms;
}

export function positiveTerms(text: string): QueryTerm[] {
  return parseQueryTerms(text).filter((term) => !term.excluded);
}
