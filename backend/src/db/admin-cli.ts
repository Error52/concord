/**
 * Grants or revokes platform admin (admin panel, special badges) by email.
 *   node dist/admin-cli.js you@example.com            → grant
 *   node dist/admin-cli.js you@example.com --revoke   → revoke
 *   node dist/admin-cli.js --list                     → list admins
 * In Docker: `make admin EMAIL=you@example.com`.
 */
import { pool,tx,execute,queryOne } from './pool.js';
import { platformAdminEmails } from '../config.js';

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
  const target = await tx(async db=>{
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended('platform-admins',0))`,[],db);
    const user=await queryOne<{id:string;username:string;email:string;is_platform_admin:boolean}>(`SELECT id,username,email,is_platform_admin FROM users WHERE lower(email)=lower($1) FOR UPDATE`,[email],db);
    if(!user || user.is_platform_admin===!revoke)return user;
    if(revoke){
      if(platformAdminEmails.includes(user.email.toLowerCase()))throw new Error('Этот email указан в PLATFORM_ADMIN_EMAILS — сначала уберите его из настроек');
      const admins=await queryOne<{n:number}>(`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`,[],db);
      if((admins?.n??0)<=1)throw new Error('Нельзя снять права с последнего администратора');
    }
    await execute(`UPDATE users SET is_platform_admin=$2 WHERE id=$1`,[user.id,!revoke],db);
    await execute(`INSERT INTO platform_audit_log(action,target_type,target_id,meta) VALUES($1,'user',$2,$3)`,[revoke?'admin.revoke':'admin.grant',user.id,JSON.stringify({source:'local-cli'})],db);
    return user;
  });
  if (!target) {
    console.error(`User with email ${email} not found — register the account first.`);
    return 1;
  }
  console.log(`${revoke ? 'Revoked' : 'Granted'} platform admin: @${target.username} <${email}>. Reload the page to see the admin panel.`);
  return 0;
}

const code = await main().catch((err: unknown) => {
  console.error(err instanceof Error?err.message:'Admin operation failed');
  return 1;
});
await pool.end();
process.exit(code);
