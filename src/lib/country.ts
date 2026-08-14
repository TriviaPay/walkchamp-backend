/**
 * Canonical country handling for region-scoped features (currently the Regional leaderboard).
 *
 * How profiles are written today: the app writes `country_code` from a fixed 40-entry ISO-2
 * picker (frontend `constants/countries.ts`), so ISO-2 uppercase IS the canonical form and
 * nothing here invents a new one. The aliases below exist only to keep a single country from
 * being split across two leaderboard buckets when a row was written by some other path — an
 * ISO-3 code ("USA"), or the country name in the code column ("UNITED STATES").
 *
 * Matching is done by EXPANDING the viewer's country to every stored form that means the same
 * country and comparing with IN (...). Nothing is rewritten: no migration, no history change.
 * If the data is already clean, the expansion is a harmless no-op.
 */

/** ISO-2 → the alternate spellings that have to resolve to it. Keys mirror the app's picker. */
const COUNTRY_ALIASES: Record<string, readonly string[]> = {
  US: ["USA", "UNITED STATES", "UNITED STATES OF AMERICA"],
  IN: ["IND", "INDIA"],
  GB: ["GBR", "UK", "UNITED KINGDOM", "GREAT BRITAIN"],
  DE: ["DEU", "GER", "GERMANY"],
  FR: ["FRA", "FRANCE"],
  JP: ["JPN", "JAPAN"],
  KR: ["KOR", "SOUTH KOREA", "KOREA, REPUBLIC OF", "REPUBLIC OF KOREA"],
  BR: ["BRA", "BRAZIL"],
  CA: ["CAN", "CANADA"],
  AU: ["AUS", "AUSTRALIA"],
  CN: ["CHN", "CHINA"],
  MX: ["MEX", "MEXICO"],
  IT: ["ITA", "ITALY"],
  ES: ["ESP", "SPAIN"],
  RU: ["RUS", "RUSSIA", "RUSSIAN FEDERATION"],
  TR: ["TUR", "TURKEY", "TÜRKIYE", "TURKIYE"],
  SA: ["SAU", "SAUDI ARABIA"],
  ID: ["IDN", "INDONESIA"],
  NG: ["NGA", "NIGERIA"],
  ZA: ["ZAF", "SOUTH AFRICA"],
  AR: ["ARG", "ARGENTINA"],
  EG: ["EGY", "EGYPT"],
  PK: ["PAK", "PAKISTAN"],
  BD: ["BGD", "BANGLADESH"],
  PH: ["PHL", "PHILIPPINES"],
  VN: ["VNM", "VIETNAM", "VIET NAM"],
  TH: ["THA", "THAILAND"],
  MY: ["MYS", "MALAYSIA"],
  NL: ["NLD", "NETHERLANDS", "THE NETHERLANDS"],
  SE: ["SWE", "SWEDEN"],
  NO: ["NOR", "NORWAY"],
  PL: ["POL", "POLAND"],
  UA: ["UKR", "UKRAINE"],
  KE: ["KEN", "KENYA"],
  ET: ["ETH", "ETHIOPIA"],
  GH: ["GHA", "GHANA"],
  NZ: ["NZL", "NEW ZEALAND"],
  SG: ["SGP", "SINGAPORE"],
  AE: ["ARE", "UAE", "UNITED ARAB EMIRATES"],
  IL: ["ISR", "ISRAEL"],
};

/** Reverse index: every alias (and every ISO-2) → its canonical ISO-2. Built once at load. */
const ALIAS_TO_CANONICAL: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [iso2, aliases] of Object.entries(COUNTRY_ALIASES)) {
    map.set(iso2, iso2);
    for (const alias of aliases) map.set(alias, iso2);
  }
  return map;
})();

/**
 * Trim + uppercase. Returns null for blank/non-string input.
 *
 * Matches the semantics of the pre-existing private helper in cashChallengeFees.ts, so the
 * two agree on what "US" means; this module does not change payment-rail behavior.
 */
export function normalizeCountryCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Resolve any stored spelling to its canonical ISO-2 code. Unknown values normalize but are
 * otherwise returned untouched — an unrecognized country still gets its own consistent bucket
 * rather than being dropped or silently merged into another.
 */
export function canonicalCountryCode(raw: unknown): string | null {
  const normalized = normalizeCountryCode(raw);
  if (!normalized) return null;
  return ALIAS_TO_CANONICAL.get(normalized) ?? normalized;
}

/**
 * Every stored representation that means the same country as `raw`, for an IN (...) comparison
 * against `upper(trim(country_code))`. Always includes the normalized input itself, so an
 * unknown code still matches its own rows exactly.
 */
export function countryCodeMatchSet(raw: unknown): string[] {
  const normalized = normalizeCountryCode(raw);
  if (!normalized) return [];
  const canonical = ALIAS_TO_CANONICAL.get(normalized);
  if (!canonical) return [normalized];
  return [...new Set([canonical, ...(COUNTRY_ALIASES[canonical] ?? []), normalized])];
}
