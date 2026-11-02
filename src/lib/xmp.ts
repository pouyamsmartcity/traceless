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

function prop(xmp: string, name: string): string | undefined {
  // Attribute form: ns:Name="value"
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attr = new RegExp(`${esc}\\s*=\\s*"([^"]*)"`).exec(xmp);
  if (attr) return decode(attr[1]!);
  // Element form: <ns:Name>value</ns:Name>, possibly wrapped in rdf:Seq/Alt/Bag with rdf:li items.
  const el = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`).exec(xmp);
  if (!el) return undefined;
  const inner = el[1]!;
  const items = [...inner.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((m) => decode(m[1]!.trim()));
  return items.length ? items.join(', ') : decode(inner.replace(/<[^>]+>/g, ' ').trim());
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
