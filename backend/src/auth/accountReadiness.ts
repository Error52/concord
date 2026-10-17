import {config} from '../config.js';

export function accountReady(row:{email_verified_at:Date|null;local_verified_at:Date|null;is_platform_admin:boolean}):boolean{
  return !config.REQUIRE_EMAIL_VERIFICATION || row.email_verified_at!=null ||
    (config.ACCOUNT_VERIFICATION_MODE==='secret-word'&&(row.local_verified_at!=null||row.is_platform_admin));
}

export const normalizeRecoveryWord=(word:string):string=>word.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase()
  .replace(/ß/g,'ss').replace(/ς/g,'σ');
