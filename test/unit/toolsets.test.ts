import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, selectTools, TOOLSETS } from '../../src/toolsets.js';

describe('selectTools', () => {
  it('selects every tool by default and for "all"', () => {
    expect([...selectTools([])]).toEqual(ALL_TOOLS);
    expect([...selectTools(['', ' '])]).toEqual(ALL_TOOLS);
    expect([...selectTools(['review', 'all'])]).toEqual(ALL_TOOLS);
  });

  it('expands toolsets and mixes them with single tools, ignoring case', () => {
    expect([...selectTools(['Review', 'list_tags'])]).toEqual([...TOOLSETS.review, 'list_tags']);
    expect([...selectTools(['code_age', 'ownership'])].sort()).toEqual(
      [...TOOLSETS.ownership].sort(),
    );
  });

  it('puts every tool in exactly one toolset', () => {
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('rejects unknown names and lists the valid ones', () => {
    expect(() => selectTools(['reveiw'])).toThrow(
      /Unknown tool or toolset "reveiw".*Toolsets: review/,
    );
    expect(() => selectTools(['toString'])).toThrow(/Unknown/);
  });
});
