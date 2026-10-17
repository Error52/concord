import {execute,type Queryable} from '../db/pool.js';

/** Session changes and media admission must agree on one per-user ordering. */
export async function lockUserSessions(userId:string,db:Queryable):Promise<void> {
  await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1,72601))`,[userId],db);
}
