'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { fetchEmailTriageProtocol, saveEmailTriageProtocol } from '@/lib/actions/email-triage';

export function EmailTriageTab() {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const load = useCallback(async () => {
    const data = await fetchEmailTriageProtocol();
    setContent(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    setSaving(true);
    setStatus('idle');
    const result = await saveEmailTriageProtocol(content);
    if (result.success) {
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2500);
    } else {
      setStatus('error');
      setErrorMsg(result.error ?? 'Save failed');
    }
    setSaving(false);
  }

  if (loading) {
    return <div className="h-96 rounded-xl bg-muted/30 animate-pulse" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email Triage — Action Protocol</CardTitle>
        <CardDescription>
          Pre-read context loaded before every draft reply. Edit the client avatar, tone rules,
          copywriting constraints, or pricing guidance here — the next triage cycle picks it up
          automatically. File: <code className="text-xs">vault/email-triage/action-protocol.md</code>
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Textarea
          className="min-h-[520px] font-mono text-sm resize-y"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Markdown content…"
        />
      </CardContent>

      <CardFooter className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>

        {status === 'saved' && (
          <span className="text-sm text-green-600">Saved — next draft cycle loads the update.</span>
        )}
        {status === 'error' && (
          <span className="text-sm text-destructive">{errorMsg}</span>
        )}

        <span className="ml-auto text-xs text-muted-foreground">
          {content.length.toLocaleString()} chars
        </span>
      </CardFooter>
    </Card>
  );
}
