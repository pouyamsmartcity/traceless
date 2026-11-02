import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, makeZip } from '../src/lib/zip';

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('makes an archive that standard tools open, with no real date and unique names', async () => {
    const a = new Uint8Array(1000).map((_, i) => i % 251);
    const blob = makeZip([
      { name: 'img-a.jpg', data: a },
      { name: 'img-a.jpg', data: new Uint8Array([1, 2, 3]) },
      { name: 'عکس.png', data: new Uint8Array(0) },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'pakkon-zip-'));
    const path = join(dir, 'x.zip');
    writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
    const out = execFileSync('python3', [
      '-I',
      '-c',
      'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps([[i.filename,i.file_size,list(i.date_time),i.comment.decode(),len(i.extra)] for i in z.infolist()]))',
      path,
    ]).toString();
    expect(JSON.parse(out)).toEqual([
      ['img-a.jpg', 1000, [1980, 1, 1, 0, 0, 0], '', 0],
      ['img-a-2.jpg', 3, [1980, 1, 1, 0, 0, 0], '', 0],
      ['عکس.png', 0, [1980, 1, 1, 0, 0, 0], '', 0],
    ]);
  });
});
