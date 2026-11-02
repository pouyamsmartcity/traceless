/** Sound recordings (voice notes, voice memos): by type, or by name when the browser gives no type. */
export function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  return /\.(m4a|mp3|ogg|oga|opus|wav|aac|flac|amr|weba)$/i.test(file.name);
}
