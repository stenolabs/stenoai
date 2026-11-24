import { describe, expect, it } from 'vitest';
import { parseEnvLines, splitCommandLine } from './commandLine';

describe('splitCommandLine', () => {
  it('splits words like a shell, without expanding anything', () => {
    expect(splitCommandLine('npx -y @modelcontextprotocol/server-filesystem ~/Notes')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '~/Notes',
    ]);
    expect(splitCommandLine(`uvx "my server" 'a b' c\\ d $HOME`)).toEqual([
      'uvx',
      'my server',
      'a b',
      'c d',
      '$HOME',
    ]);
    expect(splitCommandLine('cmd "say \\"hi\\""')).toEqual(['cmd', 'say "hi"']);
    expect(splitCommandLine('cmd ""')).toEqual(['cmd', '']);
    expect(splitCommandLine('  ')).toEqual([]);
  });

  it('refuses an unterminated quote', () => {
    expect(splitCommandLine('npx "oops')).toBeNull();
  });
});

describe('parseEnvLines', () => {
  it('reads KEY=value lines, skipping blanks and comments', () => {
    expect(parseEnvLines('API_KEY=abc=def\n\n# note\nexport TEAM="Core team"\n')).toEqual({
      env: { API_KEY: 'abc=def', TEAM: 'Core team' },
    });
  });

  it('points at the first bad line', () => {
    expect(parseEnvLines('A=1\nnot a pair\n')).toEqual({ error: 2 });
    expect(parseEnvLines('1BAD=x')).toEqual({ error: 1 });
  });
});
