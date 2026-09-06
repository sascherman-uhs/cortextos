/**
 * business-rules.ts — deterministic checks over a bounded context packet.
 *
 * These are the UHS rules that a model must not be trusted to remember. Each is
 * decidable from text alone, so it is checked in code rather than hoped for in
 * a prompt. A violation is returned with the offending excerpt so the caller
 * can fix the draft, not just be told it is wrong.
 *
 * Scope note: these check *what the agent is about to say or do*, not the
 * source material it retrieved. Retrieved material is allowed to contain the
 * word "Zillow"; an answer that tells someone to get photos from Zillow is not.
 */

export type RuleStatus = 'pass' | 'violation' | 'not_applicable';

export interface RuleFinding {
  ruleId: string;
  title: string;
  status: RuleStatus;
  /** The text that triggered the finding. */
  evidence: string | null;
  remedy: string;
  source: string;
}

export interface BusinessRule {
  id: string;
  title: string;
  /** Text that must NOT appear (in the given context). */
  forbidden?: RegExp;
  /** If present, the rule only applies when this matches. */
  appliesWhen?: RegExp;
  /** If present, at least one of these must appear for the rule to pass. */
  requires?: RegExp;
  remedy: string;
  source: string;
}

export const BUSINESS_RULES: BusinessRule[] = [
  {
    id: 'service-not-rental',
    title: 'Staging is a service, never a rental or lease',
    appliesWhen: /\bstag(e|ing|ed)\b|\binventory\b|\bfurniture\b/i,
    forbidden: /\b(rental|rentals|renting|rent|lease|leases|leasing|leased)\b/i,
    remedy: 'Say "service" or "service period". Rental/lease language for staging creates a tax exposure.',
    source: 'AGENTS.md Critical Operating Rule 4',
  },
  {
    id: 'email-default-outlook',
    title: 'All outbound email is drafted in Outlook',
    appliesWhen: /\b(email|draft|send)\b/i,
    forbidden: /\bapple mail\b|\bmailto:|\bgmail\b/i,
    remedy: 'Draft in Scott\'s Outlook (scott@utopiahomestaging.com). App buttons use an outlook.office.com deeplink, never mailto:.',
    source: 'CLAUDE.md operating rule 11 / AGENTS.md business rules',
  },
  {
    id: 'uhs-calendar-only',
    title: 'Events go on the UHS calendar, never the personal calendar',
    appliesWhen: /\b(calendar|event|appointment|schedule)\b/i,
    forbidden: /\bpersonal calendar\b|\bduplicate (it |the event )?to (his|scott's|the) personal\b/i,
    remedy: 'All events live on the UHS calendar. Never duplicate to a personal calendar.',
    source: 'AGENTS.md business rules',
  },
  {
    id: 'photos-mls-matrix',
    title: 'Listing photos come from MLS Matrix, never Zillow',
    appliesWhen: /\b(photo|photos|image|images|listing pictures)\b/i,
    forbidden: /\bzillow\b/i,
    remedy: 'Harvest listing photos from MLS Matrix (scripts/mls_photo_harvest.py).',
    source: 'AGENTS.md Critical Operating Rule 5',
  },
  {
    id: 'agent-not-owner',
    title: 'Listing agent and property owner are distinct people',
    appliesWhen: /\b(owner|owns|homeowner)\b/i,
    forbidden: /\b(the )?(listing )?agent,? (who is|is) (also )?the (owner|homeowner)\b|\bowner\/agent are the same\b/i,
    remedy: 'Surface the listing agent and the property owner as two separate contacts. Owner comes from the Assessor, agent from uhsMLS.agents.',
    source: 'AGENTS.md Critical Operating Rule 8',
  },
  {
    id: 'report-destination',
    title: 'Reports are DB-native records created through the uhsStagingReport webhook',
    appliesWhen: /\b(staging report|market analysis report|client report|report for)\b/i,
    forbidden: /\bhand-?built html\b|\bstandalone html (report|file)\b|\bnew vercel project\b|\bregister[-_]artifact\b|\bnew supabase bucket\b|\bwordpress (report )?page\b/i,
    remedy: 'POST to /api/integrations/webhook/create-report on staging-report.vercel.app so the report is editable, shareable and exportable. Never hand-build HTML or stand up a new host.',
    source: 'AGENTS.md "Reports — ONE home, ONE door"',
  },
  {
    id: 'wordpress-permalink-from-api',
    title: 'WordPress URLs are fetched from the REST API, never slugified from the title',
    appliesWhen: /utopiahomestaging\.com\/[a-z0-9-]+|blog post url|permalink/i,
    forbidden: /\bslugif(y|ied|ying)\b|\bconstruct(ed)? the url from the title\b|\bguess(ed)? the slug\b/i,
    requires: /wp-json\/wp\/v2\/posts|rest api/i,
    remedy: 'Fetch the real permalink: curl https://utopiahomestaging.com/wp-json/wp/v2/posts/{ID}?_fields=link,slug',
    source: 'AGENTS.md Critical Operating Rule 7 / CLAUDE.md rule 10',
  },
  {
    id: 'crm-not-gohighlevel',
    title: 'GoHighLevel is retired; client lookup uses Supabase project records',
    appliesWhen: /\b(crm|client lookup|existing client|prior project)\b/i,
    forbidden: /\bgo\s?high\s?level\b|\bghl\b/i,
    remedy: 'Query Supabase uhs_projects / project_contacts. GoHighLevel was retired 2026-07-06 and must never be queried.',
    source: 'CLAUDE.md operating rule 9',
  },
];

/**
 * Run every rule against a context packet. `text` is what the agent intends to
 * say or do; `intent` narrows applicability when the caller knows it.
 */
export function checkBusinessRules(text: string, rules: BusinessRule[] = BUSINESS_RULES): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const rule of rules) {
    if (rule.appliesWhen && !rule.appliesWhen.test(text)) {
      findings.push({
        ruleId: rule.id, title: rule.title, status: 'not_applicable',
        evidence: null, remedy: rule.remedy, source: rule.source,
      });
      continue;
    }
    const forbiddenMatch = rule.forbidden ? rule.forbidden.exec(text) : null;
    if (forbiddenMatch) {
      findings.push({
        ruleId: rule.id, title: rule.title, status: 'violation',
        evidence: excerpt(text, forbiddenMatch.index, forbiddenMatch[0].length),
        remedy: rule.remedy, source: rule.source,
      });
      continue;
    }
    if (rule.requires && !rule.requires.test(text)) {
      findings.push({
        ruleId: rule.id, title: rule.title, status: 'violation',
        evidence: null, remedy: rule.remedy, source: rule.source,
      });
      continue;
    }
    findings.push({
      ruleId: rule.id, title: rule.title, status: 'pass',
      evidence: null, remedy: rule.remedy, source: rule.source,
    });
  }
  return findings;
}

export function violations(findings: RuleFinding[]): RuleFinding[] {
  return findings.filter((f) => f.status === 'violation');
}

function excerpt(text: string, index: number, length: number, pad = 60): string {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}
