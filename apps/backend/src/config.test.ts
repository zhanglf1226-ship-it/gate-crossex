import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('cloud execution configuration', () => {
  it('defaults cloud deployments to preview-only', () => {
    const config = loadConfig({ GCT_DEPLOYMENT_MODE: 'cloud' });
    expect(config.deploymentMode).toBe('cloud');
    expect(config.executionMode).toBe('preview');
    expect(config.allowLiveWrites).toBe(false);
  });

  it('keeps the local terminal backward compatible', () => {
    const config = loadConfig({});
    expect(config.deploymentMode).toBe('local');
    expect(config.executionMode).toBe('live');
    expect(config.allowLiveWrites).toBe(true);
  });

  it('rejects cloud live mode without an explicit live-write switch', () => {
    expect(() => loadConfig({
      GCT_DEPLOYMENT_MODE: 'cloud',
      GCT_EXECUTION_MODE: 'live',
      GCT_ALLOW_LIVE_WRITES: '0',
    })).toThrow('cloud live execution requires GCT_ALLOW_LIVE_WRITES=1');
  });

  it('rejects unknown deployment modes instead of silently enabling local live defaults', () => {
    expect(() => loadConfig({ GCT_DEPLOYMENT_MODE: 'cluod' })).toThrow(
      'GCT_DEPLOYMENT_MODE must be local or cloud',
    );
  });

  it('requires a durable confirmation secret before cloud live execution', () => {
    expect(() => loadConfig({
      GCT_DEPLOYMENT_MODE: 'cloud',
      GCT_EXECUTION_MODE: 'live',
      GCT_ALLOW_LIVE_WRITES: '1',
    })).toThrow('cloud live execution requires GCT_ORDER_CONFIRMATION_SECRET');
    expect(() => loadConfig({
      GCT_DEPLOYMENT_MODE: 'cloud',
      GCT_ORDER_CONFIRMATION_SECRET: 'too-short',
    })).toThrow('GCT_ORDER_CONFIRMATION_SECRET must contain at least 32 characters');
  });
});
