const UI_LOG_PREFIX = '[MiCall:UI]';
type MiCallUILogLevel = 'debug' | 'info' | 'warn' | 'error';

export class MiCallUILogger {
  public constructor(public enabled = true) {}

  public debug(message: string): void {
    this.#write('debug', message);
  }

  public info(message: string): void {
    this.#write('info', message);
  }

  public warn(message: string): void {
    this.#write('warn', message);
  }

  public error(message: string): void {
    this.#write('error', message);
  }

  #write(level: MiCallUILogLevel, message: string): void {
    if (!this.enabled) {
      return;
    }
    console[level](`${UI_LOG_PREFIX} ${message}`);
  }
}
