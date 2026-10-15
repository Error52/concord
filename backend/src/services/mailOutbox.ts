import { execute, queryOne, tx, type Queryable } from '../db/pool.js';
import { sendMail, type Mail } from './mailer.js';
import { log } from '../logger.js';

export async function queueMail(userId: string, mail: Mail, db?: Queryable): Promise<void> {
  await execute(`INSERT INTO outbound_emails (user_id, recipient, subject, text_body, html_body) VALUES ($1,$2,$3,$4,$5)`,
    [userId, mail.to, mail.subject, mail.text, mail.html], db);
}

/** Row locks isolate workers; delivery is at least once if a process dies after SMTP acceptance. */
export async function deliverPendingMail(limit = 10): Promise<void> {
  for (let i = 0; i < limit; i++) {
    const found = await tx(async (db) => {
      const row = await queryOne<{id:string;recipient:string;subject:string;text_body:string;html_body:string;attempts:number}>(
        `SELECT * FROM outbound_emails WHERE delivered_at IS NULL AND attempts < 8 AND next_attempt_at <= now()
          AND created_at > now() - interval '24 hours' ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`, [], db);
      if (!row) return false;
      try {
        await sendMail({to:row.recipient,subject:row.subject,text:row.text_body,html:row.html_body});
        await execute(`UPDATE outbound_emails SET delivered_at=now(), attempts=attempts+1 WHERE id=$1`, [row.id], db);
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
