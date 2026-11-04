import { describe, expect, it } from 'vitest';
import { translateTopic, TOPIC_ZH } from '../src/i18n.js';

describe('中文主题词翻译 (i18n)', () => {
  it('精确匹配中文主题', () => {
    const r = translateTopic('趋势跟踪');
    expect(r.query).toBe('trend following');
    expect(r.translated).toBe(true);
    expect(r.matched).toBe('趋势跟踪');
  });

  it('忽略空格差异', () => {
    expect(translateTopic(' 均值回归 ').query).toBe('mean reversion');
  });

  it('中文长句做包含匹配', () => {
    expect(translateTopic('帮我找超级趋势指标').query).toBe('supertrend');
  });

  it('取最长命中键，短词不会抢先', () => {
    // “趋势跟踪” 同时包含 “趋势”，应命中更长的键
    expect(translateTopic('趋势跟踪策略').matched).toBe('趋势跟踪');
  });

  it('英文查询原样放行，不做改写', () => {
    const r = translateTopic('trend following');
    expect(r.query).toBe('trend following');
    expect(r.translated).toBe(false);
  });

  it('空查询原样返回', () => {
    expect(translateTopic('')).toEqual({ query: '', translated: false, matched: null });
    expect(translateTopic(undefined).query).toBeUndefined();
  });

  it('未收录的中文主题给出可读错误', () => {
    expect(() => translateTopic('不存在的玄学主题')).toThrow(/无法把中文主题/);
    expect(() => translateTopic('不存在的玄学主题')).toThrow(/趋势跟踪/);
  });

  it('词表值均为英文，且不含大写连字符写法', () => {
    for (const [zh, en] of Object.entries(TOPIC_ZH)) {
      expect(zh.length).toBeGreaterThan(0);
      expect(en).toMatch(/^[a-z0-9 ]+$/);
    }
  });
});
