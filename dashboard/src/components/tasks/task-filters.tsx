'use client';

import { useEffect, useRef, useState } from 'react';
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
  };
  // UHS MOD #7 — search is client-side only, passed separately so it never
  // ends up in fetchTasks dependencies and never triggers an API round-trip.
  // Filtering only fires on Enter or search-button click, never on keypress,
  // so typing never triggers a parent re-render or kanban board re-paint.
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onChange: (key: string, value: string) => void;
  onClearAll: () => void;
}

export function TaskFilters({
  orgs,
  agents,
  projects,
  filters,
  searchQuery,
  onSearchChange,
  onChange,
  onClearAll,
}: TaskFiltersProps) {
  // inputValue is purely local — never pushed to parent until the user
  // submits (Enter key or search button). This means zero re-renders
  // of the parent/kanban while the user is typing.
  const [inputValue, setInputValue] = useState(searchQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync when parent clears the search externally (e.g. Clear All)
  useEffect(() => {
    if (searchQuery === '') setInputValue('');
  }, [searchQuery]);

  function commitSearch(value: string) {
    onSearchChange(value.trim());
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commitSearch(inputValue);
    if (e.key === 'Escape') handleSearchClear();
  }

  function handleSearchClear() {
    setInputValue('');
    onSearchChange('');
    inputRef.current?.focus();
  }

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
      {/* UHS MOD #7: search by task number or title — fires on Enter or click */}
      <div className="relative flex-1 max-w-xs">
        <button
          onClick={() => commitSearch(inputValue)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          tabIndex={-1}
          aria-label="Search"
        >
          <IconSearch size={13} />
        </button>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search… (Enter to filter)"
          className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-8 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {inputValue && (
          <button
            onClick={handleSearchClear}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
            aria-label="Clear search"
          >
            <IconX size={13} />
          </button>
        )}
      </div>
      <FilterBar filters={filterConfigs} onClearAll={onClearAll} />
    </div>
  );
}
