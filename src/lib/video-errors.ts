export class VideoCleanError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'noVideo' | 'leftovers' | 'failed' | 'cannotMask' | 'cannotVoice' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'VideoCleanError';
  }
}
