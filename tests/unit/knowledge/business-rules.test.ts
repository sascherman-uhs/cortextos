import { describe, it, expect } from 'vitest';
import { checkBusinessRules, violations, BUSINESS_RULES } from '../../../src/knowledge/business-rules';
import sharedCases from '../../../src/knowledge/business-rule-cases.json';

function ids(text: string): string[] {
  return violations(checkBusinessRules(text)).map((v) => v.ruleId);
}

describe('deterministic business-rule checks on the context packet', () => {
  it('catches rental language about staging', () => {
    expect(ids('We rent the staging furniture to the seller for 30 days.'))
      .toContain('service-not-rental');
    expect(ids('The staging service period runs 30 days.'))
      .not.toContain('service-not-rental');
  });

  it('catches a non-Outlook email path', () => {
    expect(ids('I will send the draft from Apple Mail.')).toContain('email-default-outlook');
    expect(ids('Add a mailto: link to the RSVP button and send it.')).toContain('email-default-outlook');
    expect(ids('I drafted the email in Outlook for review.')).not.toContain('email-default-outlook');
  });

  it('catches calendar duplication to a personal calendar', () => {
    expect(ids('Create the event and duplicate it to the personal calendar.'))
      .toContain('uhs-calendar-only');
    expect(ids('Create the stage event on the UHS calendar.')).not.toContain('uhs-calendar-only');
  });

  it('catches Zillow as a photo source', () => {
    expect(ids('Pull the listing photos from Zillow.')).toContain('photos-mls-matrix');
    expect(ids('Harvest the listing photos from MLS Matrix.')).not.toContain('photos-mls-matrix');
  });

  it('catches conflating the listing agent with the property owner', () => {
    expect(ids('The listing agent is the owner, so one contact is enough.'))
      .toContain('agent-not-owner');
    expect(ids('The owner is on the Assessor record; the listing agent is separate.'))
      .not.toContain('agent-not-owner');
  });

  it('catches a report built anywhere but the canonical intake', () => {
    expect(ids('I will produce the staging report as a standalone HTML file.'))
      .toContain('report-destination');
    expect(ids('I will produce the staging report via the create-report webhook.'))
      .not.toContain('report-destination');
  });

  it('catches a WordPress URL slugified from a title', () => {
    expect(ids('I guessed the slug for the permalink from the post title.'))
      .toContain('wordpress-permalink-from-api');
    expect(ids('I fetched the permalink from the REST API at wp-json/wp/v2/posts/3800.'))
      .not.toContain('wordpress-permalink-from-api');
  });

  it('catches GoHighLevel as a live CRM instruction', () => {
    expect(ids('For an existing client lookup, check GoHighLevel.'))
      .toContain('crm-not-gohighlevel');
    expect(ids('For an existing client lookup, query Supabase uhs_projects.'))
      .not.toContain('crm-not-gohighlevel');
  });

  it('marks a rule not_applicable rather than passing it vacuously', () => {
    const findings = checkBusinessRules('The warehouse lease renews in March.');
    const photo = findings.find((f) => f.ruleId === 'photos-mls-matrix');
    expect(photo!.status).toBe('not_applicable');
  });

  it('returns the offending excerpt so a draft can be fixed, not just judged', () => {
    const v = violations(checkBusinessRules('We are renting staging furniture.'))[0];
    expect(v.evidence).toMatch(/renting/);
    expect(v.remedy).toMatch(/service period/);
  });
});


/**
 * The SAME case file uhsJARVIS scripts/agent-os/knowledge_business_rules.py is
 * tested against. A rule that passes in TypeScript and fails in Python (or the
 * reverse) is a fleet that disagrees with itself about what it is allowed to
 * say, so both sides answer to one list.
 */
describe('shared rule cases (identical to the JARVIS side)', () => {
  for (const c of sharedCases.cases) {
    it(`${c.rule_id}: ${c.should_violate ? 'violates' : 'passes'} — ${c.text}`, () => {
      expect(ids(c.text).includes(c.rule_id)).toBe(c.should_violate);
    });
  }

  it('covers every rule with both a violating and a passing case', () => {
    const positive = new Set(sharedCases.cases.filter((c) => c.should_violate).map((c) => c.rule_id));
    const negative = new Set(sharedCases.cases.filter((c) => !c.should_violate).map((c) => c.rule_id));
    for (const rule of BUSINESS_RULES) {
      expect(positive.has(rule.id), `no violating case for ${rule.id}`).toBe(true);
      expect(negative.has(rule.id), `no passing case for ${rule.id}`).toBe(true);
    }
  });
});
