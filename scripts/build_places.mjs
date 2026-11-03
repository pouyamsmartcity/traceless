// Builds public/data/places.tsv: an offline list of places used to say "this photo was taken near X".
// Source: GeoNames via the all-the-cities package. GeoNames data is CC BY 4.0 (https://www.geonames.org/).
// Keeps every place with 5,000+ people worldwide, and every listed place in Iran.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const cities = require('all-the-cities');
const rows = cities
  .filter((c) => c.population >= 5000 || c.country === 'IR')
  .map((c) => [c.name.replace(/[\t\n]/g, ' '), c.country, c.loc.coordinates[1].toFixed(3), c.loc.coordinates[0].toFixed(3)].join('\t'));
writeFileSync(new URL('../public/data/places.tsv', import.meta.url), rows.join('\n') + '\n');
console.log(`wrote ${rows.length} places`);
