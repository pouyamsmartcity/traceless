import { readFileSync } from 'node:fs';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { audioFindings, isAudioFile } from '../src/lib/clean-audio';

const fixture = (p: string) => new Blob([readFileSync(new URL(`./fixtures/leaky/${p}`, import.meta.url))]);

async function findings(name: string) {
  const input = new Input({ source: new BlobSource(fixture(name)), formats: ALL_FORMATS });
  try {
    return audioFindings(await input.getMetadataTags());
  } finally {
    input.dispose();
  }
}

describe('voice notes', () => {
  it('recognises sound files by type or name', () => {
    expect(isAudioFile(new File([], 'a.opus'))).toBe(true);
    expect(isAudioFile(new File([], 'x', { type: 'audio/ogg' }))).toBe(true);
    expect(isAudioFile(new File([], 'a.mp4'))).toBe(false);
  });

  for (const name of ['voice-memo.m4a', 'voice-note.mp3', 'voice-note.ogg']) {
    it(`finds the place-named title, speaker and date in ${name}`, async () => {
      const f = await findings(name);
      const ids = f.map((x) => x.id);
      expect(f.some((x) => x.id === 'comment' && x.value?.includes('Enghelab'))).toBe(true);
      expect(f.some((x) => x.id === 'owner' && x.value === 'Reza Example')).toBe(true);
      expect(ids).toContain('dateTaken');
      if (name === 'voice-note.mp3') expect(ids).toContain('extraImages'); // the cover picture
    });
  }

  it('finds the place in an iPhone-style voice memo', async () => {
    expect((await findings('voice-memo.m4a')).map((x) => x.id)).toContain('videoLocation');
  });
});
