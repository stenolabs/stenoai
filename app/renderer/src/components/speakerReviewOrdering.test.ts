import { describe, expect, it, vi } from 'vitest';

import { namesCollide, orderProfilesForRow, filterProfilesByQuery } from './SpeakerReviewPanel';

const p = (display_name: string) => ({ display_name, person_id: `id-${display_name.toLowerCase()}` });

describe('orderProfilesForRow', () => {
  it('puts people already assigned in this meeting first', () => {
    const ordered = orderProfilesForRow(
      [p('Zoe'), p('Alice'), p('Max')],
      new Set(['id-max']),
    );
    expect(ordered.map((x) => x.display_name)).toEqual(['Max', 'Alice', 'Zoe']);
  });

  it('keeps each group alphabetical', () => {
    const ordered = orderProfilesForRow(
      [p('Zoe'), p('Alice'), p('Max'), p('Bea')],
      new Set(['id-max', 'id-zoe']),
    );
    expect(ordered.map((x) => x.display_name)).toEqual(['Max', 'Zoe', 'Alice', 'Bea']);
  });

  it('leaves the order alone when nobody is assigned yet', () => {
    const ordered = orderProfilesForRow([p('Zoe'), p('Alice')], new Set());
    expect(ordered.map((x) => x.display_name)).toEqual(['Alice', 'Zoe']);
  });

  it('does not mutate the list it was given', () => {
    const input = [p('Zoe'), p('Alice')];
    orderProfilesForRow(input, new Set(['id-alice']));
    expect(input.map((x) => x.display_name)).toEqual(['Zoe', 'Alice']);
  });
});

describe('orderProfilesForRow identity', () => {
  it('matches on person_id, not on the display name', () => {
    // Two profiles can read alike after a rename. Marking the never-assigned
    // one as present in this meeting would invite the exact misassignment
    // the "here" hint exists to prevent.
    const assigned = { display_name: 'Alex', person_id: 'id-a' };
    const other = { display_name: 'Alex', person_id: 'id-b' };
    const ordered = orderProfilesForRow([other, assigned], new Set(['id-a']));
    expect(ordered.map((x) => x.person_id)).toEqual(['id-a', 'id-b']);
  });
});

describe('filterProfilesByQuery', () => {
  it('matches anywhere in the name, not just the start', () => {
    const found = filterProfilesByQuery([p('Zora Quinn'), p('Rowan Example')], 'quinn');
    expect(found.map((x) => x.display_name)).toEqual(['Zora Quinn']);
  });

  it('ignores case', () => {
    const found = filterProfilesByQuery([p('Mira Novak')], 'NOVAK');
    expect(found.map((x) => x.display_name)).toEqual(['Mira Novak']);
  });

  it('uses the same case folding regardless of the operating-system locale', () => {
    const nativeLocaleLower = String.prototype.toLocaleLowerCase;
    const localeSpy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(
      function forceTurkishLocale(this: string) {
        return nativeLocaleLower.call(this, 'tr');
      },
    );
    try {
      const found = filterProfilesByQuery([p('Irmak')], 'irmak');
      expect(found.map((x) => x.display_name)).toEqual(['Irmak']);
    } finally {
      localeSpy.mockRestore();
    }
  });

  it('finds an accented name typed without accents', () => {
    // A user on a keyboard that cannot produce the character otherwise has
    // no path to that person at all.
    const found = filterProfilesByQuery([p('Müller'), p('Mahler')], 'muller');
    expect(found.map((x) => x.display_name)).toEqual(['Müller']);
  });

  it('finds an unaccented name typed with accents', () => {
    const found = filterProfilesByQuery([p('Muller')], 'müller');
    expect(found.map((x) => x.display_name)).toEqual(['Muller']);
  });

  it('returns everything for an empty or whitespace-only query', () => {
    const all = [p('Zoe'), p('Alice')];
    expect(filterProfilesByQuery(all, '')).toHaveLength(2);
    expect(filterProfilesByQuery(all, '   ')).toHaveLength(2);
  });

  it('returns nothing when no name matches', () => {
    expect(filterProfilesByQuery([p('Zoe'), p('Alice')], 'qqq')).toEqual([]);
  });

  it('preserves the order it was given, so "here" people stay on top', () => {
    // Composed with orderProfilesForRow in the picker: filtering must not
    // re-sort, or the already-in-this-meeting people lose their position.
    const ordered = orderProfilesForRow(
      [p('Anna Bauer'), p('Bea Bauer'), p('Zoe Bauer')],
      new Set(['id-zoe bauer']),
    );
    const found = filterProfilesByQuery(ordered, 'bauer');
    expect(found.map((x) => x.display_name)).toEqual(['Zoe Bauer', 'Anna Bauer', 'Bea Bauer']);
  });

  it('does not mutate the list it was given', () => {
    const input = [p('Zoe'), p('Alice')];
    filterProfilesByQuery(input, 'zoe');
    expect(input.map((x) => x.display_name)).toEqual(['Zoe', 'Alice']);
  });
});

describe('namesCollide', () => {
  it('matches common Unicode case-fold equivalents used by the backend', () => {
    expect(namesCollide('Straße', 'STRASSE')).toBe(true);
    expect(namesCollide('ΟΣ', 'ος')).toBe(true);
  });

  it('normalizes compatibility and surrounding whitespace', () => {
    expect(namesCollide('  Person Ａ  ', 'person a')).toBe(true);
  });

  it('collapses repeated internal whitespace like the backend', () => {
    expect(namesCollide('Person   Alpha', 'person alpha')).toBe(true);
  });
});
