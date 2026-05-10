import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/reset-password
 * Resets a user's password. Available from the login page without authentication.
 * Since this is a local dashboard (not public internet), we allow direct resets.
 */
export async function POST(request: NextRequest) {
  try {
    const { username, newPassword } = await request.json();

    if (!username || typeof username !== 'string') {
      return Response.json({ success: false, error: 'Username is required' }, { status: 400 });
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return Response.json({ success: false, error: 'Password must be at least 6 characters' }, { status: 400 });
    }

    // Find the user
    const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username.trim()) as
      | { id: number; username: string }
      | undefined;

    if (!user) {
      return Response.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    // Hash and update
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

    return Response.json({ success: true });
  } catch (err) {
    console.error('[reset-password] error:', err);
    return Response.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}
