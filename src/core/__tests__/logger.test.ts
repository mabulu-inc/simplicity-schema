import { describe, it, expect, beforeEach } from 'vitest';
import { createLogger, LogLevel, type Logger } from '../logger.js';

describe('Logger', () => {
  let output: string[];
  let errorOutput: string[];
  let logger: Logger;

  function captureLogger(opts: { verbose?: boolean; quiet?: boolean; json?: boolean } = {}) {
    output = [];
    errorOutput = [];
    return createLogger({
      verbose: opts.verbose ?? false,
      quiet: opts.quiet ?? false,
      json: opts.json ?? false,
      stdout: (msg: string) => output.push(msg),
      stderr: (msg: string) => errorOutput.push(msg),
      color: false,
    });
  }

  describe('log levels', () => {
    beforeEach(() => {
      logger = captureLogger();
    });

    it('outputs error messages', () => {
      logger.error('something broke');
      expect(errorOutput).toHaveLength(1);
      expect(errorOutput[0]).toContain('something broke');
    });

    it('outputs warn messages', () => {
      logger.warn('be careful');
      expect(errorOutput).toHaveLength(1);
      expect(errorOutput[0]).toContain('be careful');
    });

    it('outputs info messages', () => {
      logger.info('hello');
      expect(output).toHaveLength(1);
      expect(output[0]).toContain('hello');
    });

    it('does not output debug messages by default', () => {
      logger.debug('hidden');
      expect(output).toHaveLength(0);
    });
  });

  describe('verbose mode', () => {
    beforeEach(() => {
      logger = captureLogger({ verbose: true });
    });

    it('outputs debug messages', () => {
      logger.debug('detail');
      expect(output).toHaveLength(1);
      expect(output[0]).toContain('detail');
    });

    it('still outputs info messages', () => {
      logger.info('hello');
      expect(output).toHaveLength(1);
    });
  });

  describe('quiet mode', () => {
    beforeEach(() => {
      logger = captureLogger({ quiet: true });
    });

    it('suppresses info messages', () => {
      logger.info('hidden');
      expect(output).toHaveLength(0);
    });

    it('suppresses warn messages', () => {
      logger.warn('hidden');
      expect(errorOutput).toHaveLength(0);
    });

    it('still outputs error messages', () => {
      logger.error('visible');
      expect(errorOutput).toHaveLength(1);
    });

    it('suppresses debug messages', () => {
      logger.debug('hidden');
      expect(output).toHaveLength(0);
    });
  });

  describe('JSON mode', () => {
    beforeEach(() => {
      logger = captureLogger({ json: true });
    });

    it('outputs info as JSON', () => {
      logger.info('hello');
      expect(output).toHaveLength(1);
      const parsed = JSON.parse(output[0]);
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('hello');
    });

    it('outputs error as JSON to stderr', () => {
      logger.error('boom');
      expect(errorOutput).toHaveLength(1);
      const parsed = JSON.parse(errorOutput[0]);
      expect(parsed.level).toBe('error');
      expect(parsed.message).toBe('boom');
    });

    it('includes timestamp in JSON output', () => {
      logger.info('test');
      const parsed = JSON.parse(output[0]);
      expect(parsed.timestamp).toBeDefined();
    });
  });

  describe('level prefixes', () => {
    it('includes level prefix in non-JSON output', () => {
      logger = captureLogger();
      logger.error('fail');
      expect(errorOutput[0]).toMatch(/error/i);
    });
  });

  describe('LogLevel enum', () => {
    it('has expected values', () => {
      expect(LogLevel.DEBUG).toBe('debug');
      expect(LogLevel.INFO).toBe('info');
      expect(LogLevel.WARN).toBe('warn');
      expect(LogLevel.ERROR).toBe('error');
    });
  });
});
