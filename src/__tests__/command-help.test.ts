import { describe, it, expect } from 'vitest';
import { parseArgs } from '../cli/args.js';
import { getCommandHelpText } from '../cli/help.js';

describe('per-command --help parsing', () => {
  const commands = [
    'run',
    'plan',
    'validate',
    'status',
    'init',
    'generate',
    'sql',
    'erd',
    'drift',
    'baseline',
    'down',
    'contract',
    'expand-status',
    'new',
    'lint',
  ] as const;

  for (const cmd of commands) {
    it(`parses ${cmd} --help and sets helpRequested`, () => {
      const parsed = parseArgs(['node', 'schema-flow', cmd, '--help']);
      expect(parsed.command).toBe(cmd);
      expect(parsed.helpRequested).toBe(true);
    });

    it(`parses ${cmd} -h and sets helpRequested`, () => {
      const parsed = parseArgs(['node', 'schema-flow', cmd, '-h']);
      expect(parsed.command).toBe(cmd);
      expect(parsed.helpRequested).toBe(true);
    });
  }

  it('parses run pre --help', () => {
    const parsed = parseArgs(['node', 'schema-flow', 'run', 'pre', '--help']);
    expect(parsed.command).toBe('run');
    expect(parsed.subcommand).toBe('pre');
    expect(parsed.helpRequested).toBe(true);
  });

  it('parses run migrate --help', () => {
    const parsed = parseArgs(['node', 'schema-flow', 'run', 'migrate', '--help']);
    expect(parsed.command).toBe('run');
    expect(parsed.subcommand).toBe('migrate');
    expect(parsed.helpRequested).toBe(true);
  });

  it('parses run post --help', () => {
    const parsed = parseArgs(['node', 'schema-flow', 'run', 'post', '--help']);
    expect(parsed.command).toBe('run');
    expect(parsed.subcommand).toBe('post');
    expect(parsed.helpRequested).toBe(true);
  });

  it('--help before command still returns top-level help', () => {
    const parsed = parseArgs(['node', 'schema-flow', '--help']);
    expect(parsed.command).toBe('help');
    // helpRequested not set because it's the top-level help command
    expect(parsed.helpRequested).toBeUndefined();
  });

  it('does not set helpRequested when --help is absent', () => {
    const parsed = parseArgs(['node', 'schema-flow', 'plan']);
    expect(parsed.command).toBe('plan');
    expect(parsed.helpRequested).toBeUndefined();
  });

  it('--help mixed with other flags still sets helpRequested', () => {
    const parsed = parseArgs(['node', 'schema-flow', 'generate', '--db', 'postgres://x', '--help']);
    expect(parsed.command).toBe('generate');
    expect(parsed.helpRequested).toBe(true);
  });
});

describe('getCommandHelpText', () => {
  it('returns help text for every command', () => {
    const commands = [
      'run',
      'plan',
      'validate',
      'status',
      'init',
      'generate',
      'sql',
      'erd',
      'drift',
      'baseline',
      'down',
      'contract',
      'expand-status',
      'new',
      'lint',
    ] as const;

    for (const cmd of commands) {
      const text = getCommandHelpText(cmd);
      expect(text).toBeTruthy();
      expect(text).toContain('Usage:');
    }
  });

  it('returns help for run subcommands', () => {
    for (const sub of ['pre', 'migrate', 'post'] as const) {
      const text = getCommandHelpText('run', sub);
      expect(text).toBeTruthy();
      expect(text).toContain('Usage:');
      expect(text).toContain(sub);
    }
  });

  it('generate help includes --output and --seeds flags', () => {
    const text = getCommandHelpText('generate');
    expect(text).toContain('--output');
    expect(text).toContain('--seeds');
    expect(text).toContain('--db');
    expect(text).toContain('--verbose');
    expect(text).toContain('--json');
  });

  it('drift help includes --apply flag', () => {
    const text = getCommandHelpText('drift');
    expect(text).toContain('--apply');
  });

  it('new help includes --name flag', () => {
    const text = getCommandHelpText('new');
    expect(text).toContain('--name');
  });

  it('each command help includes a description', () => {
    const text = getCommandHelpText('plan');
    // Should have a description line (not just usage)
    expect(text.split('\n').length).toBeGreaterThan(3);
  });

  it('each command help includes example', () => {
    const commands = [
      'run',
      'plan',
      'validate',
      'status',
      'init',
      'generate',
      'sql',
      'erd',
      'drift',
      'baseline',
      'down',
      'contract',
      'expand-status',
      'new',
      'lint',
    ] as const;

    for (const cmd of commands) {
      const text = getCommandHelpText(cmd);
      expect(text).toContain('Example');
    }
  });
});
