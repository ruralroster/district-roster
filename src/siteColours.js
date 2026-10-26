// Each site's own colour: sites in name order, a golden-angle step round
// the colour wheel apart, so neighbours in the list never look alike. The
// hue goes in --site-hue; styles.css turns it into light/dark colours.
const GOLDEN_ANGLE = 137.508;

export function siteHues(sites) {
  const sorted = [...sites].sort((a, b) => a.name.localeCompare(b.name));
  return new Map(sorted.map((s, i) => [s.site_id, Math.round((i * GOLDEN_ANGLE + 200) % 360)]));
}

export const siteStyle = (hues, siteId) => (hues.has(siteId) ? { '--site-hue': hues.get(siteId) } : undefined);
