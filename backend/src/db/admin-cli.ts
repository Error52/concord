/**
 * Grants or revokes platform admin (admin panel, special badges) by email.
 *   node dist/admin-cli.js you@example.com            → grant
 *   node dist/admin-cli.js you@example.com --revoke   → revoke
 *   node dist/admin-cli.js --list                     → list admins
 * In Docker: `make admin EMAIL=you@example.com`.
 */
import { pool } from './pool.js';

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const email = args.find((a) => !a.startsWith('--'));

async function main(): Promise<number> {
  if (args.includes('--list') || !email) {
    const { rows } = await pool.query<{ email: string; username: string }>(`SELECT email, username FROM users WHERE is_platform_admin ORDER BY created_at`);
    if (!email && !args.includes('--list')) console.log('Usage: admin-cli <email> [--revoke] | --list\n');
    console.log(rows.length ? rows.map((r) => `  ${r.email} (@${r.username})`).join('\n') : '  (no platform admins yet)');
    return 0;
  }
  const { rows } = await pool.query<{ username: string }>(`UPDATE users SET is_platform_admin = $2 WHERE lower(email) = lower($1) RETURNING username`, [email, !revoke]);
  if (rows.length === 0) {
    console.error(`User with email ${email} not found — register the account first.`);
    return 1;
  }
  console.log(`${revoke ? 'Revoked' : 'Granted'} platform admin: @${rows[0]!.username} <${email}>. Reload the page to see the admin panel.`);
  return 0;
}

const code = await main().catch((err: unknown) => {
  console.error(err);
  return 1;
});
await pool.end();
process.exit(code);
