'use client';

import { FilterBar } from '@/components/shared';
import type { FilterConfig } from '@/components/shared';
// UHS MOD #7 — search input for task number / title
import { IconSearch, IconX } from '@tabler/icons-react';

interface TaskFiltersProps {
  orgs: string[];
  agents: string[];
  projects: string[];
  filters: {
    org: string;
    agent: string;
    priority: string;
    project: string;
    status: string;
    search: string; // UHS MOD #7
  };
  onChange: (key: string, value: string) => void;
  onClearAll: () => void;
}

export function TaskFilters({
  orgs,
  agents,
  projects,
  filters,
  onChange,
  onClearAll,
}: TaskFiltersProps) {
  const filterConfigs: FilterConfig[] = [
    {
      key: 'org',
      label: 'Org',
      value: filters.org,
      onChange: (v) => onChange('org', v),
      options: [
        { value: 'all', label: 'All Orgs' },
        ...orgs.map((o) => ({ value: o, label: o })),
      ],
    },
    {
      key: 'agent',
      label: 'Agent',
      value: filters.agent,
      onChange: (v) => onChange('agent', v),
      options: [
        { value: 'all', label: 'All Agents' },
        ...agents.map((a) => ({ value: a, label: a })),
      ],
    },
    {
      key: 'priority',
      label: 'Priority',
      value: filters.priority,
      onChange: (v) => onChange('priority', v),
      options: [
        { value: 'all', label: 'All Priorities' },
        { value: 'urgent', label: 'Urgent' },
        { value: 'high', label: 'High' },
        { value: 'normal', label: 'Normal' },
        { value: 'low', label: 'Low' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      value: filters.status,
      onChange: (v) => onChange('status', v),
      options: [
        { value: 'all', label: 'All Statuses' },
        { value: 'pending', label: 'Pending' },
        { value: 'in_progress', label: 'In Progress' },
        { value: 'blocked', label: 'Blocked' },
        { value: 'completed', label: 'Completed' },
      ],
    },
  ];

  if (projects.length > 0) {
    filterConfigs.push({
      key: 'project',
      label: 'Project',
      value: filters.project,
      onChange: (v) => onChange('project', v),
      options: [
        { value: 'all', label: 'All Projects' },
        ...projects.map((p) => ({ value: p, label: p })),
      ],
    });
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      {/* UHS MOD #7: search by task number or title */}
      <div className="relative flex-1 max-w-xs">
        <IconSearch size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => onChange('search', e.target.value)}
          placeholder="Search by #number or title…"
          className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-8 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {filters.search && (
          <button
            onClick={() => onChange('search', '')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <IconX size={13} />
          </button>
        )}
      </div>
      <FilterBar filters={filterConfigs} onClearAll={onClearAll} />
    </div>
  );
}
