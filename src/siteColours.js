// Each site's colour, as a hue round the colour wheel in --site-hue
// (styles.css turns it into light/dark colours). A site's officers can
// choose one on the Sites tab (sites.colour_hue); the rest are spread out
// automatically: sites in name order, a golden-angle step apart, so
// neighbours in the list never look alike.
const GOLDEN_ANGLE = 137.508;

// The choices on the Sites tab: twelve hues, 30 degrees apart.
export const HUE_CHOICES = Array.from({ length: 12 }, (_, i) => i * 30);

export function siteHues(sites) {
  const sorted = [...sites].sort((a, b) => a.name.localeCompare(b.name));
  return new Map(
    sorted.map((s, i) => [s.site_id, s.colour_hue ?? Math.round((i * GOLDEN_ANGLE + 200) % 360)]),
  );
}

export const siteStyle = (hues, siteId) => (hues.has(siteId) ? { '--site-hue': hues.get(siteId) } : undefined);
export const hueStyle = (hue) => ({ '--site-hue': hue });
