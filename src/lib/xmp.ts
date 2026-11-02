import { FindingList, validGeo } from './findings';

/** XMP stores GPS as "35,41.982N" or "35.6997N". */
export function parseXmpCoordinate(s: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])\s*$/i.exec(s);
  if (!m) return undefined;
  let v = parseFloat(m[1]!);
  if (m[2]) v += parseFloat(m[2]) / 60;
  if (m[3]) v += parseFloat(m[3]) / 3600;
  const ref = m[4]!.toUpperCase();
  return ref === 'S' || ref === 'W' ? -v : v;
}

/** XMP packets larger than this are only checked for presence: no camera writes that much. */
const MAX_XMP = 512 * 1024;

/** Finds `ns:Name="value"` or `<ns:Name ...>value</ns:Name>` with plain string searches (linear time). */
function prop(xmp: string, name: string): string | undefined {
  // Attribute form.
  let at = xmp.indexOf(name);
  while (at >= 0) {
    const before = xmp.charCodeAt(at - 1);
    let p = at + name.length;
    while (xmp[p] === ' ') p++;
    if (xmp[p] === '=' && before !== 60 /* < */ && before !== 47 /* / */) {
      p++;
      while (xmp[p] === ' ') p++;
      const quote = xmp[p];
      if (quote === '"' || quote === "'") {
        const end = xmp.indexOf(quote, p + 1);
        if (end > p) return decode(xmp.slice(p + 1, end));
      }
    }
    at = xmp.indexOf(name, at + name.length);
  }
  // Element form, possibly wrapped in rdf:Seq/Alt/Bag with rdf:li items.
  let open = xmp.indexOf(`<${name}`);
  while (open >= 0) {
    const after = xmp[open + name.length + 1];
    if (after === '>' || after === ' ' || after === '\n' || after === '\t' || after === '\r') break;
    open = xmp.indexOf(`<${name}`, open + 1);
  }
  if (open < 0) return undefined;
  const gt = xmp.indexOf('>', open);
  const close = xmp.indexOf(`</${name}>`, gt);
  if (gt < 0 || close < 0) return undefined;
  const inner = xmp.slice(gt + 1, close);
  const items: string[] = [];
  let li = inner.indexOf('<rdf:li');
  while (li >= 0) {
    const s = inner.indexOf('>', li);
    const e = inner.indexOf('</rdf:li>', s);
    if (s < 0 || e < 0) break;
    items.push(decode(inner.slice(s + 1, e).trim()));
    li = inner.indexOf('<rdf:li', e);
  }
  return items.length ? items.join(', ') : decode(inner.replace(/<[^>]*>/g, ' ').trim());
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Adds findings for the interesting parts of an XMP packet. */
export function inspectXmp(xmp: string, out: FindingList): void {
  if (!xmp.trim()) return;
  out.add('xmp');
  if (xmp.length > MAX_XMP) {
    out.add('otherMetadata', 'very large XMP');
    return;
  }
  const lat = prop(xmp, 'exif:GPSLatitude');
  const lon = prop(xmp, 'exif:GPSLongitude');
  if (lat && lon) {
    const g = validGeo(parseXmpCoordinate(lat), parseXmpCoordinate(lon));
    if (g) out.add('gps', `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`, g);
  }
  for (const k of ['photoshop:City', 'photoshop:State', 'photoshop:Country', 'Iptc4xmpCore:Location', 'Iptc4xmpExt:City']) {
    const v = prop(xmp, k);
    if (v) out.add('cityName', v);
  }
  for (const k of ['dc:creator', 'photoshop:Credit', 'xmpRights:Owner', 'aux:OwnerName', 'exifEX:CameraOwnerName']) {
    const v = prop(xmp, k);
    if (v) out.add('owner', v);
  }
  for (const k of ['aux:SerialNumber', 'exifEX:BodySerialNumber', 'aux:LensSerialNumber']) {
    const v = prop(xmp, k);
    if (v) out.add('serialNumber', v);
  }
  for (const k of ['tiff:Model', 'exifEX:LensModel']) {
    const v = prop(xmp, k);
    if (v) out.add('deviceModel', v);
  }
  const created = prop(xmp, 'exif:DateTimeOriginal') ?? prop(xmp, 'photoshop:DateCreated') ?? prop(xmp, 'xmp:CreateDate');
  if (created) out.add('dateTaken', created);
  const tool = prop(xmp, 'xmp:CreatorTool');
  if (tool) out.add('software', tool);
  if (/xmpMM:History|xmpMM:DerivedFrom|xmpMM:OriginalDocumentID|xmpMM:DocumentID|xmpMM:InstanceID/.test(xmp)) {
    out.add('editHistory');
  }
  if (/GCamera:MicroVideo|GCamera:MotionPhoto|Camera:MotionPhoto|Container:Directory/.test(xmp)) out.add('motionPhoto');
  if (/GDepth:|GImage:Data|hdrgm:/.test(xmp)) out.add('extraImages');
}
