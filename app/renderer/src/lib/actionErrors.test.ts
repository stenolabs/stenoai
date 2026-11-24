import { describe, expect, it } from 'vitest';
import { actionErrorMessage } from './actionErrors';
import { ResultError } from './result';

describe('actionErrorMessage', () => {
  it('explains an Atlassian account with no Jira or Confluence site', () => {
    expect(actionErrorMessage(new ResultError('Sign-in did not complete', 'atlassian-no-site'))).toBe(
      'This Atlassian account has no Jira or Confluence site. Sign in with your work account, or ask your admin to allow Rovo MCP.',
    );
  });

  it('keeps a plain denial generic', () => {
    expect(actionErrorMessage(new ResultError('x', 'denied'))).toBe('Access was not granted.');
  });
});
