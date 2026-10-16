import { execute, query, queryOne, tx, type Queryable } from '../db/pool.js';
import { sendMail, type Mail } from './mailer.js';
import { log } from '../logger.js';
import {config} from '../config.js';
import {sealMail,openMail} from './mailCrypto.js';

export interface MailValidity {
  purpose:'verification'|'password-reset';
  tokenHash:string;
  expiresAt:Date;
}

export async function queueMail(userId: string, mail: Mail, db?: Queryable, validity?:MailValidity): Promise<void> {
  await execute(`INSERT INTO outbound_emails (user_id, recipient, subject, text_body, html_body, purpose, token_hash, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,now()+interval '24 hours'))`,
    [userId, mail.to, mail.subject, sealMail(mail.text,mail.html), '',validity?.purpose??null,validity?.tokenHash??null,validity?.expiresAt??null], db);
}

/** Protect pre-upgrade queued letters before the HTTP server starts. */
export async function protectQueuedMail():Promise<void> {
  for(;;){
    const count=await tx(async db=>{
      const rows=await query<{id:string;text_body:string;html_body:string}>(`SELECT id,text_body,html_body FROM outbound_emails
        WHERE text_body<>'' AND text_body NOT LIKE 'sealed:v1:%' FOR UPDATE SKIP LOCKED LIMIT 100`,[],db);
      for(const row of rows)await execute(`UPDATE outbound_emails SET text_body=$2,html_body='' WHERE id=$1`,[row.id,sealMail(row.text_body,row.html_body)],db);
      return rows.length;
    });
    if(!count)return;
  }
}

export async function clearInvalidMail():Promise<void>{
  await execute(`UPDATE outbound_emails e SET text_body='',html_body='' WHERE text_body<>'' AND
    (expires_at<=now() OR (delivered_at IS NOT NULL AND NOT ($1::boolean AND purpose IS NOT DISTINCT FROM 'verification')) OR
     (purpose='verification' AND NOT EXISTS(SELECT 1 FROM email_verifications v WHERE v.user_id=e.user_id AND v.token_hash=e.token_hash AND v.used_at IS NULL AND v.expires_at>now())) OR
     (purpose='password-reset' AND NOT EXISTS(SELECT 1 FROM password_resets r WHERE r.user_id=e.user_id AND r.token_hash=e.token_hash AND r.used_at IS NULL AND r.expires_at>now())))`,[config.DEMO_MAILBOX]);
}

/** Row locks isolate workers; delivery is at least once if a process dies after SMTP acceptance. */
export async function deliverPendingMail(limit = 10): Promise<void> {
  await clearInvalidMail();
  for (let i = 0; i < limit; i++) {
    const found = await tx(async (db) => {
      const row = await queryOne<{id:string;recipient:string;subject:string;text_body:string;html_body:string;attempts:number}>(
        `SELECT e.* FROM outbound_emails e WHERE e.delivered_at IS NULL AND e.attempts < 8 AND e.next_attempt_at <= now()
          AND e.expires_at>now() AND (
            e.purpose IS NULL OR
            (e.purpose='verification' AND EXISTS (SELECT 1 FROM email_verifications v JOIN users u ON u.id=v.user_id
              WHERE v.user_id=e.user_id AND v.token_hash=e.token_hash AND v.used_at IS NULL AND v.expires_at>now() AND u.email_verified_at IS NULL)) OR
            (e.purpose='password-reset' AND EXISTS (SELECT 1 FROM password_resets r
              WHERE r.user_id=e.user_id AND r.token_hash=e.token_hash AND r.used_at IS NULL AND r.expires_at>now()))
          ) ORDER BY e.next_attempt_at FOR UPDATE OF e SKIP LOCKED LIMIT 1`, [], db);
      if (!row) return false;
      try {
        await sendMail({to:row.recipient,subject:row.subject,...openMail(row)});
        await execute(`UPDATE outbound_emails SET delivered_at=now(), attempts=attempts+1,
          text_body=CASE WHEN $2::boolean AND purpose='verification' THEN text_body ELSE '' END,html_body='' WHERE id=$1`, [row.id,config.DEMO_MAILBOX], db);
      } catch (err) {
        // Log neither recipients nor bodies/tokens. Keep a transient failure out of the signup request.
        log.warn('email delivery postponed', {mailId:row.id,attempt:row.attempts+1,error:err instanceof Error ? err.message : 'SMTP failed'});
        await execute(`UPDATE outbound_emails SET attempts=attempts+1, next_attempt_at=now()+make_interval(secs=>$2) WHERE id=$1`,
          [row.id, Math.min(3600, 15 * 2 ** row.attempts)], db);
      }
      return true;
    });
    if (!found) return;
  }
}
