export class VideoCleanError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'noVideo' | 'leftovers' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'VideoCleanError';
  }
}
