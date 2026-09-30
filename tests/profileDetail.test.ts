import { describe, it, expect } from 'vitest';
import { profileDetail } from '../src/providers/profileDetail';

/**
 * PICKER-ROW FIDELITY.
 *
 * The row this builds is the only thing a human sees before committing a run to
 * a profile. It used to describe a TEAM profile by its leader alone, so a
 * profile whose members bound to a vacated host rendered as perfectly healthy.
 *
 * ⛔ THE BACKWARD-COMPATIBILITY CASE IS NOT A FORMALITY. The `vett` installed on
 * this machine (2026-08-25 build) emits none of endpoints/models/parseError —
 * confirmed by running `vett profiles --json` and reading the keys back, not by
 * assuming. Every one of those tests is therefore the LIVE configuration, and
 * the "+N more" cases are the future one.
 */

const base = {
  description: 'a profile',
  model: 'deepseek-v4-flash',
  endpoint: 'http://localhost:8000/v1',
  provider: 'openai',
  tools: ['bash', 'edit'],
};

describe('profileDetail', () => {
  describe('against the vett that is actually installed (no new fields)', () => {
    it('renders exactly the legacy string when the arrays are absent', () => {
      expect(profileDetail(base)).toBe(
        'model=deepseek-v4-flash  ·  endpoint=http://localhost:8000/v1  ·  tools=[bash,edit]',
      );
    });

    it('never emits "+undefined" or a bare "(+0 more)"', () => {
      const out = profileDetail(base);
      expect(out).not.toContain('undefined');
      expect(out).not.toContain('NaN');
      expect(out).not.toContain('more');
    });

    it('falls back to provider when there is no endpoint, as before', () => {
      expect(profileDetail({ ...base, endpoint: '', tools: [] })).toBe(
        'model=deepseek-v4-flash  ·  provider=openai',
      );
    });

    it('falls back to the description when nothing is bound', () => {
      expect(
        profileDetail({ description: 'notes only', model: '', endpoint: '', provider: '', tools: [] }),
      ).toBe('notes only');
    });
  });

  describe('a team profile whose members hide behind the headline', () => {
    it('flags the endpoints the headline does not show', () => {
      const out = profileDetail({
        ...base,
        endpoints: [
          'http://localhost:8000/v1',
          'https://openrouter.ai/api/v1',
          'http://localhost:8001/v1',
        ],
      });
      expect(out).toContain('endpoint=http://localhost:8000/v1 (+2 more)');
    });

    it('flags hidden models independently of endpoints', () => {
      const out = profileDetail({
        ...base,
        models: ['deepseek-v4-flash', 'deepseek/deepseek-v4-pro'],
      });
      expect(out).toContain('model=deepseek-v4-flash (+1 more)');
      // The endpoint half must stay silent — the two are counted separately.
      expect(out).toContain('endpoint=http://localhost:8000/v1  ·  ');
    });

    it('stays silent when every member shares the headline binding', () => {
      // ⭐ THE CRY-WOLF CASE. The healthy majority of team profiles bind every
      // member to one endpoint; if those rendered "+4 more", the annotation
      // would be noise on exactly the profiles that are fine.
      const out = profileDetail({
        ...base,
        endpoints: ['http://localhost:8000/v1'],
        models: ['deepseek-v4-flash'],
      });
      expect(out).not.toContain('more');
    });

    it('compares case-insensitively, matching the collector dedupe', () => {
      const out = profileDetail({
        ...base,
        endpoints: ['http://localhost:8000/v1', 'HTTP://LOCALHOST:8000/V1'],
      });
      expect(out).not.toContain('more');
    });

    it('counts by value, not by position, when the headline is not first', () => {
      // If the top-level `llm:` block is absent, endpoints[0] is the leader's
      // and a naive `length - 1` would under-count by one.
      const out = profileDetail({
        ...base,
        endpoint: 'http://c.example/v1',
        endpoints: ['http://a.example/v1', 'http://b.example/v1'],
      });
      expect(out).toContain('endpoint=http://c.example/v1 (+2 more)');
    });
  });

  describe('a profile that could not be read', () => {
    it('says so instead of rendering the empty strings the failure produced', () => {
      // ⛔ COULD-NOT-MEASURE vs MEASURED-EMPTY. Without the flag, an unparseable
      // profile arrives as all-empty fields and renders identically to one that
      // parsed fine and simply declares nothing — i.e. as merely unconfigured.
      const out = profileDetail({
        description: '',
        model: '',
        endpoint: '',
        provider: '',
        tools: [],
        parseError: true,
      });
      expect(out).toContain('could not parse');
    });

    it('is distinguishable from a profile that parsed and declares nothing', () => {
      const broken = profileDetail({
        description: '', model: '', endpoint: '', provider: '', tools: [], parseError: true,
      });
      const empty = profileDetail({
        description: '', model: '', endpoint: '', provider: '', tools: [], parseError: false,
      });
      expect(broken).not.toBe(empty);
    });
  });
});
