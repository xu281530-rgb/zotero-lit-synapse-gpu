import { hashExactText } from "./wikiCanonicalizer";

interface TextAtom {
  text: string;
  start: number;
  end: number;
}
const UNIT =
  /^(?:mm|cm|nm|um|µm|μm|m|s|min|h|kg|mg|g|kN|N|Pa|kPa|MPa|GPa|K|C|W|kW|J|kJ|Hz|kHz|MHz|mol|wt%|vol%)(?:\/(?:s|min|h|m|mm|kg|mol))?$/u;
const SPACING = /^\\(?:[,;:! ]|quad\b|qquad\b)/u;

function closingBrace(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "{") depth++;
    if (text[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function atomsFor(text: string, base = 0): TextAtom[] {
  const atoms: TextAtom[] = [];
  const emit = (value: string, start: number, end: number) => {
    for (const character of value)
      atoms.push({ text: character, start: base + start, end: base + end });
  };
  for (let index = 0; index < text.length; ) {
    const remaining = text.slice(index);
    const wrapper = /^\\(?:mathrm|textrm|text|mathit|mathbf)\s*\{/u.exec(
      remaining,
    );
    if (wrapper) {
      const opening = index + wrapper[0].length - 1;
      const closing = closingBrace(text, opening);
      if (closing >= 0) {
        const unit = text
          .slice(opening + 1, closing)
          .replace(/\\(?:[,;:! ]|quad\b|qquad\b)/gu, " ")
          .replace(/[{}\s]/gu, "");
        if (UNIT.test(unit)) {
          emit(unit, index, closing + 1);
          index = closing + 1;
          continue;
        }
      }
    }
    const spacing = SPACING.exec(remaining);
    if (spacing) {
      emit(" ", index, index + spacing[0].length);
      index += spacing[0].length;
      continue;
    }
    if (text[index] === "$" && text[index + 1] !== "$") {
      const closing = text.indexOf("$", index + 1);
      if (closing > index + 1) {
        const inner = atomsFor(
          text.slice(index + 1, closing),
          base + index + 1,
        );
        const value = inner
          .map((atom) => atom.text)
          .join("")
          .trim();
        const measurement = /^[+-]?\d+(?:\.\d+)?\s*(\S+)$/u.exec(value);
        if (measurement && UNIT.test(measurement[1])) {
          atoms.push(...inner);
          index = closing + 1;
          continue;
        }
      }
    }
    const character = String.fromCodePoint(text.codePointAt(index)!);
    emit(character, index, index + character.length);
    index += character.length;
  }
  return atoms;
}

function canonicalMap(raw: string): { text: string; positions: TextAtom[] } {
  const positions: TextAtom[] = [];
  for (const atom of atomsFor(raw)) {
    if (/\s/u.test(atom.text)) {
      if (!positions.length) continue;
      if (positions.at(-1)!.text === " ") {
        positions.at(-1)!.end = atom.end;
        continue;
      }
      positions.push({ ...atom, text: " " });
    } else positions.push(atom);
  }
  if (positions.at(-1)?.text === " ") positions.pop();
  // Unit spacing is typography; powers, signs, variables and unknown commands
  // are preserved. Offsets still point to the original indexed source.
  for (let index = positions.length - 1; index > 0; index--) {
    if (
      !/[0-9]/u.test(positions[index - 1].text) ||
      !/[A-Za-zµμ]/u.test(positions[index].text)
    )
      continue;
    const tail = positions
      .slice(index)
      .map((atom) => atom.text)
      .join("")
      .match(/^[A-Za-zµμ%]+(?:\/[A-Za-z]+)?/u)?.[0];
    if (tail && UNIT.test(tail))
      positions.splice(index, 0, {
        text: " ",
        start: positions[index].start,
        end: positions[index].start,
      });
  }
  return { text: positions.map((atom) => atom.text).join(""), positions };
}

export function canonicalWikiSourceText(raw: string): string {
  return canonicalMap(String(raw ?? "")).text;
}

export function findWikiSourceQuote(
  source: string,
  quote: string,
): { excerpt: string; matchKind: "exact" | "canonical" } | null {
  if (!quote.trim()) return null;
  const direct = source.indexOf(quote);
  if (direct >= 0)
    return {
      excerpt: source.slice(direct, direct + quote.length),
      matchKind: "exact",
    };
  const haystack = canonicalMap(source);
  const needle = canonicalWikiSourceText(quote);
  const start = haystack.text.indexOf(needle);
  if (start < 0 || !needle) return null;
  // Convert UTF-16 string offsets to atom indexes (astral characters occupy two).
  let offset = 0;
  const matched = haystack.positions.filter((atom) => {
    const before = offset;
    offset += atom.text.length;
    return offset > start && before < start + needle.length;
  });
  if (!matched.length) return null;
  return {
    excerpt: source.slice(matched[0].start, matched.at(-1)!.end),
    matchKind: "canonical",
  };
}

export async function wikiSourceTextView(rawText: string): Promise<any> {
  const displayText = canonicalWikiSourceText(rawText);
  const qualityIssues: string[] = [];
  if (rawText.includes("\uFFFD")) qualityIssues.push("replacement_characters");
  if ((rawText.match(/\$/gu)?.length ?? 0) % 2)
    qualityIssues.push("unbalanced_math_delimiters");
  if (
    /\bTable\s+\d/iu.test(rawText) &&
    !rawText.includes("|") &&
    (rawText.match(/\d+(?:\.\d+)?/gu)?.length ?? 0) >= 8
  )
    qualityIssues.push("table_layout_unavailable");
  return {
    rawText,
    displayText,
    canonicalHash: await hashExactText(displayText),
    qualityIssues,
  };
}
