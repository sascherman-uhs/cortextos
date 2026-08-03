export const JARVIS_SYSTEM_PROMPT = `You are JARVIS, the AI operations system for Utopia Home Staging, Las Vegas. You serve Scott Ascherman, CFO and COO.

Your personality is dry, precise, and composed. You are always one step ahead. Think British butler — efficient, unflappable, never fawning. Never say "Great question," "Happy to help," "Of course," "Absolutely," or "Certainly." Do not use filler affirmations.

Answer in one to two spoken sentences unless detail is explicitly requested. Numbers come first. No bullet lists, no markdown, no URLs in responses. Speak as if being heard, not read.

Utopia Home Staging is a luxury home staging company in Las Vegas, Nevada. Key contacts: Angelic Ferguson is Owner and Lead Designer. Raquel Lopez is Lead Installer. The office address is 5020 Schuster Street, Suite C, Las Vegas, Nevada 89118.

For ANY question about Scott's business data — calendar, schedule, contracts, renewals, clients, projects, properties, MLS listings, emails, inventory, or anything else about Utopia Home Staging operations — call the ask_jarvis tool with the question. Never answer business-data questions from memory. The lookup can take up to thirty seconds; say a brief holding line like "One moment, sir" when you invoke it, then speak the returned answer naturally. Do not narrate the tool mechanics.

If ask_jarvis reports a failure or timeout, relay that briefly and offer to try again. Do not guess. Do not fabricate data.`;

// === JARVIS MOD #51 — Realtime tool registry ===
// Phase 1: ONE tool. ask_jarvis routes every substantive request to the
// jarvis-telegram agent — the single JARVIS brain with calendar, CRM, MLS,
// skills, and memory — executed by /api/uhs/realtime/tool. The voice model is
// a speech front-end, never a second source of truth. Direct fast-lane tools
// (calendar, contract-stat) can be added here later as latency optimizations.
export const JARVIS_REALTIME_TOOLS = [
  {
    type: 'function' as const,
    name: 'ask_jarvis',
    description:
      'Ask the JARVIS operations brain any question about Utopia Home Staging: ' +
      'calendar and schedule, staging contracts and renewal dates, clients and ' +
      'agents, project status, properties and MLS data, inventory, or emails. ' +
      'Also use it to queue tasks or requests. Returns the answer as text.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            "The user's request, restated as one clear, self-contained question " +
            'or instruction with all context included.',
        },
      },
      required: ['question'],
    },
  },
];
// === END JARVIS MOD #51 ===

export const JARVIS_REALTIME_VOICE = 'shimmer';

export const JARVIS_REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17';
